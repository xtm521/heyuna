"""Opt-in local network controller. Configuration alone is never connectivity evidence."""
from __future__ import annotations

import base64
import importlib.util
import json
import os
import platform
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import psutil
from fastapi import APIRouter, HTTPException
from pydantic import Field

from .deployment import NetworkManifest, load_manifest
from .federation import digest, validate_artifacts
from .native_protocol import (
    ContributionReceiptV2,
    NetworkBinding,
    RecomputationEvidence,
    TrainingTaskV2,
    attestation_bindings,
    parse_bundle,
    parse_receipt,
    parse_task,
)
from .protocol import Message, canonical_hash
from .training import validate_dataset, validate_model_path


class Configure(Message):
    endpoint: str = Field(max_length=512)
    device_token: str = Field(min_length=32, max_length=256)


class ContributionSwitch(Message):
    enabled: bool


def safe_endpoint(endpoint: str) -> str:
    parsed = urlsplit(endpoint)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {"", "/"}:
        raise ValueError("coordinator endpoint must be an origin without credentials, path or query")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "::1", "localhost"}):
        raise ValueError("coordinator requires HTTPS; HTTP is limited to local development")
    if not parsed.hostname:
        raise ValueError("coordinator hostname required")
    return endpoint.rstrip("/")


class NetworkService:
    def __init__(self, state_dir: Path, resource_lock):
        self.state_dir = Path(state_dir)
        self.directory = self.state_dir / "network"
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.resource_lock = resource_lock
        self.lock = threading.RLock()
        self.cancel = threading.Event()
        self.process = None
        self.thread = None
        self.enabled = False  # Restart always requires explicit opt-in.
        self.state = "disabled"
        self.detail = "Contribution is off. No work has been requested."
        self.connected = False
        self.last_authenticated_at = 0.0
        self.receipts = []
        self.current_task = None
        self.resources = {"rss_bytes": 0, "cpu_percent": 0, "elapsed_seconds": 0}
        self.config = self._read("connection.json", {})
        self.usage = self._read("usage.json", {"date": "", "upload_bytes": 0})
        self.router = APIRouter(prefix="/network", tags=["network"])
        self.router.add_api_route("/status", self.snapshot, methods=["GET"])
        self.router.add_api_route("/configure", self.configure, methods=["POST"])
        self.router.add_api_route("/contribution", self.contribution, methods=["POST"])
        self.router.add_api_route("/run-once", self.run_once, methods=["POST"])
        self.router.add_api_route("/receipts", self.get_receipts, methods=["GET"])

    def _read(self, name, default):
        try:
            return json.loads((self.directory / name).read_text())
        except (OSError, ValueError):
            return default

    def _save(self, name, data):
        file = self.directory / name
        temporary = file.with_suffix(".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(data, stream)
        os.chmod(temporary, 0o600)
        temporary.replace(file)

    def snapshot(self):
        with self.lock:
            fresh = self.connected and time.time() - self.last_authenticated_at < 120
            chain_id = None
            try:
                if (self.state_dir / "deployment.json").is_file():
                    chain_id = load_manifest(self.state_dir / "deployment.json").chain_id
            except (OSError, ValueError):
                pass  # Unknown is not a verified network identity.
            return {
                "contribution": {"enabled": self.enabled, "state": self.state, "detail": self.detail},
                "network": {"configured": bool(self.config), "connected": fresh,
                            "endpoint": self.config.get("endpoint", ""),
                            "last_authenticated_at": self.last_authenticated_at or None,
                            "state": "authenticated" if fresh else ("configured" if self.config else "unconfigured")},
                "rewards": {"chain_id": chain_id, "confirmed": "0", "pending": "0",
                            "state": "no_chain_verification", "receipt_count": len(self.receipts)},
                "supported_limits": {"time_window": True, "memory_rss": True, "daily_upload": True,
                                     "cpu": "sampled_stop_not_scheduler_throttle"},
                "upload_bytes_today": self.usage.get("upload_bytes", 0),
                "current_task": self.current_task,
                "resources": dict(self.resources),
            }

    def configure(self, payload: Configure):
        with self.lock:
            if self.thread and self.thread.is_alive():
                raise HTTPException(409, "stop the current contribution before reconfiguring")
            try:
                endpoint = safe_endpoint(payload.endpoint)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
            self.config = {"endpoint": endpoint, "device_token": payload.device_token}
            self._save("connection.json", self.config)
            self.connected = False
            self.state = "configured" if self.enabled else "disabled"
            self.detail = "Configuration saved. Authentication has not been checked."
            return self.snapshot()

    def contribution(self, payload: ContributionSwitch):
        with self.lock:
            self.enabled = payload.enabled
            if not payload.enabled:
                self.cancel.set()
                if self.process and self.process.poll() is None:
                    self.process.terminate()
                self.state = "stopping" if self.thread and self.thread.is_alive() else "disabled"
                self.detail = "Stopping local work; no new result will be uploaded."
            elif not (self.thread and self.thread.is_alive()):
                self.state = "idle"
                self.detail = "Opted in; press Run once to request an eligible task."
            return self.snapshot()

    def _settings(self):
        defaults = {"start_time": "22:00", "end_time": "07:00", "max_cpu_percent": 50,
                    "max_memory_gb": 24, "max_upload_mb_day": 1024}
        try:
            defaults.update(json.loads((self.state_dir / "settings.json").read_text()))
        except (OSError, ValueError):
            pass
        return defaults

    def _limits(self, upload_bytes=0, *, check_available=False):
        settings = self._settings()
        now = datetime.now().astimezone()
        start = datetime.strptime(settings["start_time"], "%H:%M").time()
        end = datetime.strptime(settings["end_time"], "%H:%M").time()
        current = now.time().replace(tzinfo=None)
        permitted = (start <= current < end) if start < end else (current >= start or current < end)
        if start != end and not permitted:
            raise RuntimeError("Outside the configured contribution time window")
        if check_available and psutil.virtual_memory().available < 10 * 1024**3:
            raise RuntimeError("At least 10 GiB available memory is required for BF16 4B training")
        if float(settings["max_memory_gb"]) < 10:
            raise RuntimeError("Configured memory allowance is too small for this BF16 training cohort")
        today = now.date().isoformat()
        if self.usage.get("date") != today:
            self.usage = {"date": today, "upload_bytes": 0}
        if self.usage["upload_bytes"] + upload_bytes > float(settings["max_upload_mb_day"]) * 1024**2:
            raise RuntimeError("Daily contribution upload allowance would be exceeded")
        return settings

    @staticmethod
    def _backend():
        if platform.system() == "Darwin" and platform.machine() == "arm64":
            if importlib.util.find_spec("mlx_lm") is None:
                raise RuntimeError("Install the reviewed mac extra before contributing")
            return "mlx"
        if importlib.util.find_spec("torch") is None or importlib.util.find_spec("peft") is None:
            raise RuntimeError("This device needs the CUDA training extra before it can accept a task")
        import torch
        if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
            raise RuntimeError("This training cohort requires NVIDIA CUDA with BF16 support")
        free_memory, _ = torch.cuda.mem_get_info()
        if free_memory < 10 * 1024**3:
            raise RuntimeError("At least 10 GiB of free CUDA device memory is required")
        return "cuda"

    def _client(self):
        return httpx.Client(base_url=self.config["endpoint"], timeout=30.0, follow_redirects=False,
                            trust_env=False, headers={"Authorization": "Bearer " + self.config["device_token"]})

    def _context(self):
        path = self.state_dir / "deployment.json"
        if not path.is_file():
            raise RuntimeError("Install a trusted network manifest before requesting contribution work")
        manifest = load_manifest(path)
        return manifest, "/v2" if isinstance(manifest, NetworkManifest) else "/v1"

    @staticmethod
    def _check_receipt(receipt, manifest):
        native = isinstance(manifest, NetworkManifest)
        if native != isinstance(receipt, ContributionReceiptV2):
            raise ValueError("Receipt protocol does not match the selected network")
        if native and not receipt.network.matches(manifest):
            raise ValueError("Receipt belongs to another network")

    @staticmethod
    def _check_task_receipt(receipt, task):
        if (receipt.task_id, receipt.round_id, receipt.task_hash, receipt.work_units) != (
                task.task_id, task.round_id, task.fingerprint, task.work_units):
            raise ValueError("Receipt task, round or work-unit binding differs")
        if isinstance(task, TrainingTaskV2):
            if receipt.wallet.lower() != task.recipient.lower():
                raise ValueError("Receipt recipient differs from the committed task")
            expected = attestation_bindings(task)
            for field, value in expected.items():
                actual = getattr(receipt, field)
                if hasattr(value, "model_dump"):
                    value = value.model_dump(mode="json")
                    actual = actual.model_dump(mode="json") if actual else None
                if actual != value:
                    raise ValueError(f"Receipt {field} binding differs from the task")
            if task.category == 0 and (receipt.verification is not None or receipt.verification_evidence_hash is not None):
                raise ValueError("Training receipt contains an unexpected verification binding")
            if task.category == 1 and receipt.verification_evidence_hash is None:
                raise ValueError("Recomputation receipt has no evidence binding")

    @staticmethod
    def _request(client, method, url, **kwargs):
        # Read incrementally to reject malicious coordinator responses before unbounded allocation.
        with client.stream(method, url, **kwargs) as response:
            chunks, size = [], 0
            for chunk in response.iter_bytes(chunk_size=65536):
                size += len(chunk)
                if size > 8 * 1024**2:
                    raise RuntimeError("Coordinator response exceeds limit")
                chunks.append(chunk)
            return httpx.Response(response.status_code, content=b"".join(chunks), headers=response.headers)

    @staticmethod
    def _json(response):
        if response.status_code >= 400:
            # Error body is coordinator-controlled, so bound it and never include request headers.
            try:
                detail = str(response.json().get("detail", "request failed"))[:400]
            except (ValueError, AttributeError):
                detail = "request failed"
            raise RuntimeError(f"Coordinator HTTP {response.status_code}: {detail}")
        if len(response.content) > 8 * 1024**2:
            raise RuntimeError("Coordinator response exceeds limit")
        return response.json()

    def run_once(self):
        with self.lock:
            if not self.enabled:
                raise HTTPException(409, "Enable contribution explicitly before requesting work")
            if not self.config:
                raise HTTPException(409, "Configure a coordinator and device credential first")
            if self.thread and self.thread.is_alive():
                raise HTTPException(409, "A contribution is already running")
            try:
                self._limits(check_available=True)
            except (RuntimeError, ValueError, TypeError) as exc:
                self.state, self.detail = "paused_limits", str(exc)
                raise HTTPException(409, str(exc)) from exc
            if not self.resource_lock.acquire(blocking=False):
                self.state, self.detail = "paused_assistant", "Model resources are in use by the coding assistant"
                raise HTTPException(409, self.detail)
            self.resource_lock.release()
            self.cancel.clear()
            self.state, self.detail = "connecting", "Authenticating with the configured coordinator"
            self.thread = threading.Thread(target=self._run, daemon=True, name="heyuna-contribution")
            self.thread.start()
            return self.snapshot()

    def _run(self):
        if not self.resource_lock.acquire(blocking=False):
            self.state, self.detail = "paused_assistant", "Model resources are in use by the coding assistant"
            return
        try:
            manifest, prefix = self._context()
            backend = self._backend()
            with self._client() as client:
                status = self._json(self._request(client, "GET", prefix + "/status"))
                if not isinstance(status, dict) or status.get("role") != "device" or status.get("chain_id") != manifest.chain_id:
                    raise RuntimeError("Coordinator is not an authenticated endpoint for the selected network")
                if isinstance(manifest, NetworkManifest) and not NetworkBinding.model_validate(status.get("network")).matches(manifest):
                    raise RuntimeError("Coordinator network binding differs from the trusted manifest")
                self.connected = True
                self.last_authenticated_at = time.time()
                response = self._request(client, "POST", prefix + "/tasks/lease", json={"backend": backend})
                if response.status_code == 204:
                    self.state, self.detail = "idle", "Authenticated; no contribution task is available"
                    return
                raw = self._json(response)
                lease = raw.pop("lease")
                bundle = parse_bundle(raw)
                task = bundle.task
                if isinstance(manifest, NetworkManifest) != isinstance(task, TrainingTaskV2):
                    raise ValueError("Task protocol does not match the selected network")
                if isinstance(manifest, NetworkManifest) and not task.network.matches(manifest):
                    raise ValueError("Task belongs to another network")
                self.current_task = {"task_id": task.task_id, "round_id": task.round_id,
                                     "data_source": task.data_source, "data_license": task.data_license,
                                     "data_hash": task.data_hash, "steps": task.config.steps}
                validate_dataset(task, bundle.texts)
                a, b = base64.b64decode(bundle.shared_a, validate=True), base64.b64decode(bundle.base_b, validate=True)
                validate_artifacts(task, a, b)
                job = self.directory / "jobs" / task.task_id
                job.mkdir(parents=True, exist_ok=True, mode=0o700)
                (job / "task.json").write_text(task.model_dump_json())
                (job / "data.json").write_text(json.dumps(bundle.texts))
                (job / "a.safetensors").write_bytes(a)
                (job / "b.safetensors").write_bytes(b)
                # Never upload a stale result left by an interrupted attempt.
                (job / "result.safetensors").unlink(missing_ok=True)
                model_path = Path(os.environ.get("HEYUNA_MODEL_PATH", str(self.state_dir / "models" / "qwen3-4b")))
                validate_model_path(model_path, task)
                if self.cancel.is_set():
                    raise RuntimeError("Contribution stopped by user")
                self.state, self.detail = "training", "Running the reviewed local FFA training template"
                # Keep coordinator and wallet credentials out of the training process environment.
                env = {key: value for key, value in os.environ.items()
                       if key in {"PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR",
                                  "VIRTUAL_ENV", "PYTHONPATH", "CUDA_VISIBLE_DEVICES"}}
                env["HF_HUB_OFFLINE"] = "1"
                env["TRANSFORMERS_OFFLINE"] = "1"
                env["HF_HUB_DISABLE_TELEMETRY"] = "1"
                env["TOKENIZERS_PARALLELISM"] = "false"
                with (job / "training.log").open("wb") as log:
                    self.process = subprocess.Popen([sys.executable, "-m", "heyuna.training", "--job-dir", str(job),
                        "--model-path", str(model_path), "--backend", backend], env=env, stdout=log, stderr=log)
                    monitor = psutil.Process(self.process.pid)
                    monitor.cpu_percent()
                    heartbeat = time.monotonic()
                    started = heartbeat
                    while self.process.poll() is None:
                        if self.cancel.wait(0.5):
                            raise RuntimeError("Contribution stopped by user; result was not uploaded")
                        settings = self._limits()
                        try:
                            rss = monitor.memory_info().rss
                            cpu = monitor.cpu_percent() / max(1, psutil.cpu_count() or 1)
                        except psutil.NoSuchProcess:
                            self.process.wait(timeout=5)
                            break
                        if rss > float(settings["max_memory_gb"]) * 1024**3:
                            raise RuntimeError("Training exceeded the configured memory limit")
                        self.resources = {"rss_bytes": rss, "cpu_percent": round(cpu, 2),
                                          "elapsed_seconds": round(time.monotonic() - started, 1)}
                        if cpu > float(settings["max_cpu_percent"]):
                            raise RuntimeError("Training exceeded the sampled CPU budget; task stopped")
                        if time.monotonic() - started > 3600:
                            raise RuntimeError("Training exceeded the one-hour alpha job limit")
                        if time.monotonic() - heartbeat > 60:
                            self._json(self._request(client, "POST", f"{prefix}/tasks/{task.task_id}/heartbeat", json={"lease_id": lease["lease_id"]}))
                            heartbeat = time.monotonic()
                            self.last_authenticated_at = time.time()
                    if self.process.returncode:
                        raise RuntimeError(f"Training process failed (exit {self.process.returncode}); inspect local training.log")
                result = (job / "result.safetensors").read_bytes()
                validate_artifacts(task, a, result, update=True, base_b=b)
                submission = {"lease_id": lease["lease_id"], "task_hash": task.fingerprint,
                              "adapter_hash": digest(result), "adapter_b": base64.b64encode(result).decode()}
                if isinstance(task, TrainingTaskV2) and task.category == 1:
                    if digest(result) != task.verification.adapter_hash:
                        raise ValueError("Independent recomputation differs from the target artifact")
                    metrics = json.loads((job / "metrics.json").read_text())
                    evidence = RecomputationEvidence(task_hash=task.fingerprint,
                        target_receipt_id=task.verification.receipt_id,
                        target_chain_receipt_id=task.verification.chain_receipt_id,
                        artifact_hash=digest(result), metrics_hash=canonical_hash(metrics))
                    submission["verification_evidence"] = evidence.model_dump()
                    (job / "recomputation-evidence.json").write_text(evidence.model_dump_json())
                byte_count = len(json.dumps(submission).encode())
                self._limits(byte_count)
                if self.cancel.is_set() or not self.enabled:
                    raise RuntimeError("Contribution stopped; result was not uploaded")
                self.state, self.detail = "submitting", "Computation complete; uploading for independent verification"
                # Count attempted bytes before request so retries cannot bypass the daily cap.
                self.usage["upload_bytes"] += byte_count
                self._save("usage.json", self.usage)
                parsed_receipt = parse_receipt(self._json(self._request(
                    client, "POST", f"{prefix}/tasks/{task.task_id}/submit", json=submission)))
                self._check_receipt(parsed_receipt, manifest)
                self._check_task_receipt(parsed_receipt, task)
                if "verification_evidence" in submission and parsed_receipt.verification_evidence_hash != canonical_hash(submission["verification_evidence"]):
                    raise ValueError("Receipt recomputation evidence differs from the submitted report")
                receipt = parsed_receipt.model_dump(mode="json")
                if receipt["state"] not in {"pending_verification", "verified", "pending_settlement", "rejected"}:
                    raise ValueError("Coordinator returned an unsupported receipt state")
                if receipt["task_hash"] != task.fingerprint or receipt["adapter_hash"] != digest(result):
                    raise ValueError("Coordinator receipt does not match the submitted contribution")
                self.receipts = [r for r in self.receipts if r["receipt_id"] != receipt["receipt_id"]] + [receipt]
                self._save("receipts.json", self.receipts)
                self.state, self.detail = receipt["state"], receipt["detail"]
        except (ImportError, OSError, ValueError, TypeError, KeyError, RuntimeError, httpx.HTTPError, psutil.Error) as exc:
            self.state = "disabled" if self.cancel.is_set() else "error"
            self.detail = str(exc).replace(self.config.get("device_token", "[unset]"), "[redacted]")[:500]
            if isinstance(exc, (httpx.HTTPError, httpx.RequestError)) or "Coordinator HTTP" in str(exc):
                self.connected = False
                self.detail = "Coordinator request failed; connection is not confirmed"
        finally:
            if self.process and self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
            self.process = None
            self.resources["rss_bytes"] = 0
            self.resources["cpu_percent"] = 0
            self.resource_lock.release()

    def get_receipts(self):
        if not self.config:
            return []
        try:
            manifest, prefix = self._context()
            with self._client() as client:
                result = self._json(self._request(client, "GET", prefix + "/receipts"))
                if not isinstance(result, list):
                    raise TypeError("invalid receipt response")
                receipts = [parse_receipt(item) for item in result]
                for receipt in receipts:
                    self._check_receipt(receipt, manifest)
                    task_file = self.directory / "jobs" / receipt.task_id / "task.json"
                    if task_file.is_file():
                        self._check_task_receipt(receipt, parse_task(json.loads(task_file.read_text())))
                        result = task_file.parent / "result.safetensors"
                        if result.is_file() and (result.stat().st_size > 4 * 1024**2 or digest(result.read_bytes()) != receipt.adapter_hash):
                            raise ValueError("Remote receipt result differs from the local artifact")
                        evidence = task_file.parent / "recomputation-evidence.json"
                        if (isinstance(receipt, ContributionReceiptV2) and receipt.category == 1 and evidence.is_file()
                                and canonical_hash(json.loads(evidence.read_text())) != receipt.verification_evidence_hash):
                            raise ValueError("Remote receipt verification report differs from local evidence")
                    else:
                        receipt.detail = "Remote receipt; task binding is not locally verified. " + receipt.detail
                parsed = [item.model_dump(mode="json") for item in receipts]
                if any(item["state"] in {"claimable", "confirmed"} for item in parsed):
                    raise ValueError("Chain state from a coordinator is not independent chain evidence")
                self.receipts = parsed
                self.connected = True
                self.last_authenticated_at = time.time()
                return parsed
        except Exception as exc:
            self.connected = False
            raise HTTPException(502, "Could not retrieve authenticated contribution receipts") from exc
