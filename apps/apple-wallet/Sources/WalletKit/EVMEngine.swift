import Foundation
import Web3Core
import BigInt

public struct SignedEVMTransfer: Sendable {
    public let rawHex: String
    public let hash: String
    public let review: TransferReview
}

public actor EVMEngine {
    private struct Prepared {
        let review: TransferReview
        let endpoint: URL
        let nonce: BigUInt
        let amount: BigUInt
        let gas: BigUInt
        let maxFee: BigUInt
        let priority: BigUInt
    }
    private var prepared: Prepared?
    private var signed: (SignedEVMTransfer, URL)?
    private var generation: UInt64 = 0
    private var validated: (id: UUID, at: Date)?
    private let rpcFactory: @Sendable (URL) -> JSONRPC
    public init(rpcFactory: @escaping @Sendable (URL) -> JSONRPC = { JSONRPC(endpoint: $0) }) { self.rpcFactory = rpcFactory }
    public func discard() { generation &+= 1; prepared = nil; signed = nil; validated = nil }

    public static func genesis(for network: WalletNetwork) throws -> String {
        switch network {
        case .ethereum: "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3"
        case .sepolia: "0x25a5cc106eea7138acab33231d7160d69cb777ee0c2c553fcddf5138993e6dd9"
        default: throw WalletFailure.unconfiguredNetwork
        }
    }

    private func verify(_ network: WalletNetwork, rpc: JSONRPC) async throws {
        guard let expected = network.chainID else { throw WalletFailure.networkMismatch }
        let chainID = try JSONRPC.quantity(await rpc.call("eth_chainId"))
        let block = try await rpc.call("eth_getBlockByNumber", ["0x0", false]) as? [String: Any]
        guard chainID == BigUInt(expected), let hash = block?["hash"] as? String,
              hash.lowercased() == (try Self.genesis(for: network)) else { throw WalletFailure.networkMismatch }
    }

    public func balance(account: AccountRecord, network: WalletNetwork, endpoint: URL) async throws -> BalanceSnapshot {
        let rpc = rpcFactory(endpoint)
        try await verify(network, rpc: rpc)
        let amount = try JSONRPC.quantity(await rpc.call("eth_getBalance", [account.evmAddress, "latest"]))
        let height = try JSONRPC.quantity(await rpc.call("eth_blockNumber"))
        guard let height = UInt64(exactly: height) else { throw WalletFailure.invalidResponse }
        return BalanceSnapshot(network: network, formatted: AtomicAmount.format(amount, decimals: 18), height: height, checkedAt: Date())
    }

    public func prepare(account: AccountRecord, network: WalletNetwork, endpoint: URL, to: String, amount: String) async throws -> TransferReview {
        prepared = nil; signed = nil; validated = nil
        let marker = generation
        guard let recipient = EthereumAddress(to), recipient.address.lowercased() != "0x0000000000000000000000000000000000000000" else { throw WalletFailure.invalidAddress }
        // Mixed-case input must be checksummed; all-lower/all-upper addresses remain valid standard input.
        let body = String(to.dropFirst(2))
        if body != body.lowercased() && body != body.uppercased(), recipient.address != to { throw WalletFailure.invalidAddress }
        let value = try AtomicAmount.parse(amount, decimals: 18)
        let rpc = rpcFactory(endpoint)
        try await verify(network, rpc: rpc)
        guard try await rpc.call("eth_getCode", [recipient.address, "latest"]) as? String == "0x" else { throw WalletFailure.unsupportedTransaction }
        let nonce = try JSONRPC.quantity(await rpc.call("eth_getTransactionCount", [account.evmAddress, "pending"]))
        let balance = try JSONRPC.quantity(await rpc.call("eth_getBalance", [account.evmAddress, "pending"]))
        let latest = try await rpc.call("eth_getBlockByNumber", ["latest", false]) as? [String: Any]
        let base = try JSONRPC.quantity(latest?["baseFeePerGas"] as Any)
        let priority = try JSONRPC.quantity(await rpc.call("eth_maxPriorityFeePerGas"))
        let maxFee = base * 2 + priority
        guard priority > 0, maxFee > 0, maxFee <= BigUInt(100_000_000_000) else { throw WalletFailure.unsupportedTransaction }
        let gas = try JSONRPC.quantity(await rpc.call("eth_estimateGas", [["from": account.evmAddress, "to": recipient.address, "value": JSONRPC.hex(value)]]))
        guard gas >= 21000, gas <= 100000 else { throw WalletFailure.unsupportedTransaction }
        guard balance >= value + gas * maxFee else { throw WalletFailure.insufficientFunds }
        let review = TransferReview(id: UUID(), network: network, from: account.evmAddress, to: recipient.address,
            amount: AtomicAmount.format(value, decimals: 18), fee: AtomicAmount.format(gas * maxFee, decimals: 18),
            total: AtomicAmount.format(value + gas * maxFee, decimals: 18), expiresAt: Date().addingTimeInterval(120),
            explanation: "显示最高网络费用，实际费用由区块确认。仅普通原生币转账；节点能看到地址及 IP。链 ID \(network.chainID ?? 0)。")
        guard marker == generation, !Task.isCancelled else { throw WalletFailure.staleReview }
        prepared = Prepared(review: review, endpoint: endpoint, nonce: nonce, amount: value, gas: gas, maxFee: maxFee, priority: priority)
        return review
    }

    public func validateBeforeSigning(review: TransferReview, account: AccountRecord, endpoint: URL) async throws {
        validated = nil
        guard account.backupConfirmed else { throw WalletFailure.backupRequired }
        let marker = generation
        guard let item = prepared, Self.sameReview(item.review, review),
              item.endpoint == endpoint, item.review.expiresAt > Date(), item.review.from.lowercased() == account.evmAddress.lowercased() else { throw WalletFailure.staleReview }
        let rpc = rpcFactory(endpoint)
        try await verify(item.review.network, rpc: rpc)
        let nonce = try JSONRPC.quantity(await rpc.call("eth_getTransactionCount", [account.evmAddress, "pending"]))
        let balance = try JSONRPC.quantity(await rpc.call("eth_getBalance", [account.evmAddress, "pending"]))
        let latest = try await rpc.call("eth_getBlockByNumber", ["latest", false]) as? [String: Any]
        let base = try JSONRPC.quantity(latest?["baseFeePerGas"] as Any)
        guard nonce == item.nonce, base + item.priority <= item.maxFee,
              balance >= item.amount + item.gas * item.maxFee else { throw WalletFailure.staleReview }
        guard try await rpc.call("eth_getCode", [item.review.to, "latest"]) as? String == "0x",
              marker == generation, item.review.expiresAt > Date(), !Task.isCancelled else { throw WalletFailure.staleReview }
        validated = (item.review.id, Date())
    }

    public func sign(review: TransferReview, words: String, account: AccountRecord, endpoint: URL) throws -> SignedEVMTransfer {
        guard let item = prepared, let permit = validated, permit.id == review.id,
              Date().timeIntervalSince(permit.at) <= 30, Self.sameReview(item.review, review),
              item.endpoint == endpoint, item.review.expiresAt > Date(), account.backupConfirmed,
              item.review.from.lowercased() == account.evmAddress.lowercased() else { throw WalletFailure.staleReview }
        prepared = nil; validated = nil // Offline and one-shot; no network call holds recovery words.
        var key = try WalletCryptography.evmKey(words: words)
        defer { key.resetBytes(in: key.indices) }
        guard try WalletCryptography.evmAddress(words: words).lowercased() == item.review.from.lowercased(),
              let recipient = EthereumAddress(item.review.to), let chain = item.review.network.chainID else { throw WalletFailure.corruptStorage }
        var tx = CodableTransaction(type: .eip1559, to: recipient, nonce: item.nonce, chainID: BigUInt(chain), value: item.amount,
            gasLimit: item.gas, maxFeePerGas: item.maxFee, maxPriorityFeePerGas: item.priority)
        try tx.sign(privateKey: key)
        guard let raw = tx.encode(), let hash = tx.hash, tx.sender?.address.lowercased() == account.evmAddress.lowercased() else { throw WalletFailure.corruptStorage }
        let result = SignedEVMTransfer(rawHex: "0x" + raw.toHexString(), hash: "0x" + hash.toHexString(), review: item.review)
        signed = (result, endpoint)
        return result
    }

    public func broadcast(signed: SignedEVMTransfer, endpoint: URL) async throws -> TransferRecord {
        guard let pending = self.signed, pending.0.hash == signed.hash, pending.0.rawHex == signed.rawHex,
              pending.1 == endpoint else { throw WalletFailure.staleReview }
        self.signed = nil
        return try await broadcastRaw(raw: signed.rawHex, hash: signed.hash, review: signed.review, endpoint: endpoint)
    }

    private func broadcastRaw(raw: String, hash: String, review: TransferReview, endpoint: URL) async throws -> TransferRecord {
        let marker = generation
        let rpc = rpcFactory(endpoint)
        try await verify(review.network, rpc: rpc)
        guard marker == generation, !Task.isCancelled else { throw WalletFailure.staleReview }
        do {
            guard let returned = try await rpc.call("eth_sendRawTransaction", [raw]) as? String,
                  returned.lowercased() == hash.lowercased() else { throw WalletFailure.broadcastUncertain }
            return TransferRecord(network: review.network, hash: hash, to: review.to,
                amount: review.amount, submittedAt: Date(), status: .submitted, rawTransaction: raw)
        } catch { throw WalletFailure.broadcastUncertain }
    }


    public func rebroadcast(record: TransferRecord, account: AccountRecord, endpoint: URL) async throws -> TransferRecord {
        guard !record.network.isBitcoin, [.signed, .unknown, .submitted].contains(record.status),
              let raw = record.rawTransaction, raw.hasPrefix("0x"), raw.count <= 4096,
              let data = Data.fromHex(raw), let tx = CodableTransaction(rawValue: data),
              tx.type == .eip1559, tx.chainID == record.network.chainID.map(BigUInt.init),
              tx.sender?.address.lowercased() == account.evmAddress.lowercased(),
              tx.to.address.lowercased() == record.to.lowercased(),
              tx.value == (try AtomicAmount.parse(record.amount, decimals: 18)),
              tx.data.isEmpty, let hash = tx.hash,
              ("0x" + hash.toHexString()).lowercased() == record.hash.lowercased() else { throw WalletFailure.corruptStorage }
        let review = TransferReview(id: UUID(), network: record.network, from: account.evmAddress, to: record.to,
            amount: record.amount, fee: AtomicAmount.format(tx.gasLimit * (tx.maxFeePerGas ?? 0), decimals: 18),
            total: "", expiresAt: Date(), explanation: "仅重新广播同一笔已签名交易。")
        return try await broadcastRaw(raw: raw, hash: record.hash, review: review, endpoint: endpoint)
    }

    public func status(_ record: TransferRecord, endpoint: URL) async throws -> TransferRecord.Status {
        let rpc = rpcFactory(endpoint)
        try await verify(record.network, rpc: rpc)
        let result = try await rpc.call("eth_getTransactionReceipt", [record.hash])
        guard let receipt = result as? [String: Any] else { return record.status == .signed ? .signed : record.status == .unknown ? .unknown : .submitted }
        let status = try JSONRPC.quantity(receipt["status"] as Any)
        let height = try JSONRPC.quantity(receipt["blockNumber"] as Any)
        let latest = try JSONRPC.quantity(await rpc.call("eth_blockNumber"))
        guard latest >= height + 11 else { return .submitted }
        return status == 1 ? .confirmed : .failed
    }
    private static func sameReview(_ lhs: TransferReview, _ rhs: TransferReview) -> Bool {
        lhs.id == rhs.id && lhs.network == rhs.network && lhs.from == rhs.from && lhs.to == rhs.to
            && lhs.amount == rhs.amount && lhs.fee == rhs.fee && lhs.total == rhs.total && lhs.expiresAt == rhs.expiresAt
    }

}
