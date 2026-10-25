"""Pinned local model. No cloud fallback, remote code, or automatic startup download."""
from __future__ import annotations

import gc
import json
import os
import platform
import sys
import threading
from pathlib import Path

MODEL_ID = "Qwen/Qwen3-4B-Instruct-2507"
MODEL_REVISION = "cdbee75f17c01a7cc42f958dc650907174af0554"


def first_json_object(text: str) -> str | None:
    """Stop at one syntactically complete object; never execute a simulated next tool/result."""
    value = text.lstrip()
    if value.startswith("```"):
        if "\n" not in value:
            return None
        value = value.split("\n", 1)[1].lstrip()
    if not value.startswith("{"):
        return None
    try:
        parsed, _end = json.JSONDecoder().raw_decode(value)
    except json.JSONDecodeError:
        return None
    return json.dumps(parsed, ensure_ascii=False, allow_nan=False)


class ModelRuntime:
    def __init__(self, state_dir: Path, resource_lock: threading.RLock):
        self.state_dir = Path(state_dir)
        self.path = self.state_dir / "models" / "qwen3-4b"
        self.resource_lock = resource_lock
        self.backend = "mlx" if platform.system() == "Darwin" and platform.machine() == "arm64" else "torch"
        self.state = "missing"
        self.detail = "模型尚未下载；需要约 8 GB 磁盘空间。"
        self._model = self._tokenizer = None
        self._prepare_lock = threading.Lock()
        marker = self.state_dir / "model.json"
        if marker.exists():
            try:
                saved = json.loads(marker.read_text())
                if saved.get("revision") == MODEL_REVISION and self.complete():
                    self.state, self.detail = "downloaded", "固定版本已下载，将在首次请求时加载。"
            except (ValueError, OSError):
                pass

    def complete(self):
        index = self.path / "model.safetensors.index.json"
        try:
            shards = set(json.loads(index.read_text())["weight_map"].values())
            return bool(shards) and all(Path(f).name == f and (self.path / f).is_file() for f in shards) and (self.path / "tokenizer.json").is_file()
        except (OSError, KeyError, ValueError):
            return False

    def snapshot(self):
        return {"id": MODEL_ID, "revision": MODEL_REVISION, "backend": self.backend,
                "state": self.state, "ready": self.complete() and self.state != "error", "detail": self.detail}

    def prepare(self):
        if not self._prepare_lock.acquire(blocking=False):
            return {"state": self.state, "detail": self.detail}
        self.state, self.detail = "downloading", "正在下载官方固定版本；不会执行仓库中的 Python 代码。"
        threading.Thread(target=self._download, daemon=True, name="heyuna-model-download").start()
        return {"state": self.state, "detail": self.detail}

    def _download(self):
        try:
            # HTTP transfer is predictable on restricted desktop networks; users may opt into Xet.
            os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
            from huggingface_hub import snapshot_download
            self.path.mkdir(parents=True, exist_ok=True)
            snapshot_download(MODEL_ID, revision=MODEL_REVISION, local_dir=self.path, token=False,
                              allow_patterns=["*.json", "*.safetensors", "*.txt", "*.jinja", "LICENSE", "README.md"], max_workers=3)
            if not self.complete():
                raise RuntimeError("模型分片未完整下载")
            from .training import verify_model_files
            file_hashes = verify_model_files(self.path)
            self.state, self.detail = "downloaded", "模型下载完整且通过固定 SHA256 校验，首次使用时加载。"
            manifest = self.state_dir / "model.json"
            temporary = manifest.with_suffix(".tmp")
            temporary.write_text(json.dumps({"id": MODEL_ID, "revision": MODEL_REVISION,
                    "path": str(self.path.resolve()), "state": self.state, "file_hashes": file_hashes}), encoding="utf-8")
            temporary.replace(manifest)
        except Exception as exc:  # noqa: BLE001 - background boundary exposes failure, never substitutes a model
            self.state, self.detail = "error", f"模型下载失败：{type(exc).__name__}: {str(exc)[:300]}"
        finally:
            self._prepare_lock.release()

    def generate(self, messages: list[dict], cancel: threading.Event | None = None, max_tokens=768,
                 json_object=False):
        if not self.complete():
            raise RuntimeError("模型未准备好，请先下载模型。")
        if sum(len(m["content"]) for m in messages) > 28000:
            raise ValueError("上下文过长，请缩小任务或减少文件内容。")
        with self.resource_lock:
            inputs = output = None
            try:
                self.state, self.detail = "loading", "正在校验并加载本地模型。"
                if self._model is None:
                    from .training import verify_model_files
                    verify_model_files(self.path)
                if self.backend == "mlx":
                    from mlx_lm import load, stream_generate
                    from mlx_lm.sample_utils import make_sampler
                    if self._model is None:
                        self._model, self._tokenizer = load(str(self.path), tokenizer_config={"trust_remote_code": False})
                    prompt = self._tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
                    self.state, self.detail = "generating", "正在本机生成；项目内容未发送到云端。"
                    parts = []
                    for response in stream_generate(self._model, self._tokenizer, prompt=prompt,
                                                    max_tokens=max_tokens, sampler=make_sampler(temp=0)):
                        if cancel and cancel.is_set():
                            raise InterruptedError("任务已取消")
                        parts.append(response.text)
                        if json_object:
                            complete = first_json_object("".join(parts))
                            if complete is not None:
                                return complete
                    return "".join(parts)
                import torch
                from transformers import (
                    AutoModelForCausalLM,
                    AutoTokenizer,
                    StoppingCriteria,
                    StoppingCriteriaList,
                )
                if not torch.cuda.is_available():
                    raise RuntimeError("此版本的 Windows 模型运行需要 NVIDIA CUDA；不自动退回云端。")
                if self._model is None:
                    self._tokenizer = AutoTokenizer.from_pretrained(str(self.path), local_files_only=True, trust_remote_code=False)
                    self._model = AutoModelForCausalLM.from_pretrained(str(self.path), local_files_only=True,
                        trust_remote_code=False, torch_dtype=torch.bfloat16).to("cuda").eval()
                inputs = self._tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=True,
                                                            return_tensors="pt", return_dict=True).to("cuda")
                class Cancel(StoppingCriteria):
                    def __call__(self, input_ids, scores, **kwargs):
                        if cancel and cancel.is_set():
                            return True
                        if json_object:
                            generated = self_outer._tokenizer.decode(input_ids[0, inputs["input_ids"].shape[-1]:], skip_special_tokens=True)
                            return first_json_object(generated) is not None
                        return False
                self_outer = self
                self.state, self.detail = "generating", "正在本机生成。"
                with torch.inference_mode():
                    output = self._model.generate(**inputs, max_new_tokens=max_tokens, do_sample=False,
                                                  stopping_criteria=StoppingCriteriaList([Cancel()]))
                if cancel and cancel.is_set():
                    raise InterruptedError("任务已取消")
                decoded = self._tokenizer.decode(output[0, inputs["input_ids"].shape[-1]:], skip_special_tokens=True)
                return (first_json_object(decoded) or decoded) if json_object else decoded
            except InterruptedError:
                raise
            except Exception as exc:
                self.detail = f"本地模型错误：{type(exc).__name__}: {str(exc)[:250]}"
                raise
            finally:
                if self.state in ("loading", "generating"):
                    self.state = "downloaded"
                    if not self.detail.startswith("本地模型错误"):
                        self.detail = "本次推理已结束，本地模型可用。"
                # Training and inference must not hold two resident model copies.
                self._model = self._tokenizer = None
                inputs = output = None
                gc.collect()
                if self.backend == "mlx":
                    import mlx.core as mx
                    mx.clear_cache()
                else:
                    torch_runtime = sys.modules.get("torch")
                    if torch_runtime is not None and torch_runtime.cuda.is_initialized():
                        torch_runtime.cuda.empty_cache()

