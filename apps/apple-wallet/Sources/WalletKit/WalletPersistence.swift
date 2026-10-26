import Foundation

public struct WalletFile: Codable, Sendable {
    public var version: Int = 1
    public var account: AccountRecord?
    public var activity: [TransferRecord] = []
    public var endpoints: [String: String] = [:]
    public init() {}
}

public actor WalletPersistence {
    private let file: URL
    public init(directory: URL? = nil) throws {
        let base = try directory ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("HeyunaWallet", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        var excluded = base
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try excluded.setResourceValues(values)
        file = base.appendingPathComponent("wallet-v1.json")
    }
    public func load() throws -> WalletFile {
        guard FileManager.default.fileExists(atPath: file.path) else { return WalletFile() }
        do {
            let decoded = try JSONDecoder().decode(WalletFile.self, from: Data(contentsOf: file))
            guard decoded.version == 1 else { throw WalletFailure.corruptStorage }
            return decoded
        } catch { throw WalletFailure.corruptStorage }
    }
    public func save(_ state: WalletFile) throws {
        do {
            let data = try JSONEncoder().encode(state)
            #if os(iOS)
            try data.write(to: file, options: [.atomic, .completeFileProtection])
            #else
            try data.write(to: file, options: .atomic)
            #endif
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch { throw WalletFailure.corruptStorage }
    }
}

public enum EndpointPolicy {
    public static func validate(_ text: String) throws -> URL {
        guard let parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme?.lowercased() == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              let url = parts.url else { throw WalletFailure.invalidEndpoint }
        return url
    }
}
