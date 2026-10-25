"""Versioned, closed-schema messages for the invited Heyuna alpha."""
from __future__ import annotations

import hashlib
import json
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

MODEL_ID = "Qwen/Qwen3-4B-Instruct-2507"
CHAIN_ID = 11155111
RANK = 8
SCALE = 1.0
REWARD_POOL = 18_000_000 * 10**18
PERIODS = 520
HexDigest = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
Revision = Annotated[str, Field(pattern=r"^[0-9a-f]{40}$")]
Address = Annotated[str, Field(pattern=r"^0x[0-9a-fA-F]{40}$")]
Identifier = Annotated[str, Field(pattern=r"^[a-zA-Z0-9_-]{1,80}$")]


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class LayerSpec(Message):
    name: str = Field(pattern=r"^model\.layers\.(34|35)\.self_attn\.(q_proj|v_proj)$")
    input_size: Literal[2560] = 2560
    output_size: Literal[1024, 4096]

    @model_validator(mode="after")
    def correct_shape(self):
        expected = 4096 if self.name.endswith("q_proj") else 1024
        if self.output_size != expected:
            raise ValueError("projection shape does not match the pinned model")
        return self


DEFAULT_LAYERS = [
    LayerSpec(name=f"model.layers.{i}.self_attn.{name}", output_size=size)
    for i in (34, 35) for name, size in (("q_proj", 4096), ("v_proj", 1024))
]


class TrainingConfig(Message):
    template: Literal["heyuna-ffa-causal-lm-v1"] = "heyuna-ffa-causal-lm-v1"
    base_dtype: Literal["bfloat16"] = "bfloat16"
    rank: Literal[8] = 8
    scale: Literal[1.0] = 1.0
    steps: int = Field(default=4, ge=1, le=50)
    sequence_length: int = Field(default=128, ge=32, le=512)
    learning_rate: float = Field(default=1e-4, gt=0, le=1e-3)
    seed: int = Field(default=42, ge=0, le=2**31 - 1)
    layers: list[LayerSpec] = Field(default_factory=lambda: list(DEFAULT_LAYERS), min_length=4, max_length=4)

    @model_validator(mode="after")
    def exact_layers(self):
        if self.layers != DEFAULT_LAYERS:
            raise ValueError("v1 trains exactly q/v projections in layers 34 and 35")
        return self


class TrainingTask(Message):
    version: Literal[1] = 1
    task_id: Identifier
    round_id: Identifier
    model_id: Literal["Qwen/Qwen3-4B-Instruct-2507"] = MODEL_ID
    model_revision: Revision
    tokenizer_revision: Revision
    data_hash: HexDigest
    data_source: str = Field(min_length=1, max_length=2000)
    data_license: str = Field(min_length=1, max_length=200)
    shared_a_hash: HexDigest
    base_b_hash: HexDigest
    config: TrainingConfig = Field(default_factory=TrainingConfig)
    work_units: int = Field(default=1, ge=1, le=1000)

    @model_validator(mode="after")
    def tokenizer_matches(self):
        if self.tokenizer_revision != self.model_revision:
            raise ValueError("tokenizer revision must match the base model")
        return self

    @property
    def fingerprint(self) -> str:
        return canonical_hash(self.model_dump())


class TaskBundle(Message):
    task: TrainingTask
    texts: list[str] = Field(min_length=1, max_length=256)
    shared_a: str = Field(max_length=6_000_000)
    base_b: str = Field(max_length=6_000_000)


class ContributionState(StrEnum):
    COMPUTED = "computed"
    PENDING_VERIFICATION = "pending_verification"
    VERIFIED = "verified"
    REJECTED = "rejected"
    PENDING_SETTLEMENT = "pending_settlement"
    CLAIMABLE = "claimable"
    CONFIRMED = "confirmed"


class ContributionReceipt(Message):
    receipt_id: Identifier
    task_id: Identifier
    round_id: Identifier
    participant_id: Identifier
    wallet: Address
    task_hash: HexDigest
    adapter_hash: HexDigest
    state: ContributionState
    work_units: int = Field(ge=1)
    validator_ids: list[str] = Field(default_factory=list)
    detail: str = "Awaiting independent validators; no chain payment has occurred."


class RewardAllocation(Message):
    recipient: Address
    amount: str = Field(pattern=r"^[0-9]+$")
    category: Literal["training", "validation"]
    receipt_ids: list[str]


class RewardEpoch(Message):
    epoch: int = Field(ge=0)
    chain_id: Literal[11155111] = CHAIN_ID
    state: Literal["draft_pending_review"] = "draft_pending_review"
    budget_wei: str
    allocated_wei: str
    allocations: list[RewardAllocation]
    manifest_hash: str = ""
    notice: str = "Unsigned draft only. Not an on-chain root, proof, entitlement or payment."


def canonical_hash(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                      ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def weekly_budget(epoch: int) -> int:
    if epoch < 0:
        raise ValueError("epoch must be nonnegative")
    if epoch < PERIODS:
        return ((epoch + 1) * REWARD_POOL // PERIODS) - (epoch * REWARD_POOL // PERIODS)
    return (REWARD_POOL + PERIODS - 1) // PERIODS
