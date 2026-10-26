#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$ROOT/.state/bin"
sh "$ROOT/scripts/chain_go.sh" build -trimpath -o "$ROOT/.state/bin/heyunad" ./cmd/heyunad
python3 - "$ROOT" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
sources = sorted([*root.joinpath('chain').rglob('*.go'), root/'chain/go.mod', root/'chain/go.sum'])
records = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}
canonical = json.dumps(records, sort_keys=True, separators=(',', ':')).encode()
evidence = {'kind': 'local-application-build', 'go_version': '1.25.9', 'binary_sha256': hashlib.sha256((root/'.state/bin/heyunad').read_bytes()).hexdigest(), 'source_manifest_sha256': hashlib.sha256(canonical).hexdigest(), 'source_hashes': records, 'source_manifest_format': 'sha256 of UTF-8 canonical JSON sorted relative-path to file-SHA256 mapping', 'remote_ci_verified': False}
(root/'.state/bin/build-evidence.json').write_text(json.dumps(evidence, indent=2, sort_keys=True)+'\n')
print(json.dumps({k:v for k,v in evidence.items() if k != 'source_hashes'}))
PY
