import SwiftUI
import WalletKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct ReceiveView: View {
    @Bindable var store: WalletStore
    @Environment(\.dismiss) private var dismiss

    private var address: String { store.account?.address(for: store.selectedNetwork) ?? "" }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 26) {
                    StatusLabel(title: store.selectedNetwork.title, symbol: "network")
                    ReceiveQRCode(value: address)
                        .frame(height: 240)
                    VStack(spacing: 10) {
                        Text("收款地址").font(.headline)
                        AddressText(address: address)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: 440)
                    HStack(spacing: 12) {
                        Button {
                            #if os(macOS)
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(address, forType: .string)
                            #else
                            UIPasteboard.general.string = address
                            #endif
                        } label: {
                            Label("复制地址", systemImage: "doc.on.doc")
                                .frame(maxWidth: .infinity, minHeight: 28)
                        }
                        .buttonStyle(.borderedProminent)
                        ShareLink(item: address) {
                            Label("分享", systemImage: "square.and.arrow.up")
                                .frame(maxWidth: .infinity, minHeight: 28)
                        }
                        .buttonStyle(.bordered)
                    }
                    .disabled(address.isEmpty)
                    Text("请仅向此地址发送 \(store.selectedNetwork.title) 网络的 \(store.selectedNetwork.symbol)。转账前核对完整地址。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    if store.selectedNetwork.isBitcoin {
                        Text("本版展示此钱包的首个原生隔离见证收款地址。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(28)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
            }
            .navigationTitle("收款")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
        #if os(macOS)
        .frame(width: 520, height: 640)
        #endif
    }
}
