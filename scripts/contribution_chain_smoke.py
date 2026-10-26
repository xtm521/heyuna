#!/usr/bin/env python3
"""Exercise authenticated SDK contribution transactions on the local 3s profile.

Uses only the disposable local keyrings created by chain_localnet.py. It never
prints key material, enables a clock RPC, or writes to the 72h research profile.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from heyuna.federation import digest
from heyuna.native_protocol import RecomputationEvidence, TrainingTaskV2, VerificationReference
from heyuna.protocol import canonical_hash
from heyuna.research import native_task_operation, native_verification_result_commitment

ROOT = Path(__file__).resolve().parents[1]
BINARY = ROOT / ".state/bin/heyunad"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=ROOT / ".state/chain-accelerated")
    parser.add_argument("--job-dir", type=Path, required=True)
    parser.add_argument("--model-path", type=Path, required=True, help="Prepared pinned model for actual independent recomputation")
    parser.add_argument("--backend", choices=["mlx", "cuda"], required=True)
    args = parser.parse_args()
    state = args.state_dir.resolve()
    manifest = json.loads((state / "deployment.json").read_text())
    public = json.loads((state / "public-accounts.json").read_text())
    if (manifest.get("profile") != "accelerated-local" or manifest.get("chain_id") != 297012
            or manifest.get("challenge_seconds") != 3
            or manifest.get("rpc_url") != "http://127.0.0.1:10545"
            or manifest.get("cosmos_rpc_url") != "http://127.0.0.1:28657"):
        raise ValueError("This write-enabled smoke supports only the separate disposable loopback 3s profile")
    task = TrainingTaskV2.model_validate_json((args.job_dir / "task.json").read_text())
    if not all((task.network.chain_id == manifest["chain_id"],
                task.network.genesis_hash.lower() == manifest["genesis_hash"].lower(),
                task.network.network_domain.lower() == manifest["network_domain"].lower(),
                task.network.reward_vault_address.lower() == manifest["reward_vault_address"].lower())):
        raise ValueError("Native task is bound to a different deployment")
    candidate = (args.job_dir / "result.safetensors").read_bytes()
    validation = json.loads((args.job_dir / "validation.json").read_text())
    if (validation.get("accepted") is not True or validation.get("task_hash") != task.fingerprint
            or validation.get("adapter_hash") != digest(candidate)):
        raise ValueError("Fresh domain-bound full recomputation and quality evidence is required")
    node = manifest["cosmos_rpc_url"]
    chain_id = manifest["cosmos_chain_id"]
    output = {"version": 1, "kind": "four-process-local-sdk-contribution-smoke", "chain_id": 297012,
              "cosmos_chain_id": chain_id, "network_domain": manifest["network_domain"],
              "genesis_hash": manifest["genesis_hash"], "reward_vault": manifest["reward_vault_address"],
              "challenge_seconds": 3, "unsafe_test_profile": True, "independent_operators": False,
              "offchain_task_hash": task.fingerprint, "adapter_hash": digest(candidate),
              "transactions": [], "negative_cases": []}

    def command(parts, home="node0"):
        result = subprocess.run([str(BINARY), *parts, "--home", str(state / home), "--node", node,
                                 "--output", "json"], check=False, capture_output=True, text=True, cwd=ROOT)
        if result.returncode:
            raise RuntimeError("heyunad client failed: " + result.stderr[-1500:])
        return json.loads(result.stdout)

    def confirmed(txhash):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                return command(["query", "tx", txhash])
            except RuntimeError as error:
                if "not found" not in str(error):
                    raise
                time.sleep(0.25)
        raise TimeoutError("local transaction did not commit")

    def broadcast(parts, label, home="node0", expect_error=False):
        response = command([*parts, "--chain-id", chain_id, "--keyring-backend", "test", "--gas", "1500000",
                            "--gas-prices", "0aheyuna", "--yes"], home)
        if response.get("code", 0):
            raise RuntimeError("CheckTx rejected the transaction: " + str(response.get("raw_log", "")))
        result = confirmed(response["txhash"])
        code = int(result.get("code", 0))
        record = {"operation": label, "hash": response["txhash"], "height": int(result["height"]), "code": code}
        if expect_error:
            if code == 0:
                raise AssertionError("negative case unexpectedly accepted: " + label)
            record["reason"] = result.get("raw_log", "")
            output["negative_cases"].append(record)
        else:
            if code:
                raise RuntimeError("DeliverTx rejected " + label + ": " + result.get("raw_log", ""))
            for event in result.get("events", []):
                if event["type"] == "heyuna.contribution":
                    for attribute in event["attributes"]:
                        if attribute["key"] == "id":
                            record["id"] = attribute["value"]
            output["transactions"].append(record)
        print(json.dumps(record), flush=True)
        return record

    for verifier in public["verifiers"]:
        broadcast(["tx", "bank", "send", "validator1", verifier["address"], "2000000000000000000aheyuna"],
                  "fund-" + verifier["name"], "node1")

    config = command(["query", "contribution", "config"])
    if (config["chain_id"] != chain_id or config["network_domain"] != manifest["network_domain"]
            or config["vault_address"].lower() != manifest["reward_vault_address"].lower()
            or config["challenge_period_seconds"] != 3 or config["unsafe_test_profile"] is not True):
        raise ValueError("Chain configuration disagrees with the pinned deployment")
    payload_file = state / "contribution-payload.json"

    def execute(actor, kind, body, expect_error=False):
        envelope = {"version": 1, "chain_id": chain_id, "network_domain": config["network_domain"],
                    "vault_address": config["vault_address"], "kind": kind, "body": body}
        payload_file.write_text(json.dumps(envelope, separators=(",", ":")))
        payload_file.chmod(0o600)
        actor_home = {"validator1": "node1", "validator2": "node2"}.get(actor, "node0")
        return broadcast(["tx", "contribution", "execute", str(payload_file), "--from", actor], kind,
                         actor_home, expect_error)

    task_envelope = native_task_operation(task, cosmos_chain_id=chain_id,
                                          network_domain=config["network_domain"],
                                          vault_address=config["vault_address"],
                                          genesis_hash=manifest["genesis_hash"], round_number=0, nonce=0)
    body = task_envelope["body"]
    task_record = execute("validator1", "submit_task", body)
    task_id = task_record["id"]
    receipt_id = execute("validator1", "submit_result", {"task_id": task_id, "result_hash": "0x" + digest(candidate)})["id"]
    execute("validator1", "submit_result", {"task_id": task_id, "result_hash": "0x" + digest(candidate)}, True)
    report_hash = validation["evidence_hash"]
    if not report_hash.startswith("0x"):
        report_hash = "0x" + report_hash
    for actor in ("verifier0", "verifier1"):
        execute(actor, "submit_report", {"receipt_id": receipt_id, "report_hash": report_hash, "accept": True})

    verification_task = TrainingTaskV2.model_validate({
        **task.model_dump(), "task_id": "native-independent-recomputation",
        "recipient": public["fund_managers"][0]["evm_address"], "category": 1,
        "verification": VerificationReference(receipt_id="native-training-smoke", chain_receipt_id=receipt_id,
                                                adapter_hash=digest(candidate)).model_dump(),
    })
    verification_job = args.job_dir / "verification"
    verification_job.mkdir(mode=0o700, exist_ok=False)
    (verification_job / "task.json").write_text(verification_task.model_dump_json(indent=2))
    for name in ("data.json", "heldout.json", "a.safetensors", "b.safetensors"):
        (verification_job / name).write_bytes((args.job_dir / name).read_bytes())
    worker_env = {key: os.environ[key] for key in ("PATH", "TMPDIR", "LANG", "LC_ALL") if key in os.environ}
    worker_env.update(PYTHONPATH=str(ROOT / "backend"), HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1")
    worker_args = [sys.executable, "-m", "heyuna.training", "--job-dir", str(verification_job),
                   "--model-path", str(args.model_path), "--backend", args.backend]
    # Independent computation and a separate full-reference + heldout check are
    # actual model subprocesses. No coordinator or signing credential is passed.
    for extra in ([], ["--candidate", str(verification_job / "result.safetensors"),
                       "--heldout", str(verification_job / "heldout.json")]):
        subprocess.run([*worker_args, *extra], cwd=ROOT, env=worker_env, check=True, timeout=1200)
    recomputed = (verification_job / "result.safetensors").read_bytes()
    recomputation_metrics = json.loads((verification_job / "metrics.json").read_text())
    recomputation_validation = json.loads((verification_job / "validation.json").read_text())
    if digest(recomputed) != digest(candidate) or recomputation_validation.get("accepted") is not True:
        raise ValueError("actual independent verification did not reproduce the accepted target")
    work_evidence = RecomputationEvidence(task_hash=verification_task.fingerprint,
        target_receipt_id=verification_task.verification.receipt_id, target_chain_receipt_id=receipt_id,
        artifact_hash=digest(recomputed), metrics_hash=canonical_hash(recomputation_metrics))
    evidence_hash = "0x" + canonical_hash(work_evidence.model_dump())
    verification_envelope = native_task_operation(verification_task, cosmos_chain_id=chain_id,
        network_domain=config["network_domain"], vault_address=config["vault_address"],
        genesis_hash=manifest["genesis_hash"], round_number=0, nonce=0)
    verification_task_id = execute("validator2", "submit_task", verification_envelope["body"])["id"]
    verification_result = {"task_id": verification_task_id, "verification_target": receipt_id,
                           "artifact_hash": "0x" + digest(recomputed), "evidence_hash": evidence_hash}
    execute("validator2", "submit_result", {key: value for key, value in verification_result.items()
                                             if key != "evidence_hash"}, True)
    verification_receipt_id = execute("validator2", "submit_result", verification_result)["id"]
    stored_verification = command(["query", "contribution", "receipt", verification_receipt_id])
    expected_commitment = native_verification_result_commitment(cosmos_chain_id=chain_id,
        evm_chain_id=manifest["chain_id"], network_domain=config["network_domain"],
        vault=config["vault_address"], task_id=verification_task_id,
        worker=public["validators"][2]["evm_address"], verification_target=receipt_id,
        artifact_hash="0x" + digest(recomputed), evidence_hash=evidence_hash)
    if stored_verification["result_hash"] != expected_commitment:
        raise AssertionError("Python/Go independent verification work commitment differs")
    for actor in ("verifier0", "verifier1"):
        execute(actor, "submit_report", {"receipt_id": verification_receipt_id,
                                        "report_hash": "0x" + recomputation_validation["evidence_hash"], "accept": True})
    output["verification"] = {"offchain_task_hash": verification_task.fingerprint,
        "task_id": verification_task_id, "receipt_id": verification_receipt_id,
        "worker": public["validators"][2]["evm_address"], "recipient": verification_task.recipient,
        "artifact_hash": "0x" + digest(recomputed), "evidence_hash": evidence_hash,
        "result_commitment": expected_commitment, "work_evidence": work_evidence.model_dump(),
        "validation": recomputation_validation, "operator_independence": False}
    entry = {"index": 0, "receipt_id": receipt_id, "category": task.category,
             "amount": "1000000000000000000", "recipient": task.recipient.lower()}
    verification_entry = {"index": 1, "receipt_id": verification_receipt_id, "category": 1,
                           "amount": "100000000000000000", "recipient": verification_task.recipient.lower()}
    proposal = {"epoch": 0, "nonce": 0, "entries": [entry, verification_entry]}
    execute("verifier0", "propose_epoch", {**proposal, "epoch": 1}, True)
    for actor in ("verifier0", "verifier1"):
        execute(actor, "propose_epoch", proposal)
    challenge = "0x" + digest(b"public-local-test-challenge-no-autofreeze")
    execute("validator1", "challenge", {"epoch": 0, "evidence_hash": challenge})
    epoch = command(["query", "contribution", "epoch", "0"])
    if epoch["status"] != "pending":
        raise AssertionError("public challenge unexpectedly froze the epoch")
    execute("validator1", "freeze_epoch", {"epoch": 0, "nonce": epoch["control_nonce"]}, True)
    execute("verifier2", "freeze_epoch", {"epoch": 0, "nonce": epoch["control_nonce"]})
    epoch = command(["query", "contribution", "epoch", "0"])
    execute("validator1", "finalize_epoch", {"epoch": 0}, True)
    frozen_nonce = epoch["control_nonce"]
    for actor in ("verifier0", "verifier1"):
        execute(actor, "resume_epoch", {"epoch": 0, "nonce": frozen_nonce})
    execute("verifier0", "resume_epoch", {"epoch": 0, "nonce": frozen_nonce}, True)
    # Wait for ordinary block production, not host/chain clock mutation.
    time.sleep(4)
    execute("validator1", "finalize_epoch", {"epoch": 0})
    epoch = command(["query", "contribution", "epoch", "0"])
    if epoch["status"] != "finalized":
        raise AssertionError("epoch did not finalize")
    execute("verifier2", "freeze_epoch", {"epoch": 0, "nonce": epoch["control_nonce"]}, True)
    output.update(task_id=task_id, receipt_id=receipt_id, epoch=epoch,
                  accounting=command(["query", "contribution", "accounting"]),
                  trust_notice="Three verification keys belong to one local operator; signatures are not independent training proofs.")
    path = state / "contribution-smoke.json"
    path.write_text(json.dumps(output, indent=2) + "\n")
    os.chmod(path, 0o600)
    print(json.dumps({"evidence": str(path), "root": epoch["root"], "entries": epoch["entries"]}), flush=True)


if __name__ == "__main__":
    main()
