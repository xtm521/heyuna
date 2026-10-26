import json
import os
import threading

import pytest
from fastapi import HTTPException
from heyuna.network import Configure, ContributionSwitch, NetworkService, safe_endpoint
from heyuna.training import validate_dataset, validate_model_path
from test_federation import make_bundle


def test_dataset_digest_and_size_reject():
    task, _, _, texts = make_bundle()
    validate_dataset(task, texts)
    with pytest.raises(ValueError, match='digest'):
        validate_dataset(task, ['private project text was changed'])
    with pytest.raises(ValueError):
        validate_dataset(task, ['x' * 20000])


def test_model_missing_revision_rejected(tmp_path):
    task, _, _, _ = make_bundle()
    config = {'model_type': 'qwen3', 'hidden_size': 2560, 'num_hidden_layers': 36,
              'num_attention_heads': 32, 'num_key_value_heads': 8, 'head_dim': 128, 'vocab_size': 151936}
    (tmp_path / 'config.json').write_text(json.dumps(config))
    with pytest.raises(ValueError, match='unverified'):
        validate_model_path(tmp_path, task)


def test_node_defaults_off_and_configuration_is_not_connection(tmp_path):
    service = NetworkService(tmp_path, threading.Lock())
    assert service.snapshot()['contribution']['enabled'] is False
    with pytest.raises(HTTPException):
        service.run_once()
    service.configure(Configure(endpoint='https://coordinator.example', device_token='x' * 40))
    snapshot = service.snapshot()
    assert snapshot['network']['configured'] is True
    assert snapshot['network']['connected'] is False
    assert 'device_token' not in str(snapshot)
    # POSIX permission bits do not establish Windows file ACL privacy.
    if os.name == 'posix':
        assert service.directory.joinpath('connection.json').stat().st_mode & 0o777 == 0o600
    service.contribution(ContributionSwitch(enabled=True))
    assert NetworkService(tmp_path, threading.Lock()).enabled is False


@pytest.mark.parametrize('url', ['http://example.org', 'https://user:pass@example.org',
                               'https://example.org/?token=secret', 'file:///tmp/tasks', 'https://example.org/x'])
def test_endpoint_rejects_insecure_or_credential_origins(url):
    with pytest.raises(ValueError):
        safe_endpoint(url)


def test_daily_upload_budget_enforced(tmp_path):
    (tmp_path / 'settings.json').write_text(json.dumps({'start_time': '00:00', 'end_time': '00:00',
                                                      'max_memory_gb': 24, 'max_upload_mb_day': 1}))
    service = NetworkService(tmp_path, threading.Lock())
    service._limits(1024)
    with pytest.raises(RuntimeError, match='upload'):
        service._limits(2 * 1024**2)


def test_worker_acquires_and_releases_rlock_on_own_thread(tmp_path, monkeypatch):
    import httpx
    from test_deployment import example

    # Legacy mode is available only with its explicitly versioned manifest.
    (tmp_path / 'deployment.json').write_text(json.dumps(example()))

    lock = threading.RLock()
    service = NetworkService(tmp_path, lock)
    service.configure(Configure(endpoint='https://coordinator.example', device_token='x' * 40))
    service.contribution(ContributionSwitch(enabled=True))
    monkeypatch.setattr(service, '_limits', lambda *a, **kw: {})
    monkeypatch.setattr(service, '_backend', lambda: 'mlx')

    def transport(request):
        if request.url.path.endswith('/status'):
            return httpx.Response(200, json={'role': 'device', 'chain_id': 11155111})
        return httpx.Response(204)

    monkeypatch.setattr(service, '_client', lambda: httpx.Client(
        base_url='https://coordinator.example', transport=httpx.MockTransport(transport)))
    service.run_once()
    service.thread.join(timeout=5)
    assert not service.thread.is_alive()
    assert service.state == 'idle'
    assert service.snapshot()['network']['connected'] is True
    assert lock.acquire(blocking=False)
    lock.release()


def test_node_rejects_coordinator_claim_of_chain_confirmation(tmp_path, monkeypatch):
    import httpx
    from heyuna.federation import digest
    from heyuna.protocol import ContributionReceipt, ContributionState

    task, _, b, _ = make_bundle()
    receipt = ContributionReceipt(receipt_id='receipt', task_id=task.task_id, round_id=task.round_id,
        participant_id='device', wallet='0x' + '1' * 40, task_hash=task.fingerprint,
        adapter_hash=digest(b), state=ContributionState.CONFIRMED, work_units=1)
    service = NetworkService(tmp_path, threading.Lock())
    service.configure(Configure(endpoint='https://coordinator.example', device_token='x' * 40))
    monkeypatch.setattr(service, '_client', lambda: httpx.Client(base_url='https://coordinator.example',
        transport=httpx.MockTransport(lambda request: httpx.Response(200, json=[receipt.model_dump()]))))
    with pytest.raises(HTTPException, match='Could not retrieve'):
        service.get_receipts()
    assert not service.connected


def test_model_with_forged_revision_marker_still_requires_exact_bytes(tmp_path):
    task, _, _, _ = make_bundle()
    model = tmp_path / 'models' / 'qwen3-4b'
    model.mkdir(parents=True)
    config = {'model_type': 'qwen3', 'hidden_size': 2560, 'num_hidden_layers': 36,
              'num_attention_heads': 32, 'num_key_value_heads': 8, 'head_dim': 128, 'vocab_size': 151936}
    (model / 'config.json').write_text(json.dumps(config))
    (model / 'model.safetensors.index.json').write_text(json.dumps({
        'weight_map': {'model.weight': 'model-00001-of-00003.safetensors'}}))
    (model / 'model-00001-of-00003.safetensors').write_bytes(b'forged weight bytes')
    (model / 'tokenizer.json').write_text('{}')
    (tmp_path / 'model.json').write_text(json.dumps({'id': task.model_id, 'revision': task.model_revision,
                                                  'path': str(model), 'state': 'downloaded'}))
    with pytest.raises(ValueError, match='SHA256 mismatch'):
        validate_model_path(model, task)


def test_mlx_adam_uses_torch_compatible_bias_correction():
    import numpy as np
    mx = pytest.importorskip('mlx.core')
    from heyuna.protocol import TrainingConfig
    from heyuna.training import _mlx_optimizer

    config = TrainingConfig()
    optimizer = _mlx_optimizer(config)
    updated = optimizer.apply_gradients({'b': mx.array([1., -2.])}, {'b': mx.zeros((2,))})
    mx.eval(updated)
    np.testing.assert_allclose(np.array(updated['b']), [-config.learning_rate, config.learning_rate], rtol=1e-5)
