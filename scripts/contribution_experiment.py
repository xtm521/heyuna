#!/usr/bin/env python3
"""Run actual MLX/CUDA recomputation and adversarial adapter research offline."""
from __future__ import annotations

import argparse
import importlib.metadata
import json
import platform
import time
from datetime import UTC, datetime
from pathlib import Path

from heyuna.federation import decode_tensors, digest, encode_tensors
from heyuna.native_protocol import TrainingTaskV2
from heyuna.protocol import canonical_hash
from heyuna.research import PREREGISTRATION, ResearchCase, evaluate_case, preregistration_hash, summarize
from heyuna.training import heldout_losses, train


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job-dir", type=Path, required=True)
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument("--backend", choices=["mlx", "cuda"], required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    task = TrainingTaskV2.model_validate_json((args.job_dir / "task.json").read_text())
    texts = json.loads((args.job_dir / "data.json").read_text())
    heldout = json.loads((args.job_dir / "heldout.json").read_text())
    if set(texts) & set(heldout):
        raise ValueError("heldout examples overlap training data")
    shared_a, base_b = (args.job_dir / "a.safetensors").read_bytes(), (args.job_dir / "b.safetensors").read_bytes()
    normal = (args.job_dir / "result.safetensors").read_bytes()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    preregistered = {**PREREGISTRATION, "preregistration_hash": preregistration_hash(),
                     "task_hash": task.fingerprint, "heldout_hash": canonical_hash(heldout),
                     "training_data_hash": canonical_hash(texts), "actual_steps": task.config.steps}
    preregistration_path = args.output.with_suffix(".preregistered.json")
    preregistration_path.write_text(json.dumps(preregistered, indent=2) + "\n")
    print(json.dumps({"phase": "preregistered", "hash": preregistration_hash()}), flush=True)
    started = time.perf_counter()
    reference, reference_metrics = train(task, args.model_path, texts, shared_a, base_b, args.backend)
    reference_seconds = time.perf_counter() - started
    print(json.dumps({"phase": "actual-full-recomputation", "seconds": reference_seconds,
                      "adapter_hash": digest(reference)}), flush=True)
    substituted = PREREGISTRATION["attack_generation"]["substituted_data"]
    replacement_task = task.model_copy(update={"data_hash": canonical_hash(substituted)})
    started = time.perf_counter()
    wrong_data, wrong_metrics = train(replacement_task, args.model_path, substituted, shared_a, base_b, args.backend)
    substitution_seconds = time.perf_counter() - started
    poison = decode_tensors(normal)
    # Finite, norm-bounded one-coordinate corruption. Its position is fixed
    # before sampling; this is not a claim of arbitrary model backdoor success.
    first = min(poison)
    poison[first] = poison[first].copy()
    poison[first].flat[0] += 0.1
    sparse = encode_tensors(poison)
    cases = [
        ResearchCase("normal", normal, False, creation="Actual domain-bound fixed-template training."),
        ResearchCase("skipped_step", base_b, True, creation="Returns unchanged base B, skipping all assigned optimizer steps."),
        ResearchCase("stale_receipt", normal, True, binding_matches=False,
                     creation="Same numerical artifact with an old task/domain receipt; binding must independently fail."),
        ResearchCase("copied_result", normal, True, already_rewarded=True,
                     creation="Byte-identical already-rewarded output; recomputation alone cannot detect ownership."),
        ResearchCase("substituted_data", wrong_data, True,
                     creation="Actual training against the disclosed alternative dataset, submitted for the original task."),
        ResearchCase("sparse_poison", sparse, True,
                     creation="One finite B coordinate increased by 0.1, under the update norm bound."),
        ResearchCase("two_of_three_collusion", sparse, True, colluding_signers=2,
                     creation="Threshold-policy model with two dishonest approvals for the sparse-corrupted adapter."),
    ]
    started = time.perf_counter()
    losses = heldout_losses(task, args.model_path, heldout, shared_a, [base_b, *[c.candidate for c in cases]], args.backend)
    heldout_seconds = time.perf_counter() - started
    results = [evaluate_case(task, shared_a, base_b, reference, case, baseline_loss=losses[0], candidate_loss=loss)
               for case, loss in zip(cases, losses[1:], strict=True)]
    report = {"version": 1, "kind": "single-device-real-model-contribution-verification-research",
              "observed_at_utc": datetime.now(UTC).isoformat(), "platform": platform.platform(),
              "backend": args.backend, "model_id": task.model_id, "model_revision": task.model_revision,
              "preregistration": preregistered, "network_binding": task.network.model_dump(),
              "reference_metrics": reference_metrics, "alternative_dataset_metrics": wrong_metrics,
              "alternative_dataset_generation_seconds": substitution_seconds,
              "project_authored_training_texts": texts, "project_authored_heldout_texts": heldout,
              "project_authored_alternative_texts": substituted, "cases": results,
              "summary": summarize(results, reference_seconds=reference_seconds, heldout_seconds=heldout_seconds),
              "versions": {name: importlib.metadata.version(name) for name in ("numpy", "safetensors")},
              "limitations": ["Single physical device and one operator; no independence or cross-backend evidence.",
                              "One normal case and six correlated designed attacks are not a statistical security proof.",
                              "Heldout loss checks a tiny authored sample, not coding quality or backdoor safety.",
                              "Collusion result is the documented 2/3 threshold policy model, not an independently operated attack trial.",
                              "Sampling uses a full recomputed reference whose cost is included in both methods.",
                              "Numerical tolerance matching is not a cryptographic proof; close adversarial outputs may pass.",
                              "Correct numerical output does not prove which participant performed the computation."]}
    report["report_hash"] = canonical_hash(report)
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"phase": "completed", "report": str(args.output), "summary": report["summary"]}), flush=True)


if __name__ == "__main__":
    main()
