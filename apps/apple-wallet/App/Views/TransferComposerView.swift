import SwiftUI
import WalletKit

struct TransferComposerView: View {
    @Bindable var store: WalletStore
    @Environment(\.dismiss) private var dismiss
    @State private var recipient = ""
    @State private var amount = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("网络", value: store.selectedNetwork.title)
                    if let balance = store.balance, balance.network == store.selectedNetwork {
                        LabeledContent("已核验余额", value: "\(balance.formatted) \(store.selectedNetwork.symbol)")
                    }
                }
                Section("收款人") {
                    TextField("完整收款地址", text: $recipient, axis: .vertical)
                        .font(.system(.body, design: .monospaced))
                        .autocorrectionDisabled()
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.asciiCapable)
                        #endif
                        .accessibilityLabel("完整收款地址")
                }
                Section {
                    HStack(alignment: .firstTextBaseline) {
                        TextField("0", text: $amount)
                            .font(.title2.monospacedDigit())
                            #if os(iOS)
                            .keyboardType(.decimalPad)
                            #endif
                            .accessibilityLabel("转账金额")
                        Text(store.selectedNetwork.symbol).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 6)
                } header: {
                    Text("金额")
                } footer: {
                    Text("网络费用将在下一步单独显示。仅支持所选网络原生资产的普通转账。")
                }
                Section {
                    Button {
                        Task { await store.prepareTransfer(to: recipient, amount: amount) }
                    } label: {
                        HStack {
                            Spacer()
                            if store.isBusy { ProgressView().controlSize(.small) }
                            Text("核对交易")
                            Spacer()
                        }
                        .frame(minHeight: 30)
                    }
                    .disabled(store.isBusy || recipient.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || amount.isEmpty)
                    .accessibilityIdentifier("wallet.transfer.review")
                }
                if let message = store.message {
                    Section {
                        Label(message, systemImage: "info.circle")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("转账")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") {
                        store.dismissReview()
                        dismiss()
                    }
                    .disabled(store.isBusy)
                }
            }
            .sheet(item: Binding(
                get: { store.review },
                set: { if $0 == nil { store.dismissReview() } }
            )) { review in
                TransferReviewView(store: store, review: review) {
                    dismiss()
                }
            }
            .interactiveDismissDisabled(store.isBusy)
        }
        #if os(macOS)
        .frame(width: 560, height: 610)
        #endif
    }
}

private struct TransferReviewView: View {
    @Bindable var store: WalletStore
    let review: TransferReview
    let submitted: () -> Void
    @State private var confirmedDetails = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    HStack(spacing: 12) {
                        Image(systemName: "arrow.up.right")
                            .font(.title2).foregroundStyle(WalletTheme.accent)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("\(review.amount) \(review.network.symbol)")
                                .font(.title2.weight(.semibold)).monospacedDigit()
                            Text(review.network.title).font(.callout).foregroundStyle(.secondary)
                        }
                    }
                    WalletCard {
                        VStack(alignment: .leading, spacing: 18) {
                            addressDetail("从", address: review.from)
                            Divider()
                            addressDetail("发送至", address: review.to)
                            Divider()
                            LabeledContent("预计网络费用", value: "\(review.fee) \(review.network.symbol)")
                                .font(.callout)
                            LabeledContent("预计总支出", value: "\(review.total) \(review.network.symbol)")
                                .font(.callout.weight(.semibold))
                        }
                    }
                    Text(review.explanation)
                        .font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Toggle("我已核对网络、完整收款地址、金额和费用。", isOn: $confirmedDetails)
                        .font(.callout)
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let expired = context.date >= review.expiresAt
                        VStack(alignment: .leading, spacing: 12) {
                            if expired {
                                Label("预览已过期，请返回重新核对。", systemImage: "clock.badge.exclamationmark")
                                    .font(.callout).foregroundStyle(.secondary)
                            }
                            Button {
                                Task {
                                    let count = store.activity.count
                                    await store.confirmTransfer()
                                    if store.review == nil, store.activity.count > count {
                                        submitted()
                                    }
                                }
                            } label: {
                                HStack(spacing: 8) {
                                    if store.isBusy { ProgressView().controlSize(.small) }
                                    Label("验证身份并签名广播", systemImage: "lock.shield")
                                }
                                .frame(maxWidth: .infinity, minHeight: 34)
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(!confirmedDetails || expired || store.isBusy)
                            .accessibilityIdentifier("wallet.transfer.confirm")
                        }
                    }
                    Text("链上交易通常无法撤回。签名完成后，应用会将交易提交给已配置的节点。")
                        .font(.caption).foregroundStyle(.secondary)
                    if let message = store.message {
                        Label(message, systemImage: "info.circle")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                }
                .padding(24)
            }
            .navigationTitle("核对交易")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("返回") { store.dismissReview() }
                        .disabled(store.isBusy)
                }
            }
            .interactiveDismissDisabled(store.isBusy)
        }
        #if os(macOS)
        .frame(width: 580, height: 740)
        #endif
    }

    private func addressDetail(_ label: String, address: String) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            AddressText(address: address)
        }
    }
}
