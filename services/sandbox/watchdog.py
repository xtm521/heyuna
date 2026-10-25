# SPDX-License-Identifier: Apache-2.0
"""Immutable, non-dumpable namespace init supervising untrusted child commands."""
import ctypes
import math
import os
import selectors
import stat
import subprocess
import sys
import time

if os.getpid() != 1:
    raise SystemExit("Watchdog must be namespace PID 1")
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(4, 0, 0, 0, 0) != 0:
    raise SystemExit("Cannot protect watchdog memory")
seconds = float(sys.argv[1])
if not math.isfinite(seconds) or not 0 < seconds <= 120 or len(sys.argv) < 3:
    raise SystemExit("Invalid fixed execution deadline")
child = None
output_bytes = 0
output_selector = selectors.DefaultSelector()


def forward_output(wait):
    global output_bytes
    ready = output_selector.select(wait)
    for key, _ in ready:
        chunk = os.read(key.fd, 65536)
        if not chunk:
            output_selector.unregister(key.fd)
            continue
        output_bytes += len(chunk)
        if output_bytes > 2 * 1024 * 1024:
            print("HEYUNA_OUTPUT_LIMIT", file=sys.stderr, flush=True)
            raise SystemExit(125)
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
    return bool(ready)


def workspace_within_limits():
    # This second monitor survives backend death. It is a monitored aggregate
    # limit, while the process/file/memory limits are enforced by the kernel.
    pending, entries, size = ['/workspace'], 0, 0
    while pending:
        with os.scandir(pending.pop()) as directory:
            for entry in directory:
                entries += 1
                if entries > 4000:
                    return False
                try:
                    info = entry.stat(follow_symlinks=False)
                except FileNotFoundError:
                    continue
                if stat.S_ISDIR(info.st_mode):
                    pending.append(entry.path)
                elif stat.S_ISREG(info.st_mode):
                    size += info.st_size
                    if size > 64 * 1024 * 1024:
                        return False
                else:
                    return False
    return True


try:
    deadline = time.monotonic() + seconds
    child = subprocess.Popen(sys.argv[2:], stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    os.set_blocking(child.stdout.fileno(), False)
    output_selector.register(child.stdout, selectors.EVENT_READ)
    while child.poll() is None:
        if time.monotonic() >= deadline:
            print("HEYUNA_WATCHDOG_TIMEOUT", file=sys.stderr, flush=True)
            raise SystemExit(124)
        if not workspace_within_limits():
            print("HEYUNA_WORKSPACE_LIMIT", file=sys.stderr, flush=True)
            raise SystemExit(125)
        forward_output(0.05)
    while forward_output(0):
        pass
    raise SystemExit(child.returncode if child.returncode >= 0 else 128 - child.returncode)
finally:
    if child is not None and child.poll() is None:
        child.kill()
        try:
            child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass
    output_selector.close()
    if child is not None and child.stdout is not None:
        child.stdout.close()
    # Exiting PID 1 terminates all descendants, including detached sessions.
