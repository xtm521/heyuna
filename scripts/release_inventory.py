"""Emit a CycloneDX dependency inventory from checked-in locks, without environment secrets."""
import hashlib
import json
from pathlib import Path
import re
import sys
import tomllib
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]


def inventory():
    components = {}

    def add(kind, name, version):
        purl = f"pkg:{kind}/{quote(name, safe='/')}@{quote(version, safe='.+-')}"
        components[purl] = {"type": "library", "name": name, "version": version,
                            "purl": purl, "bom-ref": purl}

    for package in tomllib.loads((ROOT / "uv.lock").read_text())["package"]:
        if package["name"] != "heyuna":
            add("pypi", package["name"], package["version"])
    for package in tomllib.loads((ROOT / "apps/desktop/src-tauri/Cargo.lock").read_text())["package"]:
        if "source" in package:
            add("cargo", package["name"], package["version"])
    for name in ["pnpm-lock.yaml", "contracts/pnpm-lock.yaml", "apps/wallet/pnpm-lock.yaml"]:
        path = ROOT / name
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            match = re.fullmatch(r"  '?(@?[^@\s]+(?:/[^@\s]+)?)@([^':()\s]+)(?:\([^\n]*\))?'?:", line)
            if match:
                add("npm", match[1], match[2])
    return {"bomFormat": "CycloneDX", "specVersion": "1.5", "version": 1,
            "metadata": {"component": {"type": "application", "name": "Heyuna", "version": "0.1.0"},
                         "properties": [{"name": "heyuna:scope", "value": "All locked source dependencies, including optional/development platforms. Not a license or vulnerability clearance."}]},
            "components": [components[key] for key in sorted(components)]}


if __name__ == "__main__":
    output = Path(sys.argv[1] if len(sys.argv) > 1 else "release")
    output.mkdir(parents=True, exist_ok=True)
    data = inventory()
    (output / "sbom.cdx.json").write_text(json.dumps(data, indent=2) + "\n")
    sums = []
    for path in sorted(output.iterdir()):
        if path.is_file() and path.name != "SHA256SUMS":
            sums.append(hashlib.file_digest(path.open("rb"), "sha256").hexdigest() + "  " + path.name)
    (output / "SHA256SUMS").write_text("\n".join(sums) + "\n")
    print(f"Dependency inventory: {len(data['components'])} components; checksums written.")
