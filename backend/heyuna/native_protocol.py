"""Closed v2 messages. Legacy tasks/receipts never acquire native claim rights."""
from __future__ import annotations

from typing import Literal

from pydantic import Field, model_validator

from .deployment import Hash, NetworkManifest
from .protocol import (
    Address,
    ContributionReceipt,
    HexDigest,
    Identifier,
    Message,
    RewardAllocation,
    TrainingTask,
    canonical_hash,
)

NATIVE_REWARD_POOL = 14_000_000 * 10**18
NATIVE_TRAINING_POOL = NATIVE_REWARD_POOL * 9 // 10
NATIVE_VERIFICATION_POOL = NATIVE_REWARD_POOL - NATIVE_TRAINING_POOL


class NetworkBinding(Message):
    chain_id: Literal[297011, 297012]
    genesis_hash: Hash
    reward_vault_address: Address
    network_domain: Hash

    def matches(self, manifest: NetworkManifest):
        return (self.chain_id == manifest.chain_id and self.genesis_hash.lower() == manifest.genesis_hash.lower()
                and self.reward_vault_address.lower() == manifest.reward_vault_address.lower()
                and self.network_domain.lower() == manifest.network_domain.lower())


class VerificationReference(Message):
    receipt_id: Identifier  # Coordinator receipt namespace, not a chain claim ID.
    chain_receipt_id: Hash  # Independently checked by x/contribution when anchored.
    adapter_hash: HexDigest


class RecomputationEvidence(Message):
    version: Literal[1] = 1
    kind: Literal["independent-recomputation"] = "independent-recomputation"
    task_hash: HexDigest
    target_receipt_id: Identifier
    target_chain_receipt_id: Hash
    artifact_hash: HexDigest
    metrics_hash: HexDigest


class TrainingTaskV2(TrainingTask):
    version: Literal[2] = 2
    network: NetworkBinding
    recipient: Address
    category: Literal[0, 1]  # 0 training; 1 a separate recomputation task
    verification: VerificationReference | None = Field(default=None, exclude_if=lambda value: value is None)

    @model_validator(mode="after")
    def nonzero_recipient(self):
        if int(self.recipient, 16) == 0:
            raise ValueError("recipient must be nonzero")
        if (self.category == 1) != (self.verification is not None):
            raise ValueError("only recomputation tasks require a target receipt")
        return self


class TaskBundleV2(Message):
    task: TrainingTaskV2
    texts: list[str] = Field(min_length=1, max_length=256)
    shared_a: str = Field(max_length=6_000_000)
    base_b: str = Field(max_length=6_000_000)


class ContributionReceiptV2(ContributionReceipt):
    version: Literal[2] = 2
    network: NetworkBinding
    model_hash: Hash
    data_hash: Hash
    template_hash: Hash
    config_hash: Hash
    category: Literal[0, 1]
    verification: VerificationReference | None = Field(default=None, exclude_if=lambda value: value is None)
    verification_evidence_hash: HexDigest | None = Field(default=None, exclude_if=lambda value: value is None)
    detail: str = "Off-chain v2 receipt only; chain commitment, finalization and claim are separate actions."


class RewardEpochV2(Message):
    version: Literal[2] = 2
    network: NetworkBinding
    epoch: int = Field(ge=0)
    state: Literal["draft_pending_review"] = "draft_pending_review"
    budget_wei: str
    allocated_wei: str
    allocations: list[RewardAllocation]
    manifest_hash: str = ""
    notice: str = "Native-chain unsigned draft only. No legacy receipt conversion and no payment."


def native_weekly_budget(epoch: int) -> int:
    if not isinstance(epoch, int) or isinstance(epoch, bool) or epoch < 0:
        raise ValueError("epoch must be nonnegative integer")
    if epoch < 520:
        return (epoch + 1) * NATIVE_REWARD_POOL // 520 - epoch * NATIVE_REWARD_POOL // 520
    return (NATIVE_REWARD_POOL + 519) // 520


def parse_task(data):
    return TrainingTaskV2.model_validate(data) if data.get("version") == 2 else TrainingTask.model_validate(data)


def parse_bundle(data):
    from .protocol import TaskBundle
    return TaskBundleV2.model_validate(data) if data.get("task", {}).get("version") == 2 else TaskBundle.model_validate(data)


def parse_receipt(data):
    return ContributionReceiptV2.model_validate(data) if data.get("version") == 2 else ContributionReceipt.model_validate(data)


def attestation_bindings(task: TrainingTaskV2):
    return {"network": task.network, "category": task.category,
            **({"verification": task.verification} if task.verification else {}),
            "model_hash": "0x" + canonical_hash({"model_id": task.model_id, "model_revision": task.model_revision,
                                                  "tokenizer_revision": task.tokenizer_revision}),
            "data_hash": "0x" + task.data_hash,
            "template_hash": "0x" + canonical_hash({"template": task.config.template, "shared_a": task.shared_a_hash,
                                                     "base_b": task.base_b_hash}),
            "config_hash": "0x" + canonical_hash(task.config.model_dump())}
