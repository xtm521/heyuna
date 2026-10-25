"""Canonical FFA adapters: A=(rank,input), B=(output,rank), scale=1.

Safetensors is the only wire format. Neither pickle nor remote code is accepted.
"""
from __future__ import annotations

import hashlib
import math
from collections.abc import Mapping, Sequence

import numpy as np
from safetensors.numpy import load, save

from .protocol import TrainingConfig, TrainingTask

MAX_ARTIFACT_BYTES = 4 * 1024 * 1024
MAX_UPDATE_NORM = 25.0


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def encode_tensors(tensors: Mapping[str, np.ndarray]) -> bytes:
    return save({k: np.ascontiguousarray(v, dtype=np.float32) for k, v in sorted(tensors.items())})


def decode_tensors(data: bytes) -> dict[str, np.ndarray]:
    if not data or len(data) > MAX_ARTIFACT_BYTES:
        raise ValueError("adapter artifact exceeds size limit or is empty")
    try:
        tensors = load(data)
    except Exception as exc:
        raise ValueError("invalid safetensors artifact") from exc
    for array in tensors.values():
        if array.dtype != np.dtype("float32") or not np.isfinite(array).all():
            raise ValueError("adapters must contain finite float32 tensors")
    return tensors


def shared_adapter(config: TrainingConfig) -> tuple[bytes, bytes]:
    """Generate actual shared A bytes once; never rely on cross-framework RNG."""
    rng = np.random.default_rng(config.seed)
    a, b = {}, {}
    for layer in config.layers:
        bound = 1 / math.sqrt(layer.input_size)
        a[layer.name] = rng.uniform(-bound, bound, (config.rank, layer.input_size)).astype(np.float32)
        b[layer.name] = np.zeros((layer.output_size, config.rank), dtype=np.float32)
    return encode_tensors(a), encode_tensors(b)


def validate_artifacts(task: TrainingTask, a_bytes: bytes, b_bytes: bytes, *, update=False,
                       base_b: bytes | None = None) -> tuple[dict, dict]:
    if digest(a_bytes) != task.shared_a_hash:
        raise ValueError("shared frozen A hash mismatch")
    if not update and digest(b_bytes) != task.base_b_hash:
        raise ValueError("base B hash mismatch")
    a, b = decode_tensors(a_bytes), decode_tensors(b_bytes)
    expected = {layer.name for layer in task.config.layers}
    if set(a) != expected or set(b) != expected:
        raise ValueError("adapter layer set mismatch")
    for layer in task.config.layers:
        if a[layer.name].shape != (task.config.rank, layer.input_size):
            raise ValueError("A tensor shape mismatch")
        if b[layer.name].shape != (layer.output_size, task.config.rank):
            raise ValueError("B tensor shape mismatch")
    if update:
        if base_b is None or digest(base_b) != task.base_b_hash:
            raise ValueError("verified base B required to validate update")
        baseline = decode_tensors(base_b)
        norm = math.sqrt(sum(float(np.square(b[k].astype(np.float64) - baseline[k]).sum()) for k in b))
        if not math.isfinite(norm) or norm > MAX_UPDATE_NORM:
            raise ValueError("adapter update exceeds norm bound")
    return a, b


def canonical_to_mlx(a: Mapping[str, np.ndarray], b: Mapping[str, np.ndarray]) -> dict[str, np.ndarray]:
    return {**{f"{k}.lora_a": np.ascontiguousarray(v.T) for k, v in a.items()},
            **{f"{k}.lora_b": np.ascontiguousarray(v.T) for k, v in b.items()}}


def mlx_to_canonical(weights: Mapping[str, np.ndarray]) -> tuple[dict, dict]:
    a, b = {}, {}
    for name, value in weights.items():
        if name.endswith(".lora_a"):
            a[name[:-7]] = np.ascontiguousarray(value.T)
        elif name.endswith(".lora_b"):
            b[name[:-7]] = np.ascontiguousarray(value.T)
        else:
            raise ValueError("unexpected MLX adapter key")
    return a, b


def canonical_to_peft(a: Mapping[str, np.ndarray], b: Mapping[str, np.ndarray]) -> dict[str, np.ndarray]:
    return {**{f"base_model.model.{k}.lora_A.default.weight": v.copy() for k, v in a.items()},
            **{f"base_model.model.{k}.lora_B.default.weight": v.copy() for k, v in b.items()}}


def peft_to_canonical(weights: Mapping[str, np.ndarray]) -> tuple[dict, dict]:
    a, b = {}, {}
    for name, value in weights.items():
        for marker, output in ((".lora_A.default.weight", a), (".lora_B.default.weight", b)):
            if name.startswith("base_model.model.") and name.endswith(marker):
                output[name[len("base_model.model."):-len(marker)]] = value.copy()
                break
        else:
            raise ValueError("unexpected PEFT adapter key")
    return a, b


def aggregate(task: TrainingTask, a_bytes: bytes, base_b: bytes,
              updates: Sequence[tuple[TrainingTask, bytes, int]]) -> bytes:
    """Caller must supply ONLY independently accepted receipts, with verified work units."""
    if not updates:
        raise ValueError("cannot aggregate no accepted updates")
    validate_artifacts(task, a_bytes, base_b)
    if len({candidate.task_id for candidate, _, _ in updates}) != len(updates):
        raise ValueError("duplicate task contribution")
    total = sum(weight for _, _, weight in updates)
    if total <= 0:
        raise ValueError("positive verified work weights required")
    output = None
    for candidate, blob, weight in updates:
        # Tasks may have different data hashes/IDs but must share a model and adapter cohort.
        fields = ("model_id", "model_revision", "tokenizer_revision", "shared_a_hash", "base_b_hash", "config")
        if candidate.round_id != task.round_id or any(getattr(candidate, k) != getattr(task, k) for k in fields):
            raise ValueError("incompatible training cohort")
        if not isinstance(weight, int) or isinstance(weight, bool) or weight <= 0 or weight > 1000:
            raise ValueError("invalid verified work units")
        _, b = validate_artifacts(task, a_bytes, blob, update=True, base_b=base_b)
        if output is None:
            output = {k: v.astype(np.float64) * (weight / total) for k, v in b.items()}
        else:
            for k, v in b.items():
                output[k] += v.astype(np.float64) * (weight / total)
    return encode_tensors(output)
