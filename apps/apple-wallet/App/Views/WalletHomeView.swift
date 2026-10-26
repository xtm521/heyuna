import SwiftUI
import WalletKit

struct WalletHomeView: View {
    @Bindable var store: WalletStore
    let receive: () -> Void
    let send: () -> Void
    let settings: () -> Void

    private var verifiedBalance: BalanceSnapshot? {
        store.balance?.network == store.selectedNetwork ? store.balance : nil
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                accountSummary
                balanceCard
                networks
            }
            .padding(24)
            .frame(maxWidth: 840)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("资产")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { await store.refresh() }
                } label: {
                    Label("刷新", systemImage: "arrow.clockwise")
                }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(store.isBusy || store.endpoint.isEmpty || store.selectedNetwork == .heyuna)
                .accessibilityIdentifier("wallet.refresh")
            }
        }
        .refreshable {
            if !store.endpoint.isEmpty { await store.refresh() }
        }
    }

    private var accountSummary: some View {
        HStack(alignment: .center, spacing: 12) {
            HeyunaMark(size: 42)
            VStack(alignment: .leading, spacing: 4) {
                Text("个人钱包").font(.headline)
                Text("密钥由本机安全存储保护")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "lock.shield")
                .foregroundStyle(WalletTheme.accent)
                .accessibilityLabel("本机安全存储")
        }
    }

    private var balanceCard: some View {
        WalletCard {
            VStack(alignment: .leading, spacing: 20) {
                Picker("当前网络", selection: $store.selectedNetwork) {
                    ForEach(WalletNetwork.allCases) { network in
                        Text(network.title).tag(network)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("wallet.network")

                VStack(alignment: .leading, spacing: 8) {
                    Text("已确认可用余额")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            balanceAmount
                            Text(store.selectedNetwork.symbol).font(.title3).foregroundStyle(.secondary)
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            balanceAmount
                            Text(store.selectedNetwork.symbol).font(.callout).foregroundStyle(.secondary)
                        }
                    }
                    if let balance = verifiedBalance {
                        Label("已核验 · 区块 \(balance.height)", systemImage: "checkmark.seal")
                            .font(.caption).foregroundStyle(.secondary)
                        Text(balance.checkedAt, format: .dateTime.month().day().hour().minute())
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text(store.selectedNetwork == .heyuna ? "等待可信网络清单，研究网暂不可用" : "连接并核验节点后显示余额")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }

                if let account = store.account {
                    Divider()
                    AddressText(address: account.address(for: store.selectedNetwork), compact: true)
                }

                HStack(spacing: 12) {
                    Button(action: receive) {
                        Label("收款", systemImage: "arrow.down.left")
                            .frame(maxWidth: .infinity, minHeight: 28)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(store.selectedNetwork == .heyuna)
                    .accessibilityIdentifier("wallet.receive")

                    Button(action: send) {
                        Label("转账", systemImage: "arrow.up.right")
                            .frame(maxWidth: .infinity, minHeight: 28)
                    }
                    .buttonStyle(.bordered)
                    .disabled(store.isBusy || verifiedBalance == nil || store.selectedNetwork == .heyuna)
                    .accessibilityIdentifier("wallet.send")
                }

                if store.selectedNetwork.isTestnet {
                    Label("测试网络资产不承诺价值或主网兑换。", systemImage: "flask")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .onChange(of: store.selectedNetwork) { _, _ in
            if !store.endpoint.isEmpty { Task { await store.refresh() } }
        }
    }

    private var balanceAmount: some View {
        Text(verifiedBalance?.formatted ?? "—")
            .font(.system(.largeTitle, design: .rounded, weight: .medium))
            .monospacedDigit()
            .contentTransition(.numericText())
            .accessibilityLabel(verifiedBalance.map { "已确认可用余额 \($0.formatted) \(store.selectedNetwork.symbol)" } ?? "余额尚未核验")
    }

    private var networks: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("网络").font(.headline)
                Spacer()
                Button("管理", action: settings)
                    .font(.callout)
                    .accessibilityIdentifier("wallet.settings")
            }
            ForEach(WalletNetwork.allCases) { network in
                Button {
                    store.selectedNetwork = network
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: network.isBitcoin ? "bitcoinsign.circle" : network == .heyuna ? "leaf.circle" : "diamond.circle")
                            .font(.title2)
                            .foregroundStyle(network == store.selectedNetwork ? WalletTheme.accent : .secondary)
                            .frame(width: 36)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(network.title).font(.callout.weight(.medium))
                            Text(network == .heyuna ? "等待网络清单" : "原生资产")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 12)
                        VStack(alignment: .trailing, spacing: 5) {
                            Text(network == store.selectedNetwork ? (verifiedBalance?.formatted ?? "—") : "—")
                                .font(.callout.monospacedDigit())
                            Text(network == store.selectedNetwork && verifiedBalance != nil ? "已核验" : "未核验")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
                    }
                    .padding(.vertical, 12)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if network != WalletNetwork.allCases.last { Divider() }
            }
        }
    }
}
