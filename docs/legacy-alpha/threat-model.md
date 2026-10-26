> Historical v0.1 Alpha. Superseded by the sovereign researchnet; not native-chain policy or current evidence.

# Threat model and residual risks

Scope: invited alpha source, local loopback service, coordinator, worker artifacts, reward and public-fund contracts. Adversaries include malicious task submitters, workers, validators, compromised renderer/dependencies and stolen signing keys. An administrator/root-compromised device is outside meaningful local key/compute isolation guarantees.

| Asset/boundary | Threat | Implemented control | Remaining requirement |
|---|---|---|---|
| Project → agent | Prompt injection, secret exfiltration, host execution | Small text copy, denied sensitive paths/symlinks, closed tools, disconnected container, manual diff application | Sandbox escape testing; same-user filesystem race hardening |
| Renderer → local API | Arbitrary endpoint, CSRF, DNS rebinding, port squatting | Rust allowlist, random token outside renderer, per-launch pinned loopback TLS, Origin/Host controls, bounded bodies | Native bridge penetration test; Windows private-file ACL verification; no secrets in rendered logs |
| Training task → worker | Coordinator supplies arbitrary code or malicious pickle | Closed task template/schema, safetensors, fixed model revision and tensor checks | Dependency/driver vulnerability response; data review |
| Worker → validator | Fake compute, NaN/Inf, extreme norm, replay, poisoning | Task binding, finite/norm checks, deterministic replay interface, heldout evaluator, unique lease/result | True independent validators; heldout secrecy and robust quality studies |
| Participants → rewards | Sybil accounts, collusion, copied updates | Payment based on accepted work, no account/time subsidy, quorum and manifests | Invitations alone do not prove independence; publish identity/control disclosures |
| Proposal → vault | Excess release, stolen signer, overwrite, replay | Period/pool limits, unique signatures, EIP-712 domain, challenge delay, pause/cancel, finalization immutability | Key management and recovery drill; human challenge response |
| Claim → funds | Double claim, cross-chain/contract replay | Domain-bound leaf, bitmap, allowance accounting, standard ERC-20 transfer | Independent contract audits and live-chain event reconciliation |
| Public fund | Unilateral withdrawal, rushed spending | Quorum authorization, seven-day delay, public operation identity | Independent signers and public proposal process |
| Supply chain | Dependency substitution, CI secret theft | Lockfiles, pinned action commits, no deploy keys in CI, scan and audit | Signed distributables, full SBOM/attestation and reproducible-build comparison |
| Availability | Coordinator outage, withholding artifacts, lost keys | Leases, bounded retry, explicit offline/error states | Replicated public manifests, backup restore, recovery policy; no fabricated receipts |
| Privacy | Gradient leakage or malicious training data | User projects excluded, reviewed datasets, opt-in | No claim of differential privacy, secure aggregation or confidential compute |

A challenge event is evidence publication, not automatic proof of fraud. The validator quorum must cancel or pause a suspect proposal during the 72-hour interval. A 2/3 colluding quorum can allocate within contract caps; the contract cannot decide whether model training happened. Pause affects reward operations only, not ordinary token transfers.

## Mainnet acceptance

1. Two independent audits, remediation re-review, no open critical/high findings.
2. Independent 3/5 signers with public authority/key-recovery policy and rotation/migration exercise.
3. Public testnet run, public issue register and funded vulnerability bounty.
4. Actual Mac plus Windows NVIDIA round, malicious-update/replay/network interruption drills.
5. Measured heldout model gains and regression analysis, published data provenance, adequate privacy/legal assessment for launch regions.
6. Signed/reproducible release artifacts, SBOM, provenance attestation, operational/incident response budget.

No current implementation or test count satisfies all of these gates by itself.
