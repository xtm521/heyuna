// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "HeyunaWallet",
    platforms: [.iOS(.v17), .macOS("15.5")],
    products: [.library(name: "WalletKit", targets: ["WalletKit"])],
    dependencies: [
        .package(url: "https://github.com/attaswift/BigInt.git", exact: "5.4.1"),
        .package(url: "https://github.com/krzyzanowskim/CryptoSwift.git", exact: "1.10.0"),
        .package(url: "https://github.com/GigaBitcoin/secp256k1.swift", exact: "0.10.0"),
        .package(url: "https://github.com/bitcoindevkit/bdk-swift.git", exact: "3.1.1")
    ],
    targets: [
        .target(name: "Web3Core", dependencies: ["BigInt", "CryptoSwift", .product(name: "secp256k1", package: "secp256k1.swift")], path: "Vendor/Web3Core", exclude: ["LICENSE.md", "UPSTREAM.md"]),
        .target(name: "WalletKit", dependencies: ["Web3Core", "BigInt", .product(name: "BitcoinDevKit", package: "bdk-swift")]),
        .target(name: "WalletState", dependencies: ["WalletKit"], path: "App", exclude: ["Views", "HeyunaWalletApp.swift"], sources: ["WalletStore.swift"]),
        .testTarget(name: "WalletKitTests", dependencies: ["WalletKit", "WalletState", "BigInt", "Web3Core"])
    ]
)
