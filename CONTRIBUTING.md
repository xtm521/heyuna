# Contributing

Small, reviewable pull requests are welcome. Discuss protocol or token-rule changes before implementation. Never add credentials, private datasets, model weights, local project snapshots or personal logs. Use fixtures you have permission to share.

By contributing, you certify you have the right to submit the work under Apache-2.0. Sign off commits under the Developer Certificate of Origin 1.1 (https://developercertificate.org/), e.g. `git commit -s`. Preserve dependency notices; model and data licenses are separate.

Run the checks in README. Explain the user-visible behavior, tests and remaining limits. Add regression checks for security boundaries and protocol invariants. Do not imply mocks are physical devices or local EVM transactions are public-network receipts. CI does not deploy or store wallet secrets.

Use `codex/` for automated implementation branches. Protected main should require passing CI and review once collaborators are available. Report security problems privately; ordinary improvements belong in issues/PRs.
