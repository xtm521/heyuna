#!/usr/bin/env python3
"""Verify the vendored crypto facade source against an explicit file manifest."""
from pathlib import Path
import hashlib
import json
root = Path(__file__).resolve().parents[1]
manifest = json.loads((root/'Vendor/source-manifest.json').read_text())
actual = {p.relative_to(root/'Vendor/Web3Core').as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
          for p in (root/'Vendor/Web3Core').rglob('*') if p.is_file()}
expected = {entry['path']: entry['sha256'] for entry in manifest['files']}
if actual != expected:
    raise SystemExit('Vendored source differs from the reviewed manifest; review and update provenance explicitly.')
print(f"Vendored source: {len(actual)} files match pinned source manifest.")
