# Upstream source

This directory contains only `Sources/Web3Core` from web3swift 3.3.2, commit
`b9c771bf3b94983d2f9b22096b4a267a72c16006`.
Source: https://github.com/web3swift-team/web3swift/tree/3.3.2/Sources/Web3Core
License: Apache-2.0; the upstream copyright and source headers are retained.

One compatibility change in `EthereumNetwork/Request/APIRequest+Methods.swift` casts
URLSession's `URLResponse` to `HTTPURLResponse` before reading `statusCode`, returning
an error for other response types. Cryptographic paths are unchanged. No browser bridge,
token metadata, third-party wallet integration, or upstream RPC client is used by Heyuna.
The complete Web3Core target is retained to avoid undocumented cryptographic source trimming.

This is dependency provenance, not an independent security audit. Dependency versions are
pinned in Package.swift and Package.resolved. Bitcoin uses the separately pinned official
BDK Swift binary with its upstream SPM checksum.
