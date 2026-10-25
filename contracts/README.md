# Heyuna testnet contracts

Unaudited, fixed-supply testnet implementation. `tHEYUNA` is a test asset without a mainnet redemption promise. There is no deployed contract address in this repository. See [reward protocol](../docs/rewards.md) for the exact trust model and release gates.

## Reproduce locally

Requires Node.js 22.13+ and pnpm. This directory is an independent workspace; it does not modify the desktop application's dependency graph.

```sh
cd contracts
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm audit
```

`check` compiles Solidity, exports ABIs, checks the token's public API, runs in-memory EVM tests and six symbolic arithmetic proofs. It never connects to a network. All test keys are intentionally public integers 1–9 used only by an in-memory chain. Do not import them into a wallet or fund their addresses.

Compiler settings: Solidity 0.8.38, optimizer 200 runs, via IR, Cancun EVM. OpenZeppelin Contracts 5.6.1 is pinned. The compiler currently emits five non-failing upstream warnings about a future reserved identifier in OpenZeppelin ECDSA; the dependency source is not patched. Generated ABIs in `abi/` are committed; bytecode and complete compiler inputs in `artifacts/` are local build products.

## Contracts

| Contract | Responsibility |
| --- | --- |
| `HeyunaTestnet` | Atomic constructor deployment, restricted to Sepolia or local chain 31337 |
| `HeyunaToken` | Exactly 20,000,000 tokens, 18 decimals; constructor allocations 18m / 2m |
| `RewardVault` | Weekly/category caps, 2-of-3 EIP-712 proposals, 72-hour review period, immutable finalized roots and claims |
| `PublicFund` | 2-of-3 signed transfers with seven-day timelock, reservations and quorum cancellation |
| `ValidatorQuorum` | Shared immutable signer validation; no mutable owner or signer rotation |

The constructor factory predicts its third `CREATE` address and gives both vaults that immutable token address before creating the token. All creations happen in one transaction; any failure reverts everything. There is no separate initializer or token binding function.

## Unsigned Sepolia deployment plan

Create an ignored `deployments/sepolia.local.json` with `chainId: 11155111`, three `rewardValidators`, three `fundValidators`, and `genesis` as a future Unix timestamp. The validators must be independently operated EOA addresses, preferably backed by hardware wallets. Address distinctness is not proof of operator independence.

```sh
pnpm deployment-plan deployments/sepolia.local.json
```

This prints unsigned creation data only. It accepts no private key or RPC configuration, never creates a wallet, and cannot send a transaction. It refuses mainnet. Review the constructor inputs, source, chain ID, time, and provider independently before any external deployment. A successful local simulation is not a deployed Sepolia system.

## Dependency and license notes

All Heyuna sources are Apache-2.0. Imported OpenZeppelin code remains MIT, with its copyright notice retained under `third_party/`. Lockfile overrides pin security fixes `uuid@11.1.1` and `tmp@0.2.7` for GHSA-w5hq-g745-h8pq and GHSA-7c78-jf6q-g5cm. Reviewed callers use `uuid.v4()` and `tmp.fileSync({postfix: '.smt2'})`; neither change introduces lifecycle scripts. Z3 is a development-only MIT dependency; no prover is shipped to training devices.

This repository contains a narrow static policy check, not a completed Slither audit. The six Z3 proofs cover the arithmetic model only, not the Solidity implementation, Ethereum consensus, or training correctness. Independent audits, malicious-validator exercises, real-device evaluation, public testnet operation and mainnet approval remain outstanding.
