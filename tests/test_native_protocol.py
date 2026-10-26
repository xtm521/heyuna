"""Network/protocol boundary regressions; no model execution or chain payment claims."""
import base64
import json
import threading

import pytest
from fastapi.testclient import TestClient
from heyuna.coordinator import create_coordinator_app
from heyuna.deployment import NetworkManifest, rewards_config
from heyuna.federation import digest
from heyuna.native_protocol import (
    NATIVE_REWARD_POOL,
    NetworkBinding,
    TrainingTaskV2,
    native_weekly_budget,
    parse_receipt,
    parse_task,
)
from heyuna.network import NetworkService
from pydantic import ValidationError
from test_coordinator import auth, identities
from test_federation import make_bundle


def native_network():
    return {"version": 2, "profile": "accelerated-local", "chain_id": 297012,
        "cosmos_chain_id": "heyuna_297012-1", "network_name": "Local research fixture",
        "network_domain": "0x" + "d" * 64, "genesis_hash": "0x" + "e" * 64,
        "genesis_hash_kind": "sha256-canonical-genesis-json",
        "evm_anchor": {"block_number": 1, "block_hash": "0x" + "f" * 64},
        "rpc_url": "http://127.0.0.1:10545", "cosmos_rpc_url": "http://127.0.0.1:28657",
        "asset_kind": "native", "symbol": "tHEYUNA", "base_denom": "aheyuna", "decimals": 18,
        "total_supply": "20000000000000000000000000", "reward_vault_address": "0x" + "a" * 40,
        "public_fund_address": "0x" + "b" * 40, "factory_address": "0x0000000000000000000000000000000000000F01",
        "contribution_precompile_address": "0x0000000000000000000000000000000000000900", "genesis": 1000,
        "challenge_seconds": 3, "confirmations": 1,
        "code_hashes": {key: "0x" + "c" * 64 for key in ["reward_vault", "public_fund", "factory"]}}


def native_task(name="task1", category=0):
    task, a, b, texts = make_bundle()
    network = native_network()
    binding = NetworkBinding(**{k: network[k] for k in ["chain_id", "genesis_hash", "reward_vault_address", "network_domain"]})
    task = TrainingTaskV2(**{**task.model_dump(), "task_id": name, "version": 2, "network": binding,
                            "recipient": identities()[1]["wallet"], "category": category})
    return task, a, b, texts


@pytest.mark.parametrize("field,value", [("chain_id", 1), ("challenge_seconds", 259200),
    ("asset_kind", "erc20"), ("profile", "research"), ("rpc_url", "https://unreviewed.invalid"),
    ("genesis_hash", "0x" + "0" * 64), ("network_domain", "0x" + "0" * 64)])
def test_native_manifest_fails_closed_on_identity_or_profile_changes(field, value):
    data = native_network(); data[field] = value
    with pytest.raises(ValidationError):
        NetworkManifest.model_validate(data)


def test_legacy_and_native_are_not_implicitly_interpreted_as_each_other(tmp_path):
    legacy, *_ = make_bundle()
    task, *_ = native_task()
    assert parse_task(legacy.model_dump()).version == 1
    assert parse_task(task.model_dump()).version == 2
    assert task.fingerprint != legacy.fingerprint
    altered = task.model_dump(); altered["version"] = 1
    with pytest.raises(ValidationError):
        parse_task(altered)
    assert rewards_config(tmp_path)["chain_id"] == 297011
    (tmp_path / "deployment.json").write_text(json.dumps(native_network()))
    assert rewards_config(tmp_path)["state"] == "configured_unverified"
    assert rewards_config(tmp_path)["token_address"] is None
    assert NetworkService(tmp_path, threading.RLock()).snapshot()['rewards']['chain_id'] == 297012
    service = NetworkService(tmp_path, threading.RLock())
    with pytest.raises(ValueError, match="Receipt protocol"):
        from heyuna.protocol import ContributionReceipt
        service._check_receipt(ContributionReceipt(receipt_id="r", task_id="t", round_id="r", participant_id="p",
            wallet="0x" + "1" * 40, task_hash="a" * 64, adapter_hash="b" * 64,
            state="pending_verification", work_units=1), NetworkManifest.model_validate(native_network()))


def test_native_budget_integer_differences_and_continuation():
    assert sum(native_weekly_budget(e) for e in range(520)) == NATIVE_REWARD_POOL
    assert max(native_weekly_budget(e) for e in range(520)) - min(native_weekly_budget(e) for e in range(520)) <= 1
    assert native_weekly_budget(521) == (NATIVE_REWARD_POOL + 519) // 520


def test_native_offchain_flow_recipient_binding_replay_and_separate_validation_work(tmp_path):
    app = create_coordinator_app(database_url="sqlite:///" + str(tmp_path / "native.sqlite3"),
        principals=identities(), network_manifest=native_network(), clock=lambda: 1001)
    task, a, b, texts = native_task()
    with TestClient(app) as client:
        assert client.get("/v1/status", headers=auth("device")).status_code == 404
        assert client.get("/v2/status", headers=auth("device")).json()["network"]["chain_id"] == 297012
        body = {"task": task.model_dump(), "texts": texts,
                "shared_a": base64.b64encode(a).decode(), "base_b": base64.b64encode(b).decode()}
        foreign = json.loads(json.dumps(body)); foreign["task"]["network"]["genesis_hash"] = "0x" + "1" * 64
        assert client.post("/v2/tasks", headers=auth("admin"), json=foreign).status_code == 422
        assert client.post("/v2/tasks", headers=auth("admin"), json=body).status_code == 201
        assert client.post("/v2/tasks/lease", headers=auth("device2"), json={"backend": "mlx"}).status_code == 204
        lease = client.post("/v2/tasks/lease", headers=auth("device"), json={"backend": "mlx"}).json()["lease"]
        submitted = client.post("/v2/tasks/task1/submit", headers=auth("device"), json={"lease_id": lease["lease_id"],
            "task_hash": task.fingerprint, "adapter_hash": digest(b), "adapter_b": base64.b64encode(b).decode()})
        assert submitted.status_code == 200, submitted.text
        receipt = parse_receipt(submitted.json())
        assert receipt.version == 2 and receipt.category == 0
        assert receipt.network.genesis_hash == native_network()["genesis_hash"]
        for verifier in ["v1", "v2"]:
            response = client.post(f"/v2/receipts/{receipt.receipt_id}/validate", headers=auth(verifier), json={
                "adapter_hash": digest(b), "accepted": True, "recomputation_passed": True, "heldout_passed": True,
                "evidence_hash": "a" * 64, "detail": "Fixture attestation, not actual recomputation"})
            assert response.status_code == 200
        assert client.post("/v2/reward-epochs/draft", headers=auth("admin"), json={
            "epoch": 1, "receipt_ids": [receipt.receipt_id]}).status_code == 409
        draft = client.post("/v2/reward-epochs/draft", headers=auth("admin"), json={
            "epoch": 0, "receipt_ids": [receipt.receipt_id]}).json()
        assert draft["version"] == 2 and all(a["category"] == "training" for a in draft["allocations"])
        assert int(draft["allocated_wei"]) <= native_weekly_budget(0) * 9 // 10
        second = {**body, "task": {**body["task"], "task_id": "task2"}}
        assert client.post("/v2/tasks", headers=auth("admin"), json=second).status_code == 201
        lease = client.post("/v2/tasks/lease", headers=auth("device"), json={"backend": "mlx"}).json()["lease"]
        duplicate = client.post("/v2/tasks/task2/submit", headers=auth("device"), json={"lease_id": lease["lease_id"],
            "task_hash": parse_task(second["task"]).fingerprint, "adapter_hash": digest(b), "adapter_b": base64.b64encode(b).decode()})
        # Unaccepted hash candidates cannot front-run/reserve reward rights.
        assert duplicate.status_code == 200
    with pytest.raises(ValueError, match="another network"):
        create_coordinator_app(database_url="sqlite:///" + str(tmp_path / "native.sqlite3"), principals=identities(), legacy_alpha=True)


def test_independent_recomputation_can_reward_identical_B_with_target_and_evidence(tmp_path):
    from heyuna.native_protocol import RecomputationEvidence
    task, a, b, texts = native_task()
    app = create_coordinator_app(database_url="sqlite:///" + str(tmp_path / "verification.sqlite3"),
        principals=identities(), network_manifest=native_network(), clock=lambda: 1001)
    with TestClient(app) as client:
        def queue_task(candidate):
            return client.post('/v2/tasks', headers=auth('admin'), json={'task': candidate.model_dump(),
                'texts': texts, 'shared_a': base64.b64encode(a).decode(), 'base_b': base64.b64encode(b).decode()})
        def submit_task(candidate, owner, evidence=None):
            lease=client.post('/v2/tasks/lease',headers=auth(owner),json={'backend':'mlx'}).json()['lease']
            payload={'lease_id':lease['lease_id'],'task_hash':candidate.fingerprint,'adapter_hash':digest(b),'adapter_b':base64.b64encode(b).decode()}
            if evidence: payload['verification_evidence']=evidence.model_dump()
            return client.post('/v2/tasks/'+candidate.task_id+'/submit',headers=auth(owner),json=payload)
        def approve(receipt):
            for verifier in ['v1','v2']:
                response=client.post('/v2/receipts/'+receipt['receipt_id']+'/validate',headers=auth(verifier),json={
                    'adapter_hash':digest(b),'accepted':True,'recomputation_passed':True,'heldout_passed':True,
                    'evidence_hash':'a'*64,'detail':'Fixture only, not real recomputation'})
                assert response.status_code==200,response.text
        assert queue_task(task).status_code==201
        training=submit_task(task,'device').json();approve(training)
        alias_task=TrainingTaskV2(**{**task.model_dump(),'task_id':'training_alias'})
        assert queue_task(alias_task).status_code==201
        alias_receipt=submit_task(alias_task,'device').json();approve(alias_receipt)
        verifier_task=TrainingTaskV2(**{**task.model_dump(),'task_id':'recompute1','category':1,
            'recipient':identities()[2]['wallet'],'verification':{'receipt_id':training['receipt_id'],
                'chain_receipt_id':'0x'+'1'*64,'adapter_hash':digest(b)}})
        self_work=TrainingTaskV2(**{**verifier_task.model_dump(),'recipient':task.recipient})
        assert queue_task(self_work).status_code==422
        assert queue_task(verifier_task).status_code==201
        assert queue_task(TrainingTaskV2(**{**verifier_task.model_dump(),'task_id':'recompute2'})).status_code==409
        # A new accepted receipt ID for the same B cannot earn this worker the
        # same recomputation reward again by changing its target identity.
        alias_verification=TrainingTaskV2(**{**verifier_task.model_dump(),'task_id':'recompute_alias',
            'verification':{**verifier_task.verification.model_dump(),'receipt_id':alias_receipt['receipt_id'],
                            'chain_receipt_id':'0x'+'2'*64}})
        assert queue_task(alias_verification).status_code==409
        assert submit_task(verifier_task,'device2').status_code==422
        evidence=RecomputationEvidence(task_hash=verifier_task.fingerprint,target_receipt_id=training['receipt_id'],
            target_chain_receipt_id='0x'+'1'*64,artifact_hash=digest(b),metrics_hash='b'*64)
        verified=submit_task(verifier_task,'device2',evidence)
        assert verified.status_code==200,verified.text
        recomputation=verified.json();approve(recomputation)
        assert recomputation['adapter_hash']==training['adapter_hash']
        assert recomputation['verification_evidence_hash']
        draft=client.post('/v2/reward-epochs/draft',headers=auth('admin'),json={
            'epoch':0,'receipt_ids':[training['receipt_id'],recomputation['receipt_id']]})
        assert draft.status_code==200,draft.text
        assert {a['category'] for a in draft.json()['allocations']}=={'training','validation'}
        assert int(draft.json()['allocated_wei'])<=native_weekly_budget(0)
        receipt=parse_receipt(recomputation)
        NetworkService._check_task_receipt(receipt,verifier_task)
        for field,value in [('category',0),('config_hash','0x'+'9'*64),('work_units',3)]:
            altered=receipt.model_copy(update={field:value})
            with pytest.raises(ValueError,match='binding'):
                NetworkService._check_task_receipt(altered,verifier_task)


def test_coordinator_default_never_silently_starts_legacy(monkeypatch):
    monkeypatch.delenv('HEYUNA_NETWORK_MANIFEST', raising=False)
    with pytest.raises(RuntimeError, match='requires'):
        create_coordinator_app()
