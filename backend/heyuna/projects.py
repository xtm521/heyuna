"""User-selected project scope, safe disposable copies and conflict-aware change application."""
from __future__ import annotations

import hashlib
import json
import os
import stat
from pathlib import Path, PurePosixPath

IGNORED = {".git", ".hg", ".svn", ".ssh", ".aws", ".config", "node_modules", ".venv", "venv",
           "__pycache__", "target", "dist", "build", ".state", ".next", ".idea"}
MAX_FILE = 256 * 1024
MAX_PROJECT = 32 * 1024 * 1024


def read_text_file(path: Path) -> str:
    """Do not block on FIFO/device files or follow a last-component symlink."""
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("只允许读取普通文本文件")
        if info.st_size > MAX_FILE:
            raise ValueError("文件过大")
        raw = stream.read(MAX_FILE + 1)
        if len(raw) > MAX_FILE:
            raise ValueError("文件超过大小上限")
        return raw.decode("utf-8")


def excluded(path: PurePosixPath):
    return any(p in IGNORED or p.startswith(".env") or p.lower().endswith((".pem", ".key", ".p12", ".pfx"))
               or p.lower() in {"id_rsa", "id_ed25519", "credentials", "secrets.json"} for p in path.parts)


def safe_file(root: Path, relative: str) -> Path:
    rel = PurePosixPath(relative.replace("\\", "/"))
    if rel.is_absolute() or not rel.parts or any(p in {"..", "."} or ":" in p for p in rel.parts) or excluded(rel):
        raise ValueError("路径不在授权的项目文件范围内")
    result = root
    for part in rel.parts:
        result = result / part
        if result.is_symlink():
            raise ValueError("不允许通过符号链接访问文件")
    if not result.resolve().is_relative_to(root.resolve()):
        raise ValueError("文件路径越界")
    if result.exists() and not stat.S_ISREG(result.stat(follow_symlinks=False).st_mode):
        raise ValueError("目标必须为普通文件")
    return result


def text_files(root: Path) -> dict[str, str]:
    result, size = {}, 0
    for folder, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in IGNORED and not (Path(folder) / d).is_symlink())
        for name in sorted(files):
            path = Path(folder) / name
            rel = path.relative_to(root).as_posix()
            if path.is_symlink() or excluded(PurePosixPath(rel)) or path.stat().st_size > MAX_FILE:
                continue
            try:
                content = read_text_file(path)
            except (UnicodeError, OSError):
                continue
            if "\x00" in content:
                continue
            size += path.stat().st_size
            if len(result) >= 2000 or size > MAX_PROJECT:
                raise ValueError("项目超过首版范围（2000 个文本文件或 32 MiB），请选择较小的子项目。")
            result[rel] = content
    return result


class Projects:
    def __init__(self, state_dir: Path):
        self.path = state_dir / "projects.json"
        self.entries = json.loads(self.path.read_text()) if self.path.exists() else {}

    def open(self, path: str):
        root = Path(path).expanduser().resolve(strict=True)
        if not root.is_dir() or root in {Path(root.anchor), Path.home().resolve()}:
            raise ValueError("请选择具体项目，不能选择整个磁盘或个人主目录。")
        files = text_files(root)
        identity = hashlib.sha256(str(root).encode()).hexdigest()[:20]
        self.entries[identity] = str(root)
        self.path.write_text(json.dumps(self.entries), encoding="utf-8")
        self.path.chmod(0o600)
        return {"id": identity, "name": root.name, "path": str(root), "files": sorted(files)}

    def root(self, identity: str):
        if identity not in self.entries:
            raise ValueError("请先选择项目")
        return Path(self.entries[identity])

    def read(self, identity: str, relative: str):
        path = safe_file(self.root(identity), relative)
        if path.stat().st_size > MAX_FILE:
            raise ValueError("文件过大")
        return {"path": relative, "content": read_text_file(path)}


def apply_changes(root: Path, changes: list[dict], reverse=False):
    # Check every original before any write; do not silently overwrite edits made after the task.
    prepared = []
    for change in changes:
        path = safe_file(root, change["path"])
        expected, new = (change["after"], change["before"]) if reverse else (change["before"], change["after"])
        current = read_text_file(path) if path.exists() else None
        if current != expected:
            raise ValueError(f"文件已有其他修改，未应用任何变更：{change['path']}")
        prepared.append((path, current, new))
    written = []
    try:
        for path, old, new in prepared:
            path.parent.mkdir(parents=True, exist_ok=True)
            if new is None:
                path.unlink(missing_ok=True)
            else:
                path.write_text(new, encoding="utf-8")
            written.append((path, old))
    except OSError:
        for path, old in reversed(written):
            if old is None:
                path.unlink(missing_ok=True)
            else:
                path.write_text(old, encoding="utf-8")
        raise

