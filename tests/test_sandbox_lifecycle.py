"""Unit regressions plus explicitly enabled real Docker lifecycle checks."""
import os
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from unittest.mock import Mock

import pytest
from heyuna.sandbox import Sandbox


@pytest.mark.parametrize("duration", [0, -1, 121, float("inf"), float("nan"), True, "5"])
def test_deadline_cannot_be_disabled_or_extended(tmp_path, duration):
    with pytest.raises(ValueError):
        Sandbox("docker").command(tmp_path, ["python"], "test", timeout=duration)


def test_model_command_cannot_replace_supervisor(tmp_path):
    command = Sandbox("docker").command(tmp_path, ["--entrypoint=sh", "--", "-c", "bad"], "test", timeout=2)
    assert command[-7:] == ["-I", "/usr/local/lib/heyuna-watchdog.py", "2", "--entrypoint=sh", "--", "-c", "bad"]
    for required in ["--cap-drop=ALL", "--user=65532:65532", "--log-driver=none", "--pull=never",
                     "--ulimit=fsize=67108864:67108864", "--entrypoint=/usr/local/bin/python"]:
        assert required in command


def test_old_images_fail_closed(monkeypatch):
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: Mock(returncode=0, stdout=b'[{"Id":"old","Config":{"Labels":{}}}]'))
    assert not Sandbox("docker").status()["available"]


def test_daemon_timeout_still_reaps_local_cli(monkeypatch):
    def unavailable(*args, **kwargs):
        raise subprocess.TimeoutExpired(args[0], 5)
    monkeypatch.setattr(subprocess, "run", unavailable)
    process = Mock()
    process.poll.return_value = None
    Sandbox("docker")._remove("owned-container", process)
    process.kill.assert_called_once()
    process.wait.assert_called_once_with(timeout=5)


def test_exception_after_launch_always_cleans_container(tmp_path, monkeypatch):
    sandbox = Sandbox("docker")
    monkeypatch.setattr(sandbox, "status", lambda: {"available": True, "image_id": "sha256:pinned"})
    process = Mock()
    process.poll.return_value = None
    monkeypatch.setattr(subprocess, "Popen", lambda *a, **k: process)
    monkeypatch.setattr("heyuna.sandbox.workspace_violation", Mock(side_effect=OSError("scan failed")))
    cleanup = Mock()
    monkeypatch.setattr(sandbox, "_remove", cleanup)
    with pytest.raises(OSError, match="scan failed"):
        sandbox.run(tmp_path, ["python"], threading.Event())
    cleanup.assert_called_once()
    assert not sandbox._active
    assert not list(tmp_path.parent.glob("heyuna-*.log"))


def test_closed_executor_rejects_later_work(tmp_path, monkeypatch):
    sandbox = Sandbox("docker")
    monkeypatch.setattr(sandbox, "status", lambda: {"available": True, "image_id": "sha256:pinned"})
    sandbox.close()
    with pytest.raises(InterruptedError):
        sandbox.run(tmp_path, ["python"], threading.Event())


DOCKER = os.environ.get("HEYUNA_SANDBOX_TEST_DOCKER")
LIVE = pytest.mark.skipif(not DOCKER, reason="explicit real Docker test opt-in required")


@pytest.fixture
def live_workspace():
    root = Path(os.environ.get("HEYUNA_SANDBOX_TEST_ROOT", ".state/tasks")) / ("lifecycle-" + uuid.uuid4().hex)
    work = root / "workspace"
    work.mkdir(parents=True)
    root.chmod(0o755)
    work.chmod(0o777)
    yield work.resolve()
    import shutil
    shutil.rmtree(root)


def docker(*args):
    return subprocess.run([DOCKER, *args], capture_output=True, text=True, timeout=10, check=False)


def wait_running(name):
    for _ in range(100):
        result = docker("inspect", "--format", "{{.State.Running}}", name)
        if result.returncode == 0 and result.stdout.strip() == "true":
            return
        time.sleep(0.05)
    raise AssertionError("owned container never started")


def wait_absent(name, deadline=8):
    end = time.monotonic() + deadline
    while time.monotonic() < end:
        if docker("inspect", name).returncode:
            return
        time.sleep(0.1)
    raise AssertionError("owned container survived its deadline")


@LIVE
def test_live_pid1_resists_signals_ptrace_and_detached_children(live_workspace):
    sandbox = Sandbox(DOCKER)
    ready = sandbox.status()
    assert ready["available"], ready
    name = "heyuna-review-" + uuid.uuid4().hex[:12]
    attack = """import ctypes, errno, os, signal, subprocess, sys, time
assert os.getuid() == 65532 and os.getppid() == 1
os.kill(1, signal.SIGSTOP)
os.kill(1, signal.SIGKILL)
libc = ctypes.CDLL(None, use_errno=True)
assert libc.ptrace(16, 1, 0, 0) == -1 and ctypes.get_errno() == errno.EPERM
try:
    open('/proc/1/mem', 'rb+')
except PermissionError:
    pass
else:
    raise AssertionError('supervisor memory writable')
subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)
print('NONROOT_PID1_PROTECTED', flush=True)
time.sleep(30)
"""
    started = time.monotonic()
    try:
        result = subprocess.run(sandbox.command(live_workspace, ["python", "-c", attack], name,
                                timeout=2, image=ready["image_id"]), capture_output=True, text=True, timeout=10, check=False)
        assert result.returncode == 124, result
        assert "NONROOT_PID1_PROTECTED" in result.stdout
        assert "HEYUNA_WATCHDOG_TIMEOUT" in result.stderr
        assert time.monotonic() - started < 8
        wait_absent(name)
    finally:
        docker("rm", "-f", name)


@pytest.mark.parametrize("stop", ["cancel", "close"])
@LIVE
def test_live_cancel_and_shutdown_remove_owned_container(live_workspace, stop):
    sandbox, cancel, outcome = Sandbox(DOCKER), threading.Event(), []
    def run():
        try:
            sandbox.run(live_workspace, ["python", "-c", "import time; time.sleep(30)"], cancel, timeout=10)
        except Exception as exc:  # noqa: BLE001 - assert the worker thread's exact failure below
            outcome.append(exc)
    thread = threading.Thread(target=run)
    thread.start()
    try:
        for _ in range(100):
            with sandbox._guard:
                names = list(sandbox._active)
            if names:
                break
            time.sleep(0.05)
        assert names
        wait_running(names[0])
        if stop == "cancel":
            cancel.set()
        else:
            sandbox.close()
        thread.join(timeout=10)
        assert not thread.is_alive()
        assert len(outcome) == 1 and isinstance(outcome[0], InterruptedError), outcome
        wait_absent(names[0])
    finally:
        sandbox.close()
        thread.join(timeout=10)


@LIVE
def test_live_parent_kill_does_not_disable_container_deadline(live_workspace):
    # This is the same hard-kill boundary used when the native desktop exits.
    code = "from pathlib import Path; import sys,threading; from heyuna.sandbox import Sandbox; Sandbox(sys.argv[1]).run(Path(sys.argv[2]), ['python','-c','import time; time.sleep(30)'], threading.Event(), timeout=3)"
    parent = subprocess.Popen([sys.executable, "-c", code, DOCKER, str(live_workspace)],
                              stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    name = None
    try:
        for _ in range(100):
            logs = list(live_workspace.parent.glob("heyuna-*.log"))
            if logs:
                name = logs[0].stem
                break
            time.sleep(0.05)
        assert name
        wait_running(name)
        parent.kill()
        parent.wait(timeout=5)
        wait_absent(name)
        assert "HEYUNA_WATCHDOG_TIMEOUT" in logs[0].read_text()
    finally:
        if parent.poll() is None:
            parent.kill()
            parent.wait(timeout=5)
        if name:
            docker("rm", "-f", name)


@LIVE
def test_live_supervisor_enforces_workspace_bounds_without_host_monitor(live_workspace):
    sandbox = Sandbox(DOCKER)
    name = "heyuna-review-" + uuid.uuid4().hex[:12]
    code = "import os,time; os.mkfifo('/workspace/generated-fifo'); time.sleep(30)"
    try:
        result = subprocess.run(sandbox.command(live_workspace, ["python", "-c", code], name, timeout=5),
                                capture_output=True, text=True, timeout=10, check=False)
        assert result.returncode == 125, result
        assert "HEYUNA_WORKSPACE_LIMIT" in result.stderr
        wait_absent(name)
    finally:
        docker("rm", "-f", name)


@LIVE
def test_live_kernel_resource_limits_apply_to_child(live_workspace):
    code = """import os,resource
assert os.getuid() == 65532
assert resource.getrlimit(resource.RLIMIT_NOFILE) == (256,256)
assert resource.getrlimit(resource.RLIMIT_FSIZE) == (67108864,67108864)
assert resource.getrlimit(resource.RLIMIT_CORE) == (0,0)
print('KERNEL_LIMITS_CONFIRMED')
"""
    result = Sandbox(DOCKER).run(live_workspace, ["python", "-c", code], threading.Event())
    assert result == {"exit_code": 0, "output": "KERNEL_LIMITS_CONFIRMED\n"}


@LIVE
def test_live_output_limit_survives_without_host_monitor(live_workspace):
    sandbox = Sandbox(DOCKER)
    name = "heyuna-review-" + uuid.uuid4().hex[:12]
    code = "import os,time; payload=b'x'*65536\nfor _ in range(64): os.write(1,payload)\ntime.sleep(30)"
    try:
        result = subprocess.run(sandbox.command(live_workspace, ["python", "-c", code], name, timeout=5),
                                capture_output=True, timeout=10, check=False)
        assert result.returncode == 125
        assert len(result.stdout) <= 2 * 1024 * 1024
        assert b"HEYUNA_OUTPUT_LIMIT" in result.stderr
        wait_absent(name)
    finally:
        docker("rm", "-f", name)
