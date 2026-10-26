# Native research currency and settlement v2

This replaces Sepolia's historical90/10 ERC-20 route. `HeyunaToken`, `RewardVault` and `PublicFund` contracts remain legacy Alpha only. V2 uses native `aheyuna`, display`tHEYUNA`,18decimals, shared by bank/EVM/gas/staking/fund.

## Genesis and conservation

| Purpose | Units | Research bootstrap |
|---|---:|---|
| Contribution vault | 14,000,000 | Prefunded immutable native vault |
| Consensus security | 4,000,000 | Four10,000 self-bonds +3,960,000 in `security_budget` |
| Public fund | 2,000,000 | Fixed100,000 constructor faucet grant;1,900,000 under3/5 plus7days |
| Team | 0 | No founder entitlement |

Genesis sum20,000,000×10^18. No`x/mint` inflation. `chain/app/research_policy.go` compares fully reconciled end-of-block supply to the previous committed supply. Internal EVM synchronization does not create a second issuance. Execution/slashing burns can reduce supply; refilling the burnt amount is forbidden. Invariant failure halts execution; this is not a liveness guarantee under malicious code.

The faucet and bonds come from stated budgets. Faucet authority is a local research trust boundary. Private test keys never enter browser/model/worker/source. The CREATE2 factory has no custody or upgrade authority. Runtime hashes use actual constructor immutables at the predicted addresses, not compiler placeholders.

## Contribution budgets

P=14m×10^18. For0≤e<520, budget(e)=floor((e+1)P/520)-floor(eP/520). Later epochs use ceil(P/520). Category caps90% training/10% independent recomputation. Lifetime reservations and native payouts also enforce12.6m/1.4m/14m. Unused amounts stay in the original vault; cancelled proposals release reservations. No administrative catch-up payments.

V2 uses the **currently starting week**, `epoch=floor((headerTime-startTime)/604800)`, including epoch0 after real acceptance. Future weeks/past gaps are closed; finalization may cross a week boundary. This deliberately differs from Alpha's completed-week rule. Cancellation/reproposal requires fresh nonce and the same current week. Post520 keeps the single-week ceiling until remaining category budgets are used.

No reward for account count, stake, self-reported utilization or time online. A report signature alone earns nothing: category1 requires a separate accepted recomputation task/receipt. Coordinator drafts, chain records, finalization, claim and payment are distinct states.

## State and claims

Three invited verifiers; two positive reports per receipt and two matching proposal votes. Anyone can publish challenge evidence. Publication does not freeze automatically. One verifier can freeze pending batches; two matching current-nonce votes cancel/restore. Restore restarts the full challenge window. Finalized batches cannot change.

Normal challenge259200seconds; accelerated3seconds on distinct297012 only. No clock-changing RPC. Consensus handles hashes/signatures/integers/state only, no models/Python/floats/downloads.

Readonly precompile0x0900 exposes root/category totals. `NativeRewardVault` requires finalized=true, exact double-hashed leaf/proof, global epoch-index bitmap and per-epoch/lifetime caps. Relayers cannot redirect funds. Effects precede native transfer; reentry is guarded, failed transfer reverts all accounting.

```solidity
keccak256(bytes.concat(keccak256(abi.encode(
  chainId, vault, epoch, uint8(category), index, recipient, amount, contributionId
))))
```

See[protocol](protocol-v2.md). The chain prevents receipt reallocation and globally deduplicates raw result hashes within its domain. This conservative rule can reject identical legitimate outputs until distinguishable-work policies are researched. Signatures/proofs cannot prove honest training;2/3collusion is an explicit boundary.

## Consensus and treasury

Security subsidy transfers from3.96m using1040weekly integer-difference budgets;40k remains self-bonded. Prior-block finalized commit participation determines shares. Missed periods do not accrue; rounding remainder stays reserved. Current accelerated3sepochs exist only for tests. Research currency is not cost recovery; fee income/operator costs dominate after exhaustion. Compare520/1040/2600scenarios.

Local bootstrap sets NoBaseFee and minimum gas price0. Upstream effective fees/refunds route through fee_collector/distribution, with2%community tax; priority fees are not assumed to follow Ethereum coinbase semantics. Public fee behavior needs explicit redesign/review and testing. See[compatibility](evm-compatibility.md).

`NativePublicFund`: five distinct managers,3sorted EIP712signatures, nonce/deadline, reserve checks,7daydelay. Cancellation also requires quorum. No arbitrary calls/delegatecall/upgrade/user confiscation/mint. Pending contribution freeze cannot freeze user transfers.

No value, return, mainnet conversion or superior-security promise. Independent audits/operators, economic attack validation and long-running evidence remain required.
