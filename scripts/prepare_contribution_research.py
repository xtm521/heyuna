#!/usr/bin/env python3
"""Create a reproducible native v2 job from public network metadata and authored text."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from heyuna.deployment import NetworkManifest
from heyuna.federation import digest, shared_adapter
from heyuna.native_protocol import NetworkBinding, TrainingTaskV2
from heyuna.protocol import TrainingConfig, canonical_hash
from heyuna.training import MODEL_REVISION

TRAINING_TEXTS = [
    "In Python, a pure addition function can be written as def add(a, b): return a + b.",
    "A test can check that add(2, 3) equals 5. A function should document its inputs.",
]
HELDOUT_TEXTS = [
    "A Python subtraction function returns the difference between two arguments. Tests should cover zero and negative values.",
    "A pure function has the same output for the same inputs and does not modify shared state.",
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deployment", type=Path, required=True)
    parser.add_argument("--recipient", required=True, help="Public EVM address; never a private key")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest = NetworkManifest.model_validate_json(args.deployment.read_text())
    if args.output.exists():
        raise FileExistsError("Research job already exists; choose a new directory to preserve evidence")
    config = TrainingConfig(steps=1, sequence_length=64, learning_rate=1e-4, seed=42)
    a, b = shared_adapter(config)
    task = TrainingTaskV2(
        task_id="native-research-compute", round_id="native-local-round-0",
        model_revision=MODEL_REVISION, tokenizer_revision=MODEL_REVISION,
        data_hash=canonical_hash(TRAINING_TEXTS), data_source="Heyuna project-authored test texts",
        data_license="Apache-2.0", shared_a_hash=digest(a), base_b_hash=digest(b), config=config,
        recipient=args.recipient, category=0,
        network=NetworkBinding(chain_id=manifest.chain_id, genesis_hash=manifest.genesis_hash,
                               reward_vault_address=manifest.reward_vault_address,
                               network_domain=manifest.network_domain),
    )
    args.output.mkdir(parents=True, mode=0o700)
    (args.output / "task.json").write_text(task.model_dump_json(indent=2) + "\n")
    (args.output / "data.json").write_text(json.dumps(TRAINING_TEXTS, indent=2) + "\n")
    (args.output / "heldout.json").write_text(json.dumps(HELDOUT_TEXTS, indent=2) + "\n")
    (args.output / "a.safetensors").write_bytes(a)
    (args.output / "b.safetensors").write_bytes(b)
    print(json.dumps({"version": 2, "task_hash": task.fingerprint,
                      "chain_id": manifest.chain_id, "genesis_hash": manifest.genesis_hash,
                      "notice": "Public job preparation only; no chain verification, training, signing or reward."}))


if __name__ == "__main__":
    main()
