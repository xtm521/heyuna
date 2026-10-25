import numpy as np
import pytest
from heyuna.federation import (
    aggregate,
    canonical_to_mlx,
    canonical_to_peft,
    decode_tensors,
    digest,
    encode_tensors,
    mlx_to_canonical,
    peft_to_canonical,
    shared_adapter,
    validate_artifacts,
)
from heyuna.protocol import TrainingConfig, TrainingTask, canonical_hash
from heyuna.training import MODEL_REVISION


def make_bundle():
    config = TrainingConfig(steps=1)
    a, b = shared_adapter(config)
    texts = ['A function returns a value.']
    task = TrainingTask(task_id='task1', round_id='round1', model_revision=MODEL_REVISION,
                        tokenizer_revision=MODEL_REVISION, data_hash=canonical_hash(texts),
                        data_source="Heyuna project-authored test texts", data_license="Apache-2.0",
                        shared_a_hash=digest(a), base_b_hash=digest(b), config=config)
    return task, a, b, texts


def test_portable_layout_same_forward_and_frozen_a():
    task, a_bytes, b_bytes, _ = make_bundle()
    a, b = validate_artifacts(task, a_bytes, b_bytes)
    rng = np.random.default_rng(7)
    for key in b:
        b[key] = rng.normal(0, .001, b[key].shape).astype(np.float32)
    mlx = canonical_to_mlx(a, b)
    peft = canonical_to_peft(a, b)
    for converted in (mlx_to_canonical(mlx), peft_to_canonical(peft)):
        for key in a:
            np.testing.assert_array_equal(converted[0][key], a[key])
            np.testing.assert_array_equal(converted[1][key], b[key])
    key = next(iter(a))
    x = rng.normal(size=(2, 2560)).astype(np.float32)
    np.testing.assert_allclose((x @ a[key].T) @ b[key].T,
                               (x @ mlx[key + '.lora_a']) @ mlx[key + '.lora_b'], atol=1e-6)
    assert task.config.scale == 1.0


def test_weighted_b_aggregation_has_exact_linear_mean():
    task, a, b, _ = make_bundle()
    one = {key: np.full_like(value, .001) for key, value in decode_tensors(b).items()}
    three = {key: np.full_like(value, .003) for key, value in decode_tensors(b).items()}
    task2 = task.model_copy(update={"task_id": "task2", "data_hash": canonical_hash(["other public shard"])})
    merged = decode_tensors(aggregate(task, a, b, [(task, encode_tensors(one), 1),
                                                 (task2, encode_tensors(three), 3)]))
    with pytest.raises(ValueError, match="duplicate"):
        aggregate(task, a, b, [(task, b, 1), (task, b, 1)])
    for value in merged.values():
        np.testing.assert_allclose(value, .0025, rtol=1e-6)
    other = task.model_copy(update={'model_revision': 'b' * 40})
    with pytest.raises(ValueError, match='incompatible'):
        aggregate(task, a, b, [(other, b, 1)])


@pytest.mark.parametrize('attack', ['nan', 'infinity', 'shape', 'missing', 'extra', 'norm', 'a_changed'])
def test_malicious_updates_rejected(attack):
    task, a, b, _ = make_bundle()
    values = decode_tensors(b)
    key = next(iter(values))
    if attack == 'nan':
        values[key][0, 0] = np.nan
    elif attack == 'infinity':
        values[key][0, 0] = np.inf
    elif attack == 'shape':
        values[key] = values[key].T.copy()
    elif attack == 'missing':
        values.pop(key)
    elif attack == 'extra':
        values['unexpected'] = np.ones(1, dtype=np.float32)
    elif attack == 'norm':
        values[key][:] = 10
    elif attack == 'a_changed':
        av = decode_tensors(a)
        av[key][0, 0] += .1
        a = encode_tensors(av)
    with pytest.raises(ValueError):
        validate_artifacts(task, a, encode_tensors(values), update=True, base_b=b)


def test_rejects_pickle_and_non_float32():
    from heyuna.federation import decode_tensors
    from safetensors.numpy import save
    with pytest.raises(ValueError):
        decode_tensors(b'\x80\x04malicious pickle')
    with pytest.raises(ValueError):
        decode_tensors(save({'a': np.ones((8, 8), dtype=np.float64)}))
