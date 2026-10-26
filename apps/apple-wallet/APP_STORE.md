# iOS 与 Mac App Store 发行准备

核对日期：2026-10-26。**状态：开发及材料准备；未上架。** 用户已确认当前 Apple Developer 会员为个人账户。本文件是执行清单，不代表 Apple 已批准、法律主体已核实或地区合规已完成。

## 真实发行门槛

1. **组织会员。** Apple 规则 3.1.5(i) 要求提供虚拟货币存储的钱包由组织开发者提供。现有个人账户不能用本地分发证书、签名成功或改显示名代替组织资格。由 Account Holder 使用真实合法主体办理转换/组织入会；不得编造公司、DBA、D-U-N-S 或借用第三方主体。[加密货币规则](https://developer.apple.com/app-store/review/guidelines/#cryptocurrencies) · [组织入会要求](https://developer.apple.com/programs/enroll/)
2. **产品范围与地区。** 本版为自托管原生币钱包；不包含设备挖矿、完成任务发币、交易所、衍生品、ICO、法币入口或训练功能。添加这些功能会触发额外审核与法律问题。首发国家/地区需按实际运营主体与业务确认，不能默认全球开放。[业务规则](https://developer.apple.com/app-store/review/guidelines/#cryptocurrencies)
3. **Mac 权限。** App Sandbox、必要的出站网络权限、单 App 自包含、无 Root helper、无外部更新器、无训练/编码进程；最终签名产物必须复查。[Mac 要求](https://developer.apple.com/app-store/review/guidelines/#hardware-compatibility)
4. **隐私与出口。** 完成真实运营方、支持/隐私 URL、节点数据处理说明、第三方二进制隐私报告、地区和密码出口问卷。不能因仅用标准算法就预填“豁免”，也不能把 `PrivacyInfo.xcprivacy` 当作隐私政策或法律确认。[隐私填写](https://developer.apple.com/app-store/app-privacy-details/) · [出口说明](https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance/)
5. **工具链。** 当前源码最低为 iOS 17、macOS 15.5；Mac 最低系统受当前 BDK 预编译产物约束。发布时重新核对 Apple SDK 要求，并记录实际 Xcode/SDK、源码提交、依赖和构建哈希。[上传要求](https://developer.apple.com/news/upcoming-requirements/)

## 审核说明草案

> 这是合芽独立自托管钱包，支持 Bitcoin 主网/Signet 和 Ethereum 主网/Sepolia 的普通原生币收发。用户在设备上创建或导入 12/24 个英文 BIP39 单词；不支持 BIP39 附加 passphrase。密钥存于本设备系统钥匙串，不由开发者托管或云同步。首次运行不联网，节点由用户填写 HTTPS 地址。钱包没有挖矿、共训、任务发币、兑换撮合、ICO、理财或任意 DApp 签名入口。合芽研究网入口尚不可操作。

此段需在真实主体、最终功能和可供审核的网络服务就绪后复核。审核人员必须能够使用无价值测试币和专用测试助记词体验完整流程；**不要提交含真实资金的助记词**。节点没有默认值时，应在审核附件中提供经过授权、届时实际可用的 HTTPS 测试节点与操作步骤，不能假装后台一直可用。

## 发行验收矩阵

所有 `pending` 均表示尚未在本表记录证据。完成后填写实际日期、提交号、命令/设备、产物路径或 Apple 状态；不要从其他项目或桌面研究包复制结论。

| 编号 | 检查 | 通过证据 | 状态 |
| --- | --- | --- | --- |
| R01 | 当前组织会员与合法卖方主体 | Membership 类型、实际主体、Account Holder 核对；不记录凭据 | **blocked** — 用户已确认个人会员；钱包发布须真实组织会员 |
| R02 | 发布地区及业务范围 | 已确认地区、责任人、适用要求；不得虚构批准/牌照 | pending |
| R03 | 唯一 Bundle ID、App 记录与双平台 | 真实门户记录及权限；创建与提交分别记录 | pending |
| R04 | 源码和依赖锁定 | 提交号、Package.resolved、第三方许可/二进制来源及校验值 | partial — 版本/校验值/源码许可已固定；完整 Rust/C 二进制许可与 SBOM 待闭环 |
| R05 | 共享逻辑测试 | 本提交的测试结果、数量、失败/跳过及覆盖边界 | **passed (local)** — 29 项、0 失败；见 Evidence/verification.json |
| R06 | iOS 模拟器构建与 UI | Xcode/SDK、设备/系统、产物、截图；含动态字体/读屏/减少动态效果 | partial — iPhone 17 / iOS 27.0 界面测试 1 项通过；字体/读屏/减少动效完整验收待做 |
| R07 | Mac 构建与 UI | 架构、最低系统、键盘/多窗口/浅深色、截图 | partial — Mac 构建、欢迎/安全导入/HTTP 节点拒绝已观察；完整可访问性与浅色验收待做 |
| R08 | 真机 Keychain 和恢复 | 独立 iPhone/Mac 的授权/取消/锁屏/移除/重装、派生向量 | pending — 尚未完成最终 App 身份的真实 Keychain 身份验证 |
| R09 | Signet 与 Sepolia 闭环 | 专用测试地址、交易哈希、确认数、失败/断网恢复；无真实资产 | pending |
| R10 | 安全与边界测试 | 错网/重定向/流式回包及超时边界/扫描触顶/UTXO 与原始交易不符/费用/并发/旧预览/广播不确定测试及独立评审 | partial — 原生逻辑 29 测试与代理源码复核通过；不替代外部审计 |
| R11 | 签名归档与权限 | iOS/Mac Release 归档、团队、Profiles、Entitlements、产物校验值 | partial — Mac 开发签名包、iOS 未签名 Release 归档；非商店分发归档 |
| R12 | 隐私与出口 | 公开政策 URL、App Privacy、Manifest 聚合报告、出口问卷/所需文件 | pending |
| R13 | 商店素材与元数据 | 原创图标/截图、支持 URL、年龄分级、审核步骤和测试节点 | partial — 原创图标和实际欢迎页截图；完整商店材料未齐 |
| R14 | 上传及处理完成 | 每平台上传回执和 ASC 已处理 Build；上传成功不等于处理完成 | pending |
| R15 | TestFlight | 可安装版本及真实测试结果；外部测试资格另记 | pending |
| R16 | 提交审核与结果 | 实际 Submission、审核状态/问题及回复；排队不等于批准 | pending |
| R17 | 公开发布 | 目标商店地区可下载、实际版本/构建与最终源码对应 | pending |

本地存在可用证书不证明组织资格、App 记录、有效分发 Profile 或上架完成。Mac App Store 发行与站外公证发行是不同路径；研究包的 ad-hoc 签名及本地运行证据不能替代本表。

本轮实际证据见 [Evidence/README.md](Evidence/README.md) 与 [verification.json](Evidence/verification.json)。共享测试的 HTTP 均为合成夹具，未向公网广播真实交易。
