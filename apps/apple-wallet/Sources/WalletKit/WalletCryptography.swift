import Foundation
import Web3Core
import BigInt

public enum WalletCryptography {
    public static func normalize(_ input: String) throws -> String {
        let words = input.decomposedStringWithCompatibilityMapping.lowercased().split(whereSeparator: \.isWhitespace)
        guard words.count == 12 || words.count == 24 else { throw WalletFailure.invalidMnemonic }
        let phrase = words.joined(separator: " ")
        guard BIP39.mnemonicsToEntropy(phrase) != nil else { throw WalletFailure.invalidMnemonic }
        return phrase
    }
    public static func generate() throws -> String {
        guard let phrase = try BIP39.generateMnemonics(bitsOfEntropy: 256), phrase.split(separator: " ").count == 24 else { throw WalletFailure.invalidMnemonic }
        return phrase
    }
    public static func evmAddress(words: String) throws -> String {
        var key = try evmKey(words: words)
        defer { key.resetBytes(in: key.indices) }
        guard let publicKey = Utilities.privateToPublic(key), let address = Utilities.publicToAddress(publicKey) else { throw WalletFailure.invalidMnemonic }
        return address.address
    }
    static func evmKey(words: String) throws -> Data {
        let normalized = try normalize(words)
        guard var seed = BIP39.seedFromMmemonics(normalized) else { throw WalletFailure.invalidMnemonic }
        defer { seed.resetBytes(in: seed.indices) }
        guard let key = HDNode(seed: seed)?.derive(path: "m/44'/60'/0'/0/0")?.privateKey else { throw WalletFailure.invalidMnemonic }
        return key
    }
    public static func account(words: String) throws -> AccountRecord {
        let normalized = try normalize(words)
        let main = try BitcoinEngine.deriveAccount(words: normalized, network: .bitcoin)
        let signet = try BitcoinEngine.deriveAccount(words: normalized, network: .bitcoinSignet)
        return AccountRecord(id: UUID(), createdAt: Date(), evmAddress: try evmAddress(words: normalized),
            addresses: [WalletNetwork.bitcoin.id: main.address, WalletNetwork.bitcoinSignet.id: signet.address],
            descriptors: [WalletNetwork.bitcoin.id: main.descriptors, WalletNetwork.bitcoinSignet.id: signet.descriptors], backupConfirmed: true)
    }
}

public enum AtomicAmount {
    public static func parse(_ input: String, decimals: Int) throws -> BigUInt {
        guard (0...18).contains(decimals), !input.isEmpty, input.count <= 100 else { throw WalletFailure.invalidAmount }
        let parts = input.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count <= 2, let whole = parts.first, !whole.isEmpty,
              parts.allSatisfy({ $0.allSatisfy({ $0.isASCII && $0.isNumber }) }),
              whole.count <= 78 else { throw WalletFailure.invalidAmount }
        let fraction = parts.count == 2 ? String(parts[1]) : ""
        guard fraction.count <= decimals, parts.count == 1 || !fraction.isEmpty,
              let value = BigUInt(String(whole) + fraction + String(repeating: "0", count: decimals - fraction.count)),
              value > 0, value.bitWidth <= 256 else { throw WalletFailure.invalidAmount }
        return value
    }
    public static func format(_ value: BigUInt, decimals: Int) -> String {
        guard decimals > 0 else { return value.description }
        let base = BigUInt(10).power(decimals)
        let whole = value / base
        var fraction = String(value % base)
        fraction = String(repeating: "0", count: max(0, decimals - fraction.count)) + fraction
        while fraction.last == "0" { fraction.removeLast() }
        return fraction.isEmpty ? whole.description : "\(whole).\(fraction)"
    }
}
