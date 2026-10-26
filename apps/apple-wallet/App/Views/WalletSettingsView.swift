import SwiftUI
import WalletKit

enum WalletAppearance: String, CaseIterable, Identifiable {
    case system, dark, light
    var id: String { rawValue }
    var title: String {
        switch self { case .system: "跟随系统"; case .dark: "深色"; case .light: "浅色" }
    }
    var colorScheme: ColorScheme? {
        switch self { case .system: nil; case .dark: .dark; case .light: .light }
    }
}

struct WalletSettingsView: View {
    @Bindable var store: WalletStore
    @AppStorage("wallet.appearance") private var appearance = WalletAppearance.dark.rawValue
    @State private var endpoint = ""
    @State private var showsBackup = false
    @State private var showsRemoval = false
    @State private var showsPrivacy = false
    @State private var showsLicenses = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Form {
            Section("安全") {
                LabeledContent("保管方式", value: "本机安全存储")
                if let account = store.account {
                    LabeledContent("恢复备份", value: account.backupConfirmed ? "已确认" : "待确认")
                    Button {
                        showsBackup = true
                    } label: {
                        Label("查看恢复助记词", systemImage: "key.horizontal")
                    }
                    .disabled(store.isBusy)
                    Button(role: .destructive) {
                        showsRemoval = true
                    } label: {
                        Label("从此设备移除钱包", systemImage: "trash")
                    }
                    .disabled(store.isBusy)
                }
            }

            Section {
                Picker("网络", selection: $store.selectedNetwork) {
                    ForEach(WalletNetwork.allCases) { network in
                        Text(network.title).tag(network)
                    }
                }
                .accessibilityIdentifier("wallet.network")
                if store.selectedNetwork == .heyuna {
                    Label("需要可信网络清单，合芽研究网暂不可用。", systemImage: "doc.badge.clock")
                        .font(.callout).foregroundStyle(.secondary)
                } else {
                    TextField(store.selectedNetwork.isBitcoin ? "HTTPS 节点接口地址" : "HTTPS RPC 地址", text: $endpoint)
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        #endif
                        .font(.system(.callout, design: .monospaced))
                        .accessibilityLabel("节点地址")
                        .accessibilityIdentifier("wallet.endpoint")
                    HStack {
                        Button("保存节点") { store.saveEndpoint(endpoint) }
                            .disabled(store.isBusy)
                            .accessibilityIdentifier("wallet.endpoint.save")
                        Spacer()
                        Button("核验连接") {
                            Task { await store.refresh() }
                        }
                        .disabled(store.isBusy || store.endpoint.isEmpty || store.account == nil)
                    }
                    if let balance = store.balance, balance.network == store.selectedNetwork {
                        Label("网络已核验 · 区块 \(balance.height)", systemImage: "checkmark.seal")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        Label("尚未核验连接", systemImage: "circle.dotted")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let chain = store.selectedNetwork.chainID {
                    LabeledContent("链 ID", value: String(chain))
                        .font(.caption)
                }
                LabeledContent("派生路径", value: store.selectedNetwork.derivation)
                    .font(.system(.caption, design: .monospaced))
            } header: {
                Text("网络与节点")
            } footer: {
                Text("没有预置公共节点。查询与广播由你保存的节点处理；密钥留在本机。")
            }

            Section("显示") {
                Picker("外观", selection: $appearance) {
                    ForEach(WalletAppearance.allCases) { item in
                        Text(item.title).tag(item.rawValue)
                    }
                }
            }

            Section("关于") {
                LabeledContent("合芽钱包", value: version)
                Button("隐私与数据") { showsPrivacy = true }
                Button("开源许可") { showsLicenses = true }
                    .accessibilityIdentifier("wallet.licenses")
                Text("当前版本支持 BTC 与 EVM 原生资产的普通转账。合芽研究网需完成网络清单接入。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let message = store.message {
                Section {
                    Label(message, systemImage: "info.circle")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("设置")
        .onAppear { endpoint = store.endpoint }
        .onChange(of: store.selectedNetwork) { _, _ in endpoint = store.endpoint }
        .sheet(isPresented: $showsBackup) { BackupView(store: store) }
        .sheet(isPresented: $showsRemoval) { RemoveWalletView(store: store) }
        .sheet(isPresented: $showsPrivacy) { WalletPrivacyView() }
        .sheet(isPresented: $showsLicenses) { WalletLicensesView() }
        .overlay {
            if scenePhase != .active { WalletPrivacyShield() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { store.lock() }
        }
    }

    private var version: String {
        let number = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1"
        return "\(number) (\(build))"
    }
}

struct BackupView: View {
    @Bindable var store: WalletStore
    @State private var visible = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Label("恢复助记词", systemImage: "key.horizontal")
                        .font(.title2.weight(.semibold))
                    Text("请在私密环境查看。助记词可以控制钱包全部资产，不要发送给任何人。")
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if visible, let words = store.backupWords {
                        MnemonicGrid(words: words).privacySensitive()
                        Button("隐藏助记词") { conceal() }
                            .buttonStyle(.bordered)
                    } else {
                        WalletCard {
                            VStack(alignment: .leading, spacing: 18) {
                                Image(systemName: "lock.shield").font(.largeTitle).foregroundStyle(WalletTheme.accent)
                                Text("通过系统身份验证后显示。")
                                    .font(.callout).foregroundStyle(.secondary)
                                Button {
                                    Task {
                                        await store.revealBackup()
                                        visible = store.backupWords != nil
                                    }
                                } label: {
                                    Label("安全显示助记词", systemImage: "eye")
                                }
                                .buttonStyle(.borderedProminent)
                                .disabled(store.isBusy)
                            }
                        }
                    }
                    if store.isBusy { ProgressView("正在验证身份…") }
                    if let message = store.message {
                        Text(message).font(.callout).foregroundStyle(.secondary)
                    }
                }
                .padding(28)
                .frame(maxWidth: 600)
            }
            .navigationTitle("钱包备份")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { conceal(); dismiss() }
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase != .active, visible || store.backupWords != nil { conceal() }
            }
            .onDisappear { conceal() }
        }
        #if os(macOS)
        .frame(width: 600, height: 720)
        #endif
    }

    private func conceal() {
        visible = false
        store.concealBackup()
    }
}

private struct RemoveWalletView: View {
    @Bindable var store: WalletStore
    @State private var hasBackup = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("从此设备移除钱包", systemImage: "trash")
                        .font(.headline)
                    Text("这会移除此设备保存的密钥和钱包记录。链上资产不受影响，但你需要原助记词才能恢复访问。")
                        .foregroundStyle(.secondary)
                    Toggle("我已在安全的地方保存正确的恢复助记词。", isOn: $hasBackup)
                }
                Section {
                    Button("验证身份并移除", role: .destructive) {
                        Task {
                            await store.forgetWallet()
                            if store.account == nil { dismiss() }
                        }
                    }
                    .disabled(!hasBackup || store.isBusy)
                    if store.isBusy { ProgressView("正在处理…") }
                    if let message = store.message {
                        Text(message).font(.callout).foregroundStyle(.secondary)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("移除钱包")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }.disabled(store.isBusy)
                }
            }
            .interactiveDismissDisabled(store.isBusy)
        }
        #if os(macOS)
        .frame(width: 520, height: 390)
        #endif
    }
}

private struct WalletPrivacyView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("密钥与签名") {
                    Text("恢复助记词在本机创建或导入，保存在受保护的本机安全存储中。签名在本机完成，需要系统身份验证。")
                    Text("请自行离线保存恢复备份。应用不提供助记词找回服务。")
                }
                Section("网络数据") {
                    Text("首次使用不会连接公共节点。保存并核验节点后，该节点可能收到你查询的钱包地址、网络信息和广播的已签名交易。")
                    Text("链上转账公开可查。收款地址和交易哈希不应被视为匿名身份。")
                }
                Section("本机记录") {
                    Text("应用在本机保留账户地址、节点配置与发起的交易记录。移除本机钱包不会删除链上记录。")
                }
            }
            .formStyle(.grouped)
            .navigationTitle("隐私与数据")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
        #if os(macOS)
        .frame(width: 560, height: 600)
        #endif
    }
}
