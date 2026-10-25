# Operator and release runbook

## Invited testnet prerequisites

Keep coordinator credentials, RPC credentials and wallet keys in distinct stores. Never put them in a repository, model prompt, frontend environment variable or CI secret for a pull-request job. Configure real independent validator operators before advertising independence. Three addresses controlled by one person are not three independent validators.

The local coordinator deployment is described in federation.md and services/coordinator/compose.yaml. TLS, database backups/restoration, egress limits, storage retention and incident alerts must be verified before public exposure. The shipped compose binds localhost; it is not an Internet production ingress. PostgreSQL compatibility code is not proof of a production database deployment.

## Deployment and claims

1. Run contract checks and review the exact compiler settings, bytecode, ABI and fixed signer list. The immutable alpha 2/3 EOA quorum has no rotation; lost quorum keys can strand funds. Use test assets only.
2. Generate unsigned deployment data using contracts/scripts/deployment-plan.mjs. An operator reviews network, bytecode, genesis, signers and fees in their own wallet. Never fabricate independent operators or use development keys on public networks.
3. Verify factory/token/vault/fund pointers, fixed supply, allocations and runtime code hashes against a canonical Sepolia receipt and published source. Export the public deployment manifest with chain ID 11155111.
4. Copy that reviewed public manifest to the local service state directory as deployment.json and the wallet portal public configuration. The backend labels it configured_unverified until the portal checks the chain. No secret belongs in these files.
5. Export accepted off-chain drafts to the exact on-chain manifest format, including decimal-string base units. Inspect sums, leaves, role budgets and work evidence. Sign with independent keys, publish bytes and transaction, allow the entire 72-hour challenge window, then finalize.
6. Claim through the external-wallet portal. Connection is separate from signing. Display recipient, chain, token/vault, amount, gas estimate and full hash. Only a successful canonical receipt and sufficient confirmations count as confirmed. Reorganizations require reconciliation.

## GitHub repository hardening

Intended repository: xtm521/heyuna, public, Apache-2.0. Before the initial push run the repository artifact scan and Gitleaks on exactly the files to be published. Model weights, VM disks, private evidence, credentials and local tasks stay ignored.

After repository creation, enable private vulnerability reporting and protect main: prohibit force-push/deletion, require pull requests and passing checks named in .github/workflows/ci.yml, require review when an independent reviewer is available, dismiss stale approvals and require resolved conversations. Verify applied settings through GitHub; configuration files alone do not enable protection. Keep minimum workflow permissions. Dependency update PRs require review; never auto-run untrusted privileged deployment jobs.

CI exports source checksums, a CycloneDX inventory of locked dependencies and an attestation for source archives after required jobs pass. This does not attest an unsigned native installer, guarantee binary reproducibility, or replace a complete transitive license review. Native releases need their own signed artifact/SBOM/provenance workflow and Windows/macOS execution evidence.

## Incident response

Stop new tasks on suspected poisoning; retain hashes and evidence, revoke compromised invitation credentials, and review affected receipts before allocation. For a pending malicious reward root, a validator can pause rewards while the quorum cancels it. Ordinary transfers remain unaffected. A finalized allocation cannot be overwritten. Key compromise after finalization is not repaired by editing a database. Publish incident scope and a new-version migration decision when needed.

Restore coordinator data from a tested backup and reconcile draft allocations against finalized roots before resuming. A failed on-chain proposal currently leaves an off-chain draft reserved; do not manually duplicate payments. Draft cancellation/reconciliation needs an explicit protocol update.
