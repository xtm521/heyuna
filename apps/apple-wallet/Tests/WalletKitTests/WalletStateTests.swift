import XCTest
import Foundation
@testable import WalletKit
@testable import WalletState

private actor TestVault: SecretVault {
    var secret: Data?
    var failure: WalletFailure?
    var authenticationCount = 0
    var removals: [UUID] = []
    private var readContinuation: CheckedContinuation<Void, Never>?
    private var readerStarted: CheckedContinuation<Void, Never>?
    private var holdRead = false
    init(secret: Data?, failure: WalletFailure? = nil) { self.secret = secret; self.failure = failure }
    func save(_ secret: Data, account: UUID) throws { self.secret = secret }
    func read(account: UUID, reason: String) async throws -> Data {
        if holdRead {
            await withCheckedContinuation { continuation in
                readContinuation = continuation
                readerStarted?.resume(); readerStarted = nil
            }
        }
        if let failure { throw failure }
        guard let secret else { throw WalletFailure.missingWallet }
        return secret
    }
    func authenticate(reason: String) { authenticationCount += 1 }
    func remove(account: UUID) { removals.append(account); secret = nil }
    func blockRead() { holdRead = true }
    func waitForRead() async {
        if readContinuation != nil { return }
        await withCheckedContinuation { readerStarted = $0 }
    }
    func releaseRead() { holdRead = false; readContinuation?.resume(); readContinuation = nil }
}

@MainActor
final class WalletStateTests: XCTestCase {
    private let vector = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    private func fixture(vault: TestVault) async throws -> (WalletStore, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let persistence = try WalletPersistence(directory: directory)
        var file = WalletFile(); file.account = try WalletCryptography.account(words: vector)
        try await persistence.save(file)
        let store = WalletStore(vault: vault, persistence: persistence)
        await store.waitUntilReady()
        XCTAssertNotNil(store.account)
        return (store, directory)
    }

    func testClosingBackupInvalidatesAnAuthenticationStillInFlight() async throws {
        let vault = TestVault(secret: Data(vector.utf8))
        let (store, directory) = try await fixture(vault: vault)
        defer { try? FileManager.default.removeItem(at: directory) }
        await vault.blockRead()
        let pending = Task { await store.revealBackup() }
        await vault.waitForRead()
        store.concealBackup()
        await vault.releaseRead()
        await pending.value
        XCTAssertNil(store.backupWords, "A closed sheet must not repopulate the mnemonic after authentication")
    }

    func testBackgroundInvalidatesDraftAndPendingBackupRead() async throws {
        let vault = TestVault(secret: Data(vector.utf8))
        let (store, directory) = try await fixture(vault: vault)
        defer { try? FileManager.default.removeItem(at: directory) }
        await vault.blockRead()
        let pending = Task { await store.revealBackup() }
        await vault.waitForRead()
        store.lock()
        await vault.releaseRead(); await pending.value
        XCTAssertNil(store.backupWords)
        XCTAssertNil(store.review)
        XCTAssertTrue(store.isLocked)
    }

    func testOnlyExactMissingKeyAllowsRecoveryOfPublicMetadata() async throws {
        let vault = TestVault(secret: nil, failure: .missingWallet)
        let (store, directory) = try await fixture(vault: vault)
        defer { try? FileManager.default.removeItem(at: directory) }
        await store.forgetWallet()
        XCTAssertNil(store.account)
        let authCount = await vault.authenticationCount
        let removals = await vault.removals
        XCTAssertEqual(authCount, 1)
        XCTAssertEqual(removals.count, 1)
    }

    func testCancellationAndEntitlementFailureNeverEraseWallet() async throws {
        for failure: WalletFailure in [.authenticationCancelled, .locked, .missingEntitlement, .authenticationFailed] {
            let vault = TestVault(secret: nil, failure: failure)
            let (store, directory) = try await fixture(vault: vault)
            defer { try? FileManager.default.removeItem(at: directory) }
            let original = store.account
            await store.forgetWallet()
            XCTAssertEqual(store.account, original)
            let removals = await vault.removals
            XCTAssertTrue(removals.isEmpty)
        }
    }

    func testInvalidAndUntrustedEndpointsAreNotSaved() async throws {
        let vault = TestVault(secret: Data(vector.utf8))
        let (store, directory) = try await fixture(vault: vault)
        defer { try? FileManager.default.removeItem(at: directory) }
        XCTAssertTrue(store.endpoint.isEmpty)
        store.saveEndpoint("http://node.example")
        XCTAssertTrue(store.endpoint.isEmpty)
        store.selectedNetwork = .heyuna
        store.saveEndpoint("https://node.example")
        XCTAssertTrue(store.endpoint.isEmpty)
    }
}
