import SwiftUI

enum WalletTheme {
    static let accent = Color(red: 0.22, green: 0.72, blue: 0.60)
    static let ink = Color(red: 0.055, green: 0.065, blue: 0.068)

    static func surface(_ scheme: ColorScheme) -> Color {
        scheme == .dark
            ? Color(red: 0.085, green: 0.098, blue: 0.10)
            : Color(red: 0.965, green: 0.975, blue: 0.97)
    }
}

struct WalletCard<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(WalletTheme.surface(scheme), in: RoundedRectangle(cornerRadius: 18))
            .overlay {
                RoundedRectangle(cornerRadius: 18)
                    .strokeBorder(.primary.opacity(scheme == .dark ? 0.07 : 0.05))
            }
    }
}

struct HeyunaMark: View {
    var size: CGFloat = 38

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.29)
                .fill(WalletTheme.accent.opacity(0.13))
            SproutShape()
                .fill(WalletTheme.accent.gradient)
                .padding(size * 0.22)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private struct SproutShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let w = rect.width
        let h = rect.height
        path.move(to: CGPoint(x: w * 0.49, y: h * 0.98))
        path.addCurve(to: CGPoint(x: w * 0.50, y: h * 0.43), control1: CGPoint(x: w * 0.40, y: h * 0.77), control2: CGPoint(x: w * 0.43, y: h * 0.57))
        path.addCurve(to: CGPoint(x: w * 0.05, y: h * 0.06), control1: CGPoint(x: w * 0.20, y: h * 0.45), control2: CGPoint(x: w * 0.04, y: h * 0.29))
        path.addCurve(to: CGPoint(x: w * 0.48, y: h * 0.30), control1: CGPoint(x: w * 0.30, y: 0), control2: CGPoint(x: w * 0.43, y: h * 0.13))
        path.addCurve(to: CGPoint(x: w * 0.92, y: h * 0.03), control1: CGPoint(x: w * 0.58, y: h * 0.07), control2: CGPoint(x: w * 0.75, y: 0))
        path.addCurve(to: CGPoint(x: w * 0.55, y: h * 0.52), control1: CGPoint(x: w * 0.98, y: h * 0.32), control2: CGPoint(x: w * 0.81, y: h * 0.51))
        path.addCurve(to: CGPoint(x: w * 0.58, y: h * 0.98), control1: CGPoint(x: w * 0.50, y: h * 0.67), control2: CGPoint(x: w * 0.53, y: h * 0.84))
        path.closeSubpath()
        return path
    }
}

struct AddressText: View {
    let address: String
    var compact = false

    var body: some View {
        Text(compact ? abbreviated : address)
            .font(.system(.callout, design: .monospaced))
            .textSelection(.enabled)
            .foregroundStyle(.secondary)
            .lineLimit(compact ? 1 : nil)
            .accessibilityLabel(address)
    }

    private var abbreviated: String {
        guard address.count > 22 else { return address }
        return "\(address.prefix(10))…\(address.suffix(8))"
    }
}

struct StatusLabel: View {
    let title: String
    let symbol: String

    var body: some View {
        Label(title, systemImage: symbol)
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.primary.opacity(0.045), in: Capsule())
    }
}
