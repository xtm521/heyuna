# Alpha verification and remaining gates

Observed on 2026-10-25, Apple M5 Pro / 64 GB / macOS 27.0.1. This is an implementation and evidence register, not a production-security certificate.

## Implemented and exercised locally

| Area | Evidence | Exact scope |
|---|---|---|
| Desktop | React/TypeScript tests and build, Rust bridge tests/build, five real API-backed views | Browser UI and local macOS app; Windows runtime is unverified |
| Coding assistant | [Real model trace](evidence/agent-smoke.json), [review screenshot](evidence/agent-review.png) | Pinned Qwen model fixed a disposable Python addition bug, container tests exited 0, original stayed unchanged until UI apply, UI revert restored it |
| Execution isolation | [Container observations](evidence/sandbox.json) | UID 65532, read-only root, network blocked; no host execution fallback; not a sandbox escape audit |
| Training | [Real training and replay](evidence/training-smoke.json) | One optimizer step on one Mac, identical repeated adapter hash, no independent operators |
| Federation | Coordinator/worker protocol tests | Invitations, leases, expiry, duplicate submission, validation quorum, invalid tensors, aggregation and draft accounting; local SQLite fixtures |
| Rewards | [Contract evidence](../contracts/VERIFICATION.md) | Compiled bytecode executed in a local EVM; 22 tests and 6 arithmetic proof obligations; no chain transaction |
| Wallet portal | [Portal evidence](../apps/wallet/VERIFICATION.md) | 13 provider-fixture tests, production browser preview, disabled honest undeployed state; no real account/signature |
| Packaging | `scripts/build_sidecar.py` and `scripts/build_desktop.py` | Embedded Python/MLX runtime, file hashes, ad-hoc macOS signature and real process startup; no Developer ID or notarization |
| Supply chain | Lockfiles, package audits, secret scan, CI definitions | Known-advisory checks are time-bound and do not replace audits; CI results must be checked on GitHub |

The training smoke used about 7.55 GiB of MLX-reported device allocation. Heldout loss changed from 3.4847963 to 3.4898088, **worsening about 0.144%**. This stays within the configured 1% rejection tolerance, but demonstrates **no quality improvement**. The sample is project-authored fixture text, not a benchmark or paid contribution.

## Local acceptance details

Latest standard checks: Python 78 passed (real Docker tests are explicit opt-in), desktop 11 passed, wallet 13 passed, Rust 5 passed, local EVM 22 passed, symbolic arithmetic 6 obligations passed. TypeScript checks, frontend builds, Python lint and lock consistency passed. Real Docker lifecycle checks and their final image identity are separately recorded in [sandbox lifecycle evidence](evidence/sandbox-lifecycle.json).

Known non-failing tool warnings: upstream OpenZeppelin uses `error` as an identifier reserved by a future Solidity release; Monaco makes the local desktop JS bundle exceed Vite's default size advisory; Starlette warns that its httpx-backed test client is deprecated. These warnings are not audit findings or proof of zero defects.

The UI was inspected at 1440×960 and 390×844, in light/dark appearances and with 200% text sizing. Project-dialog Escape returns focus to its opener. Network and model readiness come from the local service. No token price, wallet balance, training progress or successful reward is fabricated. Native OS screen-reader traversal, native folder-dialog interaction and Windows visuals have separate open gates. Review screenshots show the browser preview, not a native release acceptance run.

Coding tasks and their review snapshots currently live in backend memory; the browser also loses its selected task on reload. Complete review/apply/revert within the same session. Do not treat this alpha as durable project history or a replacement for Git. Edits outside the app are conflict-checked before applying or reverting.

The container has CPU/RAM/PID limits and an internal deadline. Workspace byte/file and log caps are sampled by the parent process, **not kernel disk quotas**; transient overshoot is possible. The reviewed image and local Docker installation remain part of the trusted computing base. Same-user host compromise, hostile kernel/driver and container escape resistance are not proven by these checks.

## Not completed

- Same-round physical Mac + Windows NVIDIA training and cross-backend numerical acceptance. CUDA implementation and cache release have no physical NVIDIA evidence here.
- Statistically meaningful coding-model quality gains, poisoning/collusion campaigns and independent validator operation.
- Production PostgreSQL deployment, public ingress/backups/budget enforcement and object-store replication. Small adapters currently use bounded database JSON storage.
- Live Sepolia contracts, source verification, public reward manifests, 72-hour challenge operation, real external-wallet claims and canonical receipt reconciliation.
- Mainnet issuance, independent security audits, implementation-level formal verification, independent 3/5 signers/key recovery, funded bounty and operating-region review.
- Signed/notarized public installers and reproducible native-binary/provenance verification. The CI attestation workflow covers source archives only.

Mainnet stays closed until the [roadmap](roadmap.md) and [threat-model](threat-model.md) gates are met. Open-source publication is a separate deliverable from token issuance.
