#!/usr/bin/env python3
"""Build and verify the macOS app including its frozen Python runtime.

Tauri dereferences onedir symlinks while copying resources. Restore only relative
links from the locally built, reviewed sidecar before signing the local bundle.
Developer ID signing/notarization and Windows installer validation remain separate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def restore_links(source: Path, destination: Path) -> int:
    count = 0
    for link in source.rglob("*"):
        if not link.is_symlink():
            continue
        target = os.readlink(link)
        if os.path.isabs(target) or not link.resolve().is_relative_to(source.resolve()):
            raise RuntimeError(f"Unsafe runtime symlink: {link.relative_to(source)}")
        copied = destination / link.relative_to(source)
        if copied.is_symlink() or copied.is_file():
            copied.unlink()
        elif copied.is_dir():
            shutil.rmtree(copied)
        copied.symlink_to(target, target_is_directory=link.is_dir())
        count += 1
    return count


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release", action="store_true", help="Use the optimized Rust release profile")
    parser.add_argument("--skip-build", action="store_true", help="Verify an existing local app bundle")
    args = parser.parse_args()
    if platform.system() != "Darwin":
        raise SystemExit("This verified bundle workflow currently targets macOS; Windows remains a separate CI/device gate.")
    source = ROOT / "apps/desktop/src-tauri/resources/sidecar"
    if not (source / "runtime-manifest.json").is_file():
        raise SystemExit("Build the frozen runtime first with scripts/build_sidecar.py")
    manifest = json.loads((source / "runtime-manifest.json").read_text(encoding="utf-8"))
    current_sources = {path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                       for path in sorted((ROOT / "backend/heyuna").glob("*.py"))}
    if manifest.get("source_sha256") != current_sources:
        raise SystemExit("The frozen runtime is stale; rebuild it after backend changes.")
    if not args.skip_build:
        command = ["pnpm", "--filter", "@heyuna/desktop", "tauri", "build", "--bundles", "app", "--config", "src-tauri/tauri.bundle.conf.json"]
        if not args.release:
            command.append("--debug")
        subprocess.run(command, cwd=ROOT, check=True)
    profile = "release" if args.release else "debug"
    app = ROOT / f"apps/desktop/src-tauri/target/{profile}/bundle/macos/Heyuna.app"
    destination = app / "Contents/Resources/sidecar"
    if not destination.is_dir():
        raise SystemExit("The built application has no embedded runtime.")
    links = restore_links(source, destination)
    for artifact in manifest["files"]:
        path = destination / artifact["path"]
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != artifact["sha256"]:
            raise SystemExit(f"Packaged runtime does not match the staged manifest: {artifact['path']}")
    # A local ad-hoc signature is not Developer ID distribution or notarization.
    subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", str(app)], check=True)
    subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(app)], check=True)
    runtime = destination / "heyuna-service"
    check = subprocess.run([str(runtime), "--runtime-check"], cwd=app.parent,
                           capture_output=True, text=True, timeout=180, check=True)
    result = json.loads(check.stdout.strip().splitlines()[-1])
    after_sources = {path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                     for path in sorted((ROOT / "backend/heyuna").glob("*.py"))}
    if current_sources != after_sources:
        raise SystemExit("Backend sources changed during app packaging; rebuild from a stable checkout.")
    report = {"app": str(app), "profile": profile, "restored_relative_symlinks": links,
              "signature": "local_ad_hoc", "notarized": False, "runtime": result,
              "api_smoke": manifest.get("api_smoke"), "source_sha256": current_sources,
              "runtime_files_verified": len(manifest["files"]),
              "service_sha256": hashlib.sha256(runtime.read_bytes()).hexdigest()}
    evidence = ROOT / ".state" / "desktop-bundle-evidence.json"
    evidence.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
