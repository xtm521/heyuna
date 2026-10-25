"""Authenticated invited coordinator; SQLite for local tests, PostgreSQL for deployment.

This service produces unsigned reward drafts. It never reports chain confirmation.
Validators remain a trusted, separately credentialed boundary in this alpha.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import threading
import time
import uuid
from typing import Literal

from fastapi import FastAPI, HTTPException, Request, Response
from pydantic import Field, ValidationError
from sqlalchemy import JSON, Column, MetaData, String, Table, create_engine, select
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import JSONResponse

from .federation import aggregate, digest, validate_artifacts
from .protocol import (
    REWARD_POOL,
    Address,
    ContributionReceipt,
    ContributionState,
    HexDigest,
    Identifier,
    Message,
    RewardAllocation,
    RewardEpoch,
    TaskBundle,
    TrainingTask,
    canonical_hash,
    weekly_budget,
)
from .training import MODEL_REVISION, validate_dataset

LEASE_SECONDS = 900
MAX_REQUEST_BYTES = 8 * 1024 * 1024


class Principal(Message):
    participant_id: Identifier
    operator_id: Identifier
    role: Literal["device", "validator", "admin"]
    wallet: Address
    token: str = Field(min_length=32, max_length=256)


class LeaseRequest(Message):
    backend: Literal["mlx", "cuda"]


class Heartbeat(Message):
    lease_id: Identifier


class Submission(Message):
    lease_id: Identifier
    task_hash: HexDigest
    adapter_hash: HexDigest
    adapter_b: str = Field(max_length=6_000_000)


class Validation(Message):
    adapter_hash: HexDigest
    accepted: bool
    recomputation_passed: bool
    heldout_passed: bool
    evidence_hash: HexDigest
    detail: str = Field(min_length=1, max_length=2000)


class EpochRequest(Message):
    epoch: int = Field(ge=0)
    receipt_ids: list[Identifier] = Field(min_length=1, max_length=10000)


def _decode(value: str) -> bytes:
    try:
        data = base64.b64decode(value, validate=True)
    except Exception as exc:
        raise HTTPException(422, "invalid base64 artifact") from exc
    if len(data) > 4 * 1024 * 1024:
        raise HTTPException(413, "artifact exceeds limit")
    return data


class BodyLimit:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        size = 0
        messages = []
        while True:
            message = await receive()
            size += len(message.get("body", b""))
            if size > MAX_REQUEST_BYTES:
                return await JSONResponse({"detail": "request too large"}, status_code=413)(scope, receive, send)
            messages.append(message)
            if not message.get("more_body", False):
                break
        iterator = iter(messages)

        async def replay():
            return next(iterator, {"type": "http.disconnect"})

        await self.app(scope, replay, send)


class Store:
    def __init__(self, url: str):
        self.engine = create_engine(url, connect_args={"check_same_thread": False} if url.startswith("sqlite") else {})
        metadata = MetaData()
        self.records = Table("heyuna_records", metadata,
                             Column("key", String(160), primary_key=True), Column("data", JSON, nullable=False))
        metadata.create_all(self.engine)
        self.lock = threading.RLock()

    def transaction(self):
        return self.engine.begin()

    def get(self, conn, key, *, lock=False):
        query = select(self.records.c.data).where(self.records.c.key == key)
        row = conn.execute(query.with_for_update() if lock else query).first()
        return row[0] if row else None

    def put(self, conn, key, data):
        existing = self.get(conn, key)
        if existing is None:
            conn.execute(self.records.insert().values(key=key, data=data))
        else:
            conn.execute(self.records.update().where(self.records.c.key == key).values(data=data))

    def all(self, conn, prefix):
        return [row[0] for row in conn.execute(select(self.records.c.data).where(self.records.c.key.like(prefix + "%")))]


def create_coordinator_app(*, database_url: str | None = None, principals: list[dict] | None = None,
                           clock=time.time) -> FastAPI:
    url = database_url or os.environ.get("HEYUNA_DATABASE_URL", "sqlite:///heyuna-coordinator.sqlite3")
    raw = principals if principals is not None else json.loads(os.environ.get("HEYUNA_COORDINATOR_IDENTITIES", "[]"))
    try:
        identities = [Principal.model_validate(p) for p in raw]
    except ValidationError:
        raise RuntimeError("invalid coordinator identity configuration; check identifiers, roles and credential lengths") from None
    if not identities:
        raise RuntimeError("configure distinct admin, device and validator identities before startup")
    if len({p.participant_id for p in identities}) != len(identities):
        raise ValueError("participant identifiers must be unique")
    if len({p.token for p in identities}) != len(identities):
        raise ValueError("each principal needs a unique credential")
    validators = [p for p in identities if p.role == "validator"]
    if len(validators) != 3 or len({p.operator_id for p in validators}) != 3:
        raise ValueError("testnet requires exactly three separately identified validator operators")
    if any(p.role == "device" and p.operator_id in {v.operator_id for v in validators} for p in identities):
        raise ValueError("training and validation operators must be independent")
    by_id = {p.participant_id: p for p in identities}
    tokens = [(hashlib.sha256(p.token.encode()).digest(), p) for p in identities]
    store = Store(url)
    # One database row serializes critical transactions across workers and replicas.
    with store.lock, store.transaction() as conn:
        if store.get(conn, "global") is None:
            store.put(conn, "global", {"allocated": "0"})
    app = FastAPI(title="Heyuna invited coordinator", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store = store
    app.add_middleware(BodyLimit)
    hosts = os.environ.get("HEYUNA_COORDINATOR_HOSTS", "localhost,127.0.0.1,[::1],testserver").split(",")
    if "*" in hosts:
        raise ValueError("coordinator requires an explicit allowed-host list")
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=[h.strip() for h in hosts if h.strip()])

    @app.middleware("http")
    async def auth(request: Request, call_next):
        supplied = request.headers.get("authorization", "")
        if not supplied.startswith("Bearer ") or len(supplied) > 300:
            return JSONResponse({"detail": "authentication required"}, status_code=401)
        fingerprint = hashlib.sha256(supplied[7:].encode()).digest()
        principal = next((p for key, p in tokens if hmac.compare_digest(key, fingerprint)), None)
        if principal is None:
            return JSONResponse({"detail": "invalid credential"}, status_code=401)
        request.state.principal = principal
        result = await call_next(request)
        result.headers["Cache-Control"] = "no-store"
        result.headers["X-Content-Type-Options"] = "nosniff"
        return result

    def role(request, expected):
        principal = request.state.principal
        if principal.role not in expected:
            raise HTTPException(403, "role does not permit this operation")
        return principal

    def locked(conn):
        # SELECT FOR UPDATE is ignored by SQLite; use a write to acquire its database lock.
        if url.startswith("sqlite"):
            conn.execute(store.records.update().where(store.records.c.key == "global").values(
                data=store.records.c.data))
        return store.get(conn, "global", lock=True)

    @app.get("/v1/status")
    def status(request: Request):
        p = request.state.principal
        return {"state": "authenticated", "participant_id": p.participant_id, "role": p.role,
                "chain_id": 11155111, "validator_threshold": 2, "validator_count": 3,
                "settlement": "unsigned_drafts_only"}

    @app.post("/v1/tasks", status_code=201)
    def create_task(bundle: TaskBundle, request: Request):
        role(request, {"admin"})
        try:
            validate_dataset(bundle.task, bundle.texts)
            if bundle.task.model_revision != MODEL_REVISION:
                raise ValueError("unreviewed model revision")
            validate_artifacts(bundle.task, _decode(bundle.shared_a), _decode(bundle.base_b))
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        with store.lock, store.transaction() as conn:
            locked(conn)
            if store.get(conn, "task:" + bundle.task.task_id):
                raise HTTPException(409, "task ID already exists")
            data = {"bundle": bundle.model_dump(), "lease": None, "receipt_id": None}
            store.put(conn, "task:" + bundle.task.task_id, data)
        return {"task_id": bundle.task.task_id, "state": "queued", "task_hash": bundle.task.fingerprint}

    @app.post("/v1/tasks/lease")
    def lease(payload: LeaseRequest, request: Request):
        p = role(request, {"device"})
        with store.lock, store.transaction() as conn:
            locked(conn)
            tasks = store.all(conn, "task:")
            # Do not allow one device to hoard multiple live leases.
            for data in tasks:
                current = data["lease"]
                if current and current["participant_id"] == p.participant_id and current["expires_at"] > clock() and not data["receipt_id"]:
                    return {**data["bundle"], "lease": current}
            for data in tasks:
                current = data["lease"]
                if data["receipt_id"] or (current and current["expires_at"] > clock()):
                    continue
                current = {"lease_id": uuid.uuid4().hex, "participant_id": p.participant_id,
                           "expires_at": clock() + LEASE_SECONDS, "backend": payload.backend}
                data["lease"] = current
                store.put(conn, "task:" + data["bundle"]["task"]["task_id"], data)
                return {**data["bundle"], "lease": current}
        return Response(status_code=204)

    @app.post("/v1/tasks/{task_id}/heartbeat")
    def heartbeat(task_id: str, request: Request, payload: Heartbeat):
        p = role(request, {"device"})
        with store.lock, store.transaction() as conn:
            locked(conn)
            data = store.get(conn, "task:" + task_id)
            current = data and data["lease"]
            if not current or current["lease_id"] != payload.lease_id or current["participant_id"] != p.participant_id:
                raise HTTPException(409, "lease is not owned by this device")
            if current["expires_at"] <= clock() or data["receipt_id"]:
                raise HTTPException(409, "lease expired or already submitted")
            current["expires_at"] = clock() + LEASE_SECONDS
            store.put(conn, "task:" + task_id, data)
            return current

    @app.post("/v1/tasks/{task_id}/submit")
    def submit(task_id: str, payload: Submission, request: Request):
        p = role(request, {"device"})
        blob = _decode(payload.adapter_b)
        if digest(blob) != payload.adapter_hash:
            raise HTTPException(422, "result hash mismatch")
        with store.lock, store.transaction() as conn:
            locked(conn)
            data = store.get(conn, "task:" + task_id)
            if not data:
                raise HTTPException(404, "unknown task")
            task = TrainingTask.model_validate(data["bundle"]["task"])
            if payload.task_hash != task.fingerprint:
                raise HTTPException(422, "task fingerprint mismatch")
            if data["receipt_id"]:
                previous = store.get(conn, "receipt:" + data["receipt_id"])
                receipt = previous["receipt"]
                if receipt["participant_id"] == p.participant_id and receipt["adapter_hash"] == payload.adapter_hash:
                    return receipt
                raise HTTPException(409, "task already has a different accepted submission")
            current = data["lease"]
            if not current or current["participant_id"] != p.participant_id or current["lease_id"] != payload.lease_id or current["expires_at"] <= clock():
                raise HTTPException(409, "active device-owned lease required")
            try:
                validate_artifacts(task, _decode(data["bundle"]["shared_a"]), blob, update=True,
                                   base_b=_decode(data["bundle"]["base_b"]))
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
            receipt = ContributionReceipt(receipt_id=uuid.uuid4().hex, task_id=task_id, round_id=task.round_id,
                participant_id=p.participant_id, wallet=p.wallet, task_hash=task.fingerprint,
                adapter_hash=payload.adapter_hash, state=ContributionState.PENDING_VERIFICATION,
                work_units=task.work_units)
            data["receipt_id"] = receipt.receipt_id
            store.put(conn, "task:" + task_id, data)
            store.put(conn, "receipt:" + receipt.receipt_id,
                      {"receipt": receipt.model_dump(mode="json"), "adapter_b": payload.adapter_b,
                       "validations": {}, "epoch": None})
            return receipt

    @app.get("/v1/receipts")
    def receipts(request: Request):
        p = request.state.principal
        with store.lock, store.transaction() as conn:
            return [d["receipt"] for d in store.all(conn, "receipt:")
                    if p.role in {"admin", "validator"} or d["receipt"]["participant_id"] == p.participant_id]

    @app.get("/v1/receipts/{receipt_id}/review")
    def review(receipt_id: str, request: Request):
        role(request, {"validator", "admin"})
        with store.lock, store.transaction() as conn:
            data = store.get(conn, "receipt:" + receipt_id)
            if not data:
                raise HTTPException(404, "unknown receipt")
            task = store.get(conn, "task:" + data["receipt"]["task_id"])
            return {"receipt": data["receipt"], "bundle": task["bundle"], "adapter_b": data["adapter_b"]}

    @app.post("/v1/receipts/{receipt_id}/validate")
    def validate(receipt_id: str, verdict: Validation, request: Request):
        p = role(request, {"validator"})
        with store.lock, store.transaction() as conn:
            locked(conn)
            data = store.get(conn, "receipt:" + receipt_id)
            if not data:
                raise HTTPException(404, "unknown receipt")
            receipt = data["receipt"]
            if data["epoch"] is not None or receipt["state"] == "rejected":
                raise HTTPException(409, "receipt has been finalized or rejected")
            if verdict.adapter_hash != receipt["adapter_hash"]:
                raise HTTPException(422, "verdict must attest the submitted artifact")
            if p.operator_id == by_id[receipt["participant_id"]].operator_id:
                raise HTTPException(403, "self-validation forbidden")
            if p.participant_id in data["validations"]:
                if data["validations"][p.participant_id] == verdict.model_dump():
                    return receipt
                raise HTTPException(409, "validator cannot overwrite an attestation")
            if verdict.accepted and not (verdict.recomputation_passed and verdict.heldout_passed):
                raise HTTPException(422, "acceptance requires recomputation and held-out evaluation")
            data["validations"][p.participant_id] = verdict.model_dump()
            if not verdict.accepted:
                receipt["state"] = "rejected"
                receipt["detail"] = "Independent verification rejected the update; no reward is eligible."
            elif len([v for v in data["validations"].values() if v["accepted"]]) >= 2:
                receipt["state"] = "verified"
                receipt["detail"] = "Two validator attestations accepted; no on-chain settlement yet."
            receipt["validator_ids"] = sorted(data["validations"])
            store.put(conn, "receipt:" + receipt_id, data)
            return receipt

    @app.post("/v1/rounds/{round_id}/aggregate")
    def aggregate_round(round_id: str, request: Request):
        role(request, {"admin"})
        with store.lock, store.transaction() as conn:
            locked(conn)
            entries = [d for d in store.all(conn, "receipt:") if d["receipt"]["round_id"] == round_id
                       and d["receipt"]["state"] in {"verified", "pending_settlement"}]
            if not entries:
                raise HTTPException(409, "no independently verified contributions")
            tasks = [store.get(conn, "task:" + d["receipt"]["task_id"])["bundle"] for d in entries]
            task = TrainingTask.model_validate(tasks[0]["task"])
            updates = [(TrainingTask.model_validate(t["task"]), _decode(d["adapter_b"]), d["receipt"]["work_units"])
                       for t, d in zip(tasks, entries, strict=True)]
            try:
                blob = aggregate(task, _decode(tasks[0]["shared_a"]), _decode(tasks[0]["base_b"]), updates)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
            return {"state": "candidate_requires_aggregate_evaluation", "base_b": base64.b64encode(blob).decode(),
                    "adapter_hash": digest(blob), "receipt_ids": [d["receipt"]["receipt_id"] for d in entries]}

    @app.post("/v1/reward-epochs/draft")
    def draft_epoch(payload: EpochRequest, request: Request):
        role(request, {"admin"})
        if len(set(payload.receipt_ids)) != len(payload.receipt_ids):
            raise HTTPException(422, "duplicate receipts")
        with store.lock, store.transaction() as conn:
            global_state = locked(conn)
            if store.get(conn, f"epoch:{payload.epoch}"):
                raise HTTPException(409, "epoch draft already exists and cannot be overwritten")
            entries = [store.get(conn, "receipt:" + rid) for rid in payload.receipt_ids]
            if any(d is None or d["receipt"]["state"] != "verified" or d["epoch"] is not None for d in entries):
                raise HTTPException(409, "only unused, independently verified receipts can enter a draft")
            remaining = REWARD_POOL - int(global_state["allocated"])
            budget = min(weekly_budget(payload.epoch), remaining)
            if budget <= 0:
                raise HTTPException(409, "contribution allocation ceiling reached")
            train_budget = budget * 9 // 10
            validation_budget = budget - train_budget
            total_units = sum(d["receipt"]["work_units"] for d in entries)
            weighted_validators = [(v, d) for d in entries for v in sorted(d["validations"])
                                   if d["validations"][v]["accepted"]]
            validator_units = sum(d["receipt"]["work_units"] for _, d in weighted_validators)
            allocations = []
            for d in entries:
                r = d["receipt"]
                allocations.append(RewardAllocation(recipient=r["wallet"],
                    amount=str(train_budget * r["work_units"] // total_units), category="training",
                    receipt_ids=[r["receipt_id"]]))
            for validator, d in weighted_validators:
                allocations.append(RewardAllocation(recipient=by_id[validator].wallet,
                    amount=str(validation_budget * d["receipt"]["work_units"] // validator_units), category="validation",
                    receipt_ids=[d["receipt"]["receipt_id"]]))
            allocated = sum(int(a.amount) for a in allocations)
            result = RewardEpoch(epoch=payload.epoch, budget_wei=str(budget), allocated_wei=str(allocated),
                                  allocations=allocations)
            result.manifest_hash = canonical_hash(result.model_dump(exclude={"manifest_hash"}))
            store.put(conn, f"epoch:{payload.epoch}", result.model_dump())
            global_state["allocated"] = str(int(global_state["allocated"]) + allocated)
            store.put(conn, "global", global_state)
            for d in entries:
                d["epoch"] = payload.epoch
                d["receipt"]["state"] = "pending_settlement"
                d["receipt"]["detail"] = "Included in an unsigned draft; not claimable or paid on-chain."
                store.put(conn, "receipt:" + d["receipt"]["receipt_id"], d)
            return result

    @app.get("/v1/reward-epochs/{epoch}")
    def get_epoch(epoch: int, request: Request):
        with store.lock, store.transaction() as conn:
            result = store.get(conn, f"epoch:{epoch}")
            if result is None:
                raise HTTPException(404, "unknown reward epoch")
            return result

    return app
