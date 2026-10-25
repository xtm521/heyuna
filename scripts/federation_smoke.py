#!/usr/bin/env python3
"""Run a real local 4B training smoke. Requires explicit prepared model path.

This script does not publish rewards or claim multi-device/independent verification.
"""
import argparse
import hashlib
import importlib.metadata
import json
import platform
import time
from pathlib import Path

from heyuna.federation import digest, shared_adapter
from heyuna.protocol import TrainingConfig, TrainingTask, canonical_hash
from heyuna.training import MODEL_REVISION, train, verify

parser = argparse.ArgumentParser()
parser.add_argument('--model-path', type=Path, required=True)
parser.add_argument('--backend', choices=['mlx', 'cuda'], required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--steps', type=int, default=1)
parser.add_argument('--verify', action='store_true', help='Also recompute and evaluate locally, not independently')
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
config = TrainingConfig(steps=args.steps, sequence_length=64)
# Project-authored smoke data, not copied external code or private user files.
texts = ['In Python, a pure addition function can be written as def add(a, b): return a + b.',
         'A test can check that add(2, 3) equals 5. A function should document its inputs.']
a, b = shared_adapter(config)
task = TrainingTask(task_id='local-training-smoke', round_id='local-only', model_revision=MODEL_REVISION,
                    tokenizer_revision=MODEL_REVISION, data_hash=canonical_hash(texts),
                        data_source="Heyuna project-authored test texts", data_license="Apache-2.0",
                    shared_a_hash=digest(a), base_b_hash=digest(b), config=config)
(args.output / 'task.json').write_text(task.model_dump_json(indent=2))
(args.output / 'data.json').write_text(json.dumps(texts))
(args.output / 'a.safetensors').write_bytes(a)
(args.output / 'b.safetensors').write_bytes(b)
started = time.monotonic()
result, metrics = train(task, args.model_path, texts, a, b, args.backend)
metrics["training_seconds"] = round(time.monotonic() - started, 3)
if args.backend == "mlx":
    import mlx.core as mx
    metrics["peak_device_memory_bytes"] = mx.get_peak_memory()
else:
    import torch
    metrics["peak_device_memory_bytes"] = torch.cuda.max_memory_allocated()
metrics["model_id"] = task.model_id
metrics["model_revision"] = task.model_revision
metrics["platform"] = platform.platform()
metrics["versions"] = {name: importlib.metadata.version(name) for name in (
    ["mlx", "mlx-lm", "numpy", "safetensors"] if args.backend == "mlx"
    else ["torch", "transformers", "peft", "numpy", "safetensors"])}
file_hashes = {}
for file in sorted(args.model_path.iterdir()):
    if file.suffix in {".json", ".safetensors"} and file.is_file():
        hasher = hashlib.sha256()
        with file.open("rb") as stream:
            while chunk := stream.read(8 * 1024 * 1024):
                hasher.update(chunk)
        file_hashes[file.name] = hasher.hexdigest()
metrics["model_file_hashes"] = file_hashes
(args.output / 'result.safetensors').write_bytes(result)
metrics['evidence_scope'] = 'single physical machine; real local training; no network settlement'
(args.output / 'metrics.json').write_text(json.dumps(metrics, indent=2, allow_nan=False))
if args.verify:
    report = verify(task, args.model_path, texts, a, b, result,
                    ['For a nonempty list of numbers, their mean is the sum divided by the length.'], args.backend)
    report['operator_independence'] = False
    report['evidence_hash'] = canonical_hash({k: v for k, v in report.items() if k != 'evidence_hash'})
    (args.output / 'validation.json').write_text(json.dumps(report, indent=2, allow_nan=False))
print(json.dumps(metrics, indent=2))
