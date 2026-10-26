import SwiftUI
import WalletKit

enum WalletDestination: String, CaseIterable, Identifiable {
    case assets, activity, settings
    var id: String { rawValue }
    var title: String {
        switch self { case .assets: "资产"; case .activity: "记录"; case .settings: "设置" }
    }
    var symbol: String {
        switch self { case .assets: "square.stack.3d.up"; case .activity: "clock.arrow.circlepath"; case .settings: "gearshape" }
    }
}

private enum WalletSheet: String, Identifiable {
    case receive, transfer, backup
    var id: String { rawValue }
}

struct WalletRootView: View {
    @Bindable var store: WalletStore
    @State private var destination: WalletDestination? = .assets
    @State private var sheet: WalletSheet?
    @Environment(\.scenePhase) private var scenePhase
    #if os(macOS)
    @Environment(\.openSettings) private var openSettings
    #endif

    var body: some View {
        Group {
            if store.account == nil {
                WalletSetupView(store: store)
            } else {
                navigation
            }
        }
        .sheet(item: $sheet) { presented in
            switch presented {
            case .receive: ReceiveView(store: store)
            case .transfer: TransferComposerView(store: store)
            case .backup: BackupView(store: store)
            }
        }
        .alert("操作提示", isPresented: Binding(
            get: { store.message != nil },
            set: { if !$0 { store.clearMessage() } }
        )) {
            Button("好") { store.clearMessage() }
        } message: {
            Text(store.message ?? "")
        }
        .overlay {
            if scenePhase != .active {
                WalletPrivacyShield()
            }
        }
    }

    @ViewBuilder
    private var navigation: some View {
        #if os(macOS)
        NavigationSplitView {
            VStack(alignment: .leading, spacing: 24) {
                HStack(spacing: 10) {
                    HeyunaMark(size: 32)
                    Text("Heyuna").font(.title3.weight(.semibold))
                }
                .padding(.horizontal, 20)
                .padding(.top, 22)
                List(selection: $destination) {
                    ForEach([WalletDestination.assets, .activity]) { item in
                        Label(item.title, systemImage: item.symbol).tag(item)
                    }
                }
                .listStyle(.sidebar)
                Spacer(minLength: 0)
                SettingsLink {
                    Label("设置", systemImage: "gearshape")
                }
                .buttonStyle(.plain)
                .padding(20)
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 210, max: 260)
        } detail: {
            detail(destination ?? .assets)
                .frame(minWidth: 580, minHeight: 600)
        }
        #else
        TabView(selection: Binding(
            get: { destination ?? .assets },
            set: { destination = $0 }
        )) {
            ForEach(WalletDestination.allCases) { item in
                NavigationStack { detail(item) }
                    .tabItem { Label(item.title, systemImage: item.symbol) }
                    .tag(item)
            }
        }
        #endif
    }

    @ViewBuilder
    private func detail(_ selected: WalletDestination) -> some View {
        switch selected {
        case .assets:
            WalletHomeView(store: store, receive: { sheet = .receive }, send: { sheet = .transfer }) {
                #if os(macOS)
                openSettings()
                #else
                destination = .settings
                #endif
            }
        case .activity:
            WalletActivityView(store: store)
        case .settings:
            WalletSettingsView(store: store)
        }
    }
}

struct WalletPrivacyShield: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            (scheme == .dark ? WalletTheme.ink : Color.white)
            VStack(spacing: 14) {
                HeyunaMark(size: 56)
                Text("合芽钱包").font(.headline)
                Text("内容已隐藏").font(.callout).foregroundStyle(.secondary)
            }
        }
        .ignoresSafeArea()
        .accessibilityElement(children: .combine)
    }
}
