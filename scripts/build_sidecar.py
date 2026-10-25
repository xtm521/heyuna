#!/usr/bin/env python3
"""Build an onedir service using this interpreter, smoke-check, and stage for Tauri.

Run with .venv/bin/python after installing the locked packaging requirements.
This performs no model download, network deployment, code signing or notarization.
"""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PACKAGER = "6.22.3"


def backend_sources() -> dict[str, str]:
    return {path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted((ROOT / "backend/heyuna").glob("*.py"))}


def isolated_environment() -> dict[str, str]:
    env = {key: value for key, value in os.environ.items()
           if not key.startswith("HEYUNA_") and key not in {"PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV"}}
    env.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", PYTHONNOUSERSITE="1")
    return env


def service_smoke(executable: Path) -> dict:
    """Check the frozen service with fresh private state, never the user's API."""
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    token = secrets.token_hex(32)
    env = {**isolated_environment(), "HEYUNA_LOCAL_TOKEN": token}
    with tempfile.TemporaryDirectory(prefix="heyuna-runtime-") as directory:
        with (Path(directory) / "service.log").open("w+") as log:
            child = subprocess.Popen([str(executable), "-m", "heyuna.cli", "serve", "--port", str(port),
                                      "--state-dir", directory], cwd=directory, env=env,
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=log)
            try:
                endpoint = f"http://127.0.0.1:{port}/api/status"
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                status = None
                for _ in range(120):
                    if child.poll() is not None:
                        raise RuntimeError("Frozen service exited before its authenticated health check")
                    try:
                        request = urllib.request.Request(endpoint, headers={"Authorization": f"Bearer {token}"})
                        with opener.open(request, timeout=1) as response:
                            status = json.load(response)
                        break
                    except (urllib.error.URLError, TimeoutError):
                        time.sleep(0.25)
                if status is None:
                    raise RuntimeError("Frozen service did not become ready within 30 seconds")
                try:
                    opener.open(endpoint, timeout=2)
                    raise RuntimeError("Frozen service accepted a request without authentication")
                except urllib.error.HTTPError as error:
                    if error.code != 401:
                        raise RuntimeError(f"Expected HTTP 401, received {error.code}") from error
                if status["contribution"]["enabled"]:
                    raise RuntimeError("New frozen service state must leave compute contribution disabled")
                return {"authenticated_status": 200, "unauthenticated_status": 401,
                        "model_ready": status["model"]["ready"], "contribution_enabled": False}
            finally:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()


def main() -> None:
    if importlib.metadata.version("pyinstaller") != PACKAGER:
        raise SystemExit(f"Use PyInstaller {PACKAGER} from requirements-packaging.txt")
    if platform.system() not in {"Darwin", "Windows"}:
        raise SystemExit("This desktop runtime currently targets macOS and Windows only.")
    staging = ROOT / ".state" / "sidecar-build"
    output = staging / "dist"
    source_sha256 = backend_sources()
    env = {**os.environ, "PYTHONPATH": str(ROOT / "backend"), "HF_HUB_DISABLE_TELEMETRY": "1"}
    subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--distpath", str(output),
                    "--workpath", str(staging / "work"), str(ROOT / "apps/desktop/sidecar/heyuna-service.spec")],
                   cwd=ROOT, env=env, check=True)
    produced = output / "heyuna-service"
    executable = produced / ("heyuna-service.exe" if sys.platform == "win32" else "heyuna-service")
    smoke = subprocess.run([str(executable), "--runtime-check"], cwd=staging,
                           env=isolated_environment(),
                           capture_output=True, text=True, check=True, timeout=180)
    report = json.loads(smoke.stdout.strip().splitlines()[-1])
    if not report.get("frozen"):
        raise SystemExit("Runtime check did not run from a frozen bundle.")
    report["api_smoke"] = service_smoke(executable)
    if source_sha256 != backend_sources():
        raise SystemExit("Backend sources changed during packaging; rebuild from a stable checkout.")
    destination = ROOT / "apps/desktop/src-tauri/resources/sidecar"
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(produced, destination, symlinks=True)
    artifacts = []
    for path in sorted(destination.rglob("*")):
        if path.is_file() and not path.is_symlink():
            artifacts.append({"path": path.relative_to(destination).as_posix(),
                              "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    report["source_sha256"] = source_sha256
    report["files"] = artifacts
    (destination / "runtime-manifest.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"staged": str(destination), "runtime": {k: v for k, v in report.items() if k != "files"},
                      "files_hashed": len(artifacts)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
