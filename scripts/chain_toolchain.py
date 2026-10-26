#!/usr/bin/env python3
"""Install the pinned Go release from go.dev after official SHA-256 verification."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
VERSION = "go1.25.9"
TOOLCHAIN = ROOT / ".state" / "toolchain" / VERSION


def main():
    executable = TOOLCHAIN / "bin" / "go"
    if executable.exists():
        subprocess.run([str(executable), "version"], check=True)
        return
    system = {"Darwin": "darwin", "Linux": "linux"}.get(platform.system())
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "amd64"}.get(platform.machine())
    if not system or not arch:
        raise SystemExit("Unsupported host; install Go 1.25.9 and use the documented Linux/WSL build workflow.")
    with urllib.request.urlopen("https://go.dev/dl/?mode=json&include=all", timeout=60) as response:
        releases = json.load(response)
    release = next(item for item in releases if item["version"] == VERSION)
    artifact = next(item for item in release["files"] if item["os"] == system and item["arch"] == arch and item["kind"] == "archive")
    TOOLCHAIN.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="heyuna-go-", dir=TOOLCHAIN.parent) as temporary:
        archive = Path(temporary) / artifact["filename"]
        with urllib.request.urlopen("https://go.dev/dl/" + artifact["filename"], timeout=120) as response, archive.open("wb") as destination:
            shutil.copyfileobj(response, destination)
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        if digest != artifact["sha256"] or archive.stat().st_size != artifact["size"]:
            raise SystemExit("Go release checksum/size mismatch; refusing installation")
        with tarfile.open(archive) as bundle:
            for member in bundle.getmembers():
                if (member.name != "go" and not member.name.startswith("go/")) or ".." in Path(member.name).parts or member.issym() or member.islnk():
                    raise SystemExit("Unexpected toolchain archive member: " + member.name)
            bundle.extractall(temporary)
        os.replace(Path(temporary) / "go", TOOLCHAIN)
        (TOOLCHAIN / "heyuna-download.json").write_text(json.dumps({"url": "https://go.dev/dl/" + artifact["filename"], **artifact}, indent=2) + "\n")
    subprocess.run([str(executable), "version"], check=True)


if __name__ == "__main__":
    main()
