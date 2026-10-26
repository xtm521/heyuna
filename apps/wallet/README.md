# 合芽原生奖励领取门户

独立浏览器页面，通过 EIP-1193 连接兼容的浏览器钱包。默认资产为 **Heyuna 原生 tHEYUNA**，使用 `NativeRewardVault.claim`。连接账户和签名交易是两个独立操作。页面没有私钥、助记词、代币授权或通用交易入口，也不调用桌面训练 API。

## 本地启动

在仓库根目录使用 pnpm 11.25.0 安装锁定依赖，然后：

```sh
pnpm --filter @heyuna/wallet-portal check
pnpm --filter @heyuna/wallet-portal dev
```

门户固定为 `http://127.0.0.1:1421/`。`HEYUNA_COSMOS_RPC_ORIGIN` 在开发启动或静态构建时设置精确的公开 Cosmos origin（默认 `http://127.0.0.1:27657`，本机加速环境为 `http://127.0.0.1:28657`），只允许 loopback HTTP；它注入 CSP，不进入桌面 API 权限。清单中的 Cosmos URL 需与该构建允许的 origin 一致，节点也需允许门户 origin 的 CORS。桌面仅在系统浏览器中打开精确入口，不带 token、query、fragment 或账户会话。Vite 设置防嵌入和 no-referrer 响应头。未来生产域名需要另行审核并加入桌面允许列表。

原创界面使用共享碳黑/石墨/银白/青绿 tokens、本地 Inter Variable（SIL OFL）与原创三条曲面芽形。默认深色，保留 `heyuna-wallet-theme` 的用户选择。布局、文案、图形和动效均为项目原创，不暗示任何第三方背书。

## 公开网络清单 v2

`public/deployment.json` 默认未配置，连接与领取禁用，余额显示 `— / 未核验`。此文件只能由经过独立核对的公开网络清单替换；它不是私密凭据。后台使用相同清单，但页面始终自行核验网络，不能把后台的 `configured_unverified` 当作余额证明。

完整规范见 `backend/heyuna/deployment.py` 的 `NetworkManifest` 和 `protocol/NetworkManifest.v2.schema.json`。身份包括：

- `version: 2`、`asset_kind: native`、`symbol: tHEYUNA`、`base_denom: aheyuna`、18 位小数、创世总量 20,000,000 枚；
- research：EVM 297011 / Cosmos `heyuna_297011-1` / 72 小时挑战期；accelerated-local：297012 / `heyuna_297012-1` / **3 秒本机实验挑战期**；
- `network_domain`、`genesis_hash_kind: sha256-canonical-genesis-json`、带 `0x` 的 `genesis_hash`、`cosmos_rpc_url` 与 `rpc_url`；本次研究版本仅接受无凭据/路径/查询的 loopback HTTP origin；
- `evm_anchor: {block_number:1,block_hash:...}`、奖励库/公共基金/固定工厂 `0x…0F01` 的地址和 runtime code hash、贡献预编译 `0x…0900`、确认数。

钱包先从 Cosmos RPC `/genesis` 读取 `result.genesis`，按递归键排序、无空白 UTF-8 JSON 计算 SHA256，并校验 Cosmos 链 ID；再从用户 EIP-1193 钱包 RPC 读取 EVM 链 ID 与区块 1 哈希。两者必须分别匹配可信清单。缺少任一锚就停止，不把创世文件字节 hash、EVM block 0 hash 与规范化创世 hash 混用。创世响应上限 5 MiB，15 秒超时；成功的不可变创世核验缓存 5 分钟，钱包链 ID 和锚块每次重新检查。

随后读取三个合约的运行时代码，并确认奖励库绑定的贡献预编译地址。只有核验通过才读取并显示原生钱包余额。**可信清单的最初分发、RPC、浏览器钱包仍是信任边界**；这些核验不是轻客户端共识证明或安全审计。

## 分配清单与领取

使用 `contracts/scripts/native-protocol.mjs` 的 `nativeBundle` 导出 v2 包。结构为 `manifest`、无 `0x` 的小写 SHA256 `manifest_hash`、`root`、十进制字符串 `training_budget`/`verification_budget` 和 `claims`。manifest 包含 version、asset_kind、chain_id、genesis_hash、reward_vault、epoch 和 allocations；金额/周期/索引使用十进制字符串，地址正规化为小写，分配按 BigInt(index) 升序排列。

叶子使用 Solidity ABI 编码后的双 Keccak：`chainId, vault, epoch, category, index, recipient, amount, contributionId`。索引在一个周期内全局唯一，不能跨类别重复；类别 0 为训练、1 为验证。清单最多 5 MiB / 10,000 条，证明最多 64 层。

1. 用户手动选择正确钱包网络并连接；只请求账户，不发送交易。
2. 本地读取 JSON，重新计算 SHA256 和类别预算，逐条核验 Merkle 证明。
3. 通过贡献预编译 `getEpoch` 核对最终确认根与两类预算，再检查 `isClaimed` 并估算 gas。链上接口不提供 manifest hash，因此它是本地完整性检查，链上根和预算是分配锚。
4. 预览显示网络、创世哈希、收款人、奖励库、金额、贡献 ID 和最高原生币费用。gas 预留 20%，预览 2 分钟有效。RPC 明示的零费用是有效研究启动参数，界面与缺失/null 报价严格区分，不承诺后续免费。
5. 只有单独的“确认信息，在钱包中签名领取”按钮发送一次固定 claim，交易 value 为零，费用另计。发送前重新核验。
6. 达到所需确认数后，核对成功回执、目标与发送地址、完整 `RewardClaimed`（含 contributionId）、规范区块 hash 和已领取位，才显示链上已确认。

账户/网络变化会清除预览和余额。回执超时保留 hash，允许只读重查，不自动重发。网页刷新前请保留 hash；页面不是交易历史备份工具。

## 显式 legacy-erc20

历史 Sepolia v1 仍由 `protocol.ts` / `wallet.ts` 单独处理。默认公开配置不接受 v1；用户必须展开“旧版 ERC-20 兼容”并手动导入旧部署。旧 Keccak 清单、token 指针与供应量检查、ETH 费用单位均保留独立版本，不能混用原生资产证明。`scripts/export-deployment.mjs` 只用于这个历史 ERC-20 部署，不是 v2 导出器。

## 验证边界

`pnpm check` 运行协议/交易边界测试、TypeScript 和生产构建。测试包含原生域/锚/创世核验、canonical SHA256、贡献 ID、跨类别索引、状态与费用预览、受限发送、事件匹配，并保留全部旧版测试。EIP-1193 fixture 测试不是真实扩展签名或到账证据。浏览器截图与 QA 记录位于桌面 `evidence/`；真实链、钱包扩展和原生客户端分别验收。
