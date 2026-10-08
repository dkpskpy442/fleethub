"""Convergence evaluation: compares desired intent with observed reality.

Pure functions only. Inputs are plain rows; the caller (``fleet.reconcile_all``) persists results.

Rules (see docs/architecture.md):
  * Desired state (latest revision) is the source of truth for intent.
  * Inventory is the source of truth for reality. A deployer "success" is only a claim.
  * Only inventory evidence gathered AFTER the operation finished counts (``valid_through > op_done_at``).
  * Without fresh inventory data the answer is ``unverifiable`` - never "OK".
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .util import MINUTE

VERIFY_WINDOW_S = 15 * MINUTE  # ~3 inventory cycles

Row = dict[str, Any]


@dataclass
class Freshness:
    state: str  # fresh | stale | unknown
    last_sync_at: int | None
    age_s: int | None


@dataclass
class Convergence:
    state: str
    detail: str
    diff: list[dict[str, Any]] = field(default_factory=list)
    matched: bool = False
    post_op_evidence: bool = False
    op_done_at: int | None = None
    verify_deadline: int | None = None


def source_freshness(source: Row | None, now: int) -> Freshness:
    if source is None or source.get("last_sync_at") is None:
        return Freshness("unknown", None, None)
    age = now - int(source["last_sync_at"])
    if age <= source["fresh_threshold_s"]:
        return Freshness("fresh", source["last_sync_at"], age)
    if age <= source["stale_threshold_s"]:
        return Freshness("stale", source["last_sync_at"], age)
    return Freshness("unknown", source["last_sync_at"], age)


def deployment_freshness(obs: Row | None, source: Row | None, now: int) -> Freshness:
    f = source_freshness(source, now)
    if obs is None:
        return Freshness("unknown", f.last_sync_at, f.age_s)
    return f


def effective_health(obs: Row | None, freshness: Freshness) -> str:
    """Stale or missing data never shows the last-known health."""
    if obs is None or freshness.state != "fresh" or not obs.get("present"):
        return "unknown"
    return obs.get("health") or "unknown"


def diff_spec(revision: Row, obs: Row | None, names: dict[str, str] | None = None) -> list[dict[str, Any]]:
    """Field-level differences between desired revision and an observation."""
    if obs is None or not obs.get("present"):
        return [{"field": "presence", "desired": "running", "observed": "absent"}]
    out = []
    for fld, obs_key, raw_key in (
        ("model_version", "model_version_id", "model_raw"),
        ("engine_version", "engine_version_id", "engine_raw"),
        ("image", "image_id", "image_digest_raw"),
    ):
        want = revision[f"{fld}_id" if fld != "image" else "image_id"]
        got = obs.get(obs_key)
        if want != got:
            out.append({
                "field": fld,
                "desired": want,
                "observed": got,
                "observed_raw": obs.get(raw_key),
                "unrecognized": got is None,
            })
    return out


def evaluate(
    *,
    deployment: Row,
    revision: Row | None,
    request: Row | None,
    operation: Row | None,
    obs: Row | None,
    source: Row | None,
    prev: Row | None,
    now: int,
) -> Convergence:
    fresh = deployment_freshness(obs, source, now)

    if not deployment.get("managed") or revision is None:
        return Convergence("unmanaged", "Observed by inventory but has no desired state in FleetHub.")

    diff = diff_spec(revision, obs)
    matched = not diff

    # 1. A request for the current revision is still in flight.
    if request is not None and request["status"] in ("queued", "submitted") and (
        operation is None or operation["status"] in ("pending", "running")
    ):
        return Convergence("converging", "Deployment request in flight; waiting for the deployer to finish.",
                           diff, matched)

    # 2. The deployer reported a failure (or rejected / cancelled).
    if request is not None and (
        request["status"] in ("failed", "cancelled")
        or (operation is not None and operation["status"] in ("reported_failed", "cancelled"))
    ):
        msg = (operation or {}).get("result_message") or "Deployer reported failure."
        return Convergence("apply_failed", f"Apply failed: {msg}", diff, matched)

    op_done_at = None
    if operation is not None:
        op_done_at = operation.get("finished_at") or operation.get("timeout_at")
    if op_done_at is None:
        op_done_at = revision["created_at"]
    deadline = op_done_at + VERIFY_WINDOW_S
    timed_out = operation is not None and operation["status"] == "timed_out"

    # 3. No fresh evidence => cannot say anything about reality.
    if fresh.state != "fresh":
        why = "never reported" if fresh.last_sync_at is None else f"last inventory sync {fresh.age_s // 60}m ago ({fresh.state})"
        return Convergence("unverifiable", f"Cannot verify: inventory data {why}.", diff, matched,
                           op_done_at=op_done_at, verify_deadline=deadline)

    valid_through = source["last_sync_at"] if source else None
    post_op = obs is not None and valid_through is not None and valid_through > op_done_at

    if matched and post_op:
        return Convergence("converged", "Inventory confirms the desired model, engine and image digest.",
                           diff, True, True, op_done_at, deadline)

    if matched:
        return Convergence("verifying", "Waiting for an inventory sync after the operation finished.",
                           diff, True, False, op_done_at, deadline)

    was_converged = (
        prev is not None
        and prev.get("last_converged_revision_id") == revision["id"]
        and (prev.get("last_converged_at") or 0) >= op_done_at
    )
    if was_converged and post_op:
        if obs is not None and not obs.get("present"):
            return Convergence("missing", "Workload was running but inventory no longer reports it.",
                               diff, False, True, op_done_at, deadline)
        fields = ", ".join(d["field"] for d in diff)
        return Convergence("drifted", f"Out-of-band change detected ({fields} differ from desired).",
                           diff, False, True, op_done_at, deadline)

    if now < deadline:
        return Convergence("verifying", "Deployer finished; waiting for inventory to reflect the change.",
                           diff, False, post_op, op_done_at, deadline)

    if obs is not None and not obs.get("present"):
        return Convergence("missing", "Inventory does not report this workload.", diff, False, post_op,
                           op_done_at, deadline)
    if timed_out:
        return Convergence("apply_failed", "Deployer never returned a result and inventory does not show the change.",
                           diff, False, post_op, op_done_at, deadline)
    return Convergence("not_observed_after_success",
                       "Deployer reported success, but inventory still reports a different version.",
                       diff, False, post_op, op_done_at, deadline)
