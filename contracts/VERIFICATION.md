# Local contract evidence — 2026-10-25

Environment: macOS arm64, Node.js 24.19.0, pnpm 11.25.0. Dependencies are pinned by `pnpm-lock.yaml`; install lifecycle scripts are disabled. This evidence applies to the checked-in testnet sources, not a mainnet deployment.

| Command / check | Observed result |
| --- | --- |
| `pnpm check` | Exit 0; compile, static interface policy, 22/22 in-memory EVM tests, 6/6 Z3 arithmetic obligations |
| `pnpm audit --json` | Exit 0; 65 dependencies; 0 known advisories at time of check |
| Solidity compiler | 0.8.38, Cancun target, optimizer 200 runs, via IR |
| Runtime size limits | All deployed runtime sizes below 24,576 bytes and init code below 49,152 bytes |
| Testnet factory | 17,458-byte init code, 319-byte runtime |
| Token | 2,975-byte init code, 1,686-byte runtime |
| Reward vault | 7,789-byte init code, 6,267-byte runtime |
| Public fund | 5,606-byte init code, 4,117-byte runtime |
| Secret/network use | No live private keys, no RPC connection, no transaction broadcast |

The test suite executes compiled bytecode in EthereumJS VM, including atomic deployment, ERC-20 balances, signature verification, timestamps, revert paths and storage changes. It exhausts 522 weekly allocation steps and executes 128 shuffled claims with sparse indices crossing bitmap words. Its fixture keys are deliberately public integers and never leave the in-memory harness.

The compiler emits five warnings from the pinned upstream OpenZeppelin ECDSA source about `error` becoming a future reserved identifier. No compiler error remains. Two initial package advisories were resolved by reviewed, locked overrides (`uuid` 11.1.1 and `tmp` 0.2.7); no upstream source files were edited.

The static policy check is limited to source primitives, pinned licensing/compiler, the fixed token ABI and read-only deployment factory. It is not a completed Slither analysis. Z3 proves six arithmetic lemmas with unbounded symbolic integers under explicit acceptance conditions; it does not prove that the Solidity bytecode implements those lemmas or prove validator honesty. Signature cryptography and consensus inherit external assumptions.

Not performed: independent smart-contract audits, implementation-level formal verification, real independent-validator operation, adversarial economic audit, live Sepolia deployment/receipt, mainnet issuance. No “world's most secure,” “safer than Bitcoin,” or mainnet-readiness claim follows from these results.
