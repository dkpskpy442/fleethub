"""Staged rollouts.

Rollout status:  draft -> ready -> in_progress <-> paused -> completed
                                     \\-> rolling_back -> rolled_back          (draft/ready/paused -> cancelled)
Approval status (separate axis): not_required | pending | approved | rejected
Wave status:     pending -> awaiting_approval -> in_progress -> succeeded | failed (-> rolling_back -> rolled_back)
Target status:   pending -> applying -> verifying -> succeeded | failed ; pending -> skipped ;
                 * -> rolling_back -> rolled_back

A target only succeeds on inventory evidence (see reconciler): the operation finished, a fresh
post-operation observation matches the desired model+engine+image digest, replicas are ready, and
health stays healthy for the whole bake window. Any failure auto-pauses the rollout.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any

from ..adapters.interfaces import DeploymentSystem
from ..db.store import Store
from . import guardrails
from . import lookups as L
from .audit import record, rollout_event
from .clock import now as clock_now
from .desired_state import acquire_lock, create_revision, release_lock, request_apply
from .enums import ROLLOUT_ACTIVE, TARGET_IN_FLIGHT, TARGET_TERMINAL
from .errors import Conflict, DomainError, Forbidden, GuardrailBlocked
from .fleet import evaluate_deployment
from .rbac import SYSTEM, Actor, require
from .reconciler import VERIFY_WINDOW_S, deployment_freshness, effective_health
from .util import jdump, jload

Row = dict[str, Any]

DEFAULT_BAKE = {"nonprod": 10, "canary": 30, "prod": 15}


# ------------------------------------------------------------------ planning
def preview(store: Store, kind: str, mv_id: str | None, ev_id: str | None, deployment_ids: list[str],
            rollout_id: str | None = None) -> list[guardrails.GuardrailResult]:
    _validate_change(store, kind, mv_id, ev_id)
    out = []
    for did in deployment_ids:
        dep = store.must("deployments", did)
        mv, ev = guardrails.spec_for_change(store, dep, kind, mv_id, ev_id)
        out.append(guardrails.evaluate(store, dep, mv, ev, rollout_id=rollout_id))
    return out


def candidate_deployments(store: Store, kind: str, mv_id: str | None, ev_id: str | None) -> list[Row]:
    """Deployments a change could apply to (same model family for model changes; same engine for engine changes)."""
    out = []
    for dep in store.rows("deployments"):
        rev = L.current_revision(store, dep)
        obs = L.latest_obs(store, dep)
        cur_ev = (rev or {}).get("engine_version_id") or (obs or {}).get("engine_version_id")
        if kind in ("model", "model_and_engine"):
            mv = store.must("model_versions", mv_id)
            if dep["model_family_id"] != mv["family_id"]:
                continue
        if kind == "engine":
            ev = store.must("engine_versions", ev_id)
            cur = store.get("engine_versions", cur_ev)
            if cur is None or cur["engine_id"] != ev["engine_id"]:
                continue
        out.append(dep)
    return out


def generate_waves(store: Store, deployment_ids: list[str]) -> list[Row]:
    """Default staging: non-prod -> one prod canary -> remaining prod grouped by region."""
    nonprod, prod = [], []
    for did in deployment_ids:
        dep = store.must("deployments", did)
        ctx = L.target_ctx(store, dep["target_id"])
        (prod if ctx["environment"]["tier"] == "prod" else nonprod).append((dep, ctx))
    waves: list[Row] = []
    if nonprod:
        waves.append({"name": "Non-prod", "bake_minutes": DEFAULT_BAKE["nonprod"],
                      "deployment_ids": [d["id"] for d, _ in nonprod]})
    if prod:
        prod.sort(key=lambda p: (p[1]["region"]["sort"], -(_replicas(store, p[0])), p[1]["target"]["name"]))
        # Canary: the smallest prod deployment in the first region.
        first_region = prod[0][1]["region"]["id"]
        in_first = [p for p in prod if p[1]["region"]["id"] == first_region]
        canary = min(in_first, key=lambda p: _replicas(store, p[0]))
        waves.append({"name": f"Prod canary ({canary[1]['target']['name']})", "bake_minutes": DEFAULT_BAKE["canary"],
                      "deployment_ids": [canary[0]["id"]]})
        by_region: dict[str, list] = defaultdict(list)
        order: list[str] = []
        for dep, ctx in prod:
            if dep["id"] == canary[0]["id"]:
                continue
            rid = ctx["region"]["id"]
            if rid not in by_region:
                order.append(rid)
            by_region[rid].append(dep["id"])
        for rid in order:
            waves.append({"name": f"Prod {store.must('regions', rid)['name']}", "bake_minutes": DEFAULT_BAKE["prod"],
                          "deployment_ids": by_region[rid]})
    return waves


def _replicas(store: Store, dep: Row) -> int:
    rev = L.current_revision(store, dep)
    return rev["replicas"] if rev else 0


def _validate_change(store: Store, kind: str, mv_id: str | None, ev_id: str | None) -> None:
    if kind not in ("model", "engine", "model_and_engine"):
        raise DomainError(f"Unknown rollout kind {kind}")
    if kind in ("model", "model_and_engine"):
        store.must("model_versions", mv_id)
    if kind in ("engine", "model_and_engine"):
        store.must("engine_versions", ev_id)


def create_draft(store: Store, actor: Actor, *, title: str, kind: str, target_model_version_id: str | None,
                 target_engine_version_id: str | None, reason: str, waves: list[Row],
                 justifications: dict[str, str], linked_vulnerability_id: str | None = None) -> Row:
    require(actor, "rollout.create")
    _validate_change(store, kind, target_model_version_id, target_engine_version_id)
    if not title.strip():
        raise DomainError("Title is required.")
    all_ids = [d for w in waves for d in w["deployment_ids"]]
    if not all_ids:
        raise DomainError("Select at least one target deployment.")
    if len(set(all_ids)) != len(all_ids):
        raise DomainError("A deployment can only appear in one wave.")
    now = clock_now(store)
    rollout = store.insert("rollouts", {
        "id": store.new_id("ro"), "title": title.strip(), "kind": kind,
        "target_model_version_id": target_model_version_id if kind != "engine" else None,
        "target_engine_version_id": target_engine_version_id if kind != "model" else None,
        "linked_vulnerability_id": linked_vulnerability_id, "reason": reason, "status": "draft",
        "approval_status": "not_required", "pause_reason": None, "requested_by": actor.id,
        "created_at": now, "submitted_at": None, "started_at": None, "finished_at": None, "updated_at": now,
    })
    results = {r.deployment_id: r for r in preview(store, kind, target_model_version_id, target_engine_version_id,
                                                    all_ids, rollout["id"])}
    problems = []
    for idx, w in enumerate(waves):
        if not w["deployment_ids"]:
            continue
        is_prod = any(L.is_prod(store, store.must("deployments", d)) for d in w["deployment_ids"])
        wave = store.insert("rollout_waves", {
            "id": store.new_id("wave"), "rollout_id": rollout["id"], "idx": idx, "name": w["name"],
            "bake_minutes": int(w.get("bake_minutes") or DEFAULT_BAKE["prod"]), "is_prod": int(is_prod),
            "status": "pending", "started_at": None, "finished_at": None,
        })
        for did in w["deployment_ids"]:
            res = results[did]
            if res.blocked:
                problems.append({"deployment_id": did, "issue": "blocked", "checks": res.to_json()["checks"]})
                continue
            just = (justifications.get(did) or "").strip()
            if res.warnings and not just:
                problems.append({"deployment_id": did, "issue": "justification_required", "warnings": res.warnings})
                continue
            store.insert("rollout_targets", {
                "id": store.new_id("rt"), "rollout_id": rollout["id"], "wave_id": wave["id"], "deployment_id": did,
                "new_model_version_id": res.model_version_id, "new_engine_version_id": res.engine_version_id,
                "new_image_id": res.image_id, "prev_revision_id": None, "new_revision_id": None, "request_id": None,
                "rollback_revision_id": None, "rollback_request_id": None, "guardrail_json": jdump(res.to_json()),
                "acknowledged_json": jdump(res.warnings), "justification": just or None,
                "status": "skipped" if res.noop else "pending", "failure_reason": "no_change" if res.noop else None,
                "manually_verified": 0, "verify_deadline": None, "bake_until": None, "started_at": None,
                "finished_at": None,
            })
    if problems:
        raise GuardrailBlocked("Some targets cannot be included as planned.", details=problems)
    record(store, actor, "rollout.create", "rollout", rollout["id"], f"Drafted rollout '{rollout['title']}'",
           after={"kind": kind, "targets": len(all_ids), "waves": len(waves)}, reason=reason,
           correlation_id=rollout["id"])
    for did, j in justifications.items():
        if j and results.get(did) and results[did].warnings:
            record(store, actor, "rollout.acknowledge_warnings", "rollout", rollout["id"],
                   f"Acknowledged {', '.join(results[did].warnings)} for {_dep_label(store, did)}", reason=j,
                   correlation_id=rollout["id"])
    rollout_event(store, rollout["id"], "created", "Rollout drafted", actor=actor)
    return rollout


def _dep_label(store: Store, did: str) -> str:
    d = store.must("deployments", did)
    return f"{d['service_name']}@{store.must('deployment_targets', d['target_id'])['name']}"


def waves_of(store: Store, rollout_id: str) -> list[Row]:
    return sorted(store.where("rollout_waves", rollout_id=rollout_id), key=lambda w: w["idx"])


def targets_of(store: Store, rollout_id: str, wave_id: str | None = None) -> list[Row]:
    if wave_id:
        return store.where("rollout_targets", rollout_id=rollout_id, wave_id=wave_id)
    return store.where("rollout_targets", rollout_id=rollout_id)


def _touch(store: Store, rollout: Row, **changes: Any) -> None:
    store.update("rollouts", rollout["id"], updated_at=clock_now(store), **changes)


# ------------------------------------------------------------------ lifecycle actions
def submit(store: Store, actor: Actor, rollout: Row) -> Row:
    require(actor, "rollout.submit")
    if rollout["status"] != "draft":
        raise Conflict(f"Only drafts can be submitted (status is {rollout['status']}).")
    active = [t for t in targets_of(store, rollout["id"]) if t["status"] == "pending"]
    if not active:
        raise DomainError("Rollout has no targets that need changes.")
    for t in active:
        dep = store.must("deployments", t["deployment_id"])
        res = guardrails.evaluate(store, dep, t["new_model_version_id"], t["new_engine_version_id"],
                                  rollout_id=rollout["id"])
        if res.blocked:
            raise GuardrailBlocked(f"{_dep_label(store, dep['id'])} is now blocked.", details=res.to_json())
        new_warn = set(res.warnings) - set(jload(t["acknowledged_json"], []))
        if new_warn:
            raise GuardrailBlocked(f"{_dep_label(store, dep['id'])} has new warnings: {', '.join(sorted(new_warn))}",
                                   details=res.to_json())
        store.update("rollout_targets", t["id"], guardrail_json=jdump(res.to_json()))
    for t in active:
        acquire_lock(store, t["deployment_id"], rollout["id"])
    needs_approval = any(w["is_prod"] for w in waves_of(store, rollout["id"]))
    _touch(store, rollout, status="ready", submitted_at=clock_now(store),
           approval_status="pending" if needs_approval else "not_required")
    record(store, actor, "rollout.submit", "rollout", rollout["id"],
           f"Submitted '{rollout['title']}'" + (" (prod approval required)" if needs_approval else ""),
           correlation_id=rollout["id"])
    rollout_event(store, rollout["id"], "submitted",
                  "Submitted; targets locked" + ("; awaiting prod approval" if needs_approval else ""), actor=actor)
    return rollout


def decide(store: Store, actor: Actor, rollout: Row, decision: str, comment: str) -> Row:
    require(actor, "rollout.approve")
    if rollout["requested_by"] == actor.id:
        raise Forbidden("Requesters cannot approve their own rollout.", code="self_approval")
    if rollout["approval_status"] != "pending":
        raise Conflict(f"Rollout is not awaiting approval ({rollout['approval_status']}).")
    if decision not in ("approved", "rejected"):
        raise DomainError("Decision must be approved or rejected.")
    if decision == "rejected" and not comment.strip():
        raise DomainError("A comment is required when rejecting.")
    store.insert("rollout_approvals", {"id": store.new_id("appr"), "rollout_id": rollout["id"], "approver_id": actor.id,
                                       "decision": decision, "comment": comment, "at": clock_now(store)})
    _touch(store, rollout, approval_status=decision)
    record(store, actor, f"rollout.{decision}", "rollout", rollout["id"], f"{decision.title()} '{rollout['title']}'",
           reason=comment, correlation_id=rollout["id"])
    rollout_event(store, rollout["id"], decision, f"Prod waves {decision} by {actor.name}: {comment or '-'}", actor=actor)
    if decision == "rejected":
        if rollout["status"] == "ready":
            _finish(store, rollout, "cancelled", actor, "Approval rejected before start")
        elif rollout["status"] == "in_progress":
            _pause(store, rollout, "Approval rejected: prod waves will not start. Roll back or cancel.", actor)
    return rollout


def start(store: Store, actor: Actor, rollout: Row) -> Row:
    require(actor, "rollout.execute")
    if rollout["status"] != "ready":
        raise Conflict(f"Only ready rollouts can be started (status is {rollout['status']}).")
    _touch(store, rollout, status="in_progress", started_at=clock_now(store))
    record(store, actor, "rollout.start", "rollout", rollout["id"], f"Started '{rollout['title']}'",
           correlation_id=rollout["id"])
    rollout_event(store, rollout["id"], "started", "Rollout started", actor=actor)
    return rollout


def pause(store: Store, actor: Actor, rollout: Row, reason: str) -> Row:
    require(actor, "rollout.execute")
    if rollout["status"] != "in_progress":
        raise Conflict("Only running rollouts can be paused.")
    _pause(store, rollout, f"Paused by {actor.name}: {reason or 'no reason given'}", actor)
    return rollout


def _pause(store: Store, rollout: Row, reason: str, actor: Actor = SYSTEM) -> None:
    if rollout["status"] == "paused" and rollout["pause_reason"] == reason:
        return
    _touch(store, rollout, status="paused", pause_reason=reason)
    record(store, actor, "rollout.pause", "rollout", rollout["id"], f"Paused '{rollout['title']}'", reason=reason,
           correlation_id=rollout["id"])
    rollout_event(store, rollout["id"], "paused", reason, actor=actor)


def resume(store: Store, actor: Actor, rollout: Row) -> Row:
    require(actor, "rollout.execute")
    if rollout["status"] != "paused":
        raise Conflict("Only paused rollouts can be resumed.")
    failed = [t for t in targets_of(store, rollout["id"]) if t["status"] == "failed"]
    if failed:
        raise Conflict(f"{len(failed)} failed target(s) must be retried, rolled back or manually verified first.",
                       code="unresolved_failures")
    unack = [t for t in targets_of(store, rollout["id"]) if t["status"] == "pending" and _unacknowledged(t)]
    if unack:
        raise Conflict(f"{len(unack)} target(s) have new guardrail warnings that need acknowledgement.",
                       code="needs_acknowledgement")
    for w in waves_of(store, rollout["id"]):
        if w["status"] == "failed":
            store.update("rollout_waves", w["id"], status="in_progress")
    _touch(store, rollout, status="in_progress", pause_reason=None)
    record(store, actor, "rollout.resume", "rollout", rollout["id"], f"Resumed '{rollout['title']}'",
           correlation_id=rollout["id"])
    rollout_event(store, rollout["id"], "resumed", f"Resumed by {actor.name}", actor=actor)
    return rollout


def _unacknowledged(t: Row) -> set[str]:
    g = jload(t["guardrail_json"], {})
    warns = {c["code"] for c in g.get("checks", []) if c["level"] == "warn"}
    return warns - set(jload(t["acknowledged_json"], []))


def acknowledge(store: Store, actor: Actor, rollout: Row, target: Row, justification: str) -> Row:
    require(actor, "rollout.execute")
    if not justification.strip():
        raise DomainError("Justification required.")
    g = jload(target["guardrail_json"], {})
    if any(c["level"] == "block" for c in g.get("checks", [])):
        raise GuardrailBlocked("Target is blocked; it can only be skipped.")
    warns = sorted({c["code"] for c in g.get("checks", []) if c["level"] == "warn"})
    store.update("rollout_targets", target["id"], acknowledged_json=jdump(warns),
                 justification=((target["justification"] or "") + f"\n[{actor.name}] {justification}").strip())
    record(store, actor, "rollout.acknowledge_warnings", "rollout", rollout["id"],
           f"Re-acknowledged {', '.join(warns)} for {_dep_label(store, target['deployment_id'])}", reason=justification,
           correlation_id=rollout["id"])
    rollout_event(store, rollout["id"], "acknowledged", f"Warnings acknowledged: {', '.join(warns)}", actor=actor,
                  target_id=target["id"])
    return target


def skip_target(store: Store, actor: Actor, rollout: Row, target: Row, reason: str) -> Row:
    require(actor, "rollout.execute")
    if rollout["status"] not in ("draft", "ready", "in_progress", "paused"):
        raise Conflict(f"Cannot skip targets of a {rollout['status']} rollout.")
    if target["status"] != "pending":
        raise Conflict("Only targets that have not been applied can be skipped; roll back applied targets instead.")
    store.update("rollout_targets", target["id"], status="skipped", failure_reason=f"skipped: {reason}",
                 finished_at=clock_now(store))
    release_lock(store, target["deployment_id"], rollout["id"])
    record(store, actor, "rollout.skip_target", "rollout", rollout["id"],
           f"Skipped {_dep_label(store, target['deployment_id'])}; lock released", reason=reason,
           correlation_id=rollout["id"])
    rollout_event(store, rollout["id"], "target_skipped", f"Skipped: {reason}", actor=actor, target_id=target["id"])
    return target


async def retry_target(store: Store, deployer: DeploymentSystem, actor: Actor, rollout: Row, target: Row) -> Row:
    require(actor, "rollout.execute")
    if target["status"] != "failed":
        raise Conflict("Only failed targets can be retried.")
    dep = store.must("deployments", target["deployment_id"])
    rev = store.must("desired_state_revisions", target["new_revision_id"])
    req = await request_apply(store, deployer, dep, rev, actor=actor, rollout_target_id=target["id"])
    store.update("rollout_targets", target["id"], status="applying", request_id=req["id"], failure_reason=None,
                 verify_deadline=None, bake_until=None, finished_at=None)
    record(store, actor, "rollout.retry_target", "rollout", rollout["id"],
           f"Retried {_dep_label(store, dep['id'])} (attempt {req['attempt']})", correlation_id=rollout["id"])
    rollout_event(store, rollout["id"], "target_retry", f"Retry attempt {req['attempt']}", actor=actor,
                  target_id=target["id"])
    return target


def manual_verify(store: Store, actor: Actor, rollout: Row, target: Row, justification: str) -> Row:
    require(actor, "rollout.manual_verify")
    if target["status"] not in ("failed", "verifying"):
        raise Conflict("Only failed or verifying targets can be manually verified.")
    if not justification.strip():
        raise DomainError("Manual verification requires a justification.")
    store.update("rollout_targets", target["id"], status="succeeded", manually_verified=1,
                 failure_reason=f"manually verified (was: {target['failure_reason'] or target['status']})",
                 finished_at=clock_now(store))
    record(store, actor, "rollout.manual_verify", "rollout", rollout["id"],
           f"MANUALLY verified {_dep_label(store, target['deployment_id'])} without inventory evidence",
           reason=justification, correlation_id=rollout["id"])
    rollout_event(store, rollout["id"], "manually_verified", f"Manually verified: {justification}", actor=actor,
                  target_id=target["id"])
    return target


async def rollback_target(store: Store, deployer: DeploymentSystem, actor: Actor, rollout: Row, target: Row,
                          reason: str) -> Row:
    require(actor, "rollout.execute")
    if target["new_revision_id"] is None or target["status"] in ("rolled_back", "skipped", "pending"):
        raise Conflict("Target has not been applied; nothing to roll back.")
    await _start_target_rollback(store, deployer, actor, rollout, target, reason)
    return target


async def _start_target_rollback(store: Store, deployer: DeploymentSystem, actor: Actor, rollout: Row, target: Row,
                                 reason: str) -> None:
    dep = store.must("deployments", target["deployment_id"])
    prev = store.must("desired_state_revisions", target["prev_revision_id"])
    rev = create_revision(store, dep, model_version_id=prev["model_version_id"],
                          engine_version_id=prev["engine_version_id"], image_id=prev["image_id"],
                          replicas=prev["replicas"], source="rollback", actor=actor,
                          reason=f"Rollback of '{rollout['title']}': {reason}", rollout_id=rollout["id"],
                          rollout_target_id=target["id"])
    req = await request_apply(store, deployer, dep, rev, actor=actor, rollout_target_id=target["id"])
    store.update("rollout_targets", target["id"], status="rolling_back", rollback_revision_id=rev["id"],
                 rollback_request_id=req["id"], verify_deadline=None, bake_until=None)
    record(store, actor, "rollout.rollback_target", "rollout", rollout["id"],
           f"Rolling back {_dep_label(store, dep['id'])} to rev {prev['rev_no']}", reason=reason,
           correlation_id=rollout["id"])
    rollout_event(store, rollout["id"], "target_rollback", f"Rolling back to previous revision: {reason}",
                  actor=actor, target_id=target["id"])


def rollback_all(store: Store, actor: Actor, rollout: Row, reason: str) -> Row:
    require(actor, "rollout.execute")
    if rollout["status"] not in ("in_progress", "paused", "completed"):
        raise Conflict(f"Cannot roll back a rollout in status {rollout['status']}.")
    if not reason.strip():
        raise DomainError("A reason is required to roll back.")
    for t in targets_of(store, rollout["id"]):
        if t["status"] == "pending":
            store.update("rollout_targets", t["id"], status="skipped", failure_reason="rollout rolled back")
            release_lock(store, t["deployment_id"], rollout["id"])
    for t in targets_of(store, rollout["id"]):
        if t["status"] not in ("skipped", "rolled_back"):
            acquire_lock(store, t["deployment_id"], rollout["id"])
    _touch(store, rollout, status="rolling_back", pause_reason=None)
    record(store, actor, "rollout.rollback", "rollout", rollout["id"],
           f"Rolling back '{rollout['title']}' in reverse wave order", reason=reason, correlation_id=rollout["id"])
    rollout_event(store, rollout["id"], "rollback_started", f"Rollback started: {reason}", actor=actor)
    return rollout


def cancel(store: Store, actor: Actor, rollout: Row, reason: str) -> Row:
    require(actor, "rollout.execute" if rollout["status"] != "draft" else "rollout.create")
    if rollout["status"] in ("draft", "ready"):
        pass
    elif rollout["status"] == "paused":
        if any(t["status"] in TARGET_IN_FLIGHT for t in targets_of(store, rollout["id"])):
            raise Conflict("Targets are still in flight; wait for them or roll back.")
        if any(t["status"] == "failed" for t in targets_of(store, rollout["id"])):
            raise Conflict("Resolve failed targets (retry, roll back or manually verify) before cancelling.")
    else:
        raise Conflict(f"Cannot cancel a rollout in status {rollout['status']}.")
    _finish(store, rollout, "cancelled", actor, reason or "cancelled")
    return rollout


def _finish(store: Store, rollout: Row, status: str, actor: Actor, message: str) -> None:
    for t in targets_of(store, rollout["id"]):
        if t["status"] == "pending":
            store.update("rollout_targets", t["id"], status="skipped", failure_reason=f"rollout {status}")
        release_lock(store, t["deployment_id"], rollout["id"])
    _touch(store, rollout, status=status, finished_at=clock_now(store))
    record(store, actor, f"rollout.{status}", "rollout", rollout["id"], f"'{rollout['title']}' {status}: {message}",
           correlation_id=rollout["id"])
    rollout_event(store, rollout["id"], status, message, actor=actor)


# ------------------------------------------------------------------ engine (runs on every tick/action)
async def step_all(store: Store, deployer: DeploymentSystem) -> None:
    for r in sorted(store.rows("rollouts"), key=lambda r: r["created_at"]):
        if r["status"] in ("in_progress", "paused", "rolling_back"):
            await step(store, deployer, r)


async def step(store: Store, deployer: DeploymentSystem, rollout: Row) -> None:
    for t in targets_of(store, rollout["id"]):
        if t["status"] in ("applying", "verifying"):
            _evaluate_target(store, rollout, t)
        elif t["status"] == "rolling_back":
            _evaluate_rollback(store, rollout, t)
    if rollout["status"] == "in_progress":
        await _advance_waves(store, deployer, rollout)
    elif rollout["status"] == "rolling_back":
        await _advance_rollback(store, deployer, rollout)


async def _advance_waves(store: Store, deployer: DeploymentSystem, rollout: Row) -> None:
    for _ in range(20):  # waves can complete and the next start within one step
        waves = [w for w in waves_of(store, rollout["id"]) if w["status"] != "succeeded"]
        if not waves:
            _finish(store, rollout, "completed", SYSTEM, "All waves succeeded")
            return
        wave = waves[0]
        targets = targets_of(store, rollout["id"], wave["id"])
        if wave["status"] in ("pending", "awaiting_approval"):
            if wave["is_prod"] and rollout["approval_status"] != "approved":
                if wave["status"] != "awaiting_approval":
                    store.update("rollout_waves", wave["id"], status="awaiting_approval")
                    rollout_event(store, rollout["id"], "awaiting_approval",
                                  f"Wave '{wave['name']}' touches prod and is waiting for approval")
                return
            if not _recheck_wave(store, rollout, wave, targets):
                return
            now = clock_now(store)
            store.update("rollout_waves", wave["id"], status="in_progress", started_at=now)
            rollout_event(store, rollout["id"], "wave_started", f"Wave '{wave['name']}' started")
            for t in targets:
                if t["status"] == "pending":
                    await _apply_target(store, deployer, rollout, t)
            for t in targets:
                if t["status"] in ("applying", "verifying"):
                    _evaluate_target(store, rollout, t)
            targets = targets_of(store, rollout["id"], wave["id"])
        if wave["status"] == "in_progress" or wave["status"] == "failed":
            if any(t["status"] == "failed" for t in targets):
                if wave["status"] != "failed":
                    store.update("rollout_waves", wave["id"], status="failed")
                    rollout_event(store, rollout["id"], "wave_failed", f"Wave '{wave['name']}' failed a gate")
                bad = [t for t in targets if t["status"] == "failed"]
                _pause(store, rollout, f"Gate failed in wave '{wave['name']}': " + "; ".join(
                    f"{_dep_label(store, t['deployment_id'])} ({t['failure_reason']})" for t in bad))
                return
            if all(t["status"] in TARGET_TERMINAL for t in targets):
                store.update("rollout_waves", wave["id"], status="succeeded", finished_at=clock_now(store))
                rollout_event(store, rollout["id"], "wave_succeeded", f"Wave '{wave['name']}' succeeded")
                continue
            return


def _recheck_wave(store: Store, rollout: Row, wave: Row, targets: list[Row]) -> bool:
    """Guardrails are re-evaluated right before a wave applies (catalog may have changed)."""
    ok = True
    for t in targets:
        if t["status"] != "pending":
            continue
        dep = store.must("deployments", t["deployment_id"])
        res = guardrails.evaluate(store, dep, t["new_model_version_id"], t["new_engine_version_id"],
                                  rollout_id=rollout["id"])
        store.update("rollout_targets", t["id"], guardrail_json=jdump(res.to_json()))
        if res.image_id and res.image_id != t["new_image_id"]:
            store.update("rollout_targets", t["id"], new_image_id=res.image_id)
        if res.blocked:
            codes = ", ".join(c.code for c in res.checks if c.level == "block")
            _pause(store, rollout, f"Guardrail now blocks {_dep_label(store, dep['id'])} ({codes}); skip it or cancel.")
            ok = False
        elif set(res.warnings) - set(jload(t["acknowledged_json"], [])):
            new = ", ".join(sorted(set(res.warnings) - set(jload(t["acknowledged_json"], []))))
            _pause(store, rollout, f"New warning(s) for {_dep_label(store, dep['id'])}: {new}. Re-acknowledge to continue.")
            ok = False
    return ok


async def _apply_target(store: Store, deployer: DeploymentSystem, rollout: Row, t: Row) -> None:
    dep = store.must("deployments", t["deployment_id"])
    prev = L.current_revision(store, dep)
    rev = create_revision(store, dep, model_version_id=t["new_model_version_id"],
                          engine_version_id=t["new_engine_version_id"], image_id=t["new_image_id"],
                          replicas=prev["replicas"] if prev else 1, source="rollout",
                          actor=store_actor(store, rollout), reason=f"Rollout '{rollout['title']}'",
                          rollout_id=rollout["id"], rollout_target_id=t["id"])
    req = await request_apply(store, deployer, dep, rev, actor=store_actor(store, rollout), rollout_target_id=t["id"])
    store.update("rollout_targets", t["id"], status="applying", prev_revision_id=prev["id"] if prev else None,
                 new_revision_id=rev["id"], request_id=req["id"], started_at=clock_now(store))
    rollout_event(store, rollout["id"], "target_applying",
                  f"{_dep_label(store, dep['id'])}: desired rev {rev['rev_no']} requested", target_id=t["id"])


def store_actor(store: Store, rollout: Row) -> Actor:
    u = store.get("users", rollout["requested_by"])
    return Actor(u["id"], u["name"], u["role"], u["team_id"]) if u else SYSTEM


def _fail(store: Store, rollout: Row, t: Row, reason: str) -> None:
    store.update("rollout_targets", t["id"], status="failed", failure_reason=reason, finished_at=clock_now(store))
    rollout_event(store, rollout["id"], "target_failed", f"{_dep_label(store, t['deployment_id'])}: {reason}",
                  target_id=t["id"])


def _evaluate_target(store: Store, rollout: Row, t: Row) -> None:
    now = clock_now(store)
    dep = store.must("deployments", t["deployment_id"])
    if dep["current_revision_id"] != t["new_revision_id"]:
        return  # superseded (e.g. rollback in progress)
    req = store.get("deployment_requests", t["request_id"])
    op = L.request_operation(store, t["request_id"])
    if t["status"] == "applying":
        if req is None or op is None or op["status"] in ("pending", "running"):
            return
        if op["status"] in ("reported_failed", "cancelled"):
            _fail(store, rollout, t, f"apply_failed: {op['result_message'] or 'deployer reported failure'}")
            return
        done_at = op["finished_at"] or op["timeout_at"]
        store.update("rollout_targets", t["id"], status="verifying", verify_deadline=done_at + VERIFY_WINDOW_S)
        note = " (deployer gave no result)" if op["status"] == "timed_out" else ""
        rollout_event(store, rollout["id"], "target_verifying",
                      f"{_dep_label(store, dep['id'])}: deployer finished{note}; verifying against inventory",
                      target_id=t["id"])
    conv = evaluate_deployment(store, dep, now)
    ctx = L.target_ctx(store, dep["target_id"])
    obs = L.latest_obs(store, dep)
    health = effective_health(obs, deployment_freshness(obs, ctx["source"], now))
    rev = store.must("desired_state_revisions", t["new_revision_id"])
    wave = store.must("rollout_waves", t["wave_id"])
    if conv.state == "converged":
        ready = bool(obs) and (obs["replicas_ready"] or 0) >= rev["replicas"]
        if health == "unhealthy":
            _fail(store, rollout, t, "health_gate: new version reports unhealthy")
        elif t["bake_until"] is None:
            if health == "healthy" and ready:
                store.update("rollout_targets", t["id"], bake_until=now + wave["bake_minutes"] * 60)
                rollout_event(store, rollout["id"], "target_baking",
                              f"{_dep_label(store, dep['id'])}: converged and healthy; baking {wave['bake_minutes']}m",
                              target_id=t["id"])
            elif now >= t["verify_deadline"]:
                _fail(store, rollout, t, f"health_gate: {health}, {obs['replicas_ready'] if obs else 0}/{rev['replicas']} ready")
        elif health != "healthy" or not ready:
            _fail(store, rollout, t, f"health_gate: became {health} during bake")
        elif now >= t["bake_until"] and (ctx["source"]["last_sync_at"] or 0) >= t["bake_until"]:
            store.update("rollout_targets", t["id"], status="succeeded", finished_at=now)
            rollout_event(store, rollout["id"], "target_succeeded",
                          f"{_dep_label(store, dep['id'])}: verified by inventory and healthy through bake",
                          target_id=t["id"])
        return
    if t["bake_until"] is not None and conv.state in ("drifted", "missing"):
        _fail(store, rollout, t, f"{conv.state}_during_bake: {conv.detail}")
    elif conv.state == "apply_failed":
        _fail(store, rollout, t, f"apply_failed: {conv.detail}")
    elif t["verify_deadline"] and now >= t["verify_deadline"]:
        if conv.state == "unverifiable":
            _fail(store, rollout, t, "unverifiable_stale_inventory: no fresh inventory evidence before deadline")
        elif conv.state == "missing":
            _fail(store, rollout, t, "missing: inventory does not report the workload")
        else:
            _fail(store, rollout, t, "claimed_success_not_observed: deployer reported success but inventory "
                                     "still shows a different version")


def _evaluate_rollback(store: Store, rollout: Row, t: Row) -> None:
    now = clock_now(store)
    dep = store.must("deployments", t["deployment_id"])
    if dep["current_revision_id"] != t["rollback_revision_id"]:
        return
    conv = evaluate_deployment(store, dep, now)
    if conv.state == "converged":
        store.update("rollout_targets", t["id"], status="rolled_back", finished_at=now, failure_reason=None)
        release_lock(store, dep["id"], rollout["id"])
        rollout_event(store, rollout["id"], "target_rolled_back",
                      f"{_dep_label(store, dep['id'])}: inventory confirms previous version", target_id=t["id"])
    elif conv.state in ("apply_failed", "not_observed_after_success", "missing") and t["failure_reason"] != f"rollback_{conv.state}":
        store.update("rollout_targets", t["id"], failure_reason=f"rollback_{conv.state}")
        rollout_event(store, rollout["id"], "rollback_stuck",
                      f"{_dep_label(store, dep['id'])}: rollback not confirmed ({conv.state}); retry rollback",
                      target_id=t["id"])


async def _advance_rollback(store: Store, deployer: DeploymentSystem, rollout: Row) -> None:
    waves = list(reversed(waves_of(store, rollout["id"])))
    for wave in waves:
        targets = targets_of(store, rollout["id"], wave["id"])
        todo = [t for t in targets if t["status"] in ("applying", "verifying", "succeeded", "failed")]
        busy = [t for t in targets if t["status"] == "rolling_back"]
        if todo:
            if wave["status"] != "rolling_back":
                store.update("rollout_waves", wave["id"], status="rolling_back")
                rollout_event(store, rollout["id"], "wave_rolling_back", f"Rolling back wave '{wave['name']}'")
            for t in todo:
                await _start_target_rollback(store, deployer, SYSTEM, rollout, t, "rollout rollback")
            return
        if busy:
            return
        if wave["status"] not in ("pending", "rolled_back") and any(t["status"] == "rolled_back" for t in targets):
            store.update("rollout_waves", wave["id"], status="rolled_back", finished_at=clock_now(store))
    _finish(store, rollout, "rolled_back", SYSTEM, "All applied targets restored to their previous revisions")


def active_rollouts_for(store: Store, deployment_id: str) -> list[Row]:
    ids = {t["rollout_id"] for t in store.where("rollout_targets", deployment_id=deployment_id)}
    return [r for r in (store.must("rollouts", i) for i in ids) if r["status"] in ROLLOUT_ACTIVE]
