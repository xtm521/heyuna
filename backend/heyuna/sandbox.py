"""Docker is mandatory for generated code execution. Never fall back to host execution."""
from __future__ import annotations

import json
import math
import os
import shutil
import stat
import subprocess
import threading
import time
import uuid
from pathlib import Path

IMAGE = "heyuna-sandbox:0.1"
POLICY = "pid1-watchdog-v1"
MAX_SECONDS = 120


def workspace_violation(workspace: Path) -> str | None:
    """Monitored bounds, not a kernel filesystem quota; transient overshoot is possible."""
    size, entries = 0, 0
    for folder, dirs, files in os.walk(workspace, followlinks=False):
        entries += len(dirs) + len(files)
        if entries > 4000:
            return "项目副本超过文件数量上限"
        dirs[:] = [d for d in dirs if not (Path(folder) / d).is_symlink()]
        for name in files:
            try:
                info = (Path(folder) / name).stat(follow_symlinks=False)
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(info.st_mode):
                return "项目副本包含不支持的特殊文件"
            size += info.st_size
            if size > 64 * 1024 * 1024:
                return "项目副本超过 64 MiB 输出上限"
    return None


class Sandbox:
    def __init__(self, docker: str | None = None):
        self.docker = docker or shutil.which("docker")
        self._guard = threading.Lock()
        self._active: dict[str, subprocess.Popen] = {}
        self._closed = False

    def status(self):
        if not self.docker:
            return {"available": False, "detail": "未找到 Docker；自主执行已禁用，不会在主机运行生成代码。"}
        try:
            result = subprocess.run([self.docker, "image", "inspect", IMAGE], capture_output=True, timeout=5, check=False)
            if result.returncode:
                return {"available": False, "detail": "Docker 引擎未运行或隔离镜像未构建。"}
            info = json.loads(result.stdout)[0]
            if info.get("Config", {}).get("Labels", {}).get("org.heyuna.sandbox.policy") != POLICY:
                return {"available": False, "detail": "请重新构建包含容器内超时保护的隔离镜像。"}
            return {"available": True, "image_id": info["Id"], "detail": "Docker 隔离镜像已就绪；任务默认断网。"}
        except (OSError, subprocess.TimeoutExpired, ValueError, KeyError, IndexError, TypeError):
            return {"available": False, "detail": "Docker 引擎不可用。"}

    def command(self, workspace: Path, argv: list[str], name: str, timeout=MAX_SECONDS, image=IMAGE):
        if not isinstance(argv, list) or not argv or len(argv) > 32 or any(not isinstance(a, str) or "\x00" in a or len(a) > 4096 for a in argv):
            raise ValueError("命令格式不合法")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 < timeout <= MAX_SECONDS:
            raise ValueError("隔离执行时限必须在 0 至 120 秒之间")
        if not self.docker:
            raise RuntimeError("没有可用的隔离执行器")
        return [self.docker, "run", "--rm", "--name", name, "--network=none", "--read-only",
                "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "--cpus=2",
                "--memory=2g", "--memory-swap=2g", "--user=65532:65532", "--tmpfs=/tmp:rw,noexec,nosuid,size=128m",
                "--ulimit=nofile=256:256", "--ulimit=fsize=67108864:67108864", "--ulimit=core=0:0",
                "--log-driver=none", "--pull=never", "--entrypoint=/usr/local/bin/python",
                "--label=org.heyuna.sandbox.policy=" + POLICY,
                "--mount", f"type=bind,src={workspace.resolve()},dst=/workspace", "--workdir=/workspace",
                "--env=HOME=/tmp", "--env=PYTHONDONTWRITEBYTECODE=1", image,
                "-I", "/usr/local/lib/heyuna-watchdog.py", str(timeout), *argv]

    def _remove(self, name, process):
        # Never let a failed daemon cleanup skip local CLI cleanup. The independent
        # PID 1 deadline remains in force even when the daemon/transport is unavailable.
        try:
            subprocess.run([self.docker, "rm", "-f", name], capture_output=True, timeout=5, check=False)
        except (OSError, subprocess.TimeoutExpired):
            pass
        finally:
            if process.poll() is None:
                try:
                    process.kill()
                    process.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    pass

    def close(self):
        """Stop this instance's containers during application lifespan shutdown."""
        with self._guard:
            self._closed = True
            active = list(self._active.items())
        for name, process in active:
            self._remove(name, process)

    def run(self, workspace: Path, argv: list[str], cancel: threading.Event, timeout=120):
        readiness = self.status()
        if not readiness["available"]:
            raise RuntimeError("隔离执行器不可用；未执行命令")
        name = "heyuna-" + uuid.uuid4().hex[:16]
        command = self.command(workspace, argv, name, timeout=timeout, image=readiness["image_id"])
        # Output goes to a bounded-on-read local file rather than an unbounded pipe in memory.
        log = workspace.parent / (name + ".log")
        process = None
        try:
            with log.open("wb") as output:
                with self._guard:
                    if self._closed or cancel.is_set():
                        raise InterruptedError("隔离执行已停止")
                    process = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
                    self._active[name] = process
                start = time.monotonic()
                while process.poll() is None:
                    violation = workspace_violation(workspace)
                    if cancel.is_set() or self._closed or violation or time.monotonic() - start > timeout + 5 or log.stat().st_size > 2 * 1024 * 1024:
                        if cancel.is_set() or self._closed:
                            raise InterruptedError("任务已停止")
                        raise RuntimeError(violation or "命令超过时间或输出上限，已终止容器")
                    time.sleep(0.1)
            if cancel.is_set() or self._closed:
                raise InterruptedError("任务已停止")
            if violation := workspace_violation(workspace):
                raise RuntimeError(violation)
            if process.returncode == 124:
                raise RuntimeError("命令超过容器内执行时限，已终止容器")
            return {"exit_code": process.returncode, "output": log.read_bytes()[:24000].decode("utf-8", errors="replace")}
        finally:
            if process is not None:
                self._remove(name, process)
                with self._guard:
                    self._active.pop(name, None)
            log.unlink(missing_ok=True)

