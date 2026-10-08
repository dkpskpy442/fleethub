"""Rollout guardrails: evaluate a proposed (model version, engine version) for one deployment.

Levels:
  block - cannot proceed (no override)
  warn  - may proceed only with an explicit, audited justification/acknowledgement
  ok    - passed (shown for transparency)
  info  - informational (e.g. no-op change)
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from ..db.store import Store
from . import lookups as L
from .clock import now as clock_now
from .reconciler import deployment_freshness

Row = dict[str, Any]


@dataclass
class Check:
    code: str
    level: str
    message: str


@dataclass
class GuardrailResult:
    deployment_id: str
    model_version_id: str | None
    engine_version_id: str | None
    image_id: str | None
    checks: list[Check] = field(default_factory=list)

    @property
    def blocked(self) -> bool:
        return any(c.level == "block" for c in self.checks)

    @property
    def warnings(self) -> list[str]:
        return sorted(c.code for c in self.checks if c.level == "warn")

    @property
    def noop(self) -> bool:
        return any(c.code == "no_change" for c in self.checks)

    @property
    def outcome(self) -> str:
        if self.blocked:
            return "blocked"
        if self.noop:
            return "no_change"
        return "warn" if self.warnings else "ok"

    def to_json(self) -> dict[str, Any]:
        return {
            "deployment_id": self.deployment_id,
            "model_version_id": self.model_version_id,
            "engine_version_id": self.engine_version_id,
            "image_id": self.image_id,
            "outcome": self.outcome,
            "checks": [asdict(c) for c in self.checks],
        }


def compat_status(store: Store, mv_id: str, ev_id: str, hw_id: str) -> str:
    rec = store.first("compatibility_records", model_version_id=mv_id, engine_version_id=ev_id, hardware_type_id=hw_id)
    return rec["status"] if rec else "untested"


def spec_for_change(store: Store, deployment: Row, kind: str, target_mv: str | None, target_ev: str | None) -> tuple[str | None, str | None]:
    """Resolve the full (model version, engine version) a change would produce for a deployment."""
    rev = L.current_revision(store, deployment)
    obs = L.latest_obs(store, deployment)
    cur_mv = rev["model_version_id"] if rev else (obs or {}).get("model_version_id")
    cur_ev = rev["engine_version_id"] if rev else (obs or {}).get("engine_version_id")
    mv = target_mv if kind in ("model", "model_and_engine") else cur_mv
    ev = target_ev if kind in ("engine", "model_and_engine") else cur_ev
    return mv, ev


def evaluate(store: Store, deployment: Row, mv_id: str | None, ev_id: str | None, *,
             rollout_id: str | None = None, check_lock: bool = True,
             image_id: str | None = None) -> GuardrailResult:
    now = clock_now(store)
    ctx = L.target_ctx(store, deployment["target_id"])
    tier = ctx["environment"]["tier"]
    hw = ctx["hardware"]
    res = GuardrailResult(deployment["id"], mv_id, ev_id, None)
    add = res.checks.append

    if not deployment["managed"]:
        add(Check("unmanaged", "block", "Deployment is not managed by FleetHub; adopt it first."))

    if check_lock:
        lock = store.get("deployment_locks", deployment["id"])
        if lock and lock["rollout_id"] != rollout_id:
            r = store.get("rollouts", lock["rollout_id"])
            add(Check("locked", "block", f"Locked by active rollout '{r['title'] if r else lock['rollout_id']}'."))

    mv = store.get("model_versions", mv_id)
    ev = store.get("engine_versions", ev_id)
    if mv is None or ev is None:
        add(Check("unknown_current_state", "block", "Current model/engine version is unknown; cannot compute a safe change."))
        return res

    if deployment.get("model_family_id") and mv["family_id"] != deployment["model_family_id"]:
        add(Check("family_mismatch", "block", "Model version belongs to a different model family than this deployment serves."))

    # Model lifecycle
    lc = mv["lifecycle"]
    if lc == "retired":
        add(Check("model_retired", "block", f"Model version {mv['version']} is retired."))
    elif lc == "deprecated":
        add(Check("model_deprecated", "warn", f"Model version {mv['version']} is deprecated."))
    elif lc == "experimental" and tier == "prod":
        add(Check("model_experimental_prod", "warn", f"Model version {mv['version']} is experimental and this is a production target."))
    else:
        add(Check("model_lifecycle", "ok", f"Model lifecycle: {lc}."))

    # Engine lifecycle
    elc = ev["lifecycle"]
    if elc == "eol":
        add(Check("engine_eol", "block", f"Engine version {ev['version']} is end-of-life."))
    elif elc == "deprecated":
        add(Check("engine_deprecated", "warn", f"Engine version {ev['version']} is deprecated."))
    elif elc == "preview" and tier == "prod":
        add(Check("engine_preview_prod", "warn", f"Engine version {ev['version']} is a preview release and this is a production target."))
    else:
        add(Check("engine_lifecycle", "ok", f"Engine lifecycle: {elc}."))

    # Hardware support (an image must exist for the target's accelerator)
    if image_id is not None:
        img = store.get("engine_images", image_id)
        if img is not None and hw["id"] not in L.image_hardware(store, img["id"]):
            img = None
    else:
        img = L.pick_image(store, ev["id"], hw["id"])
    if img is None:
        add(Check("unsupported_hardware", "block", f"No image of this engine version supports {hw['name']}."))
    else:
        res.image_id = img["id"]
        add(Check("hardware", "ok", f"Image {img['tag']} supports {hw['name']}."))

    # Compatibility (model version x engine version x hardware)
    cs = compat_status(store, mv["id"], ev["id"], hw["id"])
    if cs == "incompatible":
        add(Check("compat_incompatible", "block", f"Recorded as incompatible on {hw['name']}."))
    elif cs == "known_issues":
        rec = store.first("compatibility_records", model_version_id=mv["id"], engine_version_id=ev["id"], hardware_type_id=hw["id"])
        add(Check("compat_known_issues", "warn", f"Known issues on {hw['name']}: {rec.get('notes') or 'see evidence'}."))
    elif cs == "untested":
        add(Check("compat_untested", "warn", f"No compatibility record for this combination on {hw['name']} (untested)."))
    else:
        add(Check("compat", "ok", f"Compatibility on {hw['name']}: {cs}."))

    # Vulnerabilities on the image that would be deployed. "remediated" means exposure was removed,
    # not that the image got safer, so it still counts; only false positives are ignored.
    if img is not None:
        worst: tuple[str, Row, Row] | None = None
        for f in store.where("vulnerability_findings", image_id=img["id"]):
            if f["status"] == "false_positive":
                continue
            v = store.must("vulnerabilities", f["vulnerability_id"])
            if f["status"] == "risk_accepted":
                level = "warn"
            elif v["severity"] == "critical":
                level = "block"
            elif v["severity"] == "high":
                level = "warn"
            else:
                continue
            if worst is None or (level == "block" and worst[0] != "block"):
                worst = (level, v, f)
        if worst and worst[0] == "block":
            add(Check("vuln_critical", "block", f"Target image is affected by critical {worst[1]['external_id']}; "
                                                "pick an engine version without it (use a model + engine rollout)."))
        elif worst and worst[2]["status"] == "risk_accepted":
            add(Check("vuln_risk_accepted", "warn", f"Target image is affected by {worst[1]['external_id']} (risk accepted)."))
        elif worst:
            add(Check("vuln_high", "warn", f"Target image is affected by high {worst[1]['external_id']}."))
        else:
            add(Check("vulns", "ok", "No critical/high findings on target image."))

    # Data freshness of the target
    fresh = deployment_freshness(L.latest_obs(store, deployment), ctx["source"], now)
    if fresh.state != "fresh":
        add(Check("stale_target_data", "warn", f"Inventory data for this deployment is {fresh.state}; current state cannot be verified."))

    # No-op
    rev = L.current_revision(store, deployment)
    if rev and img and rev["model_version_id"] == mv["id"] and rev["engine_version_id"] == ev["id"] and rev["image_id"] == img["id"]:
        add(Check("no_change", "info", "Desired state already matches this change."))

    return res
