"""Authenticated, loopback-only local application API."""
from __future__ import annotations

import asyncio
import hmac
import os
import platform
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import psutil
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from . import __version__
from .agent import AgentService
from .model import ModelRuntime
from .projects import Projects
from .sandbox import Sandbox


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class OpenProject(StrictModel):
    path: str = Field(min_length=1, max_length=4096)


class AgentInput(StrictModel):
    project_id: str = Field(max_length=64)
    prompt: str = Field(min_length=1, max_length=8000)


class Message(StrictModel):
    role: Literal["user", "assistant", "system"]
    content: str = Field(max_length=20000)


class Chat(StrictModel):
    messages: list[Message] = Field(min_length=1, max_length=30)


class Settings(StrictModel):
    start_time: str = Field(default="22:00", pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    end_time: str = Field(default="07:00", pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    max_cpu_percent: int = Field(default=50, ge=10, le=100)
    max_memory_gb: int = Field(default=24, ge=4, le=128)
    max_upload_mb_day: int = Field(default=1024, ge=1, le=10240)


def create_app(state_dir=None, token=None, model=None, sandbox=None):
    secret = token or os.environ.get("HEYUNA_LOCAL_TOKEN", "")
    if len(secret) < 32:
        raise RuntimeError("HEYUNA_LOCAL_TOKEN must contain at least 32 characters; no unauthenticated local mode.")
    state = Path(state_dir or os.environ.get("HEYUNA_STATE_DIR", ".state")).resolve()
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    resource_lock = threading.RLock()
    from .network import NetworkService
    network = NetworkService(state, resource_lock)
    runtime = model or ModelRuntime(state, resource_lock)
    executor = sandbox or Sandbox()
    projects = Projects(state)
    agent = AgentService(state, projects, runtime, executor)
    @asynccontextmanager
    async def lifespan(_app):
        try:
            yield
        finally:
            close = getattr(executor, "close", None)
            if close is not None:
                await asyncio.to_thread(close)

    app = FastAPI(title="Heyuna local API", version=__version__, docs_url=None, redoc_url=None, openapi_url=None,
                  lifespan=lifespan)
    app.state.runtime, app.state.network, app.state.agent = runtime, network, agent

    @app.middleware("http")
    async def authorize(request: Request, call_next):
        origin = request.headers.get("origin")
        if origin and origin not in {"http://localhost:1420", "http://127.0.0.1:1420", "tauri://localhost", "http://tauri.localhost"}:
            return JSONResponse({"detail": "Untrusted origin"}, status_code=403)
        if not hmac.compare_digest(request.headers.get("authorization", ""), "Bearer " + secret):
            return JSONResponse({"detail": "Local authorization required"}, status_code=401)
        length = request.headers.get("content-length")
        if length and (not length.isdigit() or int(length) > 2 * 1024 * 1024):
            return JSONResponse({"detail": "Request too large"}, status_code=413)
        # Count actual bytes too: a chunked request need not have Content-Length.
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > 2 * 1024 * 1024:
                return JSONResponse({"detail": "Request too large"}, status_code=413)
            chunks.append(chunk)
        request._body = b"".join(chunks)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(ValueError)
    async def invalid(_request, exc):
        return JSONResponse({"detail": str(exc)[:500]}, status_code=400)

    @app.exception_handler(RuntimeError)
    async def unavailable(_request, exc):
        return JSONResponse({"detail": str(exc)[:500]}, status_code=409)

    @app.get("/api/status")
    def status():
        return {"version": __version__, "mode": "testnet-alpha", "model": runtime.snapshot(),
                "sandbox": executor.status(), "device": {"platform": platform.system(),
                "memory_gb": round(psutil.virtual_memory().total / 1024**3)}, **network.snapshot()}

    @app.post("/api/model/prepare")
    def prepare():
        return runtime.prepare()

    @app.post("/api/chat")
    def chat(body: Chat):
        return {"text": runtime.generate([m.model_dump() for m in body.messages]), "model": runtime.snapshot()["id"]}

    @app.post("/api/projects/open")
    def open_project(body: OpenProject):
        try:
            return projects.open(body.path)
        except OSError as exc:
            raise HTTPException(400, "项目不存在或没有访问权限") from exc

    @app.get("/api/projects/{identity}/file")
    def read_file(identity: str, path: str):
        try:
            return projects.read(identity, path)
        except OSError as exc:
            raise HTTPException(404, "文件不可用") from exc

    @app.post("/api/agent/tasks")
    def start_task(body: AgentInput):
        return agent.start(body.project_id, body.prompt)

    @app.get("/api/agent/tasks/{identity}")
    def get_task(identity: str):
        return agent.get(identity)

    @app.post("/api/agent/tasks/{identity}/cancel")
    def cancel_task(identity: str):
        return agent.cancel(identity)

    @app.post("/api/agent/tasks/{identity}/apply")
    def apply_task(identity: str):
        return agent.apply(identity)

    @app.post("/api/agent/tasks/{identity}/revert")
    def revert_task(identity: str):
        return agent.apply(identity, reverse=True)

    @app.get("/api/settings")
    def get_settings():
        path = state / "settings.json"
        settings = Settings.model_validate_json(path.read_text()) if path.exists() else Settings()
        return {**settings.model_dump(), "supported_limits": ["start_time", "end_time", "max_memory_gb", "max_upload_mb_day"],
                "detail": "CPU 百分比仅用于负载监测；不保证操作系统调度配额。"}

    @app.put("/api/settings")
    def put_settings(body: Settings):
        path = state / "settings.json"
        temp = path.with_suffix(".tmp")
        temp.write_text(body.model_dump_json())
        temp.replace(path)
        return get_settings()

    @app.get("/api/rewards/config")
    def rewards_config():
        from .deployment import rewards_config as public_config
        return public_config(state)

    app.include_router(network.router, prefix="/api")
    return app

