import copy

import numpy as np
import pytest
from heyuna.federation import decode_tensors, digest, encode_tensors, shared_adapter
from heyuna.native_protocol import NetworkBinding, TrainingTaskV2, VerificationReference
from heyuna.protocol import TrainingConfig, TrainingTask
from heyuna.research import (
    PREREGISTRATION,
    ResearchCase,
    evaluate_case,
    full_comparison,
    native_task_operation,
    native_verification_result_commitment,
    preregistration_hash,
    sampled_comparison,
    summarize,
    wilson_interval,
)


@pytest.fixture
def research_task():
    config = TrainingConfig(steps=1, sequence_length=32)
    a, b = shared_adapter(config)
    task = TrainingTaskV2(task_id="research-unit", round_id="unit-round", model_revision="1" * 40,
                          tokenizer_revision="1" * 40, data_hash="2" * 64,
                          data_source="Authored unit fixture", data_license="Apache-2.0",
                          shared_a_hash=digest(a), base_b_hash=digest(b), config=config,
                          recipient="0x" + "3" * 40, category=0,
                          network=NetworkBinding(chain_id=297012, genesis_hash="0x" + "4" * 64,
                                                 reward_vault_address="0x" + "5" * 40,
                                                 network_domain="0x" + "6" * 64))
    return task, a, b


def test_wilson_reports_small_sample_uncertainty():
    interval = wilson_interval(0, 10)
    assert interval["wilson95"][0] == 0
    assert 0.27 < interval["wilson95"][1] < 0.28
    assert wilson_interval(1, 1)["wilson95"][0] < 0.21
    for invalid in ((0, 0), (2, 1), (-1, 3), (True, 1), (0, True)):
        with pytest.raises(ValueError):
            wilson_interval(*invalid)


def test_sparse_corruption_can_escape_sampling(research_task):
    _, _, baseline = research_task
    modified = decode_tensors(baseline)
    first = min(modified)
    modified[first].flat[0] = 0.1
    poison = encode_tensors(modified)
    assert not full_comparison(baseline, poison)
    # Deterministic, fixed pre-registered sample. This regression demonstrates
    # the known blind spot; it is not a probability-of-security estimate.
    assert sampled_comparison(baseline, poison)
    assert full_comparison(baseline, baseline)
    with pytest.raises(ValueError):
        sampled_comparison(baseline, poison, count=0)


def test_computation_quality_and_repeated_reward_are_separate(research_task):
    task, a, b = research_task
    repeated = ResearchCase("copy", b, True, already_rewarded=True)
    result = evaluate_case(task, a, b, b, repeated, baseline_loss=2.0, candidate_loss=2.0)
    assert result["specified_computation_passed"]
    assert result["heldout_nonregression_passed"]
    assert result["duplicate_reward_prevented"]
    assert not result["full_baseline_accepts"]
    quality = evaluate_case(task, a, b, b, ResearchCase("quality", b, True),
                            baseline_loss=2.0, candidate_loss=2.1)
    assert quality["specified_computation_passed"]
    assert not quality["heldout_nonregression_passed"]
    assert not quality["full_baseline_accepts"]
    changed = decode_tensors(b)
    changed[min(changed)].flat[0] = 0.1
    bad = evaluate_case(task, a, b, b, ResearchCase("collusion", encode_tensors(changed), True,
                                                 colluding_signers=2),
                        baseline_loss=2.0, candidate_loss=2.0)
    assert not bad["specified_computation_passed"]
    assert not bad["full_baseline_accepts"]
    assert bad["colluding_threshold_model_accepts"]
    with pytest.raises(ValueError):
        evaluate_case(task, a, b, b, repeated, baseline_loss=np.nan, candidate_loss=2.0)


def test_promotion_counts_full_reference_cost_and_requires_independent_evidence():
    normal = {"malicious": False, "full_baseline_accepts": True, "sampled_method_accepts": True,
              "full_comparison_seconds": 0.01, "sampled_comparison_seconds": 0.001}
    attack = {**normal, "malicious": True, "full_baseline_accepts": False, "sampled_method_accepts": True}
    summary = summarize([normal, attack], reference_seconds=100.0, heldout_seconds=10.0)
    assert summary["sampled_method"]["end_to_end_seconds"] > 110
    assert summary["end_to_end_time_reduction"] < 0.001
    assert not summary["detection_gate_passed"]
    assert not summary["minimum_30_percent_speedup_passed"]
    assert not summary["promote_sampled_method"]
    large = summarize([copy.deepcopy(normal) for _ in range(100)]
                      + [{**attack, "sampled_method_accepts": False} for _ in range(100)],
                      reference_seconds=1.0, heldout_seconds=1.0)
    assert not large["independent_sample_size_gate_passed"], "copying trials is not independent evidence"
    assert not large["promote_sampled_method"]
    assert len(preregistration_hash()) == 64
    assert PREREGISTRATION["promotion"]["minimum_end_to_end_time_reduction"] == 0.30


def test_native_bridge_is_domain_bound_and_does_not_upgrade_legacy_rights(research_task):
    task, _, _ = research_task
    kwargs = {"cosmos_chain_id": "heyuna_297012-1", "network_domain": task.network.network_domain,
              "vault_address": task.network.reward_vault_address, "genesis_hash": task.network.genesis_hash,
              "round_number": 0, "nonce": 0}
    envelope = native_task_operation(task, **kwargs)
    assert envelope["body"]["recipient"] == task.recipient
    assert envelope["body"]["data_hash"] == "0x" + task.data_hash
    assert envelope["chain_id"] == "heyuna_297012-1"
    with pytest.raises(ValueError, match="domain"):
        native_task_operation(task, **{**kwargs, "cosmos_chain_id": "heyuna_297011-1"})
    with pytest.raises(ValueError, match="domain"):
        native_task_operation(task, **{**kwargs, "genesis_hash": "0x" + "7" * 64})
    with pytest.raises(ValueError, match="uint64"):
        native_task_operation(task, **{**kwargs, "round_number": -1})
    legacy = TrainingTask.model_validate(task.model_dump(exclude={"network", "recipient", "category", "version"}))
    with pytest.raises(TypeError, match="legacy"):
        native_task_operation(legacy, **kwargs)


def test_native_verification_work_binds_target_and_matches_go(research_task):
    task, _, b = research_task
    target = "0x" + "3" * 64
    verification = task.model_copy(update={"category": 1, "verification": VerificationReference(
        receipt_id="offchain-receipt-id", chain_receipt_id=target, adapter_hash=digest(b))})
    envelope = native_task_operation(verification, cosmos_chain_id="heyuna_297012-1",
        network_domain=task.network.network_domain, vault_address=task.network.reward_vault_address,
        genesis_hash=task.network.genesis_hash, round_number=0, nonce=0)
    assert envelope["body"]["verification_target"] == target
    commitment = native_verification_result_commitment(cosmos_chain_id="heyuna_297012-1",
        evm_chain_id=297012, network_domain="0x" + "99" * 32,
        vault="0x0000000000000000000000000000000000001000", task_id="0x" + "11" * 32,
        worker="0x" + "22" * 20, verification_target="0x" + "33" * 32,
        artifact_hash="0x" + "44" * 32, evidence_hash="0x" + "55" * 32)
    assert commitment == "0x8e35b66014fd11678183acf84f1fadbc06baaa4cf77354c62910c80c822d580e"
