"""Repository-specific secret/artifact guard; complements, does not replace, Gitleaks."""
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = [re.compile(p.encode()) for p in [
    r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    r"gh[pousr]_[A-Za-z0-9]{30,}",
    r"github_pat_[A-Za-z0-9_]{40,}",
    r"AKIA[0-9A-Z]{16}",
]]
FORBIDDEN = {".state", ".venv", ".local-evidence", "node_modules", "target", "__pycache__"}


def main():
    result = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                            cwd=ROOT, check=True, capture_output=True)
    violations = []
    paths = set(result.stdout.decode().split("\0")) - {""}
    for name in sorted(paths):
        path = ROOT / name
        if not path.is_file():
            continue
        if set(Path(name).parts) & FORBIDDEN or path.name == ".env" or path.suffix in {".pem", ".p12", ".pfx", ".safetensors"}:
            violations.append((name, "private/generated artifact")); continue
        if path.stat().st_size > 10 * 1024 * 1024:
            violations.append((name, "large artifact requires explicit review")); continue
        data = path.read_bytes()
        if any(pattern.search(data) for pattern in PATTERNS):
            violations.append((name, "credential pattern"))
    for name, reason in violations:
        print(f"BLOCK {name}: {reason}")  # Never print matched secret values.
    if violations:
        raise SystemExit(1)
    print(f"Repository artifact/credential patterns: {len(paths)} files checked, no matches.")


if __name__ == "__main__":
    main()
