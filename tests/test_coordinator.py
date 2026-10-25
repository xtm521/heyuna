import base64

import pytest
from fastapi.testclient import TestClient
from heyuna.coordinator import create_coordinator_app
from heyuna.federation import digest
from test_federation import make_bundle


def identities():
    return [{'participant_id': name, 'operator_id': name, 'role': role,
             'wallet': '0x' + str(i + 1) * 40, 'token': name.ljust(40, '_')}
            for i, (name, role) in enumerate([('admin', 'admin'), ('device', 'device'),
                                              ('device2', 'device'), ('v1', 'validator'),
                                              ('v2', 'validator'), ('v3', 'validator')])]


def auth(name):
    return {'Authorization': 'Bearer ' + name.ljust(40, '_')}


@pytest.fixture
def coordinator(tmp_path):
    now = [1000.0]
    app = create_coordinator_app(database_url='sqlite:///' + str(tmp_path / 'db.sqlite3'),
                                  principals=identities(), clock=lambda: now[0])
    with TestClient(app) as client:
        yield client, now


def queue(client):
    task, a, b, texts = make_bundle()
    result = client.post('/v1/tasks', headers=auth('admin'), json={'task': task.model_dump(),
        'texts': texts, 'shared_a': base64.b64encode(a).decode(), 'base_b': base64.b64encode(b).decode()})
    assert result.status_code == 201, result.text
    return task, b


def submit(client, task, b, owner='device'):
    lease = client.post('/v1/tasks/lease', headers=auth(owner), json={'backend': 'mlx'}).json()['lease']
    payload = {'lease_id': lease['lease_id'], 'task_hash': task.fingerprint,
               'adapter_hash': digest(b), 'adapter_b': base64.b64encode(b).decode()}
    result = client.post('/v1/tasks/task1/submit', headers=auth(owner), json=payload)
    assert result.status_code == 200, result.text
    return result.json(), payload


def attest(client, receipt, validator, accepted=True):
    return client.post('/v1/receipts/' + receipt['receipt_id'] + '/validate', headers=auth(validator), json={
        'adapter_hash': receipt['adapter_hash'], 'accepted': accepted, 'recomputation_passed': accepted,
        'heldout_passed': accepted, 'evidence_hash': 'a' * 64, 'detail': 'Test attestation, not real training evidence'})


def test_authentication_and_role_boundaries(coordinator):
    client, _ = coordinator
    assert client.get('/v1/status').status_code == 401
    assert client.get('/v1/status', headers=auth('wrong')).status_code == 401
    assert client.get('/v1/status', headers=auth('device')).json()['state'] == 'authenticated'
    assert client.post('/v1/tasks/lease', headers=auth('v1'), json={'backend': 'mlx'}).status_code == 403


def test_expired_lease_reassigned_old_worker_cannot_submit(coordinator):
    client, now = coordinator
    task, b = queue(client)
    old = client.post('/v1/tasks/lease', headers=auth('device'), json={'backend': 'mlx'}).json()['lease']
    now[0] += 901
    new = client.post('/v1/tasks/lease', headers=auth('device2'), json={'backend': 'cuda'}).json()['lease']
    assert old['lease_id'] != new['lease_id']
    response = client.post('/v1/tasks/task1/submit', headers=auth('device'), json={
        'lease_id': old['lease_id'], 'task_hash': task.fingerprint, 'adapter_hash': digest(b),
        'adapter_b': base64.b64encode(b).decode()})
    assert response.status_code == 409


def test_idempotency_validation_threshold_and_unsigned_reward_draft(coordinator):
    client, _ = coordinator
    task, b = queue(client)
    receipt, payload = submit(client, task, b)
    assert receipt['state'] == 'pending_verification'
    assert client.post('/v1/tasks/task1/submit', headers=auth('device'), json=payload).json() == receipt
    assert client.get('/v1/receipts', headers=auth('device2')).json() == []
    request = {'epoch': 0, 'receipt_ids': [receipt['receipt_id']]}
    assert client.post('/v1/reward-epochs/draft', headers=auth('admin'), json=request).status_code == 409
    assert attest(client, receipt, 'device').status_code == 403
    assert attest(client, receipt, 'v1').json()['state'] == 'pending_verification'
    assert client.post('/v1/reward-epochs/draft', headers=auth('admin'), json=request).status_code == 409
    assert attest(client, receipt, 'v2').json()['state'] == 'verified'
    result = client.post('/v1/reward-epochs/draft', headers=auth('admin'), json=request)
    assert result.status_code == 200, result.text
    epoch = result.json()
    assert epoch['state'] == 'draft_pending_review'
    assert int(epoch['allocated_wei']) <= int(epoch['budget_wei'])
    assert sum(int(a['amount']) for a in epoch['allocations']) == int(epoch['allocated_wei'])
    assert client.get('/v1/receipts', headers=auth('device')).json()[0]['state'] == 'pending_settlement'
    assert client.post('/v1/reward-epochs/draft', headers=auth('admin'), json=request).status_code == 409
    request['epoch'] = 1
    assert client.post('/v1/reward-epochs/draft', headers=auth('admin'), json=request).status_code == 409


def test_rejection_never_eligible_for_rewards(coordinator):
    client, _ = coordinator
    task, b = queue(client)
    receipt, _ = submit(client, task, b)
    assert attest(client, receipt, 'v1', False).json()['state'] == 'rejected'
    assert attest(client, receipt, 'v2').status_code == 409
    assert client.post('/v1/reward-epochs/draft', headers=auth('admin'), json={
        'epoch': 0, 'receipt_ids': [receipt['receipt_id']]}).status_code == 409


def test_validator_independence_configuration(tmp_path):
    ids = identities()
    ids[-1]['operator_id'] = ids[-2]['operator_id']
    with pytest.raises(ValueError, match='three separately'):
        create_coordinator_app(database_url='sqlite:///' + str(tmp_path / 'x.db'), principals=ids)
    ids = identities()
    ids[1]['operator_id'] = ids[-1]['operator_id']
    with pytest.raises(ValueError, match='independent'):
        create_coordinator_app(database_url='sqlite:///' + str(tmp_path / 'x.db'), principals=ids)


def test_two_coordinator_instances_do_not_lease_same_task(tmp_path):
    from concurrent.futures import ThreadPoolExecutor

    url = 'sqlite:///' + str(tmp_path / 'shared.db')
    first = TestClient(create_coordinator_app(database_url=url, principals=identities()))
    second = TestClient(create_coordinator_app(database_url=url, principals=identities()))
    queue(first)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(client.post, '/v1/tasks/lease', headers=auth(owner), json={'backend': 'mlx'})
                   for client, owner in [(first, 'device'), (second, 'device2')]]
        statuses = sorted(f.result().status_code for f in futures)
    assert statuses == [200, 204]
