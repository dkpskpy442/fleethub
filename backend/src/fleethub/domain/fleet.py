"""Fleet: inventory ingestion, convergence reconciliation, and deployment-level actions."""
from __future__ import annotations

from typing import Any

from ..adapters.interfaces import DeploymentSystem, InventorySource, SourceUnavailable
from ..db.store import Store
from . import guardrails
from . import lookups as L
from .audit import record
from .clock import now as clock_now
from .desired_state import create_revision, ensure_unlocked, request_apply
from .errors import Conflict, DomainError, GuardrailBlocked
from .rbac import SYSTEM, Actor, require
from .reconciler import Convergence, evaluate
from .util import jdump

Row = dict[str, Any]

OBS_FIELDS = ("present", "model_raw", "engine_raw", "image_digest_raw", "replicas_ready", "replicas_total", "health")
ATTENTION_STATES = {"drifted", "missing", "not_observed_after_success", "apply_failed", "unmanaged"}


# ------------------------------------------------------------------ inventory ingestion
async def sync_inventory_source(store: Store, inventory: InventorySource, source: Row) -> bool:
    now = clock_now(store)
    targets = store.where("deployment_targets", inventory_source_id=source["id"])
    collected: dict[str, list] = {}
    try:
        for t in targets:
            collected[t["id"]] = await inventory.collect(source, t)
    except SourceUnavailable as e:
        store.update("data_sources", source["id"], last_sync_status="error", last_error=str(e))
        return False
    for t in targets:
        _ingest_target(store, t, collected[t["id"]], source, now)
    store.update("data_sources", source["id"], last_sync_at=now, last_sync_status="ok", last_error=None)
    return True


def _ingest_target(store: Store, target: Row, workloads: list, source: Row, now: int) -> None:
    seen: set[str] = set()
    for w in workloads:
        dep = store.first("deployments", target_id=target["id"], service_name=w.service_name)
        mv_id = L.resolve_model_raw(store, w.model_raw)
        if dep is None:
            mv = store.get("model_versions", mv_id)
            dep = store.insert("deployments", {
                "id": store.new_id("dep"),
                "target_id": target["id"],
                "service_name": w.service_name,
                "model_family_id": mv["family_id"] if mv else None,
                "managed": 0,
                "current_revision_id": None,
                "latest_observation_id": None,
                "created_at": now,
                "adopted_at": None,
            })
            record(store, SYSTEM, "deployment.discovered", "deployment", dep["id"],
                   f"Inventory discovered unmanaged workload '{w.service_name}' on {target['name']}",
                   after={"model_raw": w.model_raw, "engine_raw": w.engine_raw, "image": w.image_digest})
        seen.add(dep["id"])
        img = L.image_by_digest(store, w.image_digest)
        _write_obs(store, dep, source, now, {
            "present": 1,
            "model_raw": w.model_raw,
            "model_version_id": mv_id,
            "engine_raw": w.engine_raw,
            "engine_version_id": L.resolve_engine_raw(store, w.engine_raw),
            "image_digest_raw": w.image_digest,
            "image_id": img["id"] if img else None,
            "replicas_ready": w.replicas_ready,
            "replicas_total": w.replicas_total,
            "health": w.health,
        })
    for dep in store.where("deployments", target_id=target["id"]):
        if dep["id"] not in seen and dep["managed"]:
            _write_obs(store, dep, source, now, {
                "present": 0, "model_raw": None, "model_version_id": None, "engine_raw": None,
                "engine_version_id": None, "image_digest_raw": None, "image_id": None,
                "replicas_ready": 0, "replicas_total": 0, "health": "unknown",
            })


def _write_obs(store: Store, dep: Row, source: Row, now: int, vals: Row) -> None:
    """Observations are de-duplicated: only a change in what the inventory reports creates a row."""
    prev = L.latest_obs(store, dep)
    if prev is not None and all(prev.get(f) == vals.get(f) for f in OBS_FIELDS):
        return
    obs = store.insert("deployment_observations", {
        "id": store.new_id("obs"), "deployment_id": dep["id"], "source_id": source["id"], "observed_at": now, **vals,
    })
    store.update("deployments", dep["id"], latest_observation_id=obs["id"])


# ------------------------------------------------------------------ convergence
def evaluate_deployment(store: Store, dep: Row, now: int | None = None) -> Convergence:
    now = clock_now(store) if now is None else now
    rev = L.current_revision(store, dep)
    req = L.latest_request(store, dep["id"], rev["id"] if rev else None)
    return evaluate(
        deployment=dep,
        revision=rev,
        request=req,
        operation=L.request_operation(store, req["id"]) if req else None,
        obs=L.latest_obs(store, dep),
        source=L.target_ctx(store, dep["target_id"])["source"],
        prev=store.get("deployment_convergence", dep["id"]),
        now=now,
    )


def reconcile_all(store: Store) -> None:
    """Persist convergence transitions (for drift tracking, history and audit)."""
    now = clock_now(store)
    for dep in store.rows("deployments"):
        c = evaluate_deployment(store, dep, now)
        prev = store.get("deployment_convergence", dep["id"])
        rev = L.current_revision(store, dep)
        diff_json = jdump(c.diff) if c.diff else None
        if prev is None:
            store.insert("deployment_convergence", {
                "id": dep["id"], "deployment_id": dep["id"], "state": c.state, "diff_json": diff_json,
                "detail": c.detail, "since": now, "evaluated_at": now,
                "last_converged_at": now if c.state == "converged" else None,
                "last_converged_revision_id": rev["id"] if (c.state == "converged" and rev) else None,
            })
            continue
        entered_converged = c.state == "converged" and (
            prev["state"] != "converged" or prev["last_converged_revision_id"] != (rev or {}).get("id"))
        if prev["state"] == c.state and prev["diff_json"] == diff_json and not entered_converged:
            continue
        changes: Row = {"state": c.state, "diff_json": diff_json, "detail": c.detail, "evaluated_at": now}
        if prev["state"] != c.state:
            changes["since"] = now
        if entered_converged:
            changes["last_converged_at"] = now
            changes["last_converged_revision_id"] = rev["id"]
        store.update("deployment_convergence", dep["id"], **changes)
        if prev["state"] != c.state and c.state in ATTENTION_STATES:
            record(store, SYSTEM, f"convergence.{c.state}", "deployment", dep["id"],
                   f"{dep['service_name']} on {L.target_ctx(store, dep['target_id'])['target']['name']}: "
                   f"{prev['state']} -> {c.state}. {c.detail}", before={"state": prev["state"]},
                   after={"state": c.state, "diff": c.diff})


# ------------------------------------------------------------------ deployment actions
def _observed_spec(store: Store, dep: Row) -> Row:
    obs = L.latest_obs(store, dep)
    if obs is None or not obs["present"]:
        raise Conflict("Inventory has no current observation of this workload.")
    if not (obs["model_version_id"] and obs["engine_version_id"] and obs["image_id"]):
        raise Conflict("Observed model/engine/image is not recognized by the catalog; register it first.",
                       code="unrecognized_observation")
    return obs


def adopt(store: Store, actor: Actor, dep: Row, reason: str) -> Row:
    require(actor, "deployment.adopt")
    if dep["managed"]:
        raise Conflict("Deployment is already managed.")
    if not reason.strip():
        raise DomainError("A reason is required to adopt a deployment.")
    obs = _observed_spec(store, dep)
    mv = store.must("model_versions", obs["model_version_id"])
    store.update("deployments", dep["id"], managed=1, model_family_id=mv["family_id"], adopted_at=clock_now(store))
    rev = create_revision(store, dep, model_version_id=obs["model_version_id"], engine_version_id=obs["engine_version_id"],
                          image_id=obs["image_id"], replicas=obs["replicas_total"] or 1, source="adopt",
                          actor=actor, reason=reason)
    record(store, actor, "deployment.adopt", "deployment", dep["id"],
           f"Adopted {dep['service_name']} into FleetHub management (observed state became desired rev {rev['rev_no']})",
           reason=reason)
    return rev


async def reconcile(store: Store, deployer: DeploymentSystem, actor: Actor, dep: Row, reason: str) -> Row:
    require(actor, "deployment.reconcile")
    if not dep["managed"]:
        raise Conflict("Unmanaged deployments must be adopted first.")
    ensure_unlocked(store, dep["id"], "reconcile")
    rev = L.current_revision(store, dep)
    if rev is None:
        raise Conflict("No desired state to reconcile to.")
    req = await request_apply(store, deployer, dep, rev, actor=actor)
    record(store, actor, "deployment.reconcile", "deployment", dep["id"],
           f"Re-requested desired rev {rev['rev_no']} to correct drift", reason=reason)
    return req


def accept_observed(store: Store, actor: Actor, dep: Row, justification: str) -> Row:
    require(actor, "deployment.accept_drift")
    if not dep["managed"]:
        raise Conflict("Unmanaged deployments must be adopted first.")
    ensure_unlocked(store, dep["id"], "accept the observed state")
    if not justification.strip():
        raise DomainError("A justification is required to accept drift.")
    obs = _observed_spec(store, dep)
    res = guardrails.evaluate(store, dep, obs["model_version_id"], obs["engine_version_id"], check_lock=False,
                              image_id=obs["image_id"])
    if res.blocked:
        raise GuardrailBlocked("The observed combination violates guardrails and cannot become desired state.",
                               details=res.to_json())
    rev = create_revision(store, dep, model_version_id=obs["model_version_id"], engine_version_id=obs["engine_version_id"],
                          image_id=obs["image_id"], replicas=obs["replicas_total"] or 1, source="accept_drift",
                          actor=actor, reason=justification)
    record(store, actor, "deployment.accept_drift", "deployment", dep["id"],
           f"Accepted observed state as desired rev {rev['rev_no']} (warnings: {', '.join(res.warnings) or 'none'})",
           reason=justification)
    return rev
