# HEYUNA 本地独立研究链

这是真实 Cosmos EVM 应用和四个本机验证节点。它仍是单一操作者的研究环境，不构成独立验证者网络、公开主网、抗量子系统或技术领先年数的证明。

当前已核验结果、完整账本及回放证据见 [本地验收记录](evidence/README.md)。

## 固定依赖与资金

- Go 1.25.9；Cosmos EVM v0.7.3；SDK v0.54.3；CometBFT v0.39.3。完整依赖与 replace 在 `chain/go.mod`，来源与许可证在 `chain/upstream/`。
- 原生 `aheyuna` 为 18 位小数，显示 `tHEYUNA`；Cosmos bank 与 EVM 共用原生余额。
- 创世总量 20,000,000。14,000,000 预存确定性 RewardVault 地址；2,000,000 预存 PublicFund 地址。工厂预置于 `0x0000000000000000000000000000000000000F01`，合约地址由审查后的 init code 和 salt 确定。constructor 不依赖部署调用者设置权限。
- 四个验证者各质押 10,000；`security_budget` 无铸币权限，持有 3,960,000。按上一区块最终提交的 COMMIT 票权分配每期预算，共 1040 期；缺席不计权、整期无票不支付、舍入余数保留。补贴不自动再质押，保持初始等权。
- 移除了周期 mint。每个 EndBlock 完成后检查总供应不得超过上次提交值，因此标准销毁之后也不能补铸到原上限。供应约束失败会拒绝提交，故必须继续做负载与恶意输入审计。
- Cosmos EVM v0.7.3 的底层余额写入不会自行同步 SDK 供应计数。本应用的 EVM bank 适配层在同一缓存中按账户真实余额差额更新供应，覆盖合约自毁；原生 SDK 铸销仍只计一次。交易回滚同时撤销余额与供应，普通转账的正负差额抵消。
- 禁止公开新增验证者和 delegate/redelegate/undelegate、治理、authz、IBC 消息；只接受原生发送、EVM、贡献协议，以及现有收益领取消息。IBC keeper 为兼容依赖保留，但传输参数关闭且 Ante 拒绝入口。仅额外启用只读贡献预编译 `0x...0900`；Ethereum 标准预编译保留。

## 可复现操作

链脚本面向 macOS/Linux；本机 macOS 已实测，Linux 由新增 CI 待验证，Windows 应使用 WSL2，尚未宣称原生 Windows 节点通过。生成的研究密钥沿用固定 SDK 默认 HD path `m/44'/118'/0'/0/0`，脚本会核对派生地址，不能擅自改成钱包常见的 coin type 60。

所有密钥、节点数据库和日志仅写入 ignored `.state/`。公开地址不是密钥备份。测试 keyring 和 mnemonic 文件只适用于本地研究，目录 0700、秘密文件 0600；不上传这些目录。

```sh
python3 scripts/chain_toolchain.py
sh scripts/chain_go.sh test ./...
sh scripts/chain_build.sh
python3 scripts/chain_localnet.py keys --profile research
node contracts/scripts/research-genesis.mjs .state/chain-research/public-accounts.json .state/chain-research/genesis-contracts-input.json "$(date +%s)"
python3 scripts/chain_localnet.py init --profile research --contracts .state/chain-research/genesis-contracts-input.json
python3 scripts/chain_localnet.py start --profile research
node contracts/scripts/research-deploy.mjs .state/chain-research
python3 scripts/chain_localnet.py audit --profile research
python3 scripts/chain_localnet.py status --profile research
python3 scripts/chain_localnet.py stop --profile research
```

首次合约物料生成前先运行 `pnpm -C contracts install --frozen-lockfile --ignore-scripts` 和 `pnpm -C contracts compile`。脚本拒绝覆盖已初始化创世；要重新实验应明确采用新的私有状态目录设计，不能删除运行数据后假装同一网络。当前 CLI 默认只管理上述两个预设目录。

正常研究网：Cosmos `heyuna_297011-1` / EVM `297011`，贡献挑战期 72 小时、安全补贴每周；EVM RPC `127.0.0.1:9545`，Comet RPC `127.0.0.1:27657`。

隔离加速网：所有命令将 profile 改为 `accelerated`；Cosmos `heyuna_297012-1` / EVM `297012`，挑战期 3 秒、安全补贴期 3 秒。贡献 epoch 始终一周，绝不缩短。EVM RPC `127.0.0.1:10545`，Comet RPC `127.0.0.1:28657`。它不能证明正常 72 小时等待已经结束。

## 验收与边界

```sh
python3 scripts/chain_localnet.py faults --profile accelerated
python3 scripts/chain_localnet.py audit --profile accelerated
python3 scripts/chain_replay.py --profile accelerated --blocks 160
python3 scripts/chain_fee_flow.py
node scripts/chain_priority_fee.mjs accelerated
python3 scripts/security_economics.py
```

故障脚本实际停止一个节点并观察三节点继续；停止两个后验证两位存活节点的高度均停顿；恢复后比较同高度区块。审计脚本固定同一个高度读取 bank 和 EVM 的八个余额，并完整枚举该面额账户，要求余额之和等于供应计数和最近提交供应，再验证安全预算记账。枚举超过 10,000 个账户会明确拒绝本地有界审计。各自写出公开 evidence JSON，供应不一致会保存失败证据并返回错误。

重放脚本只读获取创世、提交区块和验证者集合，离线用两个同源码构建在独立数据库重新执行每个 ABCI 区块。第二次在 FinalizeBlock 后、Commit 前退出，再从最后提交高度恢复。每个结果与真实链后继区块中的 appHash 比较。这是**同版本重放与崩溃恢复**，不是跨版本升级、共识签名验证或双客户端独立实现。未注册任何跨版本状态迁移，删除了上游示例的无关升级处理器。

创世身份通过 SDK `ToGenesisDoc` 精确转换为 Comet 文档，按 UTF-8、键排序、无多余空格 canonical JSON 计算 SHA-256，再与 RPC `/genesis` 重算结果比较。另记原始创世文件字节 hash。钱包清单还绑定 EVM 第 1 块 hash。可信清单分发本身仍是安全前提。

本地参数 `no_base_fee=true`、最小 gas price=0 允许 prefunded CREATE2 启动，未建立公开费用和抗垃圾机制。本应用在 PostHandler 的 Finalize 阶段，按 EVM 最终计费 gas，将优先费从该交易独立的虚拟费用余额支付给实际区块提议者的 operator 账户；基础费余款保留于 SDK fee_collector/distribution，不销毁。EVM revert 交易也支付优先费；SDK 拒绝、CheckTx、ProcessProposal、模拟均不在该阶段支付。`min_gas_multiplier=0.5` 保留上游计费下限，gas limit 过大可能按至少一半计费。公开非零基础费和流量模型仍须单独验证。

`security-economics.md/json` 只是 520/1040/2600 周假设敏感性算术。研究币基准兑换值为 0；费用、成本和非零兑换值均不是市场事实。独立运营仍需多操作者、审计、长期负载、供应与费用不变量、跨版本迁移、恢复演练及真实运维预算。

独立 CI 在 `.github/workflows/chain.yml`：Go 测试/构建、本地四节点、CREATE2、身份/余额校验、故障与短重放。这里只新增工作流；本地通过不表示远端 CI 已执行。
