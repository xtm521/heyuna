import Foundation
import Security
import LocalAuthentication

public protocol SecretVault: Sendable {
    func save(_ secret: Data, account: UUID) async throws
    func read(account: UUID, reason: String) async throws -> Data
    func authenticate(reason: String) async throws
    func remove(account: UUID) async throws
}

/// Device-bound, foreground-only, user-presence-gated. Never shared with the research client.
public actor KeychainSecretVault: SecretVault {
    private let service = "com.heyuna.wallet.seed.v1"
    public init() {}

    private func identity(_ account: UUID) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account.uuidString,
            kSecAttrSynchronizable as String: false
        ]
        #if os(macOS)
        query[kSecUseDataProtectionKeychain as String] = true
        #endif
        return query
    }

    public func save(_ secret: Data, account: UUID) throws {
        let context = LAContext()
        defer { context.invalidate() }
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { throw WalletFailure.locked }
        #if os(iOS)
        let protection = kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly
        #else
        let protection = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        #endif
        var accessError: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, protection, .userPresence, &accessError) else {
            throw WalletFailure.locked
        }
        var query = identity(account)
        query[kSecAttrAccessControl as String] = access
        query[kSecValueData as String] = secret
        try check(SecItemAdd(query as CFDictionary, nil))
    }

    public func read(account: UUID, reason: String) throws -> Data {
        let context = LAContext()
        context.localizedReason = reason
        context.touchIDAuthenticationAllowableReuseDuration = 0
        defer { context.invalidate() }
        var query = identity(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecUseAuthenticationContext as String] = context
        var result: CFTypeRef?
        try check(SecItemCopyMatching(query as CFDictionary, &result))
        guard let data = result as? Data, !data.isEmpty else { throw WalletFailure.corruptStorage }
        return data
    }

    public func authenticate(reason: String) async throws {
        let context = LAContext()
        defer { context.invalidate() }
        var capabilityError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &capabilityError) else { throw WalletFailure.locked }
        do {
            guard try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) else { throw WalletFailure.authenticationFailed }
        } catch let error as LAError {
            if [.userCancel, .appCancel, .systemCancel].contains(error.code) { throw WalletFailure.authenticationCancelled }
            throw WalletFailure.authenticationFailed
        }
    }

    public func remove(account: UUID) throws {
        // Exact service + account + non-synchronizable identity; never a class-wide delete.
        let status = SecItemDelete(identity(account) as CFDictionary)
        if status != errSecItemNotFound { try check(status) }
    }

    private func check(_ status: OSStatus) throws {
        switch status {
        case errSecSuccess: return
        case errSecDuplicateItem: throw WalletFailure.duplicateWallet
        case errSecItemNotFound: throw WalletFailure.missingWallet
        case errSecUserCanceled: throw WalletFailure.authenticationCancelled
        case errSecAuthFailed: throw WalletFailure.authenticationFailed
        case errSecInteractionNotAllowed, errSecNotAvailable: throw WalletFailure.locked
        case errSecMissingEntitlement: throw WalletFailure.missingEntitlement
        default: throw WalletFailure.corruptStorage
        }
    }
}
