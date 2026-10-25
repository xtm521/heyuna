# Heyuna product design

Heyuna is an original local-first coding workspace with a separate, opt-in contribution surface. Its primary action is opening a local project; its secondary loop is explicitly preparing a model, joining an invited network, and reviewing verified contributions. It uses an original warm-white, graphite and muted leaf-green palette. No OKX logo, copied screen, image, icon, text, layout asset, or proprietary code is used.

The public OKX wallet SDK and demo informed the separation of network identity, wallet connection and transaction confirmation. They do not establish the technology used by all OKX products. Heyuna uses React, TypeScript, Tauri 2, Rust and Monaco as its own implementation choice. Icons are Lucide under ISC; upstream dependency licenses must be retained. No remote font or external editor CDN is required.

The renderer reaches the local service only through a narrow Rust bridge. A fresh per-launch TLS identity is pinned before transmitting credentials or project contents, so a process occupying the chosen port cannot impersonate the service. Plain HTTP browser preview is explicitly a localhost development path. Wallet navigation is separate and receives no local service credential.

## Primary workflows

- **Workspace:** open a project using the system picker; browse source files; describe a bounded task; observe actual task events and test output; cancel at any time; review a side-by-side diff before enabling Apply; revert with original-content conflict checks. The editor displays authoritative source read-only; AI edits live in the sandbox task copy until Apply.
- **Training:** display runtime/backend/model readiness from the local API, make the model download explicit, show network configuration state separately from active training, and let users opt in/out. Never infer success from a dispatched request. CPU limits are disabled unless the backend reports support; no GPU/thermal controls are advertised.
- **Wallet:** continuously identify Sepolia and the configured contract addresses. A missing deployment displays an em dash and an unavailable action, never a zero or invented income. External wallet navigation requires explicit confirmation; wallet connection, signing and chain confirmation remain separate steps.
- **Receipts:** show real task IDs and verification states, failure explanations and hashes. Empty state leads back to training. State labels distinguish computed, submitted, verified, settling, claimable and confirmed; unknown backend states remain visible rather than converted to success.
- **Settings:** network credential uses a password field, is cleared after successful saving, and is never stored in browser storage. Limits are read and saved through the local API. Only theme and text-size preferences are stored in localStorage.

## Visual and accessibility rules

Use semantic CSS variables for surface/text/border/accent/error states, restrained borders and 8–14 px radii. Keep dense code surfaces separate from readable task panels. Every icon button has an accessible label and visible focus. Use status/alert live regions, labeled forms, reduced-motion support, light and dark themes, and 100–200% text scaling (including code and diff editors). Below 700 px, navigation becomes a five-item bottom bar and the workspace stacks editor and assistant; phone-sized views are responsive previews, not proof of phone training.

## Evidence

Build, TypeScript, UI behavior tests, desktop/narrow screenshots, and real browser checks are recorded separately from native builds, signed installers, real 4B inference, Windows GPU execution, independent validation, and chain settlement. Test fixtures belong only in tests. No fixture data is rendered as live product evidence.
