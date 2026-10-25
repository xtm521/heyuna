# Wallet portal verification — 2026-10-25

Observed locally on macOS, Node.js 24.19.0 and pnpm 11.25.0:

- `pnpm check`: exit 0; 13 Vitest tests, TypeScript check and Vite production build passed.
- `pnpm audit --json`: exit 0; zero known advisories across 157 dependencies (including optional platform packages).
- `node --check scripts/export-deployment.mjs`: exit 0. The RPC exporter was not run against a live deployment.
- Production preview at `http://127.0.0.1:1421/`: HTTP 200; anti-framing and no-referrer response headers observed.
- Chrome production page: zero console errors or warnings. Missing deployment config leaves connection and import/preview disabled; no transaction-send button is present.
- 1280-pixel desktop: page width 1280, no horizontal overflow, all buttons at least 44 pixels high.
- 390-pixel narrow layout: page width 390, no horizontal overflow, all buttons at least 44 pixels high. Light and dark appearances inspected; sampled visible dark-mode text had no contrast ratio below 4.5:1, excluding disabled controls.

Local screenshot artifacts are in ignored `evidence/`: `wallet-production.png`, `wallet-desktop.png`, `wallet-mobile.png`, `wallet-mobile-full.png`, `wallet-mobile-dark.png`. They show the honest undeployed state, not a fabricated wallet balance or successful claim.

The unit tests use in-memory EIP-1193 fixtures and the committed contract manifest interoperability vector. They exercise manifest/proof tampering, network/account mismatch, bytecode and token identity, fees, restricted claim transaction parameters, stale quotes, already-claimed rejection and matching receipt events. No real extension account was connected; no wallet signature was requested; no transaction was broadcast.

Open gates: trusted public deployment manifest, live Sepolia contracts, real external-wallet compatibility checks, end-to-end receipt confirmation on Sepolia, malicious-browser-extension/RPC threat review and independent security audit. These local checks do not close those gates.
