# EVM compatibility matrix — research baseline

Baseline Cosmos EVM v0.7.3 full lock:Go1.25.9/SDK0.54.3/CometBFT0.39.3/Cosmos geth1.17.2-cosmos-0. This is not byte-for-byte Ethereum behavior or a public security approval. Official dependency versions are pinned; security advisories and a compatible patched set must be reviewed before public exposure.

| Surface | Implementation / evidence | Limit |
|---|---|---|
| Independent genesis/node/native currency | Actual four-node normal and accelerated networks | One local operator, not independent network |
| Solidity | Pinned solc0.8.38/Cancun; real deployment/storage/event/revert probes | Full opcode/transaction matrix not exhaustive |
| RPC | eth_chainId/getBalance/getCode/getBlockByNumber/eth_call/estimateGas/sendRawTransaction/receipts | Loopback only; no public SLA/archive/explorer |
| Wallet | EIP1193 chain ID + block1 anchor, Cosmos canonical genesis, runtime code checks | Tested fixture adapter; not all wallet extensions/devices |
| Ledger | SDK bank and EVM balances checked at same height | Explicit protocol burns lower total; not ERC20 wrapper |
| Gas/refund | Upstream min_gas_multiplier0.5; chargedGas≥gasLimit×0.5 | Large gas limit can increase billed gas vs Ethereum |
| Fee bootstrap | NoBaseFee=true,min gas price0 | Dynamic public base-fee behavior not activated or claimed |
| SDK fees | collector then next-height distribution,2%community tax, standard owner withdrawal | Nonzero SDK transfer evidence is not EVM tip proof |
| EVM priority fee | Local post-execution charged-gas split is separately tested before release | See final evidence for activated rule; do not assume upstream proposer-fee behavior |
| Finality | CometBFT stake-weighted quorum | Different from Ethereum proof-of-stake/fork-choice |
| Faults | Four equal nodes:one offline progresses,two offline stalls,recovery agrees | No arbitrary Byzantine/partition proof |
| Native precompile | 0x0900 view-only contribution oracle, malformed selectors/gas bounded | Not a generic native-write bridge |
| Upstream write precompiles | Disabled except ordinary standard EVM crypto precompiles | Ethereum tool support does not imply Cosmos write APIs |
| IBC/bridge | Disabled; no assets bridge | No cross-chain promise |
| Staking | Four genesis validators; dynamic admission/delegation blocked | SDK reward withdrawals are not staking admission |
| ERC20 Alpha | Historical contracts/tests retained | Not the native asset; no receipt conversion |
| PQ algorithms | Offline Node/OpenSSL ML-DSA experiment | No current chain quantum-security claim |
| Upgrade | Same-version historical appHash replay/crash test | Cross-version migration remains open |

Native Solidity protocol contracts export ABIs in`contracts/abi/`; oracle ABI in`chain/precompiles/contribution/abi.json`. Unknown/oversized precompile calldata and nonzero value are rejected. Source-policy/static checks, stateful tests and symbolic arithmetic cover stated boundaries only; they are not an independent audit, Slither execution or full bytecode proof.
