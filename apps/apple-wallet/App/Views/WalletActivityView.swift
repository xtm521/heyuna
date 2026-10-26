import SwiftUI
import WalletKit

struct WalletActivityView: View {
    @Bindable var store: WalletStore
    @State private var pendingRebroadcast: TransferRecord?

    var body: some View {
        Group {
            if store.activity.isEmpty {
                ContentUnavailableView {
                    Label("还没有转账记录", systemImage: "arrow.left.arrow.right")
                } description: {
                    Text("本机发起的交易会显示在这里。链上状态经节点核验后更新。")
                }
            } else {
                List {
                    Section {
                        ForEach(store.activity) { record in
                            DisclosureGroup {
                                VStack(alignment: .leading, spacing: 10) {
                                    Text("收款地址").font(.caption).foregroundStyle(.secondary)
                                    AddressText(address: record.to)
                                    Text("交易哈希").font(.caption).foregroundStyle(.secondary)
                                    AddressText(address: record.hash)
                                    Text(record.submittedAt, format: .dateTime.year().month().day().hour().minute())
                                        .font(.caption).foregroundStyle(.secondary)
                                    if canRebroadcast(record) {
                                        Button {
                                            pendingRebroadcast = record
                                        } label: {
                                            Label("重新广播同一笔", systemImage: "arrow.clockwise")
                                        }
                                        .disabled(store.isBusy)
                                        .accessibilityIdentifier("wallet.transfer.rebroadcast")
                                    }
                                }
                                .padding(.vertical, 10)
                            } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "arrow.up.right.circle")
                                        .font(.title2).foregroundStyle(WalletTheme.accent)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text("转账 \(record.amount) \(record.network.symbol)")
                                            .font(.callout.weight(.medium))
                                        Text(record.network.title).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text(status(record.status))
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                .padding(.vertical, 8)
                            }
                        }
                    } footer: {
                        Text("仅展示本机记录，不能代替完整链上历史。")
                    }
                }
            }
        }
        .navigationTitle("转账记录")
        .alert("重新广播同一笔交易？", isPresented: Binding(
            get: { pendingRebroadcast != nil },
            set: { if !$0 { pendingRebroadcast = nil } }
        ), presenting: pendingRebroadcast) { record in
            Button("验证身份并重新广播") {
                Task { await store.rebroadcast(record) }
                pendingRebroadcast = nil
            }
            .disabled(store.isBusy)
            Button("取消", role: .cancel) { pendingRebroadcast = nil }
        } message: { record in
            Text("仅重复广播相同哈希的已签名交易，不会重新支付或签名新交易；仍需系统身份验证。\n\n网络：\(record.network.title)\n交易哈希：\(record.hash)")
        }
    }

    private func status(_ value: TransferRecord.Status) -> String {
        switch value {
        case .signed: "已签名 · 尚未广播"
        case .submitted: "已广播 · 待确认"
        case .confirmed: "已确认"
        case .failed: "执行失败"
        case .unknown: "广播结果待核对"
        }
    }

    private func canRebroadcast(_ record: TransferRecord) -> Bool {
        guard record.rawTransaction?.isEmpty == false else { return false }
        return switch record.status {
        case .signed, .unknown, .submitted: true
        case .confirmed, .failed: false
        }
    }
}
