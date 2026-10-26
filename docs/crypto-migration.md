# Cryptographic migration experiment

`research/crypto-migration.mjs` is an **offline** experiment with real Node24.19.0/OpenSSL3.5.7 ML-DSA-44, standard Node crypto APIs and no invented primitive. [NIST FIPS204](https://csrc.nist.gov/pubs/fips/204/final) specifies ML-DSA; its published errata must be tracked. [Node24 crypto documentation](https://nodejs.org/docs/latest-v24.x/api/crypto.html) documents ML-DSA and context separation.

```sh
node research/crypto-migration.mjs
```

Requires Node24.8+; never silently substitutes another algorithm. Keys exist only in process memory and are not exported. Output under`.state/crypto-migration-evidence.json` records runtime, signature/public-key encoded lengths and100sample p50/p95 sign/verify times for account, consensus, network identity and software update roles. These are local timings, not consensus throughput or security strength measurements.

Each role uses a distinct context, explicit network/purpose/key/nonce binding and hybrid secp256k1+ML-DSA authorization. Tests reject modified messages/signatures, wrong keys/context/network and stale nonces. An interrupted pending→committed migration **state model** revalidates both signatures while checking unchanged model supply, balance, finalized root and claim bitmap.

The state model is not an implemented chain migration. SDK accounts, CometBFT votes, P2P handshake and release-verifier code still use their existing algorithms. No hardware key storage, key erasure, threshold ML-DSA, side-channel study or independent implementation interoperability is established. Later experiments need canonical encodings, bounded verification cost, replay protection, recovery quorum/delay, downgrade prevention, old/new client compatibility and real historical replay at each boundary. Light-client protocol design and production key recovery remain open. No whole-chain post-quantum claim follows.
