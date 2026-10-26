# License and provenance ledger

| Component | Upstream / license | Use and obligation |
|---|---|---|
| Heyuna code/docs/design | Apache-2.0 | LICENSE + NOTICE; original layout/text and icon composition |
| Qwen3-4B-Instruct-2507 | https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507 / Apache-2.0 model card | Separate optional download; retain upstream files and pinned revision |
| OpenZeppelin Contracts | https://github.com/OpenZeppelin/openzeppelin-contracts / MIT | Dependency, retain license; no claim upstream audited our composition |
| React, TypeScript, Monaco, Vite, MLX, FastAPI | Respective official distributions / MIT | Installed dependency licenses retained in package distributions |
| rcgen / Rustls | Official Rust crates / rcgen MIT OR Apache-2.0; Rustls Apache-2.0 OR ISC OR MIT | Per-launch certificate generation and pinned local TLS; no custom cryptographic algorithm |
| Tauri | https://github.com/tauri-apps/tauri / MIT or Apache-2.0 | Rust wrapper and API dependency |
| PyTorch | https://github.com/pytorch/pytorch / BSD-style | Optional Windows CUDA runtime; retain bundled license notices |
| Transformers, safetensors | Hugging Face official projects / Apache-2.0 | Local model loading and safe tensor serialization |
| CPython | Python Software Foundation license and bundled notices | Embedded runtime; license copied to `sidecar/_internal/licenses/CPython-LICENSE.txt` |
| PyInstaller 6.22.3 | [Official licensing terms](https://pyinstaller.org/en/stable/license.html) / GPL-2.0-or-later WITH Bootloader-exception; selected runtime hooks Apache-2.0 | Build tool and unmodified embedded bootloader. Its explicit bootloader exception permits combining/distributing that bootloader with other programs; the other dependencies still retain their own license requirements. Full upstream `COPYING.txt`, including the exception, is preserved in the package. Heyuna does not modify PyInstaller. |
| PyInstaller hooks contrib 2026.9 | Official wheel / upstream hook licenses | Packaging hooks; preserve the wheel's full license text and individual notices |
| Lucide | https://github.com/lucide-icons/lucide / ISC | Icon components, preserve dependency notice |
| Demo training data | Original tiny fixture statements in scripts/federation_smoke.py / Apache-2.0 | Only technical smoke evidence; not a representative licensed production corpus |

Locked dependency manifests are the source for exact versions. Release preparation must export all transitive licenses/SBOM and resolve any incompatibility, not assume this short ledger is exhaustive. A production dataset requires a dataset card with provenance, license, redistribution/training rights, sensitive-data review, hashes and deletion policy before admission.

The frozen desktop runtime preserves original wheel metadata/license directories under `sidecar/_internal/*.dist-info/` and exports collected Python distribution notices to `sidecar/_internal/licenses/python/<distribution>/`. `sidecar/_internal/licenses/python-license-index.json` records versions, declared SPDX expressions where available, and retained text paths. The PyInstaller terms are at `sidecar/_internal/licenses/python/pyinstaller/pyinstaller-6.22.3.dist-info/licenses/COPYING.txt`. Inside a macOS application these paths begin at `Heyuna.app/Contents/Resources/`. The build manifest hashes those files; it does not convert them to Apache-2.0 or establish that every binary dependency obligation is satisfied. Frontend/Rust transitive release notices and distribution review remain release gates.

SentencePiece 0.2.2 and Tokenizers 0.23.3 wheels omit standalone license text. The repository retains the unmodified license files from those exact upstream release tags under `apps/desktop/sidecar/licenses/`; `sources.json` records URLs and SHA-256 hashes. Packaging checks both the installed version and text hash, copies them into the runtime license directory, and fails if a collected Python distribution has no retained license text. This check covers distribution-level notices, not a complete audit of embedded native subcomponents.

The desktop bundle excludes the coordinator, SQLAlchemy and Psycopg database drivers; these stay in the separately installed coordinator environment. Psycopg and psycopg-binary are LGPL-3.0-only and retain their own notices when that server environment is redistributed. No model weights or production dataset are bundled with the desktop application.


## Sovereign researchnet additions

| Component | Pinned provenance / license | Obligation and scope |
|---|---|---|
| Cosmos EVM example app/config/cmd | v0.7.3, commit c3ae9067a7eadcdea55a5192226916deb44c71c4 / Apache-2.0 | Modified derived integration, original NOTICE/LICENSE under chain/upstream; own additions do not relicense upstream |
| Cosmos SDK | 0.54.3 / Apache-2.0 | Preserve notices and complete locked dependency graph |
| CometBFT | 0.39.3 / Apache-2.0 | Preserve notices; using its consensus is not inventing a new algorithm |
| Cosmos go-ethereum | 1.17.2-cosmos-0 / library LGPL-3.0, command utilities GPL-3.0 | The Go library is linked into node; retain applicable notices/source/relinking obligations and review actual binary distribution. Do not describe entire dependency graph as Apache-2.0 |
| Go | 1.25.9 / BSD-3-Clause | Official download checksum verification; retain runtime notices for distributions |
| Motion | 14.6.0 / MIT | Dependency code and license retained |
| Three.js | 0.186.1 / MIT | Lazy original artwork; preserve license |
| Inter | @fontsource-variable/inter 5.3.0 / SIL Open Font License 1.1 | Locally served woff2 with original OFL retained under each app public/fonts; no remote font request |
| Node/OpenSSL offline crypto | Node24.19.0 / Node license; OpenSSL3.5.7 / Apache-2.0 | Runtime experiment only; not a bundled chain algorithm migration |

Exact transitive versions remain in chain/go.mod, chain/go.sum, JS lockfiles, uv.lock and Cargo.lock. Release SBOM must cover each. Go source provenance is recorded in chain/upstream/SOURCE.md; a short ledger is not an exhaustive license compatibility audit. Dependency licenses do not grant permission to use third-party brands or interface assets.

## Native Apple wallet additions

The independent SwiftUI wallet has its own pinned graph in `apps/apple-wallet/Package.resolved`. Its detailed [dependency ledger](../apps/apple-wallet/DEPENDENCIES.md) records direct revisions, source submodules, original notice hashes, observed compilation scope, and remaining release gates. The bundled [ThirdPartyNotices.txt](../apps/apple-wallet/Config/ThirdPartyNotices.txt) preserves the original direct-dependency legal texts and applicable known embedded-source attributions; it must be present in both final application archives and accessible on their separate legal page.

| Component | Pinned provenance / license | Obligation and scope |
|---|---|---|
| BigInt | 5.4.1 / MIT | Preserve original copyright and permission text |
| CryptoSwift | 1.10.0 / upstream custom permission notice | Preserve the full original text and its required product-documentation acknowledgment; do not label it MIT |
| secp256k1.swift | 0.10.0 / MIT | Includes the separately licensed Bitcoin Core secp256k1 C source and SwiftCrypto source portions below |
| Bitcoin Core secp256k1 C | submodule 01b819a8c7d485fdd3f024d77273f5769d75b2d3 / MIT | Preserve COPYING and applicable source/header copyrights; the unused zkp target is not treated as an application dependency |
| SwiftCrypto source portions | submodule 92a04c10fc5ce0504f8396aac7392126033e547c / Apache-2.0 | Preserve complete Apache terms, relevant NOTICE attribution and original source copyrights; this is not a claim that all upstream test/tool components are linked |
| Vendored Web3Core | web3swift 3.3.2, b9c771bf3b94983d2f9b22096b4a267a72c16006 / Apache-2.0 | Preserve upstream source headers and LICENSE.md; one HTTPURLResponse compatibility patch is documented in Vendor/Web3Core/UPSTREAM.md |
| BDK Swift and FFI | 3.1.1 / top-level MIT OR Apache-2.0 | Preserve both supplied license texts. Its prebuilt static Rust library requires additional target-specific transitive Rust/C license and SBOM verification before store distribution |

The fixed official bdk-ffi v3.1.1 Cargo.lock and its `--locked` XCFramework packaging script have been inspected. A lockfile includes non-runtime and cross-target packages and is not proof of the exact contents of a released static binary. Complete BDK embedded-component notices, target-specific SBOM and binary/source provenance remain explicit release gates; the direct notices bundle does not claim all transitive license obligations are closed. A pinned or recent dependency is also not an independent audit of this wallet composition. These legal attributions do not reintroduce third-party product branding into wallet navigation or marketing.
