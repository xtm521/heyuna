# 原生钱包依赖、许可与来源

核对日期：2026-10-26。此清单对应本目录 `Package.swift`、`Package.resolved`、本机 SwiftPM 检出源码和 BDK 官方固定版本来源。**已收集直接依赖及已知源码组件原文许可；尚不是完整二进制依赖 SBOM 或独立安全审计。**

## 已锁定的直接组成

| 组成 | 固定版本 / revision | 使用与许可 |
| --- | --- | --- |
| BigInt | 5.4.1 / `793a7fac0bfc318e85994bf6900652e827aef33e` | 大整数；MIT，保留原文版权与许可 |
| CryptoSwift | 1.10.0 / `f2a627b84c1ff96f21ac2fcb623ab36142dd5512` | 密码实现；使用其原始自定义许可文本，包含产品致谢要求，不能简写成 MIT |
| secp256k1.swift | 0.10.0 / `48fb20fce4ca3aad89180448a127d5bc16f0e44c` | Swift secp256k1 接口；MIT，加下述 C 库及 SwiftCrypto 源码许可 |
| BDK Swift | 3.1.1 / `55284dc4e767c301c7926c412daad241c0667106` | Swift 包与预编译 FFI；顶层 MIT OR Apache-2.0，两套原文均保留，不能覆盖静态库内部全部组件 |
| Web3Core（vendored） | web3swift 3.3.2 / `b9c771bf3b94983d2f9b22096b4a267a72c16006` | 完整 `Sources/Web3Core`；Apache-2.0，保留源文件版权。仅有 HTTPURLResponse 兼容补丁，见 `Vendor/Web3Core/UPSTREAM.md` |

CryptoSwift 要求的产品文档致谢保留如下，应用的独立“第三方许可”页面也应展示同一原文：

> This product includes software developed by the "Marcin Krzyzanowski" (http://krzyzanowskim.com/).

最新版本、社区采用量、上游测试或其他软件的审计，均不证明本钱包的具体组合、内存管理、交易审查或发行包已经独立审计。

## 已知嵌入源码与实际编译范围

- `secp256k1` 产品依赖 `secp256k1_bindings`，实际使用 Bitcoin Core `secp256k1` C 子模块，revision **`01b819a8c7d485fdd3f024d77273f5769d75b2d3`**，MIT。其 `COPYING` 与本机 arm64 C 编译依赖闭包中不同版权行已保留在 notices。其他架构及 Release 最终链接内容仍需复核。
- 此 Swift 包通过符号链接及派生源码包含 Apple SwiftCrypto 的部分文件，子模块 revision **`92a04c10fc5ce0504f8396aac7392126033e547c`**（2.2.2）。包括 Digest、PrettyBytes、RNG、SecureBytes、Signature 等文件及带原版权的派生工具，适用 Apache-2.0；已保留完整 Apache 原文、适用的 NOTICE 开头与原始版权行。
- 当前产品没有链接同仓 `zkp` / `zkp_bindings` 目标。也没有把该包的格式化、lint、文档构建工具当成 App 运行依赖；它们出现在上游开发配置中不等于随 App 分发。
- SwiftCrypto 的 BoringSSL 目录名或上游完整 NOTICE 不能证明整个 BoringSSL、测试向量项目或构建脚本被本钱包链接。这里仅为已使用的源码部分保留相关原文，不复制无关测试/工具许可。BDK 二进制的 C 组件则另属下述未完成门槛。

## 原文打包与校验

[Config/ThirdPartyNotices.txt](Config/ThirdPartyNotices.txt) 为应用资源：包含直接依赖许可原文、适用的嵌入源码版权及 CryptoSwift 致谢，供两个平台的独立许可页面展示。最终归档须验证该文件实际存在且内容与源码一致，不能只验证仓库有文件。

下列 SHA-256 对应原始输入文件（不是整合后文本）；除 Web3Core 路径位于本仓库 Vendor，其余均相对本机 `.build/checkouts/`。完整原文未翻译或改写；SwiftCrypto NOTICE 只保留与实际源码部分相关的开头，省略仅适用于未分发测试/工具的章节。

| 原文路径 | SHA-256 |
| --- | --- |
| `BigInt/LICENSE.md` | `c3dfd0dca467f6d198bf365a954d4be6cb6b0e3d848ec724f86e5f579ca38d9e` |
| `CryptoSwift/LICENSE` | `e4ea9188602dd4217309aec044481b0a7d2f9d539b1d1673b9a1809709c804e0` |
| `Vendor/Web3Core/LICENSE.md` | `bf5f5fbe8b645db0087ac12918884ce89bd22a4c5fafbfd7635828e5947eff2a` |
| `secp256k1.swift/LICENSE` | `f2585d727479205c7176aeb71e50c06a6e1f2f0824cdff8e99f723a4ce1a8f3e` |
| `secp256k1.swift/Submodules/secp256k1/COPYING` | `a735999c7e5649df6fcda6fb06ab97435851c392b1b93494ae8725f37441632f` |
| `secp256k1.swift/Submodules/swift-crypto/LICENSE.txt` | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |
| `bdk-swift/LICENSE` | `031dbd187e6e01b8b0ab57250038c3810633323e61a0a4d1d0c171760dba38c7` |
| `bdk-swift/LICENSE-APACHE` | `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4` |
| `bdk-swift/LICENSE-MIT` | `638da3722c9e102ccd8011d82f61ae3b611174e4a0f8da185c582df137b60a8c` |
| `secp256k1.swift/Submodules/swift-crypto/NOTICE.txt`（原文件，打包适用部分） | `c1e2be544c25da4580c0aa246ddf93887aa4e74e455057500d8792cd0500ab1b` |

用于核对的 `.state/apple-wallet-crypto-research/bdk-LICENSE-APACHE` 与 `bdk-LICENSE-MIT` 和当前检出的 BDK Swift 相应文件逐字节一致。上述文件是许可来源，不是密钥材料。

## BDK 静态 Rust 库：必须保留的发行门槛

SwiftPM 声明的官方产物为 [BDK Swift 3.1.1 XCFramework](https://github.com/bitcoindevkit/bdk-swift/releases/download/3.1.1/bdkFFI.xcframework.zip)，上游 `Package.swift` 声明归档 SHA-256 为 **`5e7f8ac46306f9de7ec2cc1c6486d9db5141c793d33cc13071ea7d1e3dae817f`**。这是上游分发校验身份，不是 Heyuna 对所有内部依赖的安全或许可证明。

已查证对应官方 [bdk-ffi v3.1.1](https://github.com/bitcoindevkit/bdk-ffi/tree/1c5f4863c6a53cc9d063d34c4e13c91fea5c58de)，commit **`1c5f4863c6a53cc9d063d34c4e13c91fea5c58de`**：

- [Cargo.toml](https://github.com/bitcoindevkit/bdk-ffi/blob/1c5f4863c6a53cc9d063d34c4e13c91fea5c58de/bdk-ffi/Cargo.toml) 声明 bdk-ffi 3.1.1，锁定 bdk_wallet 3.1.0 与 UniFFI 0.31.2，启用的组件不止钱包签名路径。
- [Cargo.lock](https://github.com/bitcoindevkit/bdk-ffi/blob/1c5f4863c6a53cc9d063d34c4e13c91fea5c58de/bdk-ffi/Cargo.lock) SHA-256 为 **`a7b22b8c0669d16ad11a3ea7af0c78f22185a91bd9c20ba59ecfd23468d4d9b9`**，含 **182** 个锁定 package 条目，包括跨目标、构建及开发依赖；不能把这 182 项全部称为已经链接的运行依赖。
- [XCFramework 构建脚本](https://github.com/bitcoindevkit/bdk-ffi/blob/1c5f4863c6a53cc9d063d34c4e13c91fea5c58de/bdk-swift/build-xcframework.sh) 使用 `cargo build --locked`、`release-smaller` 和静态库，分别构建 iOS、模拟器与 macOS 架构后合并。它说明构建方式，不能单独证明已下载发布包和该源码的可复现等价。
- 锁文件包含 rustls、ring、aws-lc-sys、secp256k1-sys、libsqlite3-sys 等具有各自 Rust/C 许可义务的组件。某个 HTTP 功能没有被 App 调用，不等于对应代码一定未进入上游静态产物。当前未取得与每个最终 slice 对应、经核实的完整链接图、SBOM、全部嵌入 C/汇编/数据许可和发布构建来源证明。

**公开商店发行前必须补齐：** 确认发布二进制的确切源码/目标/features 与构建来源，获取或按固定锁文件重建并导出目标相关 SBOM；收集所有实际分发 Rust 及其嵌入原生组件的原始许可/NOTICE，完成兼容性及义务复核，将必需原文加入 App 资源，并复核最终归档。无法核实就不能声称第三方许可已全覆盖，不能以 BDK 顶层 MIT/Apache 原文结案。

此清单只解释原生钱包；不把研究节点、Python、训练模型、网页前端或其他独立 App 的依赖当成钱包打包内容。许可展示用于履行法律义务，不授予第三方商标/界面素材使用权，也不是联合品牌宣传。
