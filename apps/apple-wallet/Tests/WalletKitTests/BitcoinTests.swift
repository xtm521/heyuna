import BitcoinDevKit
import Foundation
import XCTest
@testable import WalletKit

final class BitcoinTests: XCTestCase {
    // The BIP-39/BIP-84 published vector is public test material, never a wallet backup.
    private let vector = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

    func testBIP84OfficialAddressAndPublicOnlyDescriptors() throws {
        let result = try BitcoinEngine.deriveAccount(words: vector, network: .bitcoin)
        XCTAssertEqual(result.address, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu")
        XCTAssertTrue(result.descriptors.external.hasPrefix("wpkh("))
        XCTAssertTrue(result.descriptors.external.contains("xpub"))
        XCTAssertFalse(result.descriptors.external.contains("xprv"))
        XCTAssertFalse(result.descriptors.internalDescriptor.contains("xprv"))
        XCTAssertNotEqual(result.descriptors.external, result.descriptors.internalDescriptor)
        let signet = try BitcoinEngine.deriveAccount(words: vector, network: .bitcoinSignet)
        XCTAssertTrue(signet.address.hasPrefix("tb1q"))
        XCTAssertNotEqual(signet.address, result.address)
        XCTAssertTrue(signet.descriptors.external.contains("tpub"))
        XCTAssertFalse(signet.descriptors.external.contains("tprv"))
    }

    func testMnemonicAndRecipientNetworkChecks() throws {
        XCTAssertThrowsError(try BitcoinEngine.deriveAccount(words: "abandon invalid checksum", network: .bitcoin))
        XCTAssertThrowsError(try BitcoinEngine.deriveAccount(words: vector, network: .sepolia))
        XCTAssertThrowsError(try Address(address: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", network: .signet))
    }

    func testExactSatoshiAmountsRejectPrecisionOverflowAndAmbiguity() throws {
        XCTAssertEqual(try BitcoinEngine.parseSats("0.00000001"), 1)
        XCTAssertEqual(try BitcoinEngine.parseSats("1.23456789"), 123_456_789)
        XCTAssertEqual(try BitcoinEngine.parseSats("21000000"), 2_100_000_000_000_000)
        for invalid in ["0", "-1", "+1", "1e-8", " 1", "1 ", ".1", "1.", "0.000000001", "21000000.00000001", "18446744073709551615", "1,000", "NaN"] {
            XCTAssertThrowsError(try BitcoinEngine.parseSats(invalid), invalid)
        }
        for sats: UInt64 in [1, 99, 100_000_000, 123_456_789, 2_100_000_000_000_000] {
            XCTAssertEqual(try BitcoinEngine.parseSats(BitcoinEngine.format(sats: sats)), sats)
        }
    }

    func testEndpointRejectsInsecureTransportCredentialsAndQuery() throws {
        XCTAssertEqual(try BitcoinEngine.checkedEndpoint(URL(string: "https://node.example/api/")!).absoluteString, "https://node.example/api")
        for invalid in ["http://node.example/api", "https://user:password@node.example/api", "https://node.example/api?token=value", "https://node.example/api#fragment", "file:///tmp/node"] {
            XCTAssertThrowsError(try BitcoinEngine.checkedEndpoint(URL(string: invalid)!))
        }
    }

    func testOfflinePSBTBuildSignAndFinalizeDoesNotChangeReviewedOutputs() throws {
        let mnemonic = try Mnemonic.fromString(mnemonic: vector)
        let key = DescriptorSecretKey(networkKind: .test, mnemonic: mnemonic, password: nil)
        let wallet = try Wallet(
            descriptor: .newBip84(secretKey: key, keychainKind: .external, networkKind: .test),
            changeDescriptor: .newBip84(secretKey: key, keychainKind: .internal, networkKind: .test),
            network: .signet, persister: .newInMemory())
        let receive = wallet.revealNextAddress(keychain: .external).address
        let script = receive.scriptPubkey().toBytes()
        // This fabricated funding transaction is never submitted to any network.
        var funding = Data([2, 0, 0, 0, 1])
        funding.append(Data(repeating: 0x11, count: 32))
        funding.append(contentsOf: [0, 0, 0, 0, 0, 255, 255, 255, 255, 1])
        funding.append(contentsOf: [160, 134, 1, 0, 0, 0, 0, 0, UInt8(script.count)])
        funding.append(script)
        funding.append(contentsOf: [0, 0, 0, 0])
        wallet.applyUnconfirmedTxs(unconfirmedTxs: [UnconfirmedTx(tx: try Transaction(transactionBytes: funding), lastSeen: 1_700_000_000)])
        let recipient = wallet.peekAddress(keychain: .external, index: 1).address
        let psbt = try TxBuilder().addRecipient(script: recipient.scriptPubkey(), amount: .fromSat(satoshi: 50_000))
            .feeRate(feeRate: .fromSatPerVb(satVb: 2)).finish(wallet: wallet)
        let before = try psbt.extractTx()
        let hash = before.computeTxid().description
        let outputs = before.output().map { ($0.value.toSat(), $0.scriptPubkey.toBytes()) }
        XCTAssertEqual(outputs.filter { $0.0 == 50_000 && $0.1 == recipient.scriptPubkey().toBytes() }.count, 1)
        XCTAssertEqual(outputs.reduce(0) { $0 + $1.0 } + (try psbt.fee()), 100_000)
        XCTAssertTrue(try wallet.sign(psbt: psbt))
        let after = try psbt.extractTxWithFeeRateLimit(maxFeeRate: .fromSatPerVb(satVb: 500))
        XCTAssertEqual(after.computeTxid().description, hash)
        XCTAssertEqual(after.input()[0].witness.count, 2)
        XCTAssertEqual(after.output().map { $0.value.toSat() }, outputs.map { $0.0 })
        XCTAssertEqual(after.output().map { $0.scriptPubkey.toBytes() }, outputs.map { $0.1 })
    }

    func testBoundedHTTPPreparePermitSignBroadcastAndIdenticalRetry() async throws {
        let fixture = try EsploraFixture(words: vector)
        EsploraProtocol.state.reset(fixture: fixture)
        let engine = BitcoinEngine(protocolClasses: [EsploraProtocol.self])
        let endpoint = URL(string: "https://wallet.test.invalid/api")!
        let balance = try await engine.balance(account: fixture.account, network: .bitcoinSignet, endpoint: endpoint)
        XCTAssertEqual(balance.formatted, "0.001")
        let review = try await engine.prepare(account: fixture.account, network: .bitcoinSignet, endpoint: endpoint,
            to: fixture.recipient, amount: "0.0005")
        try await engine.validateBeforeSigning(review: review, account: fixture.account, endpoint: endpoint)
        let requestsBeforeSigning = EsploraProtocol.state.requestCount
        let signed = try await engine.sign(review: review, words: vector, account: fixture.account, endpoint: endpoint)
        XCTAssertEqual(EsploraProtocol.state.requestCount, requestsBeforeSigning, "Mnemonic-bearing signing must be entirely offline")
        XCTAssertEqual(signed.review.to, fixture.recipient)
        let first = try await engine.broadcast(signed: signed, endpoint: endpoint)
        XCTAssertEqual(first.hash, signed.hash)
        XCTAssertEqual(first.status, .submitted)
        let repeated = try await engine.rebroadcast(record: first, account: fixture.account, endpoint: endpoint)
        XCTAssertEqual(repeated.hash, first.hash)
        XCTAssertEqual(EsploraProtocol.state.postedBodies.count, 2)
        XCTAssertEqual(EsploraProtocol.state.postedBodies.first, EsploraProtocol.state.postedBodies.last)
        let status = try await engine.status(first, endpoint: endpoint)
        XCTAssertEqual(status, .confirmed)
        var changed = first
        changed.rawTransaction = "00"
        do { _ = try await engine.rebroadcast(record: changed, account: fixture.account, endpoint: endpoint); XCTFail("Tampered raw transaction accepted") }
        catch { XCTAssertEqual(error as? WalletFailure, .invalidResponse) }
    }

    func testSigningWithoutFreshPublicPermitFailsBeforeAnyNetworkOrSecretWork() async throws {
        let fixture = try EsploraFixture(words: vector)
        EsploraProtocol.state.reset(fixture: fixture)
        let engine = BitcoinEngine(protocolClasses: [EsploraProtocol.self])
        let endpoint = URL(string: "https://wallet.test.invalid/api")!
        let review = try await engine.prepare(account: fixture.account, network: .bitcoinSignet, endpoint: endpoint, to: fixture.recipient, amount: "0.0005")
        let count = EsploraProtocol.state.requestCount
        do { _ = try await engine.sign(review: review, words: vector, account: fixture.account, endpoint: endpoint); XCTFail("Missing permit accepted") }
        catch { XCTAssertEqual(error as? WalletFailure, .staleReview) }
        XCTAssertEqual(EsploraProtocol.state.requestCount, count)
    }

    func testConfirmationThresholdAndAbsentTransactionStayDistinct() async throws {
        let fixture = try EsploraFixture(words: vector)
        let record = TransferRecord(network: .bitcoinSignet, hash: String(repeating: "a", count: 64), to: fixture.recipient,
            amount: "0.0005", submittedAt: Date(), status: .unknown)
        for (mode, expected) in [(EsploraProtocol.State.Mode.normal, TransferRecord.Status.confirmed), (.fiveConfirmations, .submitted), (.absent, .unknown)] {
            EsploraProtocol.state.reset(fixture: fixture, mode: mode)
            let engine = BitcoinEngine(protocolClasses: [EsploraProtocol.self])
            let status = try await engine.status(record, endpoint: URL(string: "https://wallet.test.invalid/api")!)
            XCTAssertEqual(status, expected)
        }
    }

    func testDiscardCancelsPublicPreBroadcastIdentityCheckWithoutPosting() async throws {
        let fixture = try EsploraFixture(words: vector)
        EsploraProtocol.state.reset(fixture: fixture)
        let engine = BitcoinEngine(protocolClasses: [EsploraProtocol.self])
        let endpoint = URL(string: "https://wallet.test.invalid/api")!
        let review = try await engine.prepare(account: fixture.account, network: .bitcoinSignet, endpoint: endpoint, to: fixture.recipient, amount: "0.0005")
        try await engine.validateBeforeSigning(review: review, account: fixture.account, endpoint: endpoint)
        let signed = try await engine.sign(review: review, words: vector, account: fixture.account, endpoint: endpoint)
        EsploraProtocol.state.reset(fixture: fixture, mode: .delayed)
        let attempt = Task { try await engine.broadcast(signed: signed, endpoint: endpoint) }
        for _ in 0..<100 where EsploraProtocol.state.requestCount == 0 { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(EsploraProtocol.state.requestCount, 1)
        let cancelledAt = Date()
        await engine.discard()
        do { _ = try await attempt.value; XCTFail("Cancelled operation returned success") } catch { }
        XCTAssertLessThan(Date().timeIntervalSince(cancelledAt), 3, "Cancellation must stop the 10-second HTTP fixture, not merely discard its result")
        XCTAssertTrue(EsploraProtocol.state.postedBodies.isEmpty)
    }

    func testUntrustedResponsesWrongUTXOAmountsRedirectsAndTruncatedDiscoveryFailClosed() async throws {
        let fixture = try EsploraFixture(words: vector)
        for mode in [EsploraProtocol.State.Mode.wrongGenesis, .wrongAmount, .wrongTxid, .wrongVout, .redirect, .neverGap, .oversized] {
            EsploraProtocol.state.reset(fixture: fixture, mode: mode)
            let engine = BitcoinEngine(protocolClasses: [EsploraProtocol.self])
            do {
                _ = try await engine.balance(account: fixture.account, network: .bitcoinSignet, endpoint: URL(string: "https://wallet.test.invalid/api")!)
                XCTFail("Invalid node response returned an apparently complete balance: \(mode)")
            } catch { XCTAssertTrue(error is WalletFailure) }
            XCTAssertLessThanOrEqual(EsploraProtocol.state.requestCount, 405)
            XCTAssertTrue(EsploraProtocol.state.postedBodies.isEmpty)
            if mode == .wrongGenesis || mode == .redirect || mode == .oversized {
                XCTAssertEqual(EsploraProtocol.state.requestCount, 1, "Reject identity before disclosing account addresses")
            }
        }
    }
}

private struct EsploraFixture: Sendable {
    let account: AccountRecord
    let firstAddress: String
    let recipient: String
    let fundingHash: String
    let rawFunding: String

    init(words: String) throws {
        let derived = try BitcoinEngine.deriveAccount(words: words, network: .bitcoinSignet)
        firstAddress = derived.address
        let wallet = try Wallet(descriptor: Descriptor(descriptor: derived.descriptors.external, networkKind: .test),
            changeDescriptor: Descriptor(descriptor: derived.descriptors.internalDescriptor, networkKind: .test), network: .signet, persister: .newInMemory())
        recipient = wallet.peekAddress(keychain: .external, index: 1).address.description
        let script = wallet.peekAddress(keychain: .external, index: 0).address.scriptPubkey().toBytes()
        var bytes = Data([2, 0, 0, 0, 1])
        bytes.append(Data(repeating: 0x11, count: 32))
        bytes.append(contentsOf: [0, 0, 0, 0, 0, 255, 255, 255, 255, 1, 160, 134, 1, 0, 0, 0, 0, 0, UInt8(script.count)])
        bytes.append(script)
        bytes.append(contentsOf: [0, 0, 0, 0])
        let funding = try Transaction(transactionBytes: bytes)
        fundingHash = funding.computeTxid().description
        rawFunding = bytes.map { String(format: "%02x", $0) }.joined()
        account = AccountRecord(id: UUID(), createdAt: Date(timeIntervalSince1970: 0), evmAddress: "",
            addresses: [WalletNetwork.bitcoinSignet.id: derived.address],
            descriptors: [WalletNetwork.bitcoinSignet.id: derived.descriptors], backupConfirmed: true)
    }
}

/// Entirely local URL loading fixture. The reserved hostname cannot be a real node.
private final class EsploraProtocol: URLProtocol, @unchecked Sendable {
    static let state = State()

    final class State: @unchecked Sendable {
        enum Mode { case normal, wrongGenesis, wrongAmount, wrongTxid, wrongVout, redirect, neverGap, oversized, fiveConfirmations, absent, delayed }
        private let lock = NSLock()
        private var fixture: EsploraFixture?
        private var mode = Mode.normal
        private var count = 0
        private var posts: [Data] = []
        var requestCount: Int { lock.withLock { count } }
        var postedBodies: [Data] { lock.withLock { posts } }
        var isDelayed: Bool { lock.withLock { mode == .delayed } }
        func reset(fixture: EsploraFixture, mode: Mode = .normal) {
            lock.withLock { self.fixture = fixture; self.mode = mode; count = 0; posts = [] }
        }
        func response(_ request: URLRequest) -> (Int, Data, [String: String]) {
            lock.withLock {
                count += 1
                guard let fixture else { return (500, Data(), [:]) }
                let path = request.url!.path
                if mode == .redirect { return (302, Data(), ["Location": "https://other.invalid/api"]) }
                if mode == .oversized { return (200, Data(repeating: 0x61, count: 20_000), [:]) }
                if path == "/api/block-height/0" {
                    return (200, Data((mode == .wrongGenesis ? String(repeating: "0", count: 64) : "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6").utf8), [:])
                }
                if path == "/api/blocks/tip/height" { return (200, Data("100".utf8), [:]) }
                if path.hasPrefix("/api/block-height/") { return (200, Data(String(repeating: "2", count: 64).utf8), [:]) }
                if path == "/api/fee-estimates" { return (200, Data("{\"6\":2}".utf8), [:]) }
                if path.hasPrefix("/api/tx/"), path.hasSuffix("/hex") { return (200, Data(fixture.rawFunding.utf8), [:]) }
                if path.hasSuffix("/status") {
                    if mode == .absent { return (404, Data(), [:]) }
                    return (200, Data("{\"confirmed\":true,\"block_height\":\(mode == .fiveConfirmations ? 96 : 95),\"block_hash\":\"\(String(repeating: "2", count: 64))\"}".utf8), [:])
                }
                if path == "/api/tx", request.httpMethod == "POST" {
                    // URL loading may expose a streamed body; preserve it for byte-identical retry checks.
                    let body: Data
                    if let value = request.httpBody { body = value }
                    else if let stream = request.httpBodyStream {
                        stream.open(); defer { stream.close() }
                        var result = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
                        while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; result.append(contentsOf: buffer.prefix(n)) }
                        body = result
                    } else { return (400, Data(), [:]) }
                    posts.append(body)
                    guard let hex = String(data: body, encoding: .utf8), hex.count.isMultiple(of: 2) else { return (400, Data(), [:]) }
                    var bytes = Data(); var index = hex.startIndex
                    while index < hex.endIndex { let end = hex.index(index, offsetBy: 2); guard let byte = UInt8(hex[index..<end], radix: 16) else { return (400, Data(), [:]) }; bytes.append(byte); index = end }
                    guard let transaction = try? Transaction(transactionBytes: bytes) else { return (400, Data(), [:]) }
                    return (200, Data(transaction.computeTxid().description.utf8), [:])
                }
                if path == "/api/address/\(fixture.firstAddress)/utxo" {
                    return (200, Data("[{\"txid\":\"\(mode == .wrongTxid ? String(repeating: "a", count: 64) : fixture.fundingHash)\",\"vout\":\(mode == .wrongVout ? 1 : 0),\"value\":\(mode == .wrongAmount ? 100_001 : 100_000),\"status\":{\"confirmed\":true,\"block_height\":90,\"block_hash\":\"\(String(repeating: "2", count: 64))\"}}]".utf8), [:])
                }
                if path.hasSuffix("/utxo") { return (200, Data("[]".utf8), [:]) }
                if path.hasPrefix("/api/address/") {
                    let used = mode == .neverGap || path == "/api/address/\(fixture.firstAddress)"
                    return (200, Data("{\"chain_stats\":{\"tx_count\":\(used ? 1 : 0)},\"mempool_stats\":{\"tx_count\":0}}".utf8), [:])
                }
                return (404, Data(), [:])
            }
        }
    }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "wallet.test.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    private let stoppedLock = NSLock()
    private var stopped = false
    override func startLoading() {
        let (code, data, headers) = Self.state.response(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: headers)!
        if Self.state.isDelayed {
            DispatchQueue.global().asyncAfter(deadline: .now() + 10) { [weak self] in self?.finish(response: response, data: data) }
        } else { finish(response: response, data: data) }
    }
    private func finish(response: HTTPURLResponse, data: Data) {
        guard !stoppedLock.withLock({ stopped }) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { stoppedLock.withLock { stopped = true } }
}
