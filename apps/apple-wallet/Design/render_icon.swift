// Original Heyuna artwork. Run with `swift Design/render_icon.swift` from apps/apple-wallet.
import AppKit
let directory = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("Config/Assets.xcassets/AppIcon.appiconset")
let sizes = [16, 32, 64, 128, 256, 512, 1024]
for size in sizes {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let context = NSGraphicsContext(bitmapImageRep: bitmap)!
    NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = context
    context.cgContext.scaleBy(x: CGFloat(size)/1024, y: CGFloat(size)/1024)
    let canvas = NSBezierPath(rect: NSRect(x: 0, y: 0, width: 1024, height: 1024))
    NSGradient(starting: NSColor(calibratedWhite: 0.14, alpha: 1), ending: NSColor(calibratedWhite: 0.035, alpha: 1))!.draw(in: canvas, angle: -60)
    let left = NSBezierPath()
    left.move(to: NSPoint(x: 500, y: 232)); left.curve(to: NSPoint(x: 230, y: 675), controlPoint1: NSPoint(x: 330, y: 260), controlPoint2: NSPoint(x: 202, y: 432))
    left.curve(to: NSPoint(x: 500, y: 232), controlPoint1: NSPoint(x: 510, y: 650), controlPoint2: NSPoint(x: 620, y: 384)); left.close()
    NSGradient(colors: [.init(calibratedWhite: 0.95, alpha: 1), .init(calibratedWhite: 0.38, alpha: 1)])!.draw(in: left, angle: 30)
    let right = NSBezierPath()
    right.move(to: NSPoint(x: 515, y: 225)); right.curve(to: NSPoint(x: 808, y: 700), controlPoint1: NSPoint(x: 450, y: 458), controlPoint2: NSPoint(x: 650, y: 698))
    right.curve(to: NSPoint(x: 515, y: 225), controlPoint1: NSPoint(x: 800, y: 414), controlPoint2: NSPoint(x: 680, y: 280)); right.close()
    NSGradient(colors: [.init(calibratedRed: 0.35, green: 0.83, blue: 0.71, alpha: 1), .init(calibratedRed: 0.10, green: 0.33, blue: 0.29, alpha: 1)])!.draw(in: right, angle: -35)
    let center = NSBezierPath()
    center.move(to: NSPoint(x: 510, y: 310)); center.curve(to: NSPoint(x: 545, y: 825), controlPoint1: NSPoint(x: 346, y: 560), controlPoint2: NSPoint(x: 462, y: 790))
    center.curve(to: NSPoint(x: 510, y: 310), controlPoint1: NSPoint(x: 720, y: 620), controlPoint2: NSPoint(x: 580, y: 385)); center.close()
    NSGradient(colors: [.init(calibratedWhite: 0.99, alpha: 1), .init(calibratedWhite: 0.46, alpha: 1)])!.draw(in: center, angle: 10)
    NSGraphicsContext.restoreGraphicsState()
    try bitmap.representation(using: .png, properties: [:])!.write(to: directory.appendingPathComponent("icon-\(size).png"))
}
