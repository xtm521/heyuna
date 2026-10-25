"""Fixed, opt-in training template. Invoked as a separate process by NetworkService.

No eval, pickle, remote Python, shell command, or client-supplied optimizer is accepted.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

from .federation import (
    canonical_to_mlx,
    canonical_to_peft,
    decode_tensors,
    digest,
    encode_tensors,
    mlx_to_canonical,
    peft_to_canonical,
    validate_artifacts,
)
from .protocol import MODEL_ID, TrainingTask, canonical_hash

MODEL_REVISION = "cdbee75f17c01a7cc42f958dc650907174af0554"
# Verified against official Hub commit metadata (LFS SHA256 / Git blob IDs) on 2026-10-25.
# Every train/verify invocation checks these bytes before loading; no network request is made.
MODEL_FILE_SHA256 = {
    "model-00001-of-00003.safetensors": "75311d91bb08cf0b882913da464a1e722a31fb44db35208663487efb7a3d8ed6",
    "model-00002-of-00003.safetensors": "0b48adbb1f60e901153d91907ba11ce63bd4b8b584482e730f48808d055dfba1",
    "model-00003-of-00003.safetensors": "7dd39ccca5e4de123c74c14af44c9bf2eb75df33b4614382af0134528e060d5d",
    "config.json": "5beea1a4a34c62782bfb2f911c606741a3bab8f92d80a118fa053c28af12e8ba",
    "generation_config.json": "835fffe355c9438e7a25be099b3fccaa98350b83451f9fd2d99512e74f1ade48",
    "merges.txt": "599bab54075088774b1733fde865d5bd747cbcc7a547c5bc12610e874e26f5e3",
    "model.safetensors.index.json": "d6c42883a895dfef5b0080ed2116a1bcd764f558406b98923d675978a1abf29c",
    "tokenizer.json": "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4",  # gitleaks:allow - public pinned model SHA256
    "tokenizer_config.json": "a62ff0a2472a0fa1b8eaabcb57c59b58afa42a22831dc141400b6e0cf2b65ce3",  # gitleaks:allow - public pinned model SHA256
    "vocab.json": "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
}


def verify_model_files(path: Path) -> dict[str, str]:
    for name, expected in MODEL_FILE_SHA256.items():
        hasher = hashlib.sha256()
        with (path / name).open("rb") as stream:
            while chunk := stream.read(8 * 1024 * 1024):
                hasher.update(chunk)
        if hasher.hexdigest() != expected:
            raise ValueError(f"pinned model file SHA256 mismatch: {name}")
    return dict(MODEL_FILE_SHA256)



def validate_dataset(task: TrainingTask, texts: list[str]) -> None:
    if not isinstance(texts, list) or not 1 <= len(texts) <= 256:
        raise ValueError("expected between 1 and 256 public training texts")
    if any(not isinstance(t, str) or not t or len(t.encode()) > 16384 for t in texts):
        raise ValueError("training texts must be nonempty and at most 16 KiB each")
    if sum(len(t.encode()) for t in texts) > 1024 * 1024:
        raise ValueError("dataset exceeds 1 MiB")
    if canonical_hash(texts) != task.data_hash:
        raise ValueError("dataset digest mismatch")


def validate_model_path(path: Path, task: TrainingTask) -> Path:
    path = path.resolve(strict=True)
    if task.model_id != MODEL_ID or task.model_revision != MODEL_REVISION:
        raise ValueError("unreviewed model revision")
    config = json.loads((path / "config.json").read_text())
    if config.get("model_type") != "qwen3" or config.get("quantization_config"):
        raise ValueError("only unquantized Qwen3 BF16 base is supported")
    expected = {"hidden_size": 2560, "num_hidden_layers": 36, "num_attention_heads": 32,
                "num_key_value_heads": 8, "head_dim": 128, "vocab_size": 151936}
    if any(config.get(key) != value for key, value in expected.items()):
        raise ValueError("model configuration does not match the pinned 4B base")
    # Official hub snapshots are named by commit; application copies carry an explicit manifest.
    pinned = path.name == MODEL_REVISION and path.parent.name == "snapshots"
    for manifest in (path / "heyuna-model.json", path.parent.parent / "model.json"):
        if manifest.is_file():
            meta = json.loads(manifest.read_text())
            pinned = pinned or (meta.get("revision") == MODEL_REVISION and meta.get("id") == MODEL_ID
                                and Path(meta.get("path", "")).resolve() == path
                                and meta.get("state") in {"ready", "downloaded"})
    if not pinned:
        raise ValueError("model revision is unverified; use the explicit model preparation flow")
    index_file = path / "model.safetensors.index.json"
    if not index_file.is_file() or not (path / "tokenizer.json").is_file():
        raise ValueError("model index or tokenizer is missing")
    index = json.loads(index_file.read_text())
    shards = set(index.get("weight_map", {}).values())
    if not shards or any(Path(name).name != name or not name.endswith(".safetensors")
                         or not (path / name).is_file() for name in shards):
        raise ValueError("model safetensors shards are missing or invalid")
    verify_model_files(path)
    return path


def token_batches(tokenizer, texts: list[str], length: int) -> list[list[int]]:
    batches = []
    for text in texts:
        ids = tokenizer.encode(text, add_special_tokens=False)[:length]
        if tokenizer.eos_token_id is not None:
            ids = ids + [tokenizer.eos_token_id]
        if len(ids) >= 2:
            batches.append(ids)
    if not batches:
        raise ValueError("no nonempty token sequences")
    return batches


def _torch_train(task, model_path, texts, a, b):
    import torch
    from peft import LoraConfig, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer

    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise RuntimeError("CUDA with BF16 support is required; CPU training is disabled")
    torch.manual_seed(task.config.seed)
    tokenizer = AutoTokenizer.from_pretrained(str(model_path), local_files_only=True, trust_remote_code=False)
    model = AutoModelForCausalLM.from_pretrained(
        str(model_path), torch_dtype=torch.bfloat16, local_files_only=True,
        trust_remote_code=False, attn_implementation="eager", use_safetensors=True,
    ).to("cuda")
    model.config.use_cache = False
    config = LoraConfig(r=8, lora_alpha=8, lora_dropout=0.0, bias="none", task_type="CAUSAL_LM",
                        target_modules=[layer.name for layer in task.config.layers])
    model = get_peft_model(model, config)
    weights = canonical_to_peft(a, b)
    names = dict(model.named_parameters())
    if not set(weights).issubset(names):
        raise RuntimeError("PEFT model parameter names differ from the reviewed template")
    for name, parameter in model.named_parameters():
        parameter.requires_grad_(name in weights and ".lora_B." in name)
        if name in weights:
            parameter.data = torch.tensor(weights[name], dtype=torch.float32, device="cuda")
    optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],
                                  lr=task.config.learning_rate, weight_decay=0.0, eps=1e-8)
    batches = token_batches(tokenizer, texts, task.config.sequence_length)
    losses = []
    model.train()
    for step in range(task.config.steps):
        tokens = torch.tensor([batches[step % len(batches)]], dtype=torch.long, device="cuda")
        optimizer.zero_grad(set_to_none=True)
        loss = model(input_ids=tokens, labels=tokens).loss
        if not torch.isfinite(loss):
            raise RuntimeError("nonfinite training loss")
        loss.backward()
        torch.nn.utils.clip_grad_norm_([p for p in model.parameters() if p.requires_grad], 1.0)
        optimizer.step()
        losses.append(float(loss.detach().cpu()))
    result = {name: names[name].detach().float().cpu().numpy() for name in weights}
    final_a, final_b = peft_to_canonical(result)
    return final_a, final_b, losses


def _mlx_optimizer(config):
    from mlx.optimizers import AdamW
    # MLX defaults bias_correction=False; PyTorch AdamW always corrects the moments.
    # Explicit True is required for the shared cross-backend optimizer contract.
    return AdamW(learning_rate=config.learning_rate, betas=[0.9, 0.999],
                 weight_decay=0.0, eps=1e-8, bias_correction=True)


def _mlx_train(task, model_path, texts, a, b):
    import mlx.core as mx
    import mlx.optimizers as optim
    from mlx import nn
    from mlx.utils import tree_flatten
    from mlx_lm import load
    from mlx_lm.tuner.utils import linear_to_lora_layers

    mx.random.seed(task.config.seed)
    model, tokenizer = load(str(model_path), tokenizer_config={"trust_remote_code": False})
    model.set_dtype(mx.bfloat16)
    linear_to_lora_layers(model, 2, {"rank": 8, "scale": 1.0, "dropout": 0.0,
                                     "keys": ["self_attn.q_proj", "self_attn.v_proj"]})
    weights = canonical_to_mlx(a, b)
    params = dict(tree_flatten(model.parameters()))
    if not set(weights).issubset(params):
        raise RuntimeError("MLX parameter names differ from the reviewed template")
    model.load_weights([(k, mx.array(v)) for k, v in weights.items()], strict=False)
    model.freeze()
    for name, module in model.named_modules():
        if name in a:
            module.unfreeze(keys=["lora_b"], recurse=False)
    actual_trainable = {k for k, _ in tree_flatten(model.trainable_parameters())}
    if actual_trainable != {f"{key}.lora_b" for key in b}:
        raise RuntimeError("only shared-A adapter B may be trainable")
    optimizer = _mlx_optimizer(task.config)
    batches = token_batches(tokenizer, texts, task.config.sequence_length)

    def loss_fn(current, x):
        logits = current(x[:, :-1]).astype(mx.float32)
        return nn.losses.cross_entropy(logits, x[:, 1:], reduction="mean")

    loss_and_grad = nn.value_and_grad(model, loss_fn)
    model.train()
    losses = []
    for step in range(task.config.steps):
        tokens = mx.array([batches[step % len(batches)]])
        loss, grads = loss_and_grad(model, tokens)
        grads, _ = optim.clip_grad_norm(grads, max_norm=1.0)
        optimizer.update(model, grads)
        mx.eval(model.parameters(), optimizer.state, loss)
        value = float(loss.item())
        if not np.isfinite(value):
            raise RuntimeError("nonfinite training loss")
        losses.append(value)
    final = dict(tree_flatten(model.parameters()))
    result = {name: np.array(final[name].astype(mx.float32)) for name in weights}
    final_a, final_b = mlx_to_canonical(result)
    return final_a, final_b, losses


def train(task: TrainingTask, model_path: Path, texts: list[str], shared_a: bytes,
          base_b: bytes, backend: str) -> tuple[bytes, dict]:
    validate_dataset(task, texts)
    a, b = validate_artifacts(task, shared_a, base_b)
    path = validate_model_path(model_path, task)
    if backend not in {"mlx", "cuda"}:
        raise ValueError("backend must be mlx or cuda")
    final_a, final_b, losses = (_mlx_train if backend == "mlx" else _torch_train)(task, path, texts, a, b)
    if any(not np.array_equal(a[name], final_a[name]) for name in a):
        raise RuntimeError("shared A changed during training")
    result = encode_tensors(final_b)
    validate_artifacts(task, shared_a, result, update=True, base_b=base_b)
    return result, {"backend": backend, "steps": task.config.steps, "losses": losses,
                    "adapter_hash": digest(result), "task_hash": task.fingerprint,
                    "evidence": "local_training_only_not_independent_validation"}


def heldout_losses(task, model_path, texts, shared_a, adapters, backend):
    """Compare base and candidate on validator-owned held-out text, with no training."""
    if not texts or len(texts) > 256 or any(not t or len(t.encode()) > 16384 for t in texts):
        raise ValueError("bounded validator-owned held-out texts required")
    path = validate_model_path(model_path, task)
    a = decode_tensors(shared_a)
    results = []
    if backend == "mlx":
        import mlx.core as mx
        from mlx import nn
        from mlx_lm import load
        from mlx_lm.tuner.utils import linear_to_lora_layers
        model, tokenizer = load(str(path), tokenizer_config={"trust_remote_code": False})
        model.set_dtype(mx.bfloat16)
        linear_to_lora_layers(model, 2, {"rank": 8, "scale": 1.0, "dropout": 0.0,
                                         "keys": ["self_attn.q_proj", "self_attn.v_proj"]})
        model.eval()
        batches = token_batches(tokenizer, texts, task.config.sequence_length)
        for adapter in adapters:
            weights = canonical_to_mlx(a, decode_tensors(adapter))
            model.load_weights([(k, mx.array(v)) for k, v in weights.items()], strict=False)
            total, count = 0.0, 0
            for ids in batches:
                tokens = mx.array([ids])
                logits = model(tokens[:, :-1]).astype(mx.float32)
                loss = nn.losses.cross_entropy(logits, tokens[:, 1:], reduction="sum")
                total += float(loss.item())
                count += len(ids) - 1
            results.append(total / count)
    elif backend == "cuda":
        import torch
        from peft import LoraConfig, get_peft_model
        from transformers import AutoModelForCausalLM, AutoTokenizer
        if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
            raise RuntimeError("CUDA with BF16 support required for validator")
        tokenizer = AutoTokenizer.from_pretrained(str(path), local_files_only=True, trust_remote_code=False)
        model = AutoModelForCausalLM.from_pretrained(str(path), torch_dtype=torch.bfloat16,
            local_files_only=True, trust_remote_code=False, attn_implementation="eager", use_safetensors=True).to("cuda")
        model = get_peft_model(model, LoraConfig(r=8, lora_alpha=8, lora_dropout=0.0, bias="none",
            task_type="CAUSAL_LM", target_modules=[layer.name for layer in task.config.layers]))
        model.eval()
        names = dict(model.named_parameters())
        batches = token_batches(tokenizer, texts, task.config.sequence_length)
        with torch.no_grad():
            for adapter in adapters:
                for name, value in canonical_to_peft(a, decode_tensors(adapter)).items():
                    names[name].data = torch.tensor(value, dtype=torch.float32, device="cuda")
                total, count = 0.0, 0
                for ids in batches:
                    tokens = torch.tensor([ids], dtype=torch.long, device="cuda")
                    loss = model(input_ids=tokens, labels=tokens).loss
                    total += float(loss.cpu()) * (len(ids) - 1)
                    count += len(ids) - 1
                results.append(total / count)
    else:
        raise ValueError("unsupported validation backend")
    if not all(np.isfinite(value) for value in results):
        raise ValueError("nonfinite held-out loss")
    return results


def verify(task, model_path, texts, shared_a, base_b, candidate, heldout, backend):
    """Full duplicate recomputation plus a separate held-out non-regression check.

    These are computational evidence, not proof that validator operators are independent.
    """
    validate_artifacts(task, shared_a, candidate, update=True, base_b=base_b)
    if set(texts) & set(heldout):
        raise ValueError("held-out examples overlap this training shard")
    reproduced, metrics = train(task, model_path, texts, shared_a, base_b, backend)
    expected, observed = decode_tensors(reproduced), decode_tensors(candidate)
    recomputation = all(np.allclose(expected[k], observed[k], atol=1e-5, rtol=1e-2) for k in expected)
    base_loss, candidate_loss = heldout_losses(task, model_path, heldout, shared_a, [base_b, candidate], backend)
    nonregression = candidate_loss <= base_loss * 1.01
    evidence = {"task_hash": task.fingerprint, "adapter_hash": digest(candidate), "backend": backend,
                "recomputed_adapter_hash": metrics["adapter_hash"], "recomputation_passed": recomputation,
                "heldout_hash": canonical_hash(heldout), "baseline_loss": base_loss,
                "candidate_loss": candidate_loss, "heldout_passed": nonregression,
                "accepted": bool(recomputation and nonregression),
                "limitations": "Small held-out loss test; not a coding benchmark or Byzantine-proof verification"}
    evidence["evidence_hash"] = canonical_hash(evidence)
    return evidence


def main():
    parser = argparse.ArgumentParser(description="Heyuna fixed FFA training / validation template")
    parser.add_argument("--job-dir", type=Path, required=True)
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument("--backend", choices=["mlx", "cuda"], required=True)
    parser.add_argument("--candidate", type=Path, help="Verify this B adapter instead of producing one")
    parser.add_argument("--heldout", type=Path, help="Validator-owned JSON list of held-out texts")
    args = parser.parse_args()
    job = args.job_dir
    task = TrainingTask.model_validate_json((job / "task.json").read_text())
    texts = json.loads((job / "data.json").read_text())
    a, b = (job / "a.safetensors").read_bytes(), (job / "b.safetensors").read_bytes()
    if args.candidate:
        if not args.heldout:
            parser.error("--candidate requires --heldout")
        evidence = verify(task, args.model_path, texts, a, b, args.candidate.read_bytes(),
                          json.loads(args.heldout.read_text()), args.backend)
        (job / "validation.json").write_text(json.dumps(evidence, allow_nan=False, indent=2))
    else:
        adapter, metrics = train(task, args.model_path, texts, a, b, args.backend)
        (job / "result.safetensors").write_bytes(adapter)
        (job / "metrics.json").write_text(json.dumps(metrics, allow_nan=False))


if __name__ == "__main__":
    main()
