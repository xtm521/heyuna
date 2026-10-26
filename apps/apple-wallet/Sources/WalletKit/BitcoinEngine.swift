import BitcoinDevKit
import Foundation

public struct SignedBitcoinTransfer: Sendable {
    public let rawHex: String
    public let hash: String
    public let review: TransferReview
}

/// Native SegWit only. Chain data is supplied by the selected Esplora service;
/// the service remains a trust and privacy boundary, rather than an SPV proof.
public actor BitcoinEngine {
    private struct Prepared: Sendable {
        let review: TransferReview
        let accountID: UUID
        let descriptors: DescriptorPair
        let endpoint: URL
        let psbt: String
        let inputs: [LocalOutput]
        var validatedAt: Date?
    }

    private let transport: BitcoinTransport
    private var prepared: Prepared?
    private var signed: (transfer: SignedBitcoinTransfer, endpoint: URL)?
    private var busy = false
    private var generation: UInt64 = 0
    private var cancelWork: (@Sendable () -> Void)?
    static let maximumFeeSats: UInt64 = 100_000
    static let maximumRateSatsPerVByte: UInt64 = 500

    public init() { transport = .live }
    // Internal dependency injection for URL loading fixtures; not exposed to the app.
    init(protocolClasses: [AnyClass]) { transport = BitcoinTransport(protocolClasses: protocolClasses) }

    public nonisolated static func deriveAccount(words: String, network: WalletNetwork) throws -> (address: String, descriptors: DescriptorPair) {
        guard network.isBitcoin else { throw WalletFailure.networkMismatch }
        let mnemonic: Mnemonic
        do { mnemonic = try Mnemonic.fromString(mnemonic: words) }
        catch { throw WalletFailure.invalidMnemonic }
        let kind: NetworkKind = network == .bitcoin ? .main : .test
        let key = DescriptorSecretKey(networkKind: kind, mnemonic: mnemonic, password: nil)
        let external = Descriptor.newBip84(secretKey: key, keychainKind: .external, networkKind: kind)
        let internalDescriptor = Descriptor.newBip84(secretKey: key, keychainKind: .internal, networkKind: kind)
        let pair = DescriptorPair(external: external.asPublic().description, internalDescriptor: internalDescriptor.asPublic().description)
        let wallet = try watchWallet(descriptors: pair, network: network)
        return (wallet.peekAddress(keychain: .external, index: 0).address.description, pair)
    }

    public func balance(account: AccountRecord, network: WalletNetwork, endpoint: URL) async throws -> BalanceSnapshot {
        try begin()
        defer { busy = false }
        let marker = generation
        let transport = transport
        let pair = try Self.descriptors(account: account, network: network)
        let endpoint = try Self.checkedEndpoint(endpoint)
        let result = try await runWork {
            let scan = try await Self.scan(descriptors: pair, network: network, endpoint: endpoint, transport: transport)
            return BalanceSnapshot(network: network, formatted: Self.format(sats: scan.total), height: UInt64(scan.height), checkedAt: Date())
        }
        guard marker == generation, !Task.isCancelled else { throw WalletFailure.staleReview }
        return result
    }

    public func prepare(account: AccountRecord, network: WalletNetwork, endpoint: URL, to: String, amount: String) async throws -> TransferReview {
        try begin()
        defer { busy = false }
        prepared = nil
        signed = nil
        let marker = generation
        let transport = transport
        let pair = try Self.descriptors(account: account, network: network)
        let endpoint = try Self.checkedEndpoint(endpoint)
        let sats = try Self.parseSats(amount)
        let result = try await runWork {
            let recipient: Address
            do { recipient = try Address(address: to, network: Self.bdkNetwork(network)) }
            catch { throw WalletFailure.invalidAddress }
            let scan = try await Self.scan(descriptors: pair, network: network, endpoint: endpoint, transport: transport)
            let wallet = scan.wallet
            let confirmed = scan.total
            guard sats < confirmed else { throw WalletFailure.insufficientFunds }
            let estimates: [UInt16: Double]
            do { estimates = try await scan.client.feeEstimates() }
            catch { throw WalletFailure.serviceUnavailable }
            guard let estimate = estimates[6] ?? estimates[3] ?? estimates[1],
                  estimate.isFinite, estimate > 0, estimate <= Double(Self.maximumRateSatsPerVByte) else {
                throw WalletFailure.invalidResponse
            }
            let rate = UInt64(ceil(estimate))
            let psbt: Psbt
            do {
                psbt = try TxBuilder()
                    .addUtxos(outpoints: scan.outputs.map { $0.outpoint })
                    .manuallySelectedOnly()
                    .addRecipient(script: recipient.scriptPubkey(), amount: .fromSat(satoshi: sats))
                    .feeRate(feeRate: .fromSatPerVb(satVb: rate))
                    .finish(wallet: wallet)
            } catch { throw WalletFailure.insufficientFunds }
            let fee = try psbt.fee()
            let total = sats.addingReportingOverflow(fee)
            guard fee <= Self.maximumFeeSats, !total.overflow, total.partialValue <= confirmed else {
                throw WalletFailure.insufficientFunds
            }
            // The unsigned transaction is decoded without relaxing the final extraction checks.
            let inputIDs = Set(try psbt.extractTx().input().map { Self.outpointID($0.previousOutput) })
            let inputs = scan.outputs.filter { inputIDs.contains(Self.outpointID($0.outpoint)) }
            guard inputs.count == inputIDs.count, !inputs.isEmpty else { throw WalletFailure.invalidResponse }
            let review = TransferReview(id: UUID(), network: network, from: account.address(for: network), to: recipient.description,
                amount: Self.format(sats: sats), fee: Self.format(sats: fee), total: Self.format(sats: total.partialValue),
                expiresAt: Date().addingTimeInterval(120),
                explanation: "仅使用节点报告至少 6 次确认的 UTXO；费用上限 0.001 BTC。双分支各限 200 个地址，连续 20 个空地址后停止；此版本信任所选节点，尚不验证区块工作量证明。")
            return Prepared(review: review, accountID: account.id, descriptors: pair, endpoint: endpoint, psbt: psbt.serialize(), inputs: inputs, validatedAt: nil)
        }
        guard marker == generation, !Task.isCancelled else { throw WalletFailure.staleReview }
        prepared = result
        return result.review
    }

    /// Public-only revalidation must finish before the calling app reads the mnemonic.
    /// A successful check grants a short-lived, single-use offline signing permit.
    public func validateBeforeSigning(review: TransferReview, account: AccountRecord, endpoint: URL) async throws {
        try begin()
        defer { busy = false }
        guard var candidate = prepared else { throw WalletFailure.staleReview }
        prepared = nil
        let marker = generation
        let transport = transport
        let endpoint = try Self.checkedEndpoint(endpoint)
        guard candidate.accountID == account.id, candidate.endpoint == endpoint,
              Self.sameReview(candidate.review, review), review.expiresAt > Date(),
              candidate.descriptors == (try Self.descriptors(account: account, network: review.network)) else { throw WalletFailure.staleReview }
        let descriptors = candidate.descriptors
        let fresh = try await runWork { try await Self.scan(descriptors: descriptors, network: review.network, endpoint: endpoint, transport: transport) }
        let current = Dictionary(uniqueKeysWithValues: fresh.outputs.map { (Self.outpointID($0.outpoint), $0) })
        for old in candidate.inputs {
            guard let now = current[Self.outpointID(old.outpoint)], !now.isSpent,
                  now.txout.value.toSat() == old.txout.value.toSat(),
                  now.txout.scriptPubkey.toBytes() == old.txout.scriptPubkey.toBytes() else { throw WalletFailure.staleReview }
        }
        guard marker == generation, !Task.isCancelled, review.expiresAt > Date() else { throw WalletFailure.staleReview }
        candidate.validatedAt = Date()
        prepared = candidate
    }

    /// Persist the returned hash and bytes as `signed` before attempting broadcast;
    /// retain `unknown` when the network outcome cannot be determined.
    /// No phrase, seed, secret descriptor, or signer wallet is retained by this actor.
    public func sign(review: TransferReview, words: String, account: AccountRecord, endpoint: URL) async throws -> SignedBitcoinTransfer {
        try begin()
        defer { busy = false }
        guard account.backupConfirmed else { throw WalletFailure.backupRequired }
        guard let candidate = prepared else { throw WalletFailure.staleReview }
        prepared = nil // One signing attempt per review, including failed attempts.
        let marker = generation
        let endpoint = try Self.checkedEndpoint(endpoint)
        guard candidate.accountID == account.id, candidate.endpoint == endpoint,
              Self.sameReview(candidate.review, review), review.expiresAt > Date(),
              let validatedAt = candidate.validatedAt, Date().timeIntervalSince(validatedAt) <= 30,
              candidate.descriptors == (try Self.descriptors(account: account, network: review.network)) else {
            throw WalletFailure.staleReview
        }
        let result = try await runWork {
            let derived = try Self.deriveAccount(words: words, network: review.network)
            guard derived.descriptors == candidate.descriptors,
                  derived.address == account.address(for: review.network) else { throw WalletFailure.invalidMnemonic }
            guard review.expiresAt > Date() else { throw WalletFailure.staleReview }
            let mnemonic = try Mnemonic.fromString(mnemonic: words)
            let kind: NetworkKind = review.network == .bitcoin ? .main : .test
            let key = DescriptorSecretKey(networkKind: kind, mnemonic: mnemonic, password: nil)
            let secretWallet = try Wallet(
                descriptor: .newBip84(secretKey: key, keychainKind: .external, networkKind: kind),
                changeDescriptor: .newBip84(secretKey: key, keychainKind: .internal, networkKind: kind),
                network: Self.bdkNetwork(review.network), persister: .newInMemory())
            let psbt = try Psbt(psbtBase64: candidate.psbt)
            let reviewedFee = try Self.parseSats(review.fee)
            guard try psbt.fee() == reviewedFee,
                  try secretWallet.sign(psbt: psbt) else { throw WalletFailure.invalidResponse }
            let tx = try psbt.extractTxWithFeeRateLimit(maxFeeRate: .fromSatPerVb(satVb: Self.maximumRateSatsPerVByte))
            return SignedBitcoinTransfer(rawHex: Self.hex(tx.serialize()), hash: tx.computeTxid().description, review: review)
        }
        guard marker == generation, !Task.isCancelled else { throw WalletFailure.staleReview }
        signed = (result, endpoint)
        return result
    }

    public func broadcast(signed transfer: SignedBitcoinTransfer, endpoint: URL) async throws -> TransferRecord {
        try begin()
        defer { busy = false }
        let endpoint = try Self.checkedEndpoint(endpoint)
        guard let pending = signed, pending.endpoint == endpoint,
              pending.transfer.hash == transfer.hash, pending.transfer.rawHex == transfer.rawHex,
              Self.sameReview(pending.transfer.review, transfer.review) else { throw WalletFailure.staleReview }
        signed = nil // Never automatically retry a possibly accepted broadcast.
        let marker = generation
        let transport = transport
        // Re-check identity before the signed transaction leaves the device.
        let result = try await runWork {
            let client = SafeEsplora(endpoint: endpoint, transport: transport)
            try await client.verifyIdentity(network: transfer.review.network)
            try Task.checkCancellation()
            return try await Self.performBroadcast(raw: transfer.rawHex, hash: transfer.hash, network: transfer.review.network,
                to: transfer.review.to, amount: transfer.review.amount, client: client)
        }
        guard marker == generation, !Task.isCancelled else { throw WalletFailure.broadcastUncertain }
        return result
    }

    /// Retry the exact signed bytes. Never re-select inputs or create another signature.
    /// The calling app must require local authentication and preserve uncertainty on error.
    public func rebroadcast(record: TransferRecord, account: AccountRecord, endpoint: URL) async throws -> TransferRecord {
        try begin()
        defer { busy = false }
        guard [.signed, .unknown, .submitted].contains(record.status), record.network.isBitcoin,
              Self.validHash(record.hash), let raw = record.rawTransaction, raw.utf8.count <= 2_100_000,
              let bytes = Self.unhex(raw) else { throw WalletFailure.invalidResponse }
        let marker = generation
        let transport = transport
        let pair = try Self.descriptors(account: account, network: record.network)
        let endpoint = try Self.checkedEndpoint(endpoint)
        let result = try await runWork {
            let client = SafeEsplora(endpoint: endpoint, transport: transport)
            try await client.verifyIdentity(network: record.network)
            let tx: Transaction
            do { tx = try Transaction(transactionBytes: bytes) }
            catch { throw WalletFailure.invalidResponse }
            guard tx.computeTxid().description == record.hash, !tx.isCoinbase(),
                  !tx.input().isEmpty, tx.input().count <= 100, tx.output().count <= 2 else { throw WalletFailure.invalidResponse }
            let recipient: Address
            do { recipient = try Address(address: record.to, network: Self.bdkNetwork(record.network)) }
            catch { throw WalletFailure.invalidAddress }
            let amount = try Self.parseSats(record.amount)
            let watch = try Self.watchWallet(descriptors: pair, network: record.network)
            var owned = Set<Data>()
            var change = Set<Data>()
            for index in 0..<UInt32(200) {
                owned.insert(watch.peekAddress(keychain: .external, index: index).address.scriptPubkey().toBytes())
                let script = watch.peekAddress(keychain: .internal, index: index).address.scriptPubkey().toBytes()
                owned.insert(script)
                change.insert(script)
            }
            var paid: UInt64 = 0
            var outputTotal: UInt64 = 0
            var recipientCount = 0
            for output in tx.output() {
                let value = output.value.toSat()
                let script = output.scriptPubkey.toBytes()
                if script == recipient.scriptPubkey().toBytes() {
                    paid = try Self.add(paid, value)
                    recipientCount += 1
                } else if !change.contains(script) { throw WalletFailure.unsupportedTransaction }
                outputTotal = try Self.add(outputTotal, value)
            }
            guard paid == amount, recipientCount == 1 else { throw WalletFailure.invalidResponse }
            var inputTotal: UInt64 = 0
            var seen = Set<String>()
            for input in tx.input() {
                guard input.witness.count == 2, input.witness[0].last == 1,
                      input.witness[1].count == 33, [2, 3].contains(input.witness[1].first ?? 0),
                      input.scriptSig.toBytes().isEmpty, seen.insert(Self.outpointID(input.previousOutput)).inserted else {
                    throw WalletFailure.unsupportedTransaction
                }
                let parentHash = input.previousOutput.txid.description
                guard Self.validHash(parentHash) else { throw WalletFailure.invalidResponse }
                let encoded = try await client.get(path: "tx/\(parentHash)/hex", maximumBytes: 2_100_000)
                guard let text = String(data: encoded, encoding: .utf8),
                      let parentBytes = Self.unhex(text.trimmingCharacters(in: .whitespacesAndNewlines)) else { throw WalletFailure.invalidResponse }
                let parent: Transaction
                do { parent = try Transaction(transactionBytes: parentBytes) }
                catch { throw WalletFailure.invalidResponse }
                let outputs = parent.output()
                guard parent.computeTxid().description == parentHash, Int(input.previousOutput.vout) < outputs.count else {
                    throw WalletFailure.invalidResponse
                }
                let previous = outputs[Int(input.previousOutput.vout)]
                guard owned.contains(previous.scriptPubkey.toBytes()) else { throw WalletFailure.invalidResponse }
                inputTotal = try Self.add(inputTotal, previous.value.toSat())
            }
            guard inputTotal >= outputTotal else { throw WalletFailure.invalidResponse }
            let fee = inputTotal - outputTotal
            guard fee <= Self.maximumFeeSats, tx.vsize() > 0,
                  fee / tx.vsize() <= Self.maximumRateSatsPerVByte,
                  fee % tx.vsize() == 0 || fee / tx.vsize() < Self.maximumRateSatsPerVByte else { throw WalletFailure.invalidResponse }
            try Task.checkCancellation()
            return try await Self.performBroadcast(raw: raw, hash: record.hash, network: record.network, to: record.to, amount: record.amount, client: client)
        }
        guard marker == generation, !Task.isCancelled else { throw WalletFailure.broadcastUncertain }
        return result
    }

    private nonisolated static func performBroadcast(raw: String, hash: String, network: WalletNetwork, to: String, amount: String, client: SafeEsplora) async throws -> TransferRecord {
        do {
            let data = try await client.postTransaction(raw)
            guard String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == hash else {
                throw WalletFailure.broadcastUncertain
            }
            return TransferRecord(network: network, hash: hash, to: to, amount: amount, submittedAt: Date(), status: .submitted, rawTransaction: raw)
        } catch { throw WalletFailure.broadcastUncertain }
    }

    private nonisolated static func add(_ lhs: UInt64, _ rhs: UInt64) throws -> UInt64 {
        let sum = lhs.addingReportingOverflow(rhs)
        guard !sum.overflow, sum.partialValue <= 2_100_000_000_000_000 else { throw WalletFailure.invalidResponse }
        return sum.partialValue
    }

    public func discard() {
        cancelWork?()
        cancelWork = nil
        generation &+= 1
        prepared = nil
        signed = nil
    }

    private func runWork<Value: Sendable>(_ operation: @escaping @Sendable () async throws -> Value) async throws -> Value {
        let task = Task.detached(priority: .userInitiated, operation: operation)
        cancelWork = { task.cancel() }
        defer { cancelWork = nil }
        return try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
    }

    private func begin() throws {
        guard !busy else { throw WalletFailure.operationInProgress }
        busy = true
    }

    private nonisolated static func descriptors(account: AccountRecord, network: WalletNetwork) throws -> DescriptorPair {
        guard network.isBitcoin, let pair = account.descriptors[network.id], !account.address(for: network).isEmpty else {
            throw WalletFailure.missingWallet
        }
        return pair
    }

    private nonisolated static func bdkNetwork(_ network: WalletNetwork) -> Network { network == .bitcoin ? .bitcoin : .signet }

    private nonisolated static func watchWallet(descriptors: DescriptorPair, network: WalletNetwork) throws -> Wallet {
        guard network.isBitcoin else { throw WalletFailure.networkMismatch }
        let kind: NetworkKind = network == .bitcoin ? .main : .test
        let external = try Descriptor(descriptor: descriptors.external, networkKind: kind)
        let internalDescriptor = try Descriptor(descriptor: descriptors.internalDescriptor, networkKind: kind)
        // A corrupt imported record must never smuggle private descriptors into persistence.
        guard external.asPublic().description == descriptors.external,
              internalDescriptor.asPublic().description == descriptors.internalDescriptor else { throw WalletFailure.corruptStorage }
        return try Wallet(descriptor: external, changeDescriptor: internalDescriptor, network: bdkNetwork(network), persister: .newInMemory())
    }

    private struct Scan: Sendable {
        let wallet: Wallet
        let client: SafeEsplora
        let outputs: [LocalOutput]
        let total: UInt64
        let height: UInt32
    }

    /// Bounded descriptor discovery. Only public descriptors enter the scanner.
    /// BDK does transaction parsing, descriptor ownership, PSBT construction and signing;
    /// our HTTP adapter enforces transport and resource limits on every read.
    private nonisolated static func scan(descriptors: DescriptorPair, network: WalletNetwork, endpoint: URL, transport: BitcoinTransport) async throws -> Scan {
        let client = SafeEsplora(endpoint: endpoint, transport: transport)
        try await client.verifyIdentity(network: network)
        let tip = try await client.height()
        let anchor = try await client.blockHash(height: tip)
        let wallet = try watchWallet(descriptors: descriptors, network: network)
        var selected: [OutPoint] = []
        var expected: [String: (value: UInt64, script: Data)] = [:]
        var transactions: [String: Transaction] = [:]
        var total: UInt64 = 0
        for keychain in [KeychainKind.external, .internal] {
            var gap = 0
            var finished = false
            for index in 0..<UInt32(200) {
                try Task.checkCancellation()
                let address = wallet.peekAddress(keychain: keychain, index: index).address
                let summary: AddressSummary = try await client.json(path: "address/\(address.description)")
                let used = summary.chainStats.txCount > 0 || summary.mempoolStats.txCount > 0
                if !used {
                    gap += 1
                    if gap == 20 { finished = true; break }
                    continue
                }
                gap = 0
                // Keep BDK's change branch index ahead of every used script we discover.
                _ = wallet.revealAddressesTo(keychain: keychain, index: index)
                let rows: [EsploraOutput] = try await client.json(path: "address/\(address.description)/utxo", maximumBytes: 100_000)
                guard rows.count <= 100 else { throw WalletFailure.invalidResponse }
                for row in rows {
                    guard row.status.confirmed else { continue }
                    guard let height = row.status.blockHeight, let blockHash = row.status.blockHash,
                          height <= tip, Self.validHash(row.txid), Self.validHash(blockHash),
                          row.value > 0, row.value <= 2_100_000_000_000_000 else { throw WalletFailure.invalidResponse }
                    guard UInt64(tip) - UInt64(height) + 1 >= 6 else { continue }
                    guard try await client.blockHash(height: height) == blockHash else { throw WalletFailure.invalidResponse }
                    let raw: Transaction
                    if let cached = transactions[row.txid] { raw = cached }
                    else {
                        guard transactions.count < 100 else { throw WalletFailure.invalidResponse }
                        let data = try await client.get(path: "tx/\(row.txid)/hex", maximumBytes: 2_100_000)
                        guard let encoded = String(data: data, encoding: .utf8), let bytes = Self.unhex(encoded.trimmingCharacters(in: .whitespacesAndNewlines)) else {
                            throw WalletFailure.invalidResponse
                        }
                        do { raw = try Transaction(transactionBytes: bytes) }
                        catch { throw WalletFailure.invalidResponse }
                        guard raw.computeTxid().description == row.txid else { throw WalletFailure.invalidResponse }
                        transactions[row.txid] = raw
                    }
                    if raw.isCoinbase(), UInt64(tip) - UInt64(height) + 1 < 100 { continue }
                    let outputs = raw.output()
                    guard UInt64(row.vout) < UInt64(outputs.count),
                          outputs[Int(row.vout)].value.toSat() == row.value,
                          outputs[Int(row.vout)].scriptPubkey.toBytes() == address.scriptPubkey().toBytes() else {
                        throw WalletFailure.invalidResponse
                    }
                    let outpoint = OutPoint(txid: raw.computeTxid(), vout: row.vout)
                    let identifier = Self.outpointID(outpoint)
                    guard expected[identifier] == nil, selected.count < 100 else { throw WalletFailure.invalidResponse }
                    let sum = total.addingReportingOverflow(row.value)
                    guard !sum.overflow, sum.partialValue <= 2_100_000_000_000_000 else { throw WalletFailure.invalidResponse }
                    total = sum.partialValue
                    selected.append(outpoint)
                    expected[identifier] = (row.value, address.scriptPubkey().toBytes())
                }
            }
            // Never present a truncated recovery scan as a complete account balance.
            guard finished else { throw WalletFailure.invalidResponse }
        }
        guard try await client.blockHash(height: tip) == anchor else { throw WalletFailure.staleReview }
        wallet.applyUnconfirmedTxs(unconfirmedTxs: transactions.values.map { UnconfirmedTx(tx: $0, lastSeen: UInt64(Date().timeIntervalSince1970)) })
        // BDK has no public API for constructing a chain Update from our HTTP transport.
        // We deliberately leave its internal chain position unconfirmed; only the explicit,
        // independently cross-checked Esplora UTXO allowlist below is spendable by our builder.
        let locals = Dictionary(uniqueKeysWithValues: wallet.listUnspent().map { (Self.outpointID($0.outpoint), $0) })
        let outputs = try selected.map { outpoint -> LocalOutput in
            let identifier = Self.outpointID(outpoint)
            guard let local = locals[identifier], let row = expected[identifier],
                  local.txout.value.toSat() == row.value, local.txout.scriptPubkey.toBytes() == row.script else {
                throw WalletFailure.invalidResponse
            }
            return local
        }
        return Scan(wallet: wallet, client: client, outputs: outputs, total: total, height: tip)
    }

    public func status(_ record: TransferRecord, endpoint: URL) async throws -> TransferRecord.Status {
        try begin()
        defer { busy = false }
        guard record.network.isBitcoin, Self.validHash(record.hash) else { throw WalletFailure.invalidResponse }
        let client = SafeEsplora(endpoint: try Self.checkedEndpoint(endpoint), transport: transport)
        try await client.verifyIdentity(network: record.network)
        let state: EsploraStatus
        do { state = try await client.json(path: "tx/\(record.hash)/status") }
        catch SafeEsploraFailure.notFound { return record.status == .signed ? .signed : .unknown }
        guard state.confirmed else { return .submitted }
        guard let height = state.blockHeight, let hash = state.blockHash, Self.validHash(hash) else { throw WalletFailure.invalidResponse }
        let tip = try await client.height()
        guard height <= tip, try await client.blockHash(height: height) == hash else { return .unknown }
        return UInt64(tip) - UInt64(height) + 1 >= 6 ? .confirmed : .submitted
    }

    public func status(record: TransferRecord, endpoint: URL) async throws -> TransferRecord.Status { try await status(record, endpoint: endpoint) }

    private nonisolated static func validHash(_ text: String) -> Bool {
        text.utf8.count == 64 && text.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    private nonisolated static func unhex(_ text: String) -> Data? {
        guard text.utf8.count.isMultiple(of: 2), text.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) || (65...70).contains($0) }) else { return nil }
        var result = Data(capacity: text.utf8.count / 2)
        var index = text.startIndex
        while index < text.endIndex {
            let next = text.index(index, offsetBy: 2)
            guard let byte = UInt8(text[index..<next], radix: 16) else { return nil }
            result.append(byte)
            index = next
        }
        return result
    }

    static func checkedEndpoint(_ endpoint: URL) throws -> URL {
        guard let parts = URLComponents(url: endpoint, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == "https", parts.host?.isEmpty == false,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil else {
            throw WalletFailure.invalidEndpoint
        }
        var text = endpoint.absoluteString
        while text.hasSuffix("/") { text.removeLast() }
        guard let normalized = URL(string: text) else { throw WalletFailure.invalidEndpoint }
        return normalized
    }

    static func parseSats(_ text: String) throws -> UInt64 {
        let pieces = text.split(separator: ".", omittingEmptySubsequences: false)
        guard pieces.count <= 2, let first = pieces.first, !first.isEmpty,
              first.utf8.allSatisfy({ (48...57).contains($0) }), let whole = UInt64(first) else { throw WalletFailure.invalidAmount }
        let fraction = pieces.count == 2 ? pieces[1] : ""
        guard fraction.count <= 8, fraction.utf8.allSatisfy({ (48...57).contains($0) }),
              pieces.count == 1 || !fraction.isEmpty else { throw WalletFailure.invalidAmount }
        let integral = whole.multipliedReportingOverflow(by: 100_000_000)
        let padded = String(fraction) + String(repeating: "0", count: 8 - fraction.count)
        guard let fractional = UInt64(padded), !integral.overflow else { throw WalletFailure.invalidAmount }
        let result = integral.partialValue.addingReportingOverflow(fractional)
        guard !result.overflow, result.partialValue > 0, result.partialValue <= 2_100_000_000_000_000 else { throw WalletFailure.invalidAmount }
        return result.partialValue
    }

    static func format(sats: UInt64) -> String {
        let whole = sats / 100_000_000
        var fraction = String(format: "%08llu", sats % 100_000_000)
        while fraction.hasSuffix("0") { fraction.removeLast() }
        return fraction.isEmpty ? String(whole) : "\(whole).\(fraction)"
    }

    private nonisolated static func outpointID(_ value: OutPoint) -> String { "\(value.txid):\(value.vout)" }
    private nonisolated static func hex(_ value: Data) -> String { value.map { String(format: "%02x", $0) }.joined() }
    private nonisolated static func sameReview(_ lhs: TransferReview, _ rhs: TransferReview) -> Bool {
        lhs.id == rhs.id && lhs.network == rhs.network && lhs.from == rhs.from && lhs.to == rhs.to
            && lhs.amount == rhs.amount && lhs.fee == rhs.fee && lhs.total == rhs.total && lhs.expiresAt == rhs.expiresAt
    }
}

private final class BitcoinRedirectGuard: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

private struct AddressSummary: Decodable, Sendable {
    struct Stats: Decodable, Sendable {
        let txCount: UInt64
        enum CodingKeys: String, CodingKey { case txCount = "tx_count" }
    }
    let chainStats: Stats
    let mempoolStats: Stats
    enum CodingKeys: String, CodingKey { case chainStats = "chain_stats", mempoolStats = "mempool_stats" }
}

private struct EsploraStatus: Decodable, Sendable {
    let confirmed: Bool
    let blockHeight: UInt32?
    let blockHash: String?
    enum CodingKeys: String, CodingKey { case confirmed, blockHeight = "block_height", blockHash = "block_hash" }
}

private struct EsploraOutput: Decodable, Sendable {
    let txid: String
    let vout: UInt32
    let value: UInt64
    let status: EsploraStatus
}

private enum SafeEsploraFailure: Error { case notFound }

/// Every operation has a 90s deadline, at most 1,200 requests, and bounded response bodies.
/// Redirects are rejected even when the destination would also use HTTPS.
private actor SafeEsplora {
    private let endpoint: URL
    private let session: URLSession
    private let deadline: Date
    private var requests = 0

    init(endpoint: URL, transport: BitcoinTransport) {
        self.endpoint = endpoint
        deadline = Date().addingTimeInterval(90)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = transport.protocolClasses ?? configuration.protocolClasses
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 90
        session = URLSession(configuration: configuration, delegate: BitcoinRedirectGuard(), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    func get(path: String, maximumBytes: Int = 16_384) async throws -> Data {
        try await request(path: path, method: "GET", body: nil, maximumBytes: maximumBytes)
    }

    func postTransaction(_ raw: String) async throws -> Data {
        try await request(path: "tx", method: "POST", body: Data(raw.utf8), maximumBytes: 128)
    }

    private func request(path: String, method: String, body: Data?, maximumBytes: Int) async throws -> Data {
        guard Date() < deadline, requests < 1_200 else { throw WalletFailure.serviceUnavailable }
        try Task.checkCancellation()
        requests += 1
        let url = endpoint.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        if body != nil { request.setValue("text/plain", forHTTPHeaderField: "Content-Type") }
        request.timeoutInterval = min(15, deadline.timeIntervalSinceNow)
        let stream: URLSession.AsyncBytes
        let response: URLResponse
        do { (stream, response) = try await session.bytes(for: request) }
        catch { throw WalletFailure.serviceUnavailable }
        guard let http = response as? HTTPURLResponse, http.url == url else { throw WalletFailure.invalidResponse }
        if http.statusCode == 404 { throw SafeEsploraFailure.notFound }
        guard http.statusCode == 200, http.expectedContentLength <= Int64(maximumBytes) else { throw WalletFailure.invalidResponse }
        var data = Data()
        do {
            for try await byte in stream {
                guard data.count < maximumBytes, Date() < deadline else { throw WalletFailure.invalidResponse }
                try Task.checkCancellation()
                data.append(byte)
            }
        } catch let failure as WalletFailure { throw failure }
        catch { throw WalletFailure.serviceUnavailable }
        return data
    }

    func json<Value: Decodable & Sendable>(path: String, maximumBytes: Int = 16_384) async throws -> Value {
        let data = try await get(path: path, maximumBytes: maximumBytes)
        do { return try JSONDecoder().decode(Value.self, from: data) }
        catch { throw WalletFailure.invalidResponse }
    }

    func verifyIdentity(network: WalletNetwork) async throws {
        guard network.isBitcoin else { throw WalletFailure.networkMismatch }
        let expected = network == .bitcoin
            ? "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"
            : "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6"
        guard try await blockHash(height: 0) == expected else { throw WalletFailure.networkMismatch }
    }

    func blockHash(height: UInt32) async throws -> String {
        // Re-read the scan anchor, rather than returning its earlier cached value.
        let data = try await get(path: "block-height/\(height)", maximumBytes: 128)
        guard let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              text.count == 64, text.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw WalletFailure.invalidResponse }
        return text
    }

    func height() async throws -> UInt32 {
        let data = try await get(path: "blocks/tip/height", maximumBytes: 64)
        guard let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), let height = UInt32(text) else {
            throw WalletFailure.invalidResponse
        }
        return height
    }

    func feeEstimates() async throws -> [UInt16: Double] {
        let values: [String: Double] = try await json(path: "fee-estimates")
        var result: [UInt16: Double] = [:]
        for (key, value) in values {
            guard let target = UInt16(key), value.isFinite, value >= 0 else { throw WalletFailure.invalidResponse }
            result[target] = value
        }
        return result
    }
}

// URLProtocol class references are immutable. No application data or mutable
// session configuration crosses executors through this test-only setting.
private struct BitcoinTransport: @unchecked Sendable {
    let protocolClasses: [AnyClass]?
    static let live = BitcoinTransport(protocolClasses: nil)
}
