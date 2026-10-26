#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export GOROOT="$ROOT/.state/toolchain/go1.25.9"
export GOPATH="$ROOT/.state/go"
export GOMODCACHE="$GOPATH/pkg/mod"
export GOCACHE="$GOPATH/build-cache"
export GOTOOLCHAIN=local
export PATH="$GOROOT/bin:$PATH"
if [ ! -x "$GOROOT/bin/go" ]; then
  python3 "$ROOT/scripts/chain_toolchain.py"
fi
cd "$ROOT/chain"
exec "$GOROOT/bin/go" "$@"
