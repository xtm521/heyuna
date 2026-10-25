"""Frozen backend entry: only two reviewed modules, never arbitrary Python code."""
from __future__ import annotations

import importlib.metadata
import json
import multiprocessing
import platform
import sys


def main() -> None:
    multiprocessing.freeze_support()
    if sys.argv[1:] == ["--runtime-check"]:
        import numpy
        import fastapi
        import httpx
        import safetensors
        import tokenizers
        import transformers
        import ssl
        import heyuna.app
        import heyuna.training
        ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl.create_default_context()
        report = {"frozen": bool(getattr(sys, "frozen", False)), "platform": platform.system(),
                  "python": platform.python_version(), "numpy": numpy.__version__,
                  "backend": "unavailable", "tls_contexts_initialized": True,
                  "inference_verified": False, "training_verified": False}
        if sys.platform == "darwin":
            import mlx.core as mx
            from mlx_lm import load
            value = mx.sum(mx.array([1.0, 2.0], dtype=mx.float32))
            mx.eval(value)
            report.update(backend="mlx", mlx=importlib.metadata.version("mlx"),
                          mlx_lm=importlib.metadata.version("mlx-lm"), tensor_smoke=float(value))
        elif sys.platform == "win32":
            import torch
            report.update(backend="cuda" if torch.cuda.is_available() else "cuda_unavailable", torch=torch.__version__)
        print(json.dumps(report, ensure_ascii=False))
        return
    arguments = sys.argv[1:]
    module = "heyuna.cli"
    if arguments[:1] == ["-m"]:
        if len(arguments) < 2 or arguments[1] not in {"heyuna.cli", "heyuna.training"}:
            raise SystemExit("Only reviewed Heyuna service and training entrypoints are available.")
        module, arguments = arguments[1], arguments[2:]
    sys.argv = [module, *arguments]
    if module == "heyuna.training":
        from heyuna.training import main as entry
    else:
        from heyuna.cli import main as entry
    entry()


if __name__ == "__main__":
    main()
