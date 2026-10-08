"""Desired state -> deployment request -> external operation.

Desired state is the source of truth for intent: an immutable, numbered revision per change.
A deployment request asks a DeploymentSystem to converge to one revision (idempotent per
revision+attempt). A newer revision supersedes any in-flight request for the same deployment.
"""
from __future__ import annotations

from typing import Any

from ..adapters.interfaces import DeploymentSystem, DeploySpec
from ..db.store import Store
from . import lookups as L
from .audit import record
from .clock import now as clock_now
from .errors import Conflict
from .rbac import Actor
from .util import MINUTE

OP_TIMEOUT_S = 20 * MINUTE

Row = dict[str, Any]


def create_revision(store: Store, deployment: Row, *, model_version_id: str, engine_version_id: str,
                    image_id: str, replicas: int, source: str, actor: Actor, reason: str | None = None,
                    rollout_id: str | None = None, rollout_target_id: str | None = None) -> Row:
    revs = store.where("desired_state_revisions", deployment_id=deployment["id"])
    rev_no = max((r["rev_no"] for r in revs), default=0) + 1
    rev = store.insert("desired_state_revisions", {
        "id": store.new_id("dsr"),
        "deployment_id": deployment["id"],
        "rev_no": rev_no,
        "model_version_id": model_version_id,
        "engine_version_id": engine_version_id,
        "image_id": image_id,
        "replicas": replicas,
        "source": source,
        "rollout_id": rollout_id,
        "rollout_target_id": rollout_target_id,
        "actor_id": actor.id,
        "reason": reason,
        "created_at": clock_now(store),
    })
    prev = L.current_revision(store, deployment)
    store.update("deployments", deployment["id"], current_revision_id=rev["id"])
    record(store, actor, f"desired_state.{source}", "deployment", deployment["id"],
           f"Desired state rev {rev_no} ({source}): {L.model_label(store, model_version_id)} on "
           f"{L.engine_label(store, engine_version_id)}",
           before=_spec(prev), after=_spec(rev), reason=reason, correlation_id=rollout_id)
    return rev


def _spec(rev: Row | None) -> dict[str, Any] | None:
    if rev is None:
        return None
    return {k: rev[k] for k in ("rev_no", "model_version_id", "engine_version_id", "image_id", "replicas")}


def in_flight_requests(store: Store, deployment_id: str) -> list[Row]:
    return [r for r in store.where("deployment_requests", deployment_id=deployment_id)
            if r["status"] in ("queued", "submitted")]


async def request_apply(store: Store, deployer: DeploymentSystem, deployment: Row, revision: Row, *,
                        actor: Actor, rollout_target_id: str | None = None) -> Row:
    now = clock_now(store)
    # Supersede anything still in flight for this deployment.
    for old in in_flight_requests(store, deployment["id"]):
        store.update("deployment_requests", old["id"], status="superseded", completed_at=now)
        op = L.request_operation(store, old["id"])
        if op and op["status"] in ("pending", "running"):
            await deployer.cancel(op["external_ref"])
            store.update("external_operations", op["id"], status="cancelled", finished_at=now,
                         result_message="Superseded by a newer desired revision")
    attempt = 1 + len(store.where("deployment_requests", deployment_id=deployment["id"], revision_id=revision["id"]))
    req = store.insert("deployment_requests", {
        "id": store.new_id("dreq"),
        "deployment_id": deployment["id"],
        "revision_id": revision["id"],
        "idempotency_key": f"{deployment['id']}:rev{revision['rev_no']}:a{attempt}",
        "attempt": attempt,
        "status": "queued",
        "superseded_by_id": None,
        "rollout_target_id": rollout_target_id,
        "requested_by": actor.id,
        "requested_at": now,
        "submitted_at": None,
        "completed_at": None,
    })
    for old in store.where("deployment_requests", deployment_id=deployment["id"], status="superseded"):
        if old["superseded_by_id"] is None:
            store.update("deployment_requests", old["id"], superseded_by_id=req["id"])
    target = store.must("deployment_targets", deployment["target_id"])
    spec = DeploySpec(
        deployment_id=deployment["id"],
        target_id=target["id"],
        service_name=deployment["service_name"],
        model_raw=L.model_raw(store, revision["model_version_id"]),
        engine_raw=L.engine_raw(store, revision["engine_version_id"]),
        image_digest=store.must("engine_images", revision["image_id"])["digest"],
        replicas=revision["replicas"],
    )
    ref = await deployer.submit(spec)
    store.insert("external_operations", {
        "id": store.new_id("op"),
        "request_id": req["id"],
        "adapter": deployer.name,
        "external_ref": ref,
        "status": "running",
        "result_message": None,
        "started_at": now,
        "finished_at": None,
        "timeout_at": now + OP_TIMEOUT_S,
        "last_polled_at": now,
    })
    store.update("deployment_requests", req["id"], status="submitted", submitted_at=now)
    return req


async def poll_operations(store: Store, deployer: DeploymentSystem) -> None:
    """Record what the deployer *claims*. Convergence is decided later from inventory."""
    now = clock_now(store)
    for op in store.where("external_operations", lambda o: o["status"] in ("pending", "running")):
        st = await deployer.poll(op["external_ref"])
        req = store.must("deployment_requests", op["request_id"])
        if st.status == "succeeded":
            store.update("external_operations", op["id"], status="reported_succeeded",
                         finished_at=st.finished_at or now, result_message=st.message, last_polled_at=now)
            store.update("deployment_requests", req["id"], status="completed", completed_at=now)
        elif st.status == "failed":
            store.update("external_operations", op["id"], status="reported_failed",
                         finished_at=st.finished_at or now, result_message=st.message, last_polled_at=now)
            store.update("deployment_requests", req["id"], status="failed", completed_at=now)
        elif now >= op["timeout_at"]:
            store.update("external_operations", op["id"], status="timed_out", last_polled_at=now,
                         result_message="Deployer returned no result before the timeout")
            store.update("deployment_requests", req["id"], status="completed", completed_at=now)
        else:
            store.update("external_operations", op["id"], last_polled_at=now)


# ------------------------------------------------------------------ locks
def lock_owner(store: Store, deployment_id: str) -> Row | None:
    lock = store.get("deployment_locks", deployment_id)
    return store.get("rollouts", lock["rollout_id"]) if lock else None


def ensure_unlocked(store: Store, deployment_id: str, action: str) -> None:
    owner = lock_owner(store, deployment_id)
    if owner is not None:
        raise Conflict(
            f"Cannot {action}: deployment is locked by active rollout '{owner['title']}'. "
            "Pause that rollout and skip/roll back this target, or cancel the rollout.",
            code="locked", details={"rollout_id": owner["id"]},
        )


def acquire_lock(store: Store, deployment_id: str, rollout_id: str) -> None:
    lock = store.get("deployment_locks", deployment_id)
    if lock and lock["rollout_id"] != rollout_id:
        ensure_unlocked(store, deployment_id, "lock")
    if lock is None:
        store.insert("deployment_locks", {"id": deployment_id, "deployment_id": deployment_id,
                                          "rollout_id": rollout_id, "acquired_at": clock_now(store)})


def release_lock(store: Store, deployment_id: str, rollout_id: str) -> None:
    lock = store.get("deployment_locks", deployment_id)
    if lock and lock["rollout_id"] == rollout_id:
        store.delete("deployment_locks", deployment_id)
