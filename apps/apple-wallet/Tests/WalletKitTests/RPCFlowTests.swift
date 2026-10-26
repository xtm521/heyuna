import Foundation
import XCTest
import Web3Core
@testable import WalletKit

/// All HTTP is intercepted by URLProtocol. These fixtures never contact a node or broadcast a transaction.
final class RPCFlowTests: XCTestCase {
    private let words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    private let destination = "0x3535353535353535353535353535353535353535"

    private func environment() throws -> (RPCFixture, EVMEngine, AccountRecord, URL) {
        let fixture = RPCFixture()
        let endpoint = URL(string: "https://\(UUID().uuidString.lowercased()).wallet.invalid/rpc")!
        MockRPCProtocol.install(fixture, host: endpoint.host!)
        addTeardownBlock { MockRPCProtocol.remove(host: endpoint.host!) }
        let engine = EVMEngine(rpcFactory: { url in
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [MockRPCProtocol.self]
            return JSONRPC(endpoint: url, configuration: configuration)
        })
        return (fixture, engine, try WalletCryptography.account(words: words), endpoint)
    }

    private func expect(_ failure: WalletFailure, _ operation: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line) async {
        do { try await operation(); XCTFail("Expected \(failure)", file: file, line: line) }
        catch { XCTAssertEqual(error as? WalletFailure, failure, file: file, line: line) }
    }

    func testWrongChainAndGenesisStopBeforeSigningOrBroadcasting() async throws {
        for wrongChain in [true, false] {
            let (fixture, engine, account, endpoint) = try environment()
            if wrongChain { fixture.set(chainID: "0x1") }
            else { fixture.set(genesis: "0x" + String(repeating: "1", count: 64)) }
            await expect(.networkMismatch) {
                _ = try await engine.prepare(account: account, network: .sepolia, endpoint: endpoint, to: self.destination, amount: "0.01")
            }
            XCTAssertEqual(fixture.broadcasts, [])
        }
    }

    func testNonceChangesInvalidateTheReviewedTransfer() async throws {
        let (fixture, engine, account, endpoint) = try environment()
        let review = try await engine.prepare(account: account, network: .sepolia, endpoint: endpoint, to: destination, amount: "0.01")
        fixture.set(nonce: "0x8")
        await expect(.staleReview) { try await engine.validateBeforeSigning(review: review, account: account, endpoint: endpoint) }
        await expect(.staleReview) { _ = try await engine.sign(review: review, words: self.words, account: account, endpoint: endpoint) }
        XCTAssertEqual(fixture.broadcasts, [])
    }

    func testFailedRevalidationRevokesAnEarlierSigningPermit() async throws {
        let (fixture, engine, account, endpoint) = try environment()
        let review = try await engine.prepare(account: account, network: .sepolia, endpoint: endpoint, to: destination, amount: "0.01")
        try await engine.validateBeforeSigning(review: review, account: account, endpoint: endpoint)
        fixture.set(nonce: "0x8")
        await expect(.staleReview) { try await engine.validateBeforeSigning(review: review, account: account, endpoint: endpoint) }
        await expect(.staleReview) { _ = try await engine.sign(review: review, words: self.words, account: account, endpoint: endpoint) }
        XCTAssertEqual(fixture.broadcasts, [])
    }

    func testOfflineSigningAndOneShotBroadcastPreserveReviewedFields() async throws {
        let (fixture, engine, account, endpoint) = try environment()
        let review = try await engine.prepare(account: account, network: .sepolia, endpoint: endpoint, to: destination, amount: "0.01")
        await expect(.staleReview) { _ = try await engine.sign(review: review, words: self.words, account: account, endpoint: endpoint) }
        try await engine.validateBeforeSigning(review: review, account: account, endpoint: endpoint)
        let requestsBeforeSigning = fixture.requestCount
        let signed = try await engine.sign(review: review, words: words, account: account, endpoint: endpoint)
        XCTAssertEqual(fixture.requestCount, requestsBeforeSigning, "No network call may retain the mnemonic")
        let data = try XCTUnwrap(Data.fromHex(signed.rawHex))
        let decoded = try XCTUnwrap(CodableTransaction(rawValue: data))
        XCTAssertEqual(decoded.chainID, 11155111)
        XCTAssertEqual(decoded.nonce, 7)
        XCTAssertEqual(decoded.to.address.lowercased(), destination)
        XCTAssertEqual(decoded.value.description, "10000000000000000")
        XCTAssertEqual(decoded.gasLimit, 21000)
        XCTAssertEqual(decoded.maxFeePerGas, 3_000_000_000)
        XCTAssertEqual(decoded.maxPriorityFeePerGas, 1_000_000_000)
        XCTAssertEqual(decoded.sender?.address.lowercased(), account.evmAddress.lowercased())
        await expect(.staleReview) { _ = try await engine.sign(review: review, words: self.words, account: account, endpoint: endpoint) }
        let record = try await engine.broadcast(signed: signed, endpoint: endpoint)
        XCTAssertEqual(record.status, .submitted)
        XCTAssertEqual(record.rawTransaction, signed.rawHex)
        XCTAssertEqual(record.hash, signed.hash)
        await expect(.staleReview) { _ = try await engine.broadcast(signed: signed, endpoint: endpoint) }
        XCTAssertEqual(fixture.broadcasts, [signed.rawHex])
    }

    func testRebroadcastRejectsChangedNetworkRecipientAmountAndHash() async throws {
        let (fixture, engine, account, endpoint) = try environment()
        let review = try await engine.prepare(account: account, network: .sepolia, endpoint: endpoint, to: destination, amount: "0.01")
        try await engine.validateBeforeSigning(review: review, account: account, endpoint: endpoint)
        let signed = try await engine.sign(review: review, words: words, account: account, endpoint: endpoint)
        func record(network: WalletNetwork = .sepolia, hash: String? = nil, to: String? = nil, amount: String = "0.01", raw: String? = nil) -> TransferRecord {
            TransferRecord(network: network, hash: hash ?? signed.hash, to: to ?? destination, amount: amount, submittedAt: Date(), status: .unknown, rawTransaction: raw ?? signed.rawHex)
        }
        let invalid = [
            record(network: .ethereum),
            record(hash: "0x" + String(repeating: "0", count: 64)),
            record(to: "0x4545454545454545454545454545454545454545"),
            record(amount: "0.02"),
            record(raw: "0x02ff")
        ]
        for corrupted in invalid {
            await expect(.corruptStorage) { _ = try await engine.rebroadcast(record: corrupted, account: account, endpoint: endpoint) }
        }
        XCTAssertEqual(fixture.broadcasts, [])
        let recovered = try await engine.rebroadcast(record: record(), account: account, endpoint: endpoint)
        XCTAssertEqual(recovered.hash, signed.hash)
        XCTAssertEqual(fixture.broadcasts, [signed.rawHex], "Recovery may only resend the exact previously signed bytes")
    }

    func testOversizedResponseIsRejectedWithAndWithoutContentLength() async throws {
        for declared in [true, false] {
            let (fixture, _, _, endpoint) = try environment()
            fixture.set(oversized: declared ? .declared : .streamed)
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [MockRPCProtocol.self]
            let rpc = JSONRPC(endpoint: endpoint, configuration: configuration)
            await expect(.invalidResponse) { _ = try await rpc.call("eth_chainId") }
            XCTAssertEqual(fixture.broadcasts, [])
        }
    }

    func testMismatchingReturnedHashPreservesBroadcastUncertainty() async throws {
        let (fixture, engine, account, endpoint) = try environment()
        let review = try await engine.prepare(account: account, network: .sepolia, endpoint: endpoint, to: destination, amount: "0.01")
        try await engine.validateBeforeSigning(review: review, account: account, endpoint: endpoint)
        let signed = try await engine.sign(review: review, words: words, account: account, endpoint: endpoint)
        fixture.set(wrongBroadcastHash: true)
        await expect(.broadcastUncertain) { _ = try await engine.broadcast(signed: signed, endpoint: endpoint) }
        await expect(.staleReview) { _ = try await engine.broadcast(signed: signed, endpoint: endpoint) }
        XCTAssertEqual(fixture.broadcasts, [signed.rawHex])
    }

    func testDiscardDuringPreBroadcastIdentityCheckSendsNoTransaction() async throws {
        let (fixture, engine, account, endpoint) = try environment()
        let review = try await engine.prepare(account: account, network: .sepolia, endpoint: endpoint, to: destination, amount: "0.01")
        try await engine.validateBeforeSigning(review: review, account: account, endpoint: endpoint)
        let signed = try await engine.sign(review: review, words: words, account: account, endpoint: endpoint)
        let arrived = expectation(description: "Broadcast is paused in its public identity check")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        fixture.holdNextGenesis(arrived: { arrived.fulfill() }, release: release)
        let operation = Task { try await engine.broadcast(signed: signed, endpoint: endpoint) }
        await fulfillment(of: [arrived], timeout: 2)
        await engine.discard()
        release.signal()
        await expect(.staleReview) { _ = try await operation.value }
        XCTAssertEqual(fixture.broadcasts, [], "Locking or switching networks must invalidate a not-yet-sent transaction")
    }
}

private final class RPCFixture: @unchecked Sendable {
    enum Oversized { case none, declared, streamed }
    private let lock = NSLock()
    private var chainID = "0xaa36a7"
    private var genesis = "0x25a5cc106eea7138acab33231d7160d69cb777ee0c2c553fcddf5138993e6dd9"
    private var nonce = "0x7"
    private var oversized = Oversized.none
    private var wrongBroadcastHash = false
    private var observedBroadcasts: [String] = []
    private var requests = 0
    private var genesisHold: (() -> Void)?
    var broadcasts: [String] { lock.withLock { observedBroadcasts } }
    var requestCount: Int { lock.withLock { requests } }

    func holdNextGenesis(arrived: @escaping @Sendable () -> Void, release: DispatchSemaphore) {
        lock.withLock { genesisHold = { arrived(); _ = release.wait(timeout: .now() + 5) } }
    }

    func set(chainID: String? = nil, genesis: String? = nil, nonce: String? = nil, oversized: Oversized? = nil, wrongBroadcastHash: Bool? = nil) {
        lock.withLock {
            if let chainID { self.chainID = chainID }
            if let genesis { self.genesis = genesis }
            if let nonce { self.nonce = nonce }
            if let oversized { self.oversized = oversized }
            if let wrongBroadcastHash { self.wrongBroadcastHash = wrongBroadcastHash }
        }
    }

    func response(for request: URLRequest) throws -> (headers: [String: String], data: Data) {
        try lock.withLock {
            requests += 1
            if oversized == .declared { return (["Content-Length": "2000001"], Data()) }
            if oversized == .streamed { return ([:], Data(repeating: 0x20, count: 2_000_001)) }
            let body: Data
            if let data = request.httpBody { body = data }
            else if let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }
                var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable {
                    let count = stream.read(&buffer, maxLength: buffer.count)
                    guard count >= 0 else { throw WalletFailure.invalidResponse }
                    if count == 0 { break }
                    data.append(contentsOf: buffer.prefix(count))
                }
                body = data
            } else { throw WalletFailure.invalidResponse }
            guard let envelope = try JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let method = envelope["method"] as? String, let id = envelope["id"] else { throw WalletFailure.invalidResponse }
            let params = envelope["params"] as? [Any] ?? []
            let result: Any
            switch method {
            case "eth_chainId": result = chainID
            case "eth_getBlockByNumber":
                if params.first as? String == "0x0", let hold = genesisHold {
                    genesisHold = nil
                    hold()
                }
                result = params.first as? String == "0x0" ? ["hash": genesis] : ["baseFeePerGas": "0x3b9aca00"]
            case "eth_getCode": result = "0x"
            case "eth_getTransactionCount": result = nonce
            case "eth_getBalance": result = "0xde0b6b3a7640000"
            case "eth_maxPriorityFeePerGas": result = "0x3b9aca00"
            case "eth_estimateGas": result = "0x5208"
            case "eth_blockNumber": result = "0x100"
            case "eth_sendRawTransaction":
                guard let raw = params.first as? String, let bytes = Data.fromHex(raw),
                      let transaction = CodableTransaction(rawValue: bytes), let hash = transaction.hash else { throw WalletFailure.invalidResponse }
                observedBroadcasts.append(raw)
                result = wrongBroadcastHash ? "0x" + String(repeating: "0", count: 64) : "0x" + hash.toHexString()
            default: throw WalletFailure.invalidResponse
            }
            let data = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": id, "result": result])
            return (["Content-Type": "application/json", "Content-Length": String(data.count)], data)
        }
    }
}

private final class MockRPCProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var fixtures: [String: RPCFixture] = [:]
    static func install(_ fixture: RPCFixture, host: String) { lock.withLock { fixtures[host] = fixture } }
    static func remove(host: String) { _ = lock.withLock { fixtures.removeValue(forKey: host) } }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host?.hasSuffix(".wallet.invalid") == true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let url = request.url, let fixture = Self.lock.withLock({ Self.fixtures[url.host ?? ""] }) else { throw WalletFailure.invalidResponse }
            let output = try fixture.response(for: request)
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: output.headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            // Chunking also exercises the streaming cap when Content-Length is absent.
            for start in stride(from: 0, to: output.data.count, by: 16_384) {
                client?.urlProtocol(self, didLoad: output.data.subdata(in: start..<min(start + 16_384, output.data.count)))
            }
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
