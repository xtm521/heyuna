# Native wallet development evidence — 2026-10-26

These are development results, not a published App Store wallet or approval for real funds.

- `verification.json` records the implementation-file hashes, local build outcomes and explicit open gates.
- `ios-welcome.png` is an actual iPhone 17 / iOS 27.0 simulator screenshot exported from the passing native UI test. The test verifies offline welcome, a secure input, invalid-mnemonic rejection and a return to the empty setup screen.
- `macos-welcome.png` is the actual native Mac development UI with no account or configured node.
- `macos-invalid-node.png` records the actual rejection of an HTTP node URL. No node was contacted or saved.

The automated suite passed **29 tests**, with **0 failures**. Bitcoin data and JSON-RPC are intercepted by local test fixtures; published test mnemonics and synthetic funding transactions are used. No real asset, wallet backup, external broadcast or mining/training process enters those tests. Keychain race/recovery tests use a mock vault, not physical authentication.

Mac code signatures and Sandbox/network-client entitlements were inspected. The development bundle has `get-task-allow`; it is not notarized or signed for App Store distribution. The unsigned iOS Release archive proves compilation and packaging only. Both products contain the expected privacy manifest and dependency notice text. Private build logs, local code signatures and archives remain under ignored `.state/`.

Still open: iPhone/Mac authenticated Keychain and recovery tests, real Signet/Sepolia transfers and confirmations, independent security assessment, complete binary dependency provenance/licenses/SBOM, organization membership, publishing regions, privacy and export answers, distribution signatures, upload, TestFlight, review and public availability. See [APP_STORE.md](../APP_STORE.md).
