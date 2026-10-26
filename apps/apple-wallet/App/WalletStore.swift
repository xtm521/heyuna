import Foundation
import Observation
import WalletKit

private actor WalletDeriver {
    func draft(words: String?) throws -> WalletDraft {
        let phrase = try words.map(WalletCryptography.normalize) ?? WalletCryptography.generate()
        return WalletDraft(words: phrase.split(separator: " ").map(String.init), account: try WalletCryptography.account(words: phrase))
    }
}

@MainActor @Observable
final class WalletStore {
    private(set) var account: AccountRecord?
    var selectedNetwork: WalletNetwork = .bitcoinSignet {
        didSet { if oldValue != selectedNetwork { balance = nil; dismissReview() } }
    }
    private(set) var balance: BalanceSnapshot?
    private(set) var activity: [TransferRecord] = []
    private(set) var isBusy = false
    var message: String?
    private(set) var draft: WalletDraft?
    private(set) var backupWords: [String]?
    private(set) var review: TransferReview?
    private(set) var isLocked = true
    var endpoint: String { file.endpoints[selectedNetwork.id] ?? "" }

    @ObservationIgnored private let vault: any SecretVault
    @ObservationIgnored private let evm = EVMEngine()
    @ObservationIgnored private let bitcoin = BitcoinEngine()
    @ObservationIgnored private let deriver = WalletDeriver()
    @ObservationIgnored private var persistence: WalletPersistence?
    @ObservationIgnored private var file = WalletFile()
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var backupGeneration = 0
    @ObservationIgnored private var ready = false
    @ObservationIgnored private var initialization: Task<Void, Never>?

    init(vault: any SecretVault = KeychainSecretVault(), persistence suppliedPersistence: WalletPersistence? = nil) {
        self.vault = vault
        isBusy = true
        initialization = Task {
            defer { isBusy = false }
            do {
                let storage = try suppliedPersistence ?? WalletPersistence()
                let saved = try await storage.load()
                persistence = storage; file = saved
                account = saved.account; activity = saved.activity; ready = true
            } catch { show(error) }
        }
    }

    func waitUntilReady() async { await initialization?.value }

    func clearMessage() { message = nil }
    func concealBackup() { backupGeneration += 1; backupWords = nil }
    func createDraft() async { await makeDraft(words: nil) }
    func importDraft(words: String) async { await makeDraft(words: words) }
    private func makeDraft(words: String?) async {
        guard !isBusy, ready else { return }
        guard account == nil else { show(WalletFailure.duplicateWallet); return }
        isBusy = true; defer { isBusy = false }
        let token = generation
        do {
            let result = try await deriver.draft(words: words)
            guard generation == token else { return }
            draft = result; isLocked = false
        } catch { show(error) }
    }
    func cancelDraft() { generation += 1; draft = nil; backupWords = nil }

    func finishBackup() async {
        guard !isBusy, let draft, let persistence else { return }
        isBusy = true; defer { isBusy = false }
        let token = generation
        var data = Data(draft.words.joined(separator: " ").utf8)
        defer { data.resetBytes(in: data.indices) }
        do {
            try await vault.save(data, account: draft.account.id)
            guard token == generation else { try await vault.remove(account: draft.account.id); return }
            var next = file; next.account = draft.account
            do { try await persistence.save(next) }
            catch { try? await vault.remove(account: draft.account.id); throw error }
            file = next; account = draft.account; self.draft = nil; isLocked = true
        } catch { show(error) }
    }

    func saveEndpoint(_ value: String) {
        guard !isBusy else { show(WalletFailure.operationInProgress); return }
        do {
            guard selectedNetwork != .heyuna else { throw WalletFailure.unconfiguredNetwork }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { _ = try EndpointPolicy.validate(trimmed) }
            file.endpoints[selectedNetwork.id] = trimmed
            balance = nil; dismissReview()
            let snapshot = file
            Task { do { try await persistence?.save(snapshot) } catch { show(error) } }
        } catch { show(error) }
    }

    func refresh() async {
        guard !isBusy, let account else { return }
        isBusy = true; defer { isBusy = false }
        let network = selectedNetwork; let token = generation
        do {
            guard network != .heyuna, !endpoint.isEmpty else { throw WalletFailure.unconfiguredNetwork }
            let url = try EndpointPolicy.validate(endpoint)
            let snapshot = try await network.isBitcoin
                ? bitcoin.balance(account: account, network: network, endpoint: url)
                : evm.balance(account: account, network: network, endpoint: url)
            guard selectedNetwork == network, generation == token else { return }
            balance = snapshot
            for index in activity.indices where activity[index].network == network && activity[index].status != .confirmed && activity[index].status != .failed {
                let status = try await network.isBitcoin
                    ? bitcoin.status(activity[index], endpoint: url)
                    : evm.status(activity[index], endpoint: url)
                guard generation == token, selectedNetwork == network else { return }
                activity[index].status = status
            }
            file.activity = activity; try await persistence?.save(file)
        } catch { if generation == token { balance = nil; show(error) } }
    }

    func prepareTransfer(to: String, amount: String) async {
        guard !isBusy, let account else { return }
        isBusy = true; defer { isBusy = false }
        let token = generation; let network = selectedNetwork
        do {
            guard account.backupConfirmed else { throw WalletFailure.backupRequired }
            guard !activity.contains(where: { $0.network == network && ($0.status == .signed || $0.status == .submitted || $0.status == .unknown) }) else { throw WalletFailure.pendingTransfer }
            guard network != .heyuna, !endpoint.isEmpty else { throw WalletFailure.unconfiguredNetwork }
            let url = try EndpointPolicy.validate(endpoint)
            let result = try await network.isBitcoin
                ? bitcoin.prepare(account: account, network: network, endpoint: url, to: to, amount: amount)
                : evm.prepare(account: account, network: network, endpoint: url, to: to, amount: amount)
            guard token == generation, selectedNetwork == network else { return }
            review = result
        } catch { if generation == token { show(error) } }
    }

    func confirmTransfer() async {
        guard !isBusy, let review, let account, review.network == selectedNetwork else { return }
        isBusy = true; defer { isBusy = false; self.review = nil; isLocked = true }
        let token = generation
        do {
            let url = try EndpointPolicy.validate(endpoint)
            if review.network.isBitcoin { try await bitcoin.validateBeforeSigning(review: review, account: account, endpoint: url) }
            else { try await evm.validateBeforeSigning(review: review, account: account, endpoint: url) }
            guard token == generation else { throw WalletFailure.staleReview }
            var data = try await vault.read(account: account.id, reason: "验证身份并签名这笔转账")
            defer { data.resetBytes(in: data.indices) }
            guard token == generation, review.expiresAt > Date(), let words = String(data: data, encoding: .utf8) else { throw WalletFailure.staleReview }
            let submitted: TransferRecord
            if review.network.isBitcoin {
                let signed = try await bitcoin.sign(review: review, words: words, account: account, endpoint: url)
                guard generation == token else { throw WalletFailure.staleReview }
                try await rememberPending(hash: signed.hash, raw: signed.rawHex, review: signed.review)
                guard generation == token else { throw WalletFailure.staleReview }
                try await markAttempted(hash: signed.hash, network: review.network)
                guard generation == token else { throw WalletFailure.staleReview }
                submitted = try await bitcoin.broadcast(signed: signed, endpoint: url)
            } else {
                let signed = try await evm.sign(review: review, words: words, account: account, endpoint: url)
                guard generation == token else { throw WalletFailure.staleReview }
                try await rememberPending(hash: signed.hash, raw: signed.rawHex, review: signed.review)
                guard generation == token else { throw WalletFailure.staleReview }
                try await markAttempted(hash: signed.hash, network: review.network)
                guard generation == token else { throw WalletFailure.staleReview }
                submitted = try await evm.broadcast(signed: signed, endpoint: url)
            }
            if let index = activity.firstIndex(where: { $0.id == submitted.id }) { activity[index] = submitted }
            file.activity = activity; try await persistence?.save(file)
            balance = nil; message = "交易已广播，等待链上确认。"
        } catch { if token == generation { show(error) } }
    }

    private func rememberPending(hash: String, raw: String, review: TransferReview) async throws {
        guard let persistence else { throw WalletFailure.corruptStorage }
        let record = TransferRecord(network: review.network, hash: hash, to: review.to, amount: review.amount, submittedAt: Date(), status: .signed, rawTransaction: raw)
        // Persist the signed hash before attempting a network broadcast. Never retry automatically.
        if !activity.contains(where: { $0.id == record.id }) { activity.insert(record, at: 0) }
        file.activity = activity
        try await persistence.save(file)
    }

    private func markAttempted(hash: String, network: WalletNetwork) async throws {
        guard let index = activity.firstIndex(where: { $0.hash == hash && $0.network == network }), let persistence else { throw WalletFailure.corruptStorage }
        activity[index].status = .unknown; file.activity = activity
        try await persistence.save(file)
    }

    func rebroadcast(_ record: TransferRecord) async {
        guard !isBusy, let account, record.network == selectedNetwork,
              let original = activity.first(where: { $0.id == record.id }), original.rawTransaction != nil,
              [.signed, .unknown, .submitted].contains(original.status) else { return }
        isBusy = true; defer { isBusy = false }
        let token = generation
        do {
            let url = try EndpointPolicy.validate(endpoint)
            try await vault.authenticate(reason: "确认重新广播同一笔已签名交易，不创建新转账")
            guard generation == token else { throw WalletFailure.staleReview }
            try await markAttempted(hash: original.hash, network: original.network)
            guard generation == token else { throw WalletFailure.staleReview }
            let result = try await original.network.isBitcoin
                ? bitcoin.rebroadcast(record: original, account: account, endpoint: url)
                : evm.rebroadcast(record: original, account: account, endpoint: url)
            if let index = activity.firstIndex(where: { $0.id == result.id }) { activity[index] = result }
            file.activity = activity; try await persistence?.save(file)
            message = "同一笔交易已重新广播，请继续核对确认状态。"
        } catch { if token == generation { show(error) } }
    }

    func dismissReview() {
        generation += 1; review = nil
        Task { await evm.discard(); await bitcoin.discard() }
    }
    func lock() {
        generation += 1; backupGeneration += 1; draft = nil; backupWords = nil; review = nil; isLocked = true
        Task { await evm.discard(); await bitcoin.discard() }
    }
    func revealBackup() async {
        guard !isBusy, let account else { return }
        isBusy = true; defer { isBusy = false }
        let token = generation; let backupToken = backupGeneration
        do {
            var data = try await vault.read(account: account.id, reason: "验证身份以查看钱包恢复助记词")
            defer { data.resetBytes(in: data.indices) }
            guard token == generation, backupToken == backupGeneration, let words = String(data: data, encoding: .utf8) else { return }
            backupWords = words.split(separator: " ").map(String.init); isLocked = false
        } catch { if generation == token { show(error) } }
    }
    func forgetWallet() async {
        guard !isBusy, let account, let persistence else { return }
        isBusy = true; defer { isBusy = false }
        do {
            do {
                var proof = try await vault.read(account: account.id, reason: "验证身份以从此设备移除钱包")
                defer { proof.resetBytes(in: proof.indices) }
            } catch WalletFailure.missingWallet {
                // Only exact item-not-found is recoverable here; cancel/locked/entitlement failures preserve everything.
                try await vault.authenticate(reason: "原密钥不可用，验证身份以清理本机公开记录并重新导入备份")
            }
            try await vault.remove(account: account.id)
            var next = file; next.account = nil; next.activity = []
            try await persistence.save(next)
            file = next; self.account = nil; activity = []; balance = nil; lock()
        } catch { show(error) }
    }
    private func show(_ error: Error) {
        guard !(error is CancellationError) else { return }
        message = (error as? WalletFailure)?.errorDescription ?? "操作未完成，请检查网络或安全设置后重试。"
    }
}
