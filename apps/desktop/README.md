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

The external wallet button remains disabled until a real Sepolia token/reward contract and allowed wallet URL are configured. No wallet connection, claim, balance, model response, or training progress is simulated. The alpha's built-in allowlist contains the exact development portal `http://127.0.0.1:1421/` (no query or fragment) and the official HTTPS hosts `wallet.okx.com` and `www.okx.com`. Adding a production claim portal requires a reviewed code change. Opening a wallet is not connecting one or submitting a transaction, and no local API credential is passed to it.
