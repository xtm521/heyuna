import SwiftUI

@main
struct HeyunaWalletApp: App {
    @State private var store = WalletStore()
    @AppStorage("wallet.appearance") private var appearance = WalletAppearance.dark.rawValue
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        #if os(macOS)
        Window("合芽钱包", id: "heyuna.wallet") {
            walletWindow
        }
        .defaultSize(width: 1040, height: 760)
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }

        Settings {
            WalletSettingsView(store: store)
                .frame(width: 540, height: 620)
                .tint(WalletTheme.accent)
                .preferredColorScheme(WalletAppearance(rawValue: appearance)?.colorScheme)
        }
        #else
        WindowGroup("合芽钱包") {
            walletWindow
        }
        #endif
    }

    private var walletWindow: some View {
        WalletRootView(store: store)
            .tint(WalletTheme.accent)
            .preferredColorScheme(WalletAppearance(rawValue: appearance)?.colorScheme)
            .onChange(of: scenePhase) { _, phase in
                if phase == .background { store.lock() }
            }
    }
}
