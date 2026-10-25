# 合芽奖励协议 v1（受邀测试网实现）

本文件描述 `contracts/` 已实现的合约规则。测试网络为 Ethereum Sepolia（11155111），本地 EVM 为 31337。当前仓库没有部署地址、链上余额或主网发行证据。资产由链 ID 与合约地址识别；名称和代码不是资产真实性证明。

## 供应量和控制权限

`HeyunaToken` 一次性铸造 20,000,000 × 10^18 个最小单位，奖励库收到 18,000,000 枚，公共基金收到 2,000,000 枚。无团队预留。当前实现名称为 `Heyuna Testnet`，代码 `tHEYUNA`，不承诺与未来 `HEYUNA` 主网币兑换。

代币不可升级，没有管理员、追加铸造、销毁、税费、重基准、黑名单或暂停接口。奖励库暂停不影响普通 ERC-20 转账。公开基金没有任意调用、授权第三方花费或管理员提走余额的接口，只能通过多签、延时的固定代币转账。

`HeyunaTestnet` 的构造函数在同一交易中创建两个资金库和代币。新合约 nonce 从 1 开始，第三次 `CREATE` 的 token 地址由 `RLP([factory, 3])` 提前计算；两个资金库构造时即固定该地址，创建 token 后再次核验地址。没有可抢跑的初始化或重新绑定入口。修改部署顺序必须同步审查这一不变量。

## 周期和预算

部署参数 `genesis` 是未来的 Unix 秒时间。周期编号从 0 开始，每周 604,800 秒。

前 520 个周期的额度为：

```text
R = 18,000,000 × 10^18
B(e) = floor(R × (e + 1) / 520) − floor(R × e / 520), 0 ≤ e < 520
B(e) = ceil(R / 520), e ≥ 520
training_cap(e) = floor(B(e) × 9 / 10)
validation_cap(e) = B(e) − training_cap(e)
```

训练累计最多 16,200,000 枚，验证累计最多 1,800,000 枚。每周分别不能超过类别额度，不能借用另一类别的空余额度。整数取整产生的最小单位尾差会保留在原类别库容量中，在 520 周之后按同样的单周上限分配。

只能为**刚刚结束的一周**提交提案：`genesis + (e + 1) × WEEK ≤ now < genesis + (e + 2) × WEEK`。错过的历史周不能追溯补填，周预算不能叠加；未分配额度继续保留在奖励库，520 周之后继续释放至用完。这个限制约束的是每期分配额度，不是每个自然周实际领取的转账额；用户可以稍后集中领取过去已确认的奖励。

已提案额度立即预留。取消待确认提案释放预留，最终确认额度永久计入累计分配；未领取的既得奖励没有到期没收或回收入口。合约仅保证经济边界，任务工作单位、真实训练与独立验证仍由链下公开验收决定。

## 提案、挑战、确认和领取

1. 验证者核对公开分配清单的任务去重、工作单位、训练与验证类别、收款账户、额度、评测报告和模型版本。
2. 两名不同验证者签署 EIP-712 `RewardProposal`，签名按恢复地址升序排列。任何账户可以转发，不能修改内容。
3. `proposeEpoch` 记录根、清单摘要、类别总额、提案 nonce 和 72 小时后可确认的时间。
4. 任何人可以在窗口内调用 `reportChallenge` 发布证据摘要。它只是公开证据日志，**不会自动冻结分配**，避免零成本重复挑战永久阻塞奖励。监测者必须通知验证者；任一验证者可立即暂停奖励库，两名验证者可取消待确认提案。
5. 72 小时后，未暂停的待确认提案可由任何人 `finalizeEpoch`。确认后的根与额度不能覆盖、取消或修改。
6. 用户或中继调用 `claim`。收款地址被证明固定，中继不能转走资金；按周期与 index 位图防止重复领取，类别累计领取不能超过签名提案额度。

取消会增加该周期 nonce，旧提案签名因此失效。在当周有效提案窗口内可以重新提案，新的提案重新开始 72 小时挑战期。取消支持已过挑战期但尚未最终确认的提案；最终确认与取消存在交易排序竞争，因此发现事故应先暂停。

`pause()` 仅限任一验证者。`unpause()` 需要两人签署包含新控制 nonce 的消息；每次暂停都作废事故前签署的恢复消息。暂停限制提交、确认和领取；不影响挑战日志和取消提案，不影响普通代币转账。

### EIP-712 和 ABI

域为 `{name: "HeyunaRewardVault", version: "1", chainId, verifyingContract}`。`chainId` 和 `verifyingContract` 防止跨链与跨资金库重放。完整 typed data 定义位于 `contracts/scripts/protocol.mjs`；公开 ABI 位于 `contracts/abi/`。

```text
proposeEpoch(epoch, root, manifestHash, trainingAmount, validationAmount, deadline, signatures)
cancelEpoch(epoch, reasonHash, deadline, signatures)
reportChallenge(epoch, evidenceHash)
finalizeEpoch(epoch)
claim(epoch, index, recipient, kind, amount, proof)
isClaimed(epoch, index)
pause()
unpause(deadline, signatures)
```

`kind=0` 为训练，`kind=1` 为独立验证；金额和 index 的 JSON 表示必须使用十进制字符串。签名包含从合约读取的提案 nonce，不能由客户端猜测。

Merkle 叶使用 OpenZeppelin StandardMerkleTree 的双重哈希与排序节点规则：

```text
keccak256(bytes.concat(keccak256(abi.encode(
  uint256(chainId), address(rewardVault), uint256(epoch), uint256(index),
  address(recipient), uint8(kind), uint256(amount)
))))
```

`buildManifest` 对分配项按数值 index 排序，校验重复 index 和精度，输出紧凑 UTF-8 JSON；`manifestHash` 为这份**精确字节内容**的 Keccak-256（不是 SHA-256，不是带空白的展示 JSON）。JSON 固定字段顺序为 `version, chain_id, reward_vault, epoch, allocations`；分配项字段顺序为 `index, recipient, kind, amount`，地址为 EIP-55 校验和形式。机器可读互操作测试向量位于 `contracts/fixtures/manifest-v1.json`。

链上不遍历整棵树核算清单总额，靠签名验证者核对根与公开清单的一致性；合约另在领取时强制限制总额。恶意根不能超额转出，但可能造成先领者占用额度、真实贡献者领取失败。因此“根已上链”不是“每个人已被公平奖励”的证明。

## 公共基金

公共基金签名域为 `HeyunaPublicFund`。`queuePayment(recipient, amount, descriptionHash, deadline, signatures)` 要求两名独立管理者签署当前 `nextNonce` 的付款消息，公开用途摘要并预留余额。七天后任何人可以 `executePayment(paymentId)`，资金只到已签名账户。`cancelPayment` 需要两人签名和原因摘要；已执行或已取消付款不能再次执行。所有付款都受未预留余额约束，固定七天延迟不能缩短。

首版签名集合不可修改，不支持 ERC-1271 合约钱包验证、签名者轮换或密钥恢复。三个地址并不等于三个独立的人；同一操作者的三个测试账户只能证明多密钥逻辑。丢失两把密钥会阻塞新分配和基金管理；一个恶意验证者可反复暂停奖励。主网需要真实 3/5 管理、独立安全评审后的恢复机制及迁移方案，不能宣称这版代码已经具备。

## 钱包与前端状态

- `计算完成`、`待验证`、`验证通过`、`待结算`来自任务与验收记录，不据此增加链上余额。
- `可领取`要求已知网络和合约、已最终确认的有效证明，且 `isClaimed=false`。
- `已发送`只有交易 hash，不等于到账；`链上已确认`需要成功 receipt、正确链和合约的 `RewardClaimed` 事件，以及约定确认数。失败、替换、RPC 超时、链重组分别处理。
- 总供应量为固定 2,000 万；库内余额、累计分配、累计领取和流通估计分别展示，不能混用。用户把币转回资金库也不会产生新奖励预算。
- 用户点击连接钱包与签名领取是不同操作。默认先使用外部钱包；训练和模型进程不持有私钥，协调器不能获得钱包签名能力。

## 安全证据与仍未完成的门槛

本地验证包含固定供应与部署指针、2/3 门槛和签名篡改、过期与重放、520 周预算、522 周状态穷尽、重复领取、跨位图随机领取、暂停、7 天基金延迟和预留保护。`contracts/scripts/static-check.mjs` 是有限的 ABI/源码策略检查，不能称为完整静态安全审计。Z3 的六个证明仅涵盖预算与预留算术模型，不证明 Solidity 字节码符合该模型。

验证者达到门槛后仍可串谋把当期合法额度分给自己；合约没有训练真实性的零知识证明，也没有自动欺诈裁决、质押罚没或无信任协调器。Merkle 证明和签名只证明分配被授权，不证明模型质量、安全、数据权利或训练执行。公开训练报告与复算流程必须独立验证。

两家独立机构审计和复审、完整静态分析、实现级形式化验证、漏洞赏金、真实独立签名者、事故恢复演练、真实多设备任务验收与 Sepolia 交易回执均是后续证据门槛。主网被当前部署脚本和构造函数阻止，不存在“世界最安全”或“超越 BTC”的验收结论。

参考： [OpenZeppelin ERC-20](https://docs.openzeppelin.com/contracts/5.x/erc20-supply)、[StandardMerkleTree](https://github.com/OpenZeppelin/merkle-tree)、[EIP-712](https://eips.ethereum.org/EIPS/eip-712)、[EIP-161](https://eips.ethereum.org/EIPS/eip-161)。
