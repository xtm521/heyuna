# Researchnet operations and reproduction

The commands below operate on **local research identities only**. Never copy test mnemonics/keyrings to source or use them for valuable assets. All private state is ignored under`.state/`. The node/contract genesis recipe is in the[root README](../README.md)and[chain operations](../services/chain/README.md).

## Identity and startup

Run the normal72h and accelerated3s profiles as separate chains. IDs alone do not establish identity: preserve the trusted v2deployment manifest, canonical Comet genesis hash, EVM block1 anchor, actual runtime hashes and node source/binary fingerprint. Initial manifest distribution is a trust boundary. The helper refuses initialized-genesis overwrite and only stops processes whose full command matches the owned node directory. Archive stopped experiment directories explicitly; never hide a failed run by deleting it.

Genesis installs the fixed CREATE2 factory and prefunds the predicted reward/fund addresses. `research-genesis.mjs` simulates constructors at their real addresses to hash immutables. `research-deploy.mjs` derives only ignored local faucet credentials, checks public identity/chain/factory, deploys exact code and reconciles balances. It does not contact public chains. Unsolicited existing-currency donations cannot brick fund deployment; they do not enlarge the genesis supply.

## Contribution experiment

Install the reviewed Mac extra and prepare the exact pinned model through the desktop model flow. Do not bypass model byte hashes or use a mirror. Runtime task templates are closed; code supplied by a coordinator is never executed. Sample data/heldout are project-authored research fixtures, not user projects or a production benchmark.

```sh
# Set to the public faucet EVM address from this run's public-accounts.json.
export HEYUNA_RESEARCH_RECIPIENT='0x<research-faucet-address>'
python scripts/prepare_contribution_research.py --deployment .state/chain-accelerated/deployment.json --recipient "$HEYUNA_RESEARCH_RECIPIENT" --output .state/contribution-research/final-job
python -m heyuna.training --job-dir .state/contribution-research/final-job --model-path .state/models/qwen3-4b --backend mlx
python -m heyuna.training --job-dir .state/contribution-research/final-job --model-path .state/models/qwen3-4b --backend mlx --candidate .state/contribution-research/final-job/result.safetensors --heldout .state/contribution-research/final-job/heldout.json
python scripts/contribution_chain_smoke.py --help
```

Use the smoke script's explicit job/model/backend/state arguments for the fresh accelerated chain. It performs actual SDK task/result/report transactions, independent recomputation work, two-category root proposal, public challenge, freeze, quorum restore, ordinary block-time finalization and negative-case receipts. Run once per fresh epoch0; it does not overwrite finalized batches or change clocks. Evidence binds the actual job, chain and binary. Private model children use credential-scrubbed allowlists; the trusted SDK harness needs its normal local toolchain environment.

```sh
node contracts/scripts/research-claim.mjs .state/chain-accelerated
node contracts/scripts/research-evm-smoke.mjs .state/chain-accelerated
python3 scripts/chain_localnet.py audit --profile accelerated
```

The claim script relays both finalized allocations to their committed recipients, checks exact native balance deltas/events and duplicate rejection. Faucet grants, security subsidies and contribution receipts remain separate accounting categories. A fullrecompute can legitimately produce identical B; category1 uses target/artifact/evidence work commitments, not a pretend changed B. See[protocol](protocol-v2.md)and[experiment report](contribution-research.md).

## Coordinator and UI

```sh
# Configure distinct credentials privately in HEYUNA_COORDINATOR_IDENTITIES.
# Use a private PostgreSQL URL for a deployed coordinator.
heyuna coordinator --network-manifest .state/chain-research/deployment.json --port 8080
```

Factory startup also requires HEYUNA_NETWORK_MANIFEST; absent native config fails closed. Historical Alpha requires explicitly named`create_legacy_coordinator_app`. Database state cannot silently change network/protocol. Native routes are`/v2`; old`/v1`receipts never gain native rights. Coordinator reports remain remote assertions until local task checks and independent chain settlement verification.

For desktop browser preview,`python scripts/dev.py`keeps local authorization only in the server proxy, not renderer JavaScript. Put a reviewed deployment.json in the chosen service state directory. The wallet portal's HEYUNA_COSMOS_RPC_ORIGIN must equal the exact intended loopback Cosmos origin for CSP; Comet CORS allows only documented local app origins. A real EIP1193 wallet signs separately. Browser test adapters only establish read-only RPC/proof behavior, not a real wallet-extension signature.

## Faults, fees, replay and economics

```sh
python3 scripts/chain_localnet.py faults --profile accelerated
node scripts/chain_priority_fee.mjs accelerated
python3 scripts/chain_fee_flow.py
python3 scripts/chain_replay.py --profile accelerated --blocks 160
python3 scripts/security_economics.py
node research/crypto-migration.mjs
```

Full account-balance sum, SDK Supply and last committed supply must agree, including after execution/slashing burns. EVM/bank accounts are compared at the same height. Priority uses final charged gas and the actual proposer; rejected SDK/proposal/simulation paths cannot pay it. Current NoBaseFee bootstrap is not a public dynamic-fee market. Source/tests alone never establish the actual fee path.

Replay downloads public genesis/blocks/validator sets into an independent no-key database, reexecutes every block twice from the same source, and injects a crash after Finalize before Commit. This proves the stated deterministic/crash scenario, not a different-version migration or consensus signature verification. Exported-genesis restart after burns is not yet a supported recovery path; use original genesis plus history or the committed database. Future migration requires its own design and dual-version tests.

Economic scenarios are assumptions, including zero research-coin value; no guaranteed income/cost recovery follows. Online coordinator/storage/monitoring plans target≤¥1000/month, while independent nodes, hardware, audits and R&D are separate. Measure actual invoices and cap work/storage before public admission. No supplier account was purchased by these scripts.

## Release and remaining admission gates

Source CI/secrets/locks, local macOS package, wallet fixture/RPC evidence, Windows build, actual heterogeneous GPU training, independent operators and mainnet release are different gates. Final same-version replay cannot certify a future migration. Keep P1 failures and fixes in public evidence. Independent7-node operation requires≥4operators and each<1/3power; signer independence, audits, bounty, public ingress/quotas/backup recovery, sustained load, dataset rights and operating-region review remain open.
