import XCTest
import Foundation
import BigInt
import Web3Core
@testable import WalletKit

final class EVMTests: XCTestCase {
    // Public BIP-39 test vector, never funded and never an app credential.
    private let vector = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

    func testPublishedDerivationAndMnemonicValidation() throws {
        XCTAssertEqual(try WalletCryptography.evmAddress(words: vector).lowercased(), "0x9858effd232b4033e47d90003d41ec34ecaeda94")
        XCTAssertThrowsError(try WalletCryptography.normalize("abandon abandon invalid"))
        XCTAssertThrowsError(try WalletCryptography.normalize(Array(repeating: "abandon", count: 12).joined(separator: " ")))
        let generated = try WalletCryptography.generate()
        XCTAssertEqual(generated.split(separator: " ").count, 24)
        XCTAssertEqual(try WalletCryptography.normalize(generated), generated)
    }

    func testIntegerAmountsNeverRoundOrAcceptExponent() throws {
        XCTAssertEqual(try AtomicAmount.parse("0.000000000000000001", decimals: 18), 1)
        XCTAssertEqual(try AtomicAmount.parse("123456789.123456789123456789", decimals: 18).description, "123456789123456789123456789")
        for text in ["0", "-1", "+1", "1e18", "NaN", " 1", "1 ", "1.", ".1", "1,000", "0.0000000000000000001", String(repeating: "9", count: 80)] {
            XCTAssertThrowsError(try AtomicAmount.parse(text, decimals: 18), text)
        }
        XCTAssertEqual(AtomicAmount.format(0, decimals: 18), "0")
        XCTAssertEqual(AtomicAmount.format(1, decimals: 18), "0.000000000000000001")
        XCTAssertEqual(AtomicAmount.format(1_230_000_000_000_000_000, decimals: 18), "1.23")
    }

    func testEIP1559SignatureRoundTripBindsChainRecipientValueAndFee() throws {
        var key = try WalletCryptography.evmKey(words: vector)
        defer { key.resetBytes(in: key.indices) }
        let recipient = try XCTUnwrap(EthereumAddress("0x3535353535353535353535353535353535353535"))
        var tx = CodableTransaction(type: .eip1559, to: recipient, nonce: 7, chainID: 11155111, value: 12345,
            gasLimit: 21000, maxFeePerGas: 2_000_000_000, maxPriorityFeePerGas: 1_000_000_000)
        try tx.sign(privateKey: key)
        let raw = try XCTUnwrap(tx.encode())
        let decoded = try XCTUnwrap(CodableTransaction(rawValue: raw))
        XCTAssertEqual(raw.first, 2)
        XCTAssertEqual(decoded.sender?.address.lowercased(), try WalletCryptography.evmAddress(words: vector).lowercased())
        XCTAssertEqual(decoded.chainID, 11155111)
        XCTAssertEqual(decoded.to.address, recipient.address)
        XCTAssertEqual(decoded.value, 12345)
        XCTAssertEqual(decoded.nonce, 7)
        XCTAssertEqual(decoded.gasLimit, 21000)
        XCTAssertEqual(decoded.maxFeePerGas, 2_000_000_000)
        XCTAssertEqual(decoded.maxPriorityFeePerGas, 1_000_000_000)
        XCTAssertEqual(decoded.hash, tx.hash)
    }

    func testEndpointAndNetworkIdentityDoNotAcceptLooseFallback() throws {
        for endpoint in ["http://example.com", "https://user:pass@example.com", "https://example.com?a=b", "https://example.com#fragment", "file:///tmp/node"] {
            XCTAssertThrowsError(try EndpointPolicy.validate(endpoint))
        }
        XCTAssertEqual(try EndpointPolicy.validate("https://node.example/rpc").scheme, "https")
        XCTAssertEqual(try EVMEngine.genesis(for: .ethereum), "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3")
        XCTAssertThrowsError(try EVMEngine.genesis(for: .heyuna))
        XCTAssertNotEqual(WalletNetwork.ethereum.chainID, WalletNetwork.sepolia.chainID)
    }

    func testPublicMetadataHasNoMnemonicOrPrivateDescriptor() throws {
        let account = try WalletCryptography.account(words: vector)
        let json = String(decoding: try JSONEncoder().encode(account), as: UTF8.self)
        XCTAssertFalse(json.contains(vector))
        XCTAssertFalse(json.contains("xprv"))
        XCTAssertFalse(json.contains("tprv"))
        XCTAssertTrue(json.contains(account.evmAddress))
        XCTAssertNotEqual(account.address(for: .bitcoin), account.address(for: .bitcoinSignet))
    }

    func testPersistenceVersionAndCorruptionFailClosed() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let storage = try WalletPersistence(directory: directory)
        var state = WalletFile()
        state.account = try WalletCryptography.account(words: vector)
        try await storage.save(state)
        let loaded = try await storage.load()
        XCTAssertEqual(loaded.account, state.account)
        try Data("{}".utf8).write(to: directory.appendingPathComponent("wallet-v1.json"))
        do { _ = try await storage.load(); XCTFail("Corrupt storage must not become an empty wallet") }
        catch { XCTAssertEqual(error as? WalletFailure, .corruptStorage) }
    }
}
