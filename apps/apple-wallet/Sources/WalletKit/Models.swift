import Foundation

public enum WalletNetwork: String, CaseIterable, Codable, Identifiable, Sendable {
    case bitcoin, bitcoinSignet, ethereum, sepolia, heyuna
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .bitcoin: "BTC"
        case .bitcoinSignet: "BTC · Signet 测试网"
        case .ethereum: "ETH"
        case .sepolia: "ETH · Sepolia 测试网"
        case .heyuna: "合芽研究网"
        }
    }
    public var symbol: String { isBitcoin ? "BTC" : self == .heyuna ? "tHEYUNA" : "ETH" }
    public var isBitcoin: Bool { self == .bitcoin || self == .bitcoinSignet }
    public var isTestnet: Bool { self != .bitcoin && self != .ethereum }
    public var decimals: Int { isBitcoin ? 8 : 18 }
    public var chainID: UInt64? {
        switch self { case .ethereum: 1; case .sepolia: 11155111; case .heyuna: 297011; default: nil }
    }
    public var derivation: String {
        isBitcoin ? (self == .bitcoin ? "m/84'/0'/0'" : "m/84'/1'/0'") : "m/44'/60'/0'/0/0"
    }
}

public struct DescriptorPair: Codable, Equatable, Sendable {
    public let external: String
    public let internalDescriptor: String
    public init(external: String, internalDescriptor: String) {
        self.external = external; self.internalDescriptor = internalDescriptor
    }
}

public struct AccountRecord: Codable, Equatable, Sendable, Identifiable {
    public let id: UUID
    public let createdAt: Date
    public let evmAddress: String
    public let addresses: [String: String]
    public let descriptors: [String: DescriptorPair]
    public let backupConfirmed: Bool
    public init(id: UUID, createdAt: Date, evmAddress: String, addresses: [String: String], descriptors: [String: DescriptorPair], backupConfirmed: Bool) {
        self.id = id; self.createdAt = createdAt; self.evmAddress = evmAddress
        self.addresses = addresses; self.descriptors = descriptors; self.backupConfirmed = backupConfirmed
    }
    public func address(for network: WalletNetwork) -> String { network.isBitcoin ? (addresses[network.id] ?? "") : evmAddress }
}

public struct WalletDraft: Sendable {
    public let words: [String]
    public let account: AccountRecord
    public init(words: [String], account: AccountRecord) { self.words = words; self.account = account }
}

public struct BalanceSnapshot: Sendable {
    public let network: WalletNetwork
    public let formatted: String
    public let height: UInt64
    public let checkedAt: Date
    public init(network: WalletNetwork, formatted: String, height: UInt64, checkedAt: Date) {
        self.network = network; self.formatted = formatted; self.height = height; self.checkedAt = checkedAt
    }
}

public struct TransferReview: Identifiable, Sendable {
    public let id: UUID
    public let network: WalletNetwork
    public let from: String
    public let to: String
    public let amount: String
    public let fee: String
    public let total: String
    public let expiresAt: Date
    public let explanation: String
    public init(id: UUID, network: WalletNetwork, from: String, to: String, amount: String, fee: String, total: String, expiresAt: Date, explanation: String) {
        self.id = id; self.network = network; self.from = from; self.to = to
        self.amount = amount; self.fee = fee; self.total = total; self.expiresAt = expiresAt; self.explanation = explanation
    }
}

public struct TransferRecord: Codable, Identifiable, Sendable {
    public enum Status: String, Codable, Sendable { case signed, submitted, confirmed, failed, unknown }
    public var id: String { network.id + ":" + hash }
    public let network: WalletNetwork
    public let hash: String
    public let to: String
    public let amount: String
    public let submittedAt: Date
    public var status: Status
    /// Public signed transaction bytes, retained only for identical-hash rebroadcast after interruption.
    public var rawTransaction: String?
    public init(network: WalletNetwork, hash: String, to: String, amount: String, submittedAt: Date, status: Status, rawTransaction: String? = nil) {
        self.network = network; self.hash = hash; self.to = to; self.amount = amount; self.submittedAt = submittedAt; self.status = status; self.rawTransaction = rawTransaction
    }
}

public enum WalletFailure: Error, LocalizedError, Equatable, Sendable {
    case invalidMnemonic, invalidAddress, invalidAmount, invalidEndpoint, networkMismatch, unconfiguredNetwork
    case insufficientFunds, unsupportedTransaction, staleReview, missingWallet, backupRequired
    case pendingTransfer
    case authenticationCancelled, authenticationFailed, locked, missingEntitlement, duplicateWallet, corruptStorage
    case serviceUnavailable, invalidResponse, broadcastUncertain, operationInProgress
    public var errorDescription: String? {
        switch self {
        case .invalidMnemonic: "助记词格式或校验不正确。请核对单词和顺序。"
        case .invalidAddress: "收款地址不符合所选网络。"
        case .invalidAmount: "请输入大于零、精度正确的金额。"
        case .invalidEndpoint: "节点地址必须使用 HTTPS，且不能包含账户、密码或查询参数。"
        case .networkMismatch: "节点网络身份不匹配，已停止操作。"
        case .unconfiguredNetwork: "请先配置并核验节点。合芽研究网还需要可信网络清单。"
        case .insufficientFunds: "可用余额不足以支付金额和网络费用。"
        case .unsupportedTransaction: "此版本仅支持普通原生币转账。"
        case .staleReview: "交易预览已过期或网络状态已变化，请重新核对。"
        case .missingWallet: "请先创建或导入钱包。"
        case .backupRequired: "请先完成助记词备份确认。"
        case .pendingTransfer: "此网络仍有待确认或广播结果未知的转账，请先核对记录。"
        case .authenticationCancelled: "已取消身份验证。"
        case .authenticationFailed: "身份验证未通过。"
        case .locked: "设备已锁定或安全存储当前不可用。"
        case .missingEntitlement: "此安装包的安全存储权限不可用，请使用正确签名的版本。"
        case .duplicateWallet: "当前设备已存在钱包，请先核对现有钱包。"
        case .corruptStorage: "钱包记录无法读取。请保留备份，停止操作。"
        case .serviceUnavailable: "节点暂时无法连接，请稍后重试。"
        case .invalidResponse: "节点返回的数据不符合协议。"
        case .broadcastUncertain: "广播结果未确定。请先核对交易哈希，避免重复发送。"
        case .operationInProgress: "已有操作进行中，请稍候。"
        }
    }
}
