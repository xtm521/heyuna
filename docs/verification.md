# Sovereign researchnet verification —2026-10-26

This records actual local implementation evidence, not a production-security certificate. Machine:Apple M5 Pro/64GB/macOS27.0.1. Final chain run is **fresh3**, after resolving the execution-burn accounting defect. Run1/run2 evidence is explicitly historical; no result from them substitutes final-source acceptance.

## Exercised implementation

| Area | Evidence | Exact result and limit |
|---|---|---|
| Independent chain |[node records](../services/chain/evidence/) | Own heyunad, two separate4-validator loopback profiles, real genesis/CREATE2/contracts;one operator |
| Native supply |[EVM probe](evidence/researchnet/accelerated-evm-evidence.json),[ledger](../services/chain/evidence/) | Genesis20m×10^18;1base-unit execution burn;complete account sum=SDKSupply=lastCommitted=19999999999999999999999999;bank/EVM equal at fixed height |
| Contribution |[SDK transactions](evidence/native-contribution.json) | Real pinned Qwen MLX training, separate local worker recomputation,evidence binding,2/3reports,challenge/freeze/quorum restore and final root;7real negative transactions rejected |
| Native claims |[two-category claims](evidence/researchnet/accelerated-claim-evidence.json) | Training1tHEYUNA at225,independent recomputation0.1at226;exact recipient/vault balance deltas,event and duplicate rejection;3schallenge only |
| Consensus faults |[fault/replay records](../services/chain/evidence/) | One of4offline progresses,two stall,recovery agrees;not arbitrary Byzantine proof |
| Fee split |[priority/SDK fee records](../services/chain/evidence/) | Charged50000×3aheyuna priority paid actual proposer on success/revert;SDK fees flow collector→distribution→owner withdrawal;dynamic nonzero base fee not activated |
| Historical replay |[replay evidence](../services/chain/evidence/) | Two same-source builds;accelerated270committed blocks include burn,contributions,claims,priority;Bcrashes afterFinalize135/beforeCommit and recovers from134;not cross-version migration/signature verification |
| Training research |[report](contribution-research.md),[JSON](evidence/contribution-research.json) |1normal/6designed correlated attacks;sampling leaks2/6and is0.164%slower including reference/evaluation cost;no promotion,full recomputation retained |
| Desktop/UI |[current branding QA](../apps/desktop/evidence/brand-neutral-verification.json),[error-state QA](../apps/desktop/evidence/brand-neutral-error-verification.json),[historical QA](../apps/desktop/evidence/verification.json),[design](design.md) | Original carbon/silver/teal;current branding checks use explicit UI fixtures and generic wallet connection without signing;historical real-chain/compute and native evidence remain separate |
| Wallet |[QA](../apps/desktop/evidence/verification.json) | Actual RPC through public-address EIP1193 test adapter;genesis/anchor/runtime/proofs/fees/receipts/claimed bits;not user extension signature |
| macOS package |[bundle](evidence/desktop-brand-neutral-bundle-2026-10-26.json),[scope](native.md) | Rebuilt3244runtime files,current source hashes,ad-hoc signature,isolated copy pinnedTLS200/401;no same-identity native-window launch,not notarized |
| Crypto migration |[offline result](evidence/researchnet/crypto-migration.json) | Real ML-DSA-44 in4role contexts,100samples each,tamper/replay and hybrid state model;no chain integration |
| Economics |[scenarios](../services/chain/security-economics.md) |432hypothetical fee/cost/duration scenarios,not price forecasts/security guarantees |

Final node binarySHA256:`342b1c2a92359fc81cb8501d955e280fe617629b2d2e60c64fd390f90832a587`. Build evidence includes source-file fingerprints. The wallet cannot remotely prove a node binary digest solely fromRPC; trusted manifests/build records remain separate evidence.

Fresh3 accelerated genesis:`0xf79baaec0021985f848c1d1ac7ec3f5a7b5a31ff01d3f44e6b1c450ff6c84774`. Normal72hresearch genesis:`0x1e3f06ac8530db882134afaf06aa39b23c60785a7276355b7d0850d5a165484a`. IDs and loopback addresses are experimental,not a public deployed network.

## Checks

Python101passed/7explicit opt-in skips;desktop27;wallet27;Solidity33including11native tests;12symbolic arithmetic obligations across native and historical pools. FullGo package tests and local node/ledger scripts passed. TypeScript/production builds,Python backend/tests lint,dependency audits and public-source secret scans are recorded at release. Research/build script lint is not an acceptance claim. Remote CI must be read from the actual PR/workflow runs; a local result or workflow file is not a remote execution claim. Symbolic proofs cover integer arithmetic only,not bytecode refinement or all chain safety.

Non-failing warnings:upstreamOpenZeppelin uses future-reserved`error`identifier,Monaco bundle-size advisory,Starlette test-client deprecation. These are not security-clearance evidence. Four exact public source/license SHA256s containing api/tokens filenames are narrowly allowlisted inGitleaks;no credential/path-wide exclusion was added.

## Failures found and corrected

Internal peer review and actual chain probes found:legitimate recomputation's identicalBwas incorrectly deduplicated;unverifiedrawhash could reserve work by frontrunning;target-receipt aliases could pay the same worker twice;one verifier could lock a voting epoch;the native coordinator inherited a legacy single-verifier rejection veto;extra1wei could brick a future fund constructor;EVMSELFDESTRUCT removed account value without updating SDKSupply. Native coordinator acceptance/rejection now requires two immutable votes,with order/permutation regression coverage;legacy v1 retains its explicit historical semantics. Other corrections have targeted regressions,real two-category settlement,and final full-account conservation/replay. The failedrun2diagnostic is preserved in chain evidence; no silent patch was applied to its database. It was archived and a new explicit genesis created. Internal peer review is not an independent institutional audit.

## Open gates

- Seven nodes with≥4independent operators,each<1/3power,and genuinely independent training verifiers.
- Physical Mac+Windows NVIDIA same-round numerical acceptance;mobile thermal/battery feasibility.
- Meaningful coding quality/backdoor/poisoning studies with adequate independent samples;privacy beyond excluding projects/chats.
- Normal72h elapsed challenge operation,public RPC/fee market,DoS/ingress/storage/egress quotas,PostgreSQL backup/incident budget.
- Actual dual-version migration,light client,key recovery and real PQ migration at accounts/consensus/P2P/update boundaries. Burned export-genesis restart is not supported;database recovery/original-genesis replay are the tested paths.
- Two independent security audits/remediation review,unresolved-high/critical clearance,bounty,economic attacks and sustained public operation.
- Native full-model/OSscreen-reader/picker verification,Windows device/runtime/installer,DeveloperID/notarization and reproducible signed binary distribution.

No mainnet issue,value promise,world-leading security or50-year leadership conclusion follows. Source publication,CI,local chain,actual external-wallet signature,independent operation and mainnet remain separate claims.
