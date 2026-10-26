# Heyuna desktop alpha

Tauri 2 + Rust + React/TypeScript + locally bundled Monaco. The browser renderer has no filesystem, shell, unrestricted HTTP, wallet-key, or dialog permission. Rust exposes three narrow commands: local API bridge, system project picker, and an allowlisted external-wallet launcher. The bearer credential remains in Rust (desktop) or Vite's server process (browser development).

## Development

From repository root, install the Python package into `.venv` and run `pnpm install --frozen-lockfile` using pnpm 11.25.0. Then:

```sh
pnpm desktop dev
```

The desktop starts its embedded runtime using a random loopback port, credential, and per-launch TLS certificate. Rust trusts only that certificate; certificate validation completes before credentials or project contents are sent. It disables system certificate roots, proxies, redirects and plaintext fallback. Certificate/key files are created in a random app-data subdirectory (0700 directory, 0600 files on Unix) and removed on normal teardown. Windows uses the user's inherited app-data ACL; Windows permission and crash-recovery validation remain device gates. A process already able to read the user's private app files is outside this transport boundary.

Development builds fall back to `.venv/bin/python -m heyuna.cli serve` (Windows `.venv/Scripts/python.exe`) when an embedded runtime has not been built. `HEYUNA_PYTHON` overrides the interpreter. Debug builds may connect to an explicitly configured existing service with `HEYUNA_API_URL=http://127.0.0.1:8765` and `HEYUNA_LOCAL_TOKEN`; this plaintext development path is not the production transport and is rejected by release builds.

Browser development requires the local Python service separately. Set the same `HEYUNA_LOCAL_TOKEN` in the backend and the Vite process, then `pnpm dev`. Vite listens only on `127.0.0.1:1420`, rejects non-local Host/Origin, and injects authentication server-side. Never name the token `VITE_*` or embed it in frontend source. A browser preview can open a project using a local absolute path; the actual desktop uses the system picker.

```sh
pnpm typecheck
pnpm test:desktop
pnpm build
```

## Local macOS application bundle

The explicit packaging workflow embeds a Python/MLX runtime; it does not include model weights. Install the project with its macOS dependencies before building:

```sh
.venv/bin/python -m pip install -r apps/desktop/sidecar/requirements-packaging.txt
.venv/bin/python scripts/build_sidecar.py
.venv/bin/python scripts/build_desktop.py
```

The final script builds `apps/desktop/src-tauri/target/debug/bundle/macos/Heyuna.app`, restores the runtime's verified relative symlinks, applies a local ad-hoc signature, checks that signature, and runs the embedded runtime from the actual application package. Use `--release` for an optimized Rust build. Run the sidecar build again after backend changes. Hashes and runtime results are recorded in the staged `runtime-manifest.json` and `.state/desktop-bundle-evidence.json`.

Use this script rather than distributing the intermediate Tauri bundle: Tauri's resource copying dereferences PyInstaller's library links, which must be restored for MLX to locate its Metal library. The default Tauri configuration keeps `bundle.active=false`; the reviewed bundle configuration is enabled only by this workflow. A release executable without an embedded runtime or explicitly provisioned `HEYUNA_PYTHON` fails closed.

The local macOS app has no Developer ID distribution signature or notarization. Windows runtime packaging and installer/device validation remain separate gates. A successful tiny MLX tensor operation verifies runtime loading only; it does not establish 4B model inference, training, or model improvement. Those require explicit model download and independent execution evidence.

## External wallet boundary

The external wallet button remains disabled until a research-network identity, reward vault and allowed wallet URL are configured. No wallet connection, claim, balance, model response, or training progress is simulated. The built-in allowlist contains only the exact development portal `http://127.0.0.1:1421/`, without a query, fragment, credentials or an alternate path. Adding a production claim portal requires a reviewed code change. Opening a wallet is not connecting one or submitting a transaction, and no local API credential is passed to it.

## Research-network renderer

The default appearance is carbon/graphite with original silver/teal artwork and locally bundled Inter. Existing `heyuna-theme` and `heyuna-text-scale` choices are retained. `heyuna-effects` controls the optional original three-ribbon scene. The scene and Motion are dynamically imported only for positively known idle, focused, visible state; Three caps rendering at 30 fps and DPR 1.5. GPU resources are synchronously disposed before task submission or contribution enable, and on background/reduced-motion/unknown-state transitions. The 1.1-second entrance plays once in the renderer's app session. This is a visual effect, never an indication of training progress.

The three workspace panes resize by dragging their separators or using Left/Right/Home/End on a focused separator. On narrow screens the same panels stack. Tool log entries represent requests, not completion; `test` JSON is interpreted only through `exit_code` and `output`, with unknown text retained without HTML rendering. RSS and process CPU are sampled backend values. No GPU progress or completion time is estimated.

Reward pages default to native tHEYUNA on the Heyuna research chain (297011). The accelerated-local domain (297012, three-second challenge) is visibly distinguished. A configured network is not an established connection or a verified wallet balance. The separate portal verifies canonical Cosmos genesis, the EVM block-one anchor, runtime hashes, finalized roots and proof identity before a claim. Native wallet balance is shown only there after successful verification; the desktop's placeholder backend numbers are never displayed as balances. Legacy ERC-20 is an explicit import path in the separate portal.

The source redesign is not evidence that the already packaged alpha has been replaced. Rebuild and native-device verification remain separate steps. The current QA inventory and browser screenshots are in `evidence/`.
