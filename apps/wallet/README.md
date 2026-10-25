# 合芽钱包领取门户

独立浏览器页面，通过 EIP-1193 连接通用浏览器钱包或可选 OKX 钱包。它只执行固定奖励库的 `claim`，不托管私钥、不请求代币授权、不连接训练服务、不自动签名。

## 本地启动和桌面入口

```sh
cd apps/wallet
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm dev
```

唯一开发入口为 **`http://127.0.0.1:1421/`**。桌面应用使用系统浏览器打开这个精确 URL，不使用 Tauri 内嵌 WebView 连接钱包，不添加 query 或 fragment，不传递本地 API token、私钥、助记词、授权头或账户会话。门户只读取自己的公开 `deployment.json`；它不调用桌面后台 `/api`。使用无钱包扩展的浏览器会显示明确错误。

`pnpm build` 输出静态 `dist/`，`pnpm preview` 同样绑定 127.0.0.1:1421。生产发布使用单独经过批准的 HTTPS 域名，并在桌面外链允许列表中显式添加；静态服务器须保留 `Content-Security-Policy: frame-ancestors 'none'`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer` 响应头（开发与预览服务已设置），避免嵌入和引用泄露。门户不是一个交易所，也不复制 OKX 的品牌、页面素材或商标。

## 公开部署配置

仓库内 `public/deployment.json` 默认地址为空。此时连接、文件导入和领取均禁用；不会显示虚构余额或交易。部署完成后，运维者独立核对开源合约和实际部署地址，再导出公共配置：

```sh
# HEYUNA_SEPOLIA_RPC_URL 通过本地环境配置；不写入仓库或门户链接。
node scripts/export-deployment.mjs <已核验的 HeyunaTestnet 工厂地址> > deployment.local.json
```

该命令只执行 RPC 读取，不创建钱包或发送交易。导出 `version`、Sepolia `chain_id`、四个合约地址、`genesis`、18 位 `decimals`、最小单位形式的固定 `total_supply`、3 个区块的 `confirmations` 以及四个运行时代码 `code_hashes`。导出值并不独立证明源码审计或 RPC 诚实；部署者仍需与核验过的构建及区块浏览器源码核对。

将经核对的同一份配置分别放入：

- 门户 `apps/wallet/public/deployment.json`（已构建版本还需更新其 `dist/deployment.json`）。
- 桌面后台 `.state/deployment.json`（向桌面提供公共信息，不共享 API token）。

后台 `/api/rewards/config` 会将 `reward_vault_address` 适配为桌面用的 `rewards_address`，同时保留原始 `deployment` 对象。门户始终自行读取部署文件并核验链上状态，不能把后台 `configured_unverified` 当成链上已验证。

客户端在预览和发送前检查：实际链 ID、四份运行时代码摘要、工厂与两资金库的 token 指针、代币符号/小数位/总供应量、创世时间、暂停状态、最终确认周期和已领取位。公共奖励清单不能覆盖部署身份。

## 清单和领取流程

使用 `contracts/scripts/protocol.mjs` 的 `buildManifest` 输出 JSON 包，包含 `manifest`、`root`、`manifestHash` 和每条 `claims` 的 `proof`。金额、索引和周期使用十进制字符串。导出的 `trainingAmount`/`validationAmount` BigInt 应转成字符串；页面会重新计算总额，不信任文件声称的总额。合约目录中的 `fixtures/manifest-v1.json` 只用于互操作测试，不是已部署资产。

1. 用户选择钱包并连接。网页仅请求账户，网络必须已经切换到 Sepolia。
2. 用户从本地选择公开 JSON（最多 5 MiB / 10,000 条）。页面重建规范 JSON、检查 Keccak-256 摘要，并逐条验证收款人、金额和 Merkle 证明；文件不上传。
3. 用户点击“核验合约并预览费用”。页面读取最终确认的根与类别总额，检查未领取状态并估算费用。
4. 独立预览展示收款账户、奖励金额、完整奖励库地址和最高网络费用。gas 预留为估算的 120%，预览两分钟后失效。
5. 只有“确认信息，在钱包中签名领取”触发一次 `eth_sendTransaction`。交易 value 为零，只允许固定 `claim` 调用，没有 `approve` 或通用调用入口。钱包仍需用户亲自确认。
6. 页面保留已发送 hash，等待所配置的确认数；核对成功状态、目标合约、发送账户、完整 `RewardClaimed` 事件、规范区块 hash 和链上 `isClaimed` 后才显示“链上已确认”。

账户、网络或连接变化会清除预览，要求重新连接。拒绝签名不显示成功。回执超时、交易替换或 RPC 失败保留交易 hash，显示“回执仍需核对”，允许只读重查；不会自动重发。相同领取项存在待核对交易时阻止再次预览发送。刷新页面前请保留 hash，钱包和区块浏览器是已发送交易的后续查询渠道。

## 本地验证范围

`pnpm check` 包含 TypeScript 检查、Vite 生产构建及 13 项测试，覆盖链 ID、缺失部署、供应量/小数位、代码摘要、清单摘要、金额精度、索引与证明、账户变化、费用估算与预览过期、受限交易发送参数和回执事件匹配。测试用本地 EIP-1193 fixture，不调用任何真实钱包或网络。

已用 Chrome 检查 1280 像素桌面与 390 像素窄屏的默认未部署状态、禁用按钮和外观切换。截图保留在忽略跟踪的 `evidence/`。这不构成真实钱包签名、Sepolia 到账、完整硬件钱包兼容性或生产安全审计证据。

自有实现 Apache-2.0；React / ethers 等依赖保留各自许可；图标使用 lucide-react（ISC）。默认不包含第三方分析、远程字体或钱包助记词输入。浏览器扩展、RPC、部署配置发布渠道的安全仍属于信任边界。
