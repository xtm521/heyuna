import SwiftUI

struct WalletLicensesView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var notices: String?
    @State private var unavailable = false

    var body: some View {
        NavigationStack {
            Group {
                if let notices {
                    ScrollView {
                        Text(notices)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(24)
                    }
                } else if unavailable {
                    ContentUnavailableView {
                        Label("许可文件不可用", systemImage: "doc.text")
                    } description: {
                        Text("此安装包中未找到可读取的开源许可文件。")
                    }
                } else {
                    ProgressView("正在读取许可…")
                }
            }
            .navigationTitle("开源许可")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .task {
                guard let url = Bundle.main.url(forResource: "ThirdPartyNotices", withExtension: "txt"),
                      let content = try? String(contentsOf: url, encoding: .utf8),
                      !content.isEmpty else {
                    unavailable = true
                    return
                }
                notices = content
            }
        }
        #if os(macOS)
        .frame(width: 640, height: 680)
        #endif
    }
}
