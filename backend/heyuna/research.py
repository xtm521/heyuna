"""Offline contribution-verification research, separate from consensus and signing.

Full recomputation establishes agreement with a specified numerical result, not
proof of who performed it. This module never signs reports or grants rewards.
"""
from __future__ import annotations

import hashlib
import math
import time
from dataclasses import dataclass
from typing import Any

import numpy as np

from .federation import decode_tensors, digest, validate_artifacts
from .native_protocol import TrainingTaskV2, attestation_bindings
from .protocol import canonical_hash

PREREGISTRATION = {
    "version": 1,
    "suite": "heyuna-contribution-research-v1",
    "hypotheses": ["specified-computation-result", "heldout-nonregression", "duplicate-reward-prevention"],
    "cases": ["normal", "skipped_step", "stale_receipt", "copied_result", "substituted_data",
              "sparse_poison", "two_of_three_collusion"],
    "comparison": {"atol": 1e-5, "rtol": 1e-2},
    "heldout_max_loss_ratio": 1.01,
    "sampling_coordinates": 512,
    "sampling_seed": "heyuna-public-reproducible-sampling-v1",
    "sampling_seed_notice": "Public reproducibility seed; not an unpredictable production challenge.",
    "attack_generation": {
        "skipped_step": "Return the unchanged base B artifact.",
        "stale_receipt": "Return the normal result with a nonmatching old task/domain binding.",
        "copied_result": "Return byte-identical normal output already marked rewarded.",
        "substituted_data": [
            "The replacement dataset teaches that addition returns subtraction: def add(a, b): return a - b.",
            "This substituted text is a project-authored adversarial fixture, not the assigned training shard.",
        ],
        "sparse_poison": {"tensor": "lexicographically-first", "flat_coordinate": 0, "delta": 0.1},
        "two_of_three_collusion": "Use the same sparse-corrupted adapter with two modeled dishonest approvals.",
    },
    "promotion": {"minimum_end_to_end_time_reduction": 0.30, "maximum_cheat_acceptance_increase": 0.0,
                  "maximum_normal_false_rejection_increase": 0.0,
                  "minimum_independent_normal_cases": 100, "minimum_independent_attack_cases": 100},
    "timing_policy": "Count full reference recomputation and heldout evaluation in both methods; no free oracle.",
    "confidence_interval": "Wilson 95%; descriptive only for this correlated small deterministic suite.",
}


def wilson_interval(successes: int, trials: int, z: float = 1.959963984540054) -> dict[str, Any]:
    if (not isinstance(successes, int) or isinstance(successes, bool) or not isinstance(trials, int)
            or isinstance(trials, bool) or not 0 <= successes <= trials or trials <= 0):
        raise ValueError("positive trial count and bounded integer successes required")
    p = successes / trials
    divisor = 1 + z * z / trials
    center = (p + z * z / (2 * trials)) / divisor
    radius = z * math.sqrt(p * (1 - p) / trials + z * z / (4 * trials * trials)) / divisor
    return {"successes": successes, "trials": trials, "rate": p,
            "wilson95": [0.0 if successes == 0 else max(0.0, center - radius),
                         1.0 if successes == trials else min(1.0, center + radius)],
            "generalization": "Small correlated deterministic suite; not a population guarantee."}


def _aligned(reference: bytes, candidate: bytes):
    expected, actual = decode_tensors(reference), decode_tensors(candidate)
    if set(expected) != set(actual) or any(expected[k].shape != actual[k].shape for k in expected):
        raise ValueError("candidate layer set or shape differs from reference")
    return expected, actual


def full_comparison(reference: bytes, candidate: bytes) -> bool:
    expected, actual = _aligned(reference, candidate)
    return all(np.allclose(expected[k], actual[k], atol=1e-5, rtol=1e-2) for k in expected)


def sampled_comparison(reference: bytes, candidate: bytes, *, count: int = 512,
                       seed: str = PREREGISTRATION["sampling_seed"]) -> bool:
    """Diagnostic coordinate sampling against a full reference, with its cost counted.

This is deliberately not a succinct compute proof. Sparse adversarial corruption
can escape a coordinate sample, and computing the reference is still necessary.
"""
    if not isinstance(count, int) or isinstance(count, bool) or count <= 0 or count > 1_000_000:
        raise ValueError("bounded positive sampling count required")
    expected, actual = _aligned(reference, candidate)
    expected_flat = np.concatenate([expected[k].ravel() for k in sorted(expected)])
    actual_flat = np.concatenate([actual[k].ravel() for k in sorted(actual)])
    seed_number = int.from_bytes(hashlib.sha256(seed.encode()).digest()[:16], "big")
    positions = np.random.default_rng(seed_number).choice(len(expected_flat), min(count, len(expected_flat)),
                                                         replace=False)
    return bool(np.allclose(expected_flat[positions], actual_flat[positions], atol=1e-5, rtol=1e-2))


@dataclass(frozen=True)
class ResearchCase:
    name: str
    candidate: bytes
    malicious: bool
    binding_matches: bool = True
    already_rewarded: bool = False
    colluding_signers: int = 0
    creation: str = ""


def evaluate_case(task: TrainingTaskV2, shared_a: bytes, base_b: bytes, reference: bytes,
                  case: ResearchCase, *, baseline_loss: float, candidate_loss: float) -> dict[str, Any]:
    if not all(math.isfinite(value) and value >= 0 for value in (baseline_loss, candidate_loss)):
        raise ValueError("finite nonnegative actual heldout losses required")
    structural = True
    rejection = None
    try:
        validate_artifacts(task, shared_a, case.candidate, update=True, base_b=base_b)
    except ValueError as error:
        structural, rejection = False, str(error)
    started = time.perf_counter()
    computation = structural and full_comparison(reference, case.candidate)
    full_seconds = time.perf_counter() - started
    started = time.perf_counter()
    sampled = structural and sampled_comparison(reference, case.candidate)
    sampled_seconds = time.perf_counter() - started
    quality = candidate_loss <= baseline_loss * PREREGISTRATION["heldout_max_loss_ratio"]
    eligible = structural and case.binding_matches and not case.already_rewarded
    full_accept = bool(eligible and computation and quality)
    sample_accept = bool(eligible and sampled and quality)
    return {"case": case.name, "malicious": case.malicious, "creation": case.creation,
            "adapter_hash": digest(case.candidate), "artifact_format_and_norm_passed": structural,
            "structural_rejection": rejection, "specified_computation_passed": bool(computation),
            "sampled_computation_passed": bool(sampled), "heldout_nonregression_passed": quality,
            "baseline_loss": baseline_loss, "candidate_loss": candidate_loss,
            "domain_binding_passed": case.binding_matches,
            "duplicate_reward_prevented": case.already_rewarded,
            "full_baseline_accepts": full_accept, "sampled_method_accepts": sample_accept,
            "full_comparison_seconds": full_seconds, "sampled_comparison_seconds": sampled_seconds,
            "colluding_threshold_model_accepts": bool(eligible and case.colluding_signers >= 2),
            "collusion_notice": "Threshold-policy model only; signatures do not imply independent evaluation."}


def summarize(results: list[dict], *, reference_seconds: float, heldout_seconds: float,
              independent_trials_verified: bool = False) -> dict:
    if not results or reference_seconds < 0 or heldout_seconds < 0:
        raise ValueError("nonempty results and nonnegative measured costs required")
    normal = [item for item in results if not item["malicious"]]
    attacks = [item for item in results if item["malicious"]]
    if not normal or not attacks:
        raise ValueError("normal and attack samples are both required")
    summary = {}
    for method, field, timing in (("full_baseline", "full_baseline_accepts", "full_comparison_seconds"),
                                   ("sampled_method", "sampled_method_accepts", "sampled_comparison_seconds")):
        summary[method] = {
            "cheat_acceptance": wilson_interval(sum(bool(item[field]) for item in attacks), len(attacks)),
            "normal_false_rejection": wilson_interval(sum(not item[field] for item in normal), len(normal)),
            "end_to_end_seconds": reference_seconds + heldout_seconds + sum(item[timing] for item in results),
        }
    baseline, sampled = summary["full_baseline"], summary["sampled_method"]
    reduction = 1 - sampled["end_to_end_seconds"] / max(baseline["end_to_end_seconds"], 1e-12)
    gate = PREREGISTRATION["promotion"]
    sufficient = (independent_trials_verified and len(normal) >= gate["minimum_independent_normal_cases"]
                  and len(attacks) >= gate["minimum_independent_attack_cases"])
    safe = (sampled["cheat_acceptance"]["rate"] <= baseline["cheat_acceptance"]["rate"]
            and sampled["normal_false_rejection"]["rate"] <= baseline["normal_false_rejection"]["rate"])
    return {**summary, "end_to_end_time_reduction": reduction,
            "reference_recomputation_seconds_included": reference_seconds,
            "heldout_evaluation_seconds_included": heldout_seconds,
            "detection_gate_passed": safe, "minimum_30_percent_speedup_passed": reduction >= 0.30,
            "independent_sample_size_gate_passed": sufficient,
            "promote_sampled_method": bool(safe and reduction >= 0.30 and sufficient),
            "default_verifier": "full-recomputation-plus-independent-heldout",
            "quality_improvement_proven": False,
            "operator_independence_verified": False}


def native_task_operation(task: TrainingTaskV2, *, cosmos_chain_id: str, network_domain: str,
                          vault_address: str, genesis_hash: str, round_number: int, nonce: int) -> dict:
    """Build reviewable public CLI input; no wallet, private key or signature access."""
    if not isinstance(task, TrainingTaskV2):
        raise TypeError("legacy tasks cannot acquire native settlement rights")
    if (cosmos_chain_id != f"heyuna_{task.network.chain_id}-1"
            or task.network.network_domain.lower() != network_domain.lower()
            or task.network.genesis_hash.lower() != genesis_hash.lower()
            or task.network.reward_vault_address.lower() != vault_address.lower()):
        raise ValueError("native task settlement domain mismatch")
    if any(not isinstance(v, int) or isinstance(v, bool) or not 0 <= v < 2**64 for v in (round_number, nonce)):
        raise ValueError("round and nonce must be uint64")
    bindings = attestation_bindings(task)
    body = {key: bindings[key] for key in ("model_hash", "data_hash", "template_hash", "config_hash")}
    body.update(round=round_number, nonce=nonce, recipient=task.recipient, category=task.category)
    if task.category == 1:
        if task.verification is None:
            raise ValueError("independent verification requires a bound training receipt")
        body["verification_target"] = task.verification.chain_receipt_id
    return {"version": 1, "chain_id": cosmos_chain_id, "network_domain": network_domain,
            "vault_address": vault_address, "kind": "submit_task", "body": body}


def preregistration_hash() -> str:
    return canonical_hash(PREREGISTRATION)


def native_verification_result_commitment(*, cosmos_chain_id: str, evm_chain_id: int,
                                          network_domain: str, vault: str, task_id: str,
                                          worker: str, verification_target: str, artifact_hash: str,
                                          evidence_hash: str) -> str:
    """Exact x/contribution canonical-JSON SHA256 verification work commitment."""
    if evm_chain_id not in {297011, 297012} or cosmos_chain_id != f"heyuna_{evm_chain_id}-1":
        raise ValueError("verification result network domain mismatch")
    hashes = (network_domain, task_id, verification_target, artifact_hash, evidence_hash)
    if any(not isinstance(value, str) or len(value) != 66 or not value.startswith("0x") for value in hashes):
        raise ValueError("verification result requires 32-byte hex commitments")
    for value in hashes:
        if int(value, 16) == 0:
            raise ValueError("zero verification commitment")
    for address in (vault, worker):
        if not isinstance(address, str) or len(address) != 42 or not address.startswith("0x") or int(address, 16) == 0:
            raise ValueError("verification result requires nonzero EVM identities")
    return "0x" + canonical_hash({"version": 1, "domain": network_domain.lower(), "chain_id": cosmos_chain_id,
                                  "evm_chain_id": evm_chain_id, "vault": vault.lower(),
                                  "task_id": task_id.lower(), "worker": worker.lower(),
                                  "verification_target": verification_target.lower(),
                                  "artifact_hash": artifact_hash.lower(), "evidence_hash": evidence_hash.lower()})
