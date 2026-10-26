import CoreImage.CIFilterBuiltins
import SwiftUI

struct ReceiveQRCode: View {
    let value: String

    var body: some View {
        Group {
            if let image = makeImage() {
                Image(decorative: image, scale: 1)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .padding(16)
                    .background(.white, in: RoundedRectangle(cornerRadius: 16))
                    .accessibilityLabel("收款地址二维码")
            } else {
                ContentUnavailableView("无法生成二维码", systemImage: "qrcode")
            }
        }
        .frame(maxWidth: 240, maxHeight: 240)
    }

    private func makeImage() -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(value.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        return CIContext().createCGImage(output, from: output.extent)
    }
}
