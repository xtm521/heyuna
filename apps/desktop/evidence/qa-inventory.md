# Research-network UI verification inventory

Current redesign source is separate from the previous packaged alpha. This inventory is not a native-app or live-chain completion claim.

- Desktop navigation: all five pages, default dark and persisted light preference, 100%/200% text size, keyboard focus and Escape restoration.
- Workspace: empty and disconnected states; project file selection; keyboard and pointer resize; real task submission/cancellation, collapsed tool requests vs test result, unknown plain text, review before apply/revert; Monaco page switching.
- Training: opt-in default off, prerequisites vs actual connection, enabled stop despite prerequisite loss, process RSS/CPU only, real task source and receipt stages.
- Visual resource policy: three original ribbons, 1.1-second intro per app session, <=30 fps, DPR<=1.5; synchronous dispose before task/contribution; offscreen/blur/reduced-motion/effects-off/unknown status release and static fallback.
- Wallet: native research chain defaults; unconfigured and unverified show em dash; accelerated-local warning; no action without trusted deployment; external connection and signature separate; versioned legacy data only by explicit import.
- Portal: full transaction preview contains network, genesis, recipient, contract, amount, fee cap; chain/genesis/runtime mismatch rejection; account/chain invalidation; proof/category/contribution identity and receipt checks.
- Responsive visual pass: 1440px desktop, 390px narrow viewport, enlarged text, light/dark; no document horizontal overflow or unreadably small helper text.
- Off-happy-path: local service disappears during an enabled contribution; unknown/malformed tool output; no wallet extension or wrong-chain wallet; pending receipt retains transaction identity.

Functional fixtures are explicitly tests. Actual local service/browser checks and actual research-chain checks must be recorded separately with their results.
