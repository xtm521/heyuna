import SwiftUI
import WalletKit

struct WalletSetupView: View {
    @Bindable var store: WalletStore
    @State private var route: SetupRoute = .welcome
    @State private var importedWords = ""
    @State private var answers: [Int: String] = [:]
    @State private var challenge: [Int] = []
    @State private var understandsBackup = false
    @State private var wordsVisible = true
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private enum SetupRoute: Equatable { case welcome, importWords, backup, verify }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    switch route {
                    case .welcome: welcome
                    case .importWords: importForm
                    case .backup: backup
                    case .verify: verification
                    }
                }
                .padding(28)
                .frame(maxWidth: 600)
                .frame(maxWidth: .infinity, alignment: .center)
            }
            .navigationTitle(route == .welcome ? "" : "设置钱包")
            .toolbar {
                if route != .welcome {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("取消") { reset() }
                            .disabled(store.isBusy)
                    }
                }
            }
            .overlay {
                if store.isBusy {
                    ZStack {
                        Rectangle().fill(.ultraThinMaterial)
                        ProgressView("正在安全处理…")
                            .padding(24)
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                    }
                }
            }
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: route)
            .onChange(of: scenePhase) { _, phase in
                if phase != .active { wordsVisible = false }
                if phase == .background { reset() }
            }
        }
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 680)
        #endif
    }

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 32) {
            HeyunaMark(size: 68)
            VStack(alignment: .leading, spacing: 14) {
                Text("合芽钱包")
                    .font(.largeTitle.weight(.semibold))
                Text("掌握自己的密钥。")
                    .font(.title2.weight(.medium))
                    .foregroundStyle(.secondary)
                Text("在 iPhone 与 Mac 上管理 BTC 和 EVM 原生资产。钱包独立运行，签名需要你的确认。")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            WalletCard {
                VStack(alignment: .leading, spacing: 18) {
                    setupFeature("本机保管", detail: "助记词保存于本机受保护的安全存储。", icon: "lock.shield")
                    setupFeature("独立确认", detail: "先核对收款地址、网络与费用，再验证身份。", icon: "checkmark.seal")
                    setupFeature("自行连接", detail: "首次不联网，由你配置节点。", icon: "network")
                }
            }
            VStack(spacing: 12) {
                Button {
                    Task {
                        await store.createDraft()
                        if store.draft != nil {
                            wordsVisible = true
                            route = .backup
                        }
                    }
                } label: {
                    Text("创建新钱包").frame(maxWidth: .infinity, minHeight: 34)
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("wallet.create")

                Button {
                    route = .importWords
                } label: {
                    Text("导入已有钱包").frame(maxWidth: .infinity, minHeight: 34)
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("wallet.import")
            }
            Text("开发测试版，请勿存入真实资产。请保管好恢复助记词，合芽无法代你恢复钱包。")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 24)
    }

    private var importForm: some View {
        VStack(alignment: .leading, spacing: 20) {
            heading("恢复你的钱包", detail: "输入 12 或 24 个助记词，以空格分隔。请在私密环境操作。")
            SecureField("输入 12 或 24 个单词，以空格分隔", text: $importedWords)
                .font(.system(.body, design: .monospaced))
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
                .textFieldStyle(.roundedBorder)
                .padding(.vertical, 10)
                .privacySensitive()
                .accessibilityLabel("助记词")
                .accessibilityIdentifier("wallet.import.words")
            Text("助记词只在本机处理，不会发送到节点。仅支持标准英语 12 或 24 词，不支持额外的 BIP39 恢复口令。")
                .font(.caption).foregroundStyle(.secondary)
            Text("BTC 使用 BIP84 原生隔离见证账户 0；EVM 使用 m/44'/60'/0'/0/0。其他派生路径中的账户不会显示在本版中。")
                .font(.caption).foregroundStyle(.secondary)
            Button {
                Task {
                    await store.importDraft(words: importedWords)
                    if store.draft != nil {
                        importedWords = ""
                        wordsVisible = true
                        route = .backup
                    }
                }
            } label: {
                Text("检查助记词").frame(maxWidth: .infinity, minHeight: 28)
            }
            .buttonStyle(.borderedProminent)
            .disabled(importedWords.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityIdentifier("wallet.import.continue")
        }
    }

    @ViewBuilder
    private var backup: some View {
        if let draft = store.draft {
            VStack(alignment: .leading, spacing: 22) {
                heading("备份恢复助记词", detail: "按顺序抄写这 \(draft.words.count) 个单词，保存在只有你能访问的地方。")
                if wordsVisible {
                    MnemonicGrid(words: draft.words)
                        .privacySensitive()
                } else {
                    WalletCard {
                        VStack(alignment: .leading, spacing: 14) {
                            Label("助记词已隐藏", systemImage: "eye.slash")
                            Button("继续备份") { wordsVisible = true }
                        }
                    }
                }
                Label("不要截图、上传云端或发送给任何人。任何持有助记词的人都能控制资产。", systemImage: "exclamationmark.shield")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button {
                    challenge = Array(draft.words.indices.shuffled().prefix(3)).sorted()
                    answers = [:]
                    understandsBackup = false
                    route = .verify
                } label: {
                    Text("已抄写，核对备份").frame(maxWidth: .infinity, minHeight: 28)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!wordsVisible)
            }
        } else {
            expiredDraft
        }
    }

    @ViewBuilder
    private var verification: some View {
        if let draft = store.draft {
            VStack(alignment: .leading, spacing: 22) {
                heading("核对你的备份", detail: "按照纸面备份填写对应位置的单词。")
                ForEach(challenge, id: \.self) { index in
                    VStack(alignment: .leading, spacing: 8) {
                        Text("第 \(index + 1) 个单词").font(.callout.weight(.medium))
                        SecureField("输入单词", text: Binding(
                            get: { answers[index] ?? "" },
                            set: { answers[index] = $0 }
                        ))
                        .textFieldStyle(.roundedBorder)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        #endif
                        .privacySensitive()
                    }
                }
                Toggle("我理解：丢失助记词可能永久失去资产，合芽无法重置它。", isOn: $understandsBackup)
                    .font(.callout)
                Button {
                    Task {
                        await store.finishBackup()
                        if store.account != nil { importedWords = ""; answers = [:] }
                    }
                } label: {
                    Text("完成并安全保存").frame(maxWidth: .infinity, minHeight: 28)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!backupMatches(draft.words) || !understandsBackup)
                .accessibilityIdentifier("wallet.backup.confirm")
                Button("重新查看助记词") { route = .backup }
                    .buttonStyle(.borderless)
            }
        } else {
            expiredDraft
        }
    }

    private var expiredDraft: some View {
        ContentUnavailableView {
            Label("设置已暂停", systemImage: "lock")
        } description: {
            Text("为保护助记词，请重新开始。")
        } actions: {
            Button("返回") { reset() }
        }
    }

    private func backupMatches(_ words: [String]) -> Bool {
        challenge.count == 3 && challenge.allSatisfy { index in
            (answers[index] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == words[index]
        }
    }

    private func reset() {
        store.cancelDraft()
        importedWords = ""
        answers = [:]
        challenge = []
        understandsBackup = false
        wordsVisible = false
        route = .welcome
    }

    private func heading(_ title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.title2.weight(.semibold))
            Text(detail).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func setupFeature(_ title: String, detail: String, icon: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon).foregroundStyle(WalletTheme.accent).frame(width: 24)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.callout.weight(.semibold))
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct MnemonicGrid: View {
    let words: [String]

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 130), spacing: 10)], spacing: 10) {
            ForEach(Array(words.enumerated()), id: \.offset) { index, word in
                HStack(spacing: 10) {
                    Text("\(index + 1)")
                        .foregroundStyle(.tertiary)
                        .frame(minWidth: 20, alignment: .trailing)
                    Text(word).foregroundStyle(.primary)
                    Spacer(minLength: 0)
                }
                .font(.system(.callout, design: .monospaced))
                .padding(.horizontal, 12)
                .padding(.vertical, 12)
                .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 9))
                .accessibilityElement(children: .combine)
            }
        }
    }
}
