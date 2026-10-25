"""Run authenticated loopback API + web preview; keep the secret out of browser JavaScript."""
import os
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path


def main():
    root = Path(__file__).resolve().parents[1]
    pnpm = shutil.which("pnpm")
    if not pnpm:
        raise SystemExit("Install the pnpm version declared in package.json first.")
    env = {**os.environ, "HEYUNA_LOCAL_TOKEN": secrets.token_urlsafe(48)}
    commands = [[sys.executable, "-m", "heyuna.cli", "serve", "--state-dir", str(root / ".state")],
                [pnpm, "dev"]]
    children = []
    try:
        for command in commands:
            children.append(subprocess.Popen(command, cwd=root, env=env))
        print("Heyuna local preview: http://127.0.0.1:1420 ; Ctrl+C stops both services.", flush=True)
        while all(p.poll() is None for p in children):
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()


if __name__ == "__main__":
    main()
