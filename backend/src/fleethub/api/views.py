"""Read models: shape domain state into JSON for the UI. No mutations here."""
from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any

from ..db.store import Store
from ..domain import guardrails
from ..domain import lookups as L
from ..domain import vulns as V
from ..domain.clock import now as clock_now
from ..domain.enums import FINDING_ACTIVE, ROLLOUT_ACTIVE, SEVERITY_ORDER
from ..domain.fleet import evaluate_deployment
from ..domain.reconciler import deployment_freshness, effective_health, source_freshness
from ..domain.rollouts import targets_of, waves_of
from ..domain.util import DAY, jload

Row = dict[str, Any]


# ------------------------------------------------------------------ refs
def mv_ref(s: Store, mv_id: str | None) -> Row | None:
    mv = s.get("model_versions", mv_id)
    if mv is None:
        return None
    fam = s.must("model_families", mv["family_id"])
    return {"id": mv["id"], "version": mv["version"], "label": f"{fam['name']} {mv['version']}",
            "family_id": fam["id"], "family_name": fam["name"], "lifecycle": mv["lifecycle"]}


def ev_ref(s: Store, ev_id: str | None) -> Row | None:
    ev = s.get("engine_versions", ev_id)
    if ev is None:
        return None
    eng = s.must("engines", ev["engine_id"])
    return {"id": ev["id"], "version": ev["version"], "label": f"{eng['name']} {ev['version']}",
            "engine_id": eng["id"], "engine_name": eng["name"], "lifecycle": ev["lifecycle"]}


def img_ref(s: Store, img_id: str | None) -> Row | None:
    img = s.get("engine_images", img_id)
    if img is None:
        return None
    return {"id": img["id"], "tag": img["tag"], "repo": img["repo"], "digest": img["digest"],
            "accelerator": img["accelerator"], "engine_version_id": img["engine_version_id"]}


def user_ref(s: Store, uid: str | None) -> Row | None:
    if uid is None:
        return None
    if uid == "system":
        return {"id": "system", "name": "FleetHub (system)", "role": "system"}
    u = s.get("users", uid)
    return {"id": u["id"], "name": u["name"], "role": u["role"]} if u else {"id": uid, "name": uid, "role": "?"}


def rollout_ref(s: Store, rid: str | None) -> Row | None:
    r = s.get("rollouts", rid)
    return {"id": r["id"], "title": r["title"], "status": r["status"]} if r else None


def source_view(s: Store, src: Row, now: int) -> Row:
    f = source_freshness(src, now)
    return {"id": src["id"], "kind": src["kind"], "name": src["name"], "description": src["description"],
            "sync_interval_s": src["sync_interval_s"], "fresh_threshold_s": src["fresh_threshold_s"],
            "stale_threshold_s": src["stale_threshold_s"], "last_sync_at": src["last_sync_at"],
            "last_sync_status": src["last_sync_status"], "last_error": src["last_error"],
            "freshness": f.state, "age_s": f.age_s}


def target_view(s: Store, t: Row) -> Row:
    ctx = L.target_ctx(s, t["id"])
    return {"id": t["id"], "name": t["name"],
            "environment": {k: ctx["environment"][k] for k in ("id", "name", "tier")},
            "region": {k: ctx["region"][k] for k in ("id", "name", "cloud")},
            "hardware": {k: ctx["hardware"][k] for k in ("id", "name", "vendor", "accelerator")},
            "inventory_source_id": t["inventory_source_id"]}


def _image_vulns(s: Store, image_id: str | None) -> list[Row]:
    if image_id is None:
        return []
    out = []
    for f in s.where("vulnerability_findings", image_id=image_id):
        v = s.must("vulnerabilities", f["vulnerability_id"])
        out.append({"finding_id": f["id"], "vulnerability_id": v["id"], "external_id": v["external_id"],
                    "severity": v["severity"], "status": f["status"], "title": v["title"]})
    out.sort(key=lambda x: SEVERITY_ORDER[x["severity"]])
    return out


def _worst_active(vs: list[Row]) -> str | None:
    act = [v for v in vs if v["status"] in FINDING_ACTIVE or v["status"] == "risk_accepted"]
    return min((v["severity"] for v in act), key=lambda x: SEVERITY_ORDER[x], default=None)


def deployment_row(s: Store, dep: Row, now: int) -> Row:
    ctx = L.target_ctx(s, dep["target_id"])
    rev = L.current_revision(s, dep)
    obs = L.latest_obs(s, dep)
    fresh = deployment_freshness(obs, ctx["source"], now)
    conv = evaluate_deployment(s, dep, now)
    stored = s.get("deployment_convergence", dep["id"])
    lock = s.get("deployment_locks", dep["id"])
    obs_vulns = _image_vulns(s, obs["image_id"]) if obs and obs["present"] else []
    des_vulns = _image_vulns(s, rev["image_id"]) if rev else []
    fam = s.get("model_families", dep["model_family_id"])
    return {
        "id": dep["id"], "service_name": dep["service_name"], "managed": bool(dep["managed"]),
        "target": target_view(s, ctx["target"]),
        "model_family": {"id": fam["id"], "name": fam["name"]} if fam else None,
        "desired": None if rev is None else {
            "revision_id": rev["id"], "rev_no": rev["rev_no"], "source": rev["source"], "created_at": rev["created_at"],
            "model_version": mv_ref(s, rev["model_version_id"]), "engine_version": ev_ref(s, rev["engine_version_id"]),
            "image": img_ref(s, rev["image_id"]), "replicas": rev["replicas"],
        },
        "observed": None if obs is None else {
            "observation_id": obs["id"], "present": bool(obs["present"]), "observed_at": obs["observed_at"],
            "valid_through": ctx["source"]["last_sync_at"],
            "model_raw": obs["model_raw"], "model_version": mv_ref(s, obs["model_version_id"]),
            "engine_raw": obs["engine_raw"], "engine_version": ev_ref(s, obs["engine_version_id"]),
            "image_digest": obs["image_digest_raw"], "image": img_ref(s, obs["image_id"]),
            "replicas_ready": obs["replicas_ready"], "replicas_total": obs["replicas_total"],
            "reported_health": obs["health"],
        },
        "convergence": {"state": conv.state, "detail": conv.detail, "diff": conv.diff,
                        "since": stored["since"] if stored and stored["state"] == conv.state else now,
                        "verify_deadline": conv.verify_deadline},
        "health": effective_health(obs, fresh),
        "freshness": {"state": fresh.state, "last_sync_at": fresh.last_sync_at, "age_s": fresh.age_s,
                      "source_id": ctx["source"]["id"], "source_name": ctx["source"]["name"]},
        "lock": None if lock is None else {"rollout": rollout_ref(s, lock["rollout_id"]), "acquired_at": lock["acquired_at"]},
        "vulns": {"observed_worst": _worst_active(obs_vulns), "desired_worst": _worst_active(des_vulns),
                  "observed": obs_vulns, "desired": des_vulns},
    }


def fleet(s: Store) -> list[Row]:
    now = clock_now(s)
    rows = [deployment_row(s, d, now) for d in s.rows("deployments")]
    rows.sort(key=lambda r: (r["target"]["environment"]["tier"] != "prod", r["target"]["name"], r["service_name"]))
    return rows


# ------------------------------------------------------------------ deployment detail
def deployment_detail(s: Store, dep: Row, audit_rows: list[Row], observations: list[Row], events: list[Row]) -> Row:
    now = clock_now(s)
    base = deployment_row(s, dep, now)
    revs = sorted(s.where("desired_state_revisions", deployment_id=dep["id"]), key=lambda r: -r["rev_no"])
    reqs = sorted(s.where("deployment_requests", deployment_id=dep["id"]), key=lambda r: (-r["requested_at"], -r["attempt"]))
    chain_req = L.latest_request(s, dep["id"], dep["current_revision_id"])
    chain_op = L.request_operation(s, chain_req["id"]) if chain_req else None
    src = L.target_ctx(s, dep["target_id"])["source"]
    base.update({
        "revisions": [{
            "id": r["id"], "rev_no": r["rev_no"], "source": r["source"], "created_at": r["created_at"],
            "actor": user_ref(s, r["actor_id"]), "reason": r["reason"], "rollout": rollout_ref(s, r["rollout_id"]),
            "model_version": mv_ref(s, r["model_version_id"]), "engine_version": ev_ref(s, r["engine_version_id"]),
            "image": img_ref(s, r["image_id"]), "replicas": r["replicas"], "current": r["id"] == dep["current_revision_id"],
        } for r in revs],
        "requests": [_request_view(s, r) for r in reqs[:15]],
        "chain": {
            "revision": (lambda c: c and {"rev_no": c["rev_no"], "created_at": c["created_at"], "source": c["source"]})(
                s.get("desired_state_revisions", dep["current_revision_id"])),
            "request": _request_view(s, chain_req) if chain_req else None,
            "operation": _op_view(chain_op) if chain_op else None,
            "inventory": {"source": source_view(s, src, now), "latest_observation_at": (L.latest_obs(s, dep) or {}).get("observed_at")},
            "verdict": base["convergence"],
        },
        "observations": [{
            "id": o["id"], "observed_at": o["observed_at"], "present": bool(o["present"]), "model_raw": o["model_raw"],
            "engine_raw": o["engine_raw"], "image_digest": o["image_digest_raw"], "image": img_ref(s, o["image_id"]),
            "model_version": mv_ref(s, o["model_version_id"]), "engine_version": ev_ref(s, o["engine_version_id"]),
            "replicas_ready": o["replicas_ready"], "replicas_total": o["replicas_total"], "health": o["health"],
        } for o in observations],
        "rollouts": [{**rollout_ref(s, t["rollout_id"]), "target_status": t["status"], "target_id": t["id"]}
                     for t in s.where("rollout_targets", deployment_id=dep["id"])],
        "audit": [audit_view(s, a) for a in audit_rows],
        "events": events,
        "actions": {
            "can_adopt": not dep["managed"],
            "can_reconcile": bool(dep["managed"]) and base["lock"] is None and base["convergence"]["state"] in (
                "drifted", "missing", "apply_failed", "not_observed_after_success"),
            "can_accept_observed": bool(dep["managed"]) and base["lock"] is None and base["convergence"]["state"] in (
                "drifted", "not_observed_after_success"),
        },
    })
    return base


def _request_view(s: Store, r: Row) -> Row:
    op = L.request_operation(s, r["id"])
    rev = s.must("desired_state_revisions", r["revision_id"])
    return {"id": r["id"], "idempotency_key": r["idempotency_key"], "attempt": r["attempt"], "status": r["status"],
            "rev_no": rev["rev_no"], "requested_at": r["requested_at"], "submitted_at": r["submitted_at"],
            "completed_at": r["completed_at"], "requested_by": user_ref(s, r["requested_by"]),
            "superseded_by_id": r["superseded_by_id"], "operation": _op_view(op) if op else None}


def _op_view(op: Row) -> Row:
    return {k: op[k] for k in ("id", "adapter", "external_ref", "status", "result_message", "started_at",
                               "finished_at", "timeout_at", "last_polled_at")}


def audit_view(s: Store, a: Row) -> Row:
    return {"id": a["id"], "at": a["at"], "actor": user_ref(s, a["actor_id"]), "actor_role": a["actor_role"],
            "action": a["action"], "entity_type": a["entity_type"], "entity_id": a["entity_id"],
            "summary": a["summary"], "before": jload(a["before_json"]), "after": jload(a["after_json"]),
            "reason": a["reason"], "correlation_id": a["correlation_id"]}


# ------------------------------------------------------------------ catalogs
def _deployments_using(s: Store, now: int, *, mv_id: str | None = None, ev_id: str | None = None) -> list[Row]:
    out = []
    for d in s.rows("deployments"):
        rev = L.current_revision(s, d)
        obs = L.latest_obs(s, d)
        des = rev and ((mv_id and rev["model_version_id"] == mv_id) or (ev_id and rev["engine_version_id"] == ev_id))
        ob = obs and obs["present"] and ((mv_id and obs["model_version_id"] == mv_id) or (ev_id and obs["engine_version_id"] == ev_id))
        if des or ob:
            row = deployment_row(s, d, now)
            row["match"] = {"desired": bool(des), "observed": bool(ob)}
            out.append(row)
    return out


def models(s: Store) -> list[Row]:
    out = []
    for fam in sorted(s.rows("model_families"), key=lambda f: f["name"]):
        versions = sorted(s.where("model_versions", family_id=fam["id"]), key=lambda v: v["released_at"], reverse=True)
        deps = s.where("deployments", model_family_id=fam["id"])
        out.append({**fam, "owner_team": s.must("teams", fam["owner_team_id"])["name"],
                    "versions": [{"id": v["id"], "version": v["version"], "lifecycle": v["lifecycle"]} for v in versions],
                    "lifecycle_counts": dict(Counter(v["lifecycle"] for v in versions)),
                    "deployment_count": len(deps), "unmanaged_count": sum(1 for d in deps if not d["managed"])})
    return out


def model_family(s: Store, fam: Row) -> Row:
    now = clock_now(s)
    versions = sorted(s.where("model_versions", family_id=fam["id"]), key=lambda v: v["released_at"], reverse=True)
    vs = []
    for v in versions:
        using = _deployments_using(s, now, mv_id=v["id"])
        recs = s.where("compatibility_records", model_version_id=v["id"])
        vs.append({**v, "desired_count": sum(1 for d in using if d["match"]["desired"]),
                   "observed_count": sum(1 for d in using if d["match"]["observed"]),
                   "compat_counts": dict(Counter(r["status"] for r in recs))})
    return {**fam, "owner_team": s.must("teams", fam["owner_team_id"])["name"], "versions": vs}


def compat_matrix_for_model(s: Store, mv: Row) -> Row:
    fam = s.must("model_families", mv["family_id"])
    hws = sorted(s.rows("hardware_types"), key=lambda h: h["name"])
    rows = []
    for eng in sorted(s.rows("engines"), key=lambda e: e["name"]):
        for ev in sorted(s.where("engine_versions", engine_id=eng["id"]), key=lambda e: e["released_at"], reverse=True):
            supported = set()
            for img in s.where("engine_images", engine_version_id=ev["id"]):
                supported |= L.image_hardware(s, img["id"])
            cells = {}
            any_record = False
            for hw in hws:
                rec = s.first("compatibility_records", model_version_id=mv["id"], engine_version_id=ev["id"], hardware_type_id=hw["id"])
                any_record |= rec is not None
                cells[hw["id"]] = {
                    "status": rec["status"] if rec else ("untested" if hw["id"] in supported else "unsupported_hardware"),
                    "notes": rec["notes"] if rec else None, "evidence_url": rec["evidence_url"] if rec else None,
                    "verified_at": rec["verified_at"] if rec else None, "verified_by": user_ref(s, rec["verified_by"]) if rec else None,
                }
            rows.append({"engine_version": ev_ref(s, ev["id"]), "has_records": any_record, "cells": cells})
    return {"hardware": [{"id": h["id"], "name": h["name"]} for h in hws], "rows": rows, "family": fam["name"]}


def model_version(s: Store, mv: Row, audit_rows: list[Row]) -> Row:
    now = clock_now(s)
    fam = s.must("model_families", mv["family_id"])
    rollouts = [r for r in s.rows("rollouts") if r["target_model_version_id"] == mv["id"]]
    return {
        **mv, "family": {"id": fam["id"], "name": fam["name"], "slug": fam["slug"],
                         "owner_team": s.must("teams", fam["owner_team_id"])["name"], "owner_team_id": fam["owner_team_id"]},
        "compat": compat_matrix_for_model(s, mv),
        "deployments": _deployments_using(s, now, mv_id=mv["id"]),
        "rollouts": [rollout_summary(s, r) for r in rollouts],
        "audit": [audit_view(s, a) for a in audit_rows],
    }


def engines(s: Store) -> list[Row]:
    now = clock_now(s)
    out = []
    for eng in sorted(s.rows("engines"), key=lambda e: e["name"]):
        evs = sorted(s.where("engine_versions", engine_id=eng["id"]), key=lambda e: e["released_at"], reverse=True)
        vrows = []
        for ev in evs:
            imgs = s.where("engine_images", engine_version_id=ev["id"])
            fnds = [v for i in imgs for v in _image_vulns(s, i["id"])]
            using = _deployments_using(s, now, ev_id=ev["id"])
            vrows.append({"id": ev["id"], "version": ev["version"], "lifecycle": ev["lifecycle"],
                          "released_at": ev["released_at"], "worst_vuln": _worst_active(fnds),
                          "observed_count": sum(1 for d in using if d["match"]["observed"]),
                          "desired_count": sum(1 for d in using if d["match"]["desired"])})
        out.append({**eng, "owner_team": s.must("teams", eng["owner_team_id"])["name"], "versions": vrows})
    return out


def engine_version(s: Store, ev: Row, audit_rows: list[Row]) -> Row:
    now = clock_now(s)
    eng = s.must("engines", ev["engine_id"])
    imgs = []
    for img in sorted(s.where("engine_images", engine_version_id=ev["id"]), key=lambda i: i["tag"]):
        hw = [s.must("hardware_types", h)["name"] for h in sorted(L.image_hardware(s, img["id"]))]
        imgs.append({**img_ref(s, img["id"]), "built_at": img["built_at"], "hardware": hw,
                     "vulns": _image_vulns(s, img["id"]), "exposure": {k: len(v) for k, v in V.image_exposure(s, img["id"]).items()}})
    models_compat = defaultdict(list)
    for rec in s.where("compatibility_records", engine_version_id=ev["id"]):
        models_compat[rec["model_version_id"]].append({"hardware": s.must("hardware_types", rec["hardware_type_id"])["name"],
                                                       "status": rec["status"], "notes": rec["notes"]})
    compat = [{"model_version": mv_ref(s, mid), "records": sorted(recs, key=lambda r: r["hardware"])}
              for mid, recs in models_compat.items()]
    compat.sort(key=lambda c: c["model_version"]["label"])
    newer = [e for e in s.where("engine_versions", engine_id=eng["id"]) if e["released_at"] > ev["released_at"]]
    return {**ev, "engine": {"id": eng["id"], "name": eng["name"], "slug": eng["slug"], "repo_url": eng["repo_url"]},
            "images": imgs, "compat": compat, "deployments": _deployments_using(s, now, ev_id=ev["id"]),
            "newer_versions": [{**ev_ref(s, e["id"]), "worst_vuln": _worst_active(
                [v for i in s.where("engine_images", engine_version_id=e["id"]) for v in _image_vulns(s, i["id"])])}
                for e in sorted(newer, key=lambda e: e["released_at"])],
            "rollouts": [rollout_summary(s, r) for r in s.rows("rollouts") if r["target_engine_version_id"] == ev["id"]],
            "audit": [audit_view(s, a) for a in audit_rows]}


def compat_matrix(s: Store, family_id: str | None, engine_id: str | None) -> Row:
    hws = sorted(s.rows("hardware_types"), key=lambda h: h["name"])
    mvs = [m for m in s.rows("model_versions") if (not family_id or m["family_id"] == family_id) and m["lifecycle"] != "retired"]
    mvs.sort(key=lambda m: (s.must("model_families", m["family_id"])["name"], m["version"]))
    evs = [e for e in s.rows("engine_versions") if not engine_id or e["engine_id"] == engine_id]
    evs.sort(key=lambda e: (s.must("engines", e["engine_id"])["name"], e["released_at"]))
    recs = {(r["model_version_id"], r["engine_version_id"], r["hardware_type_id"]): r for r in s.rows("compatibility_records")}
    rows = []
    for mv in mvs:
        cells = {}
        for ev in evs:
            supported = set()
            for img in s.where("engine_images", engine_version_id=ev["id"]):
                supported |= L.image_hardware(s, img["id"])
            for hw in hws:
                r = recs.get((mv["id"], ev["id"], hw["id"]))
                cells[f"{ev['id']}|{hw['id']}"] = (r["status"] if r else ("untested" if hw["id"] in supported else "n/a"))
        rows.append({"model_version": mv_ref(s, mv["id"]), "cells": cells})
    return {"hardware": [{"id": h["id"], "name": h["name"]} for h in hws],
            "engine_versions": [ev_ref(s, e["id"]) for e in evs], "rows": rows}


# ------------------------------------------------------------------ vulnerabilities
def vulnerabilities(s: Store) -> list[Row]:
    out = []
    for v in s.rows("vulnerabilities"):
        fnds = s.where("vulnerability_findings", vulnerability_id=v["id"])
        ex = V.exposure(s, v["id"])
        evs = {s.must("engine_images", f["image_id"])["engine_version_id"] for f in fnds}
        out.append({**v, "finding_statuses": dict(Counter(f["status"] for f in fnds)),
                    "engine_versions": [ev_ref(s, e) for e in sorted(evs)],
                    "exposure": {"observed": sum(1 for e in ex if e["observed"]), "desired": sum(1 for e in ex if e["desired"]),
                                 "prod_observed": sum(1 for e in ex if e["observed"] and L.is_prod(s, s.must("deployments", e["deployment_id"]))),
                                 "unverifiable": sum(1 for e in ex if e["freshness"] != "fresh")},
                    "active": any(f["status"] in FINDING_ACTIVE for f in fnds),
                    "rollouts": [rollout_summary(s, r) for r in s.rows("rollouts") if r["linked_vulnerability_id"] == v["id"]]})
    out.sort(key=lambda x: (not x["active"], SEVERITY_ORDER[x["severity"]], -x["exposure"]["observed"]))
    return out


def vulnerability(s: Store, v: Row, audit_rows: list[Row]) -> Row:
    now = clock_now(s)
    fnds = []
    for f in s.where("vulnerability_findings", vulnerability_id=v["id"]):
        img = s.must("engine_images", f["image_id"])
        ex = V.image_exposure(s, img["id"])
        fnds.append({**f, "image": img_ref(s, img["id"]), "engine_version": ev_ref(s, img["engine_version_id"]),
                     "updated_by": user_ref(s, f["updated_by"]),
                     "exposure": {"observed": len(ex["observed"]), "desired": len(ex["desired"])}})
    ex_rows = []
    for e in V.exposure(s, v["id"]):
        dep = s.must("deployments", e["deployment_id"])
        ex_rows.append({**deployment_row(s, dep, now), "exposure": {"observed": e["observed"], "desired": e["desired"]}})
    ex_rows.sort(key=lambda r: (r["target"]["environment"]["tier"] != "prod", r["target"]["name"]))
    return {**v, "findings": fnds, "exposure": ex_rows, "remediation_options": V.remediation_options(s, v["id"]),
            "rollouts": [rollout_summary(s, r) for r in s.rows("rollouts") if r["linked_vulnerability_id"] == v["id"]],
            "audit": [audit_view(s, a) for a in audit_rows]}


# ------------------------------------------------------------------ rollouts
def rollout_summary(s: Store, r: Row) -> Row:
    ts = targets_of(s, r["id"])
    waves = waves_of(s, r["id"])
    cur = next((w for w in waves if w["status"] not in ("succeeded", "pending")), None) or \
        next((w for w in waves if w["status"] == "pending"), None)
    return {"id": r["id"], "title": r["title"], "kind": r["kind"], "status": r["status"],
            "approval_status": r["approval_status"], "pause_reason": r["pause_reason"],
            "target_model_version": mv_ref(s, r["target_model_version_id"]),
            "target_engine_version": ev_ref(s, r["target_engine_version_id"]),
            "requested_by": user_ref(s, r["requested_by"]), "created_at": r["created_at"], "updated_at": r["updated_at"],
            "started_at": r["started_at"], "finished_at": r["finished_at"],
            "linked_vulnerability": (lambda v: {"id": v["id"], "external_id": v["external_id"], "severity": v["severity"]} if v else None)(
                s.get("vulnerabilities", r["linked_vulnerability_id"])),
            "target_counts": dict(Counter(t["status"] for t in ts)), "target_total": len(ts),
            "wave_count": len(waves), "current_wave": cur and {"idx": cur["idx"], "name": cur["name"], "status": cur["status"]}}


def rollout_detail(s: Store, r: Row, events: list[Row], audit_rows: list[Row]) -> Row:
    now = clock_now(s)
    waves = []
    for w in waves_of(s, r["id"]):
        tv = []
        for t in sorted(targets_of(s, r["id"], w["id"]), key=lambda t: t["id"]):
            dep = s.must("deployments", t["deployment_id"])
            g = jload(t["guardrail_json"], {})
            ack = set(jload(t["acknowledged_json"], []))
            warns = {c["code"] for c in g.get("checks", []) if c["level"] == "warn"}
            tv.append({
                "id": t["id"], "status": t["status"], "failure_reason": t["failure_reason"],
                "manually_verified": bool(t["manually_verified"]), "verify_deadline": t["verify_deadline"],
                "bake_until": t["bake_until"], "started_at": t["started_at"], "finished_at": t["finished_at"],
                "justification": t["justification"], "guardrails": g, "acknowledged": sorted(ack),
                "unacknowledged": sorted(warns - ack),
                "new_model_version": mv_ref(s, t["new_model_version_id"]), "new_engine_version": ev_ref(s, t["new_engine_version_id"]),
                "new_image": img_ref(s, t["new_image_id"]),
                "prev": (lambda p: p and {"rev_no": p["rev_no"], "model_version": mv_ref(s, p["model_version_id"]),
                                          "engine_version": ev_ref(s, p["engine_version_id"]), "image": img_ref(s, p["image_id"])})(
                    s.get("desired_state_revisions", t["prev_revision_id"])),
                "request": _request_view(s, s.must("deployment_requests", t["request_id"])) if t["request_id"] else None,
                "rollback_request": _request_view(s, s.must("deployment_requests", t["rollback_request_id"])) if t["rollback_request_id"] else None,
                "deployment": deployment_row(s, dep, now),
            })
        waves.append({**w, "is_prod": bool(w["is_prod"]), "targets": tv})
    return {**rollout_summary(s, r), "reason": r["reason"], "submitted_at": r["submitted_at"], "waves": waves,
            "approvals": [{**a, "approver": user_ref(s, a["approver_id"])} for a in
                          sorted(s.where("rollout_approvals", rollout_id=r["id"]), key=lambda a: a["at"])],
            "events": [{**e, "actor": user_ref(s, e["actor_id"])} for e in events],
            "audit": [audit_view(s, a) for a in audit_rows]}


def rollouts(s: Store) -> list[Row]:
    rs = sorted(s.rows("rollouts"), key=lambda r: (r["status"] not in ROLLOUT_ACTIVE, -r["updated_at"]))
    return [rollout_summary(s, r) for r in rs]


def rollout_preview(s: Store, kind: str, mv_id: str | None, ev_id: str | None, results: list[guardrails.GuardrailResult],
                    waves: list[Row]) -> Row:
    now = clock_now(s)
    out = []
    for res in results:
        dep = s.must("deployments", res.deployment_id)
        row = deployment_row(s, dep, now)
        out.append({"deployment": row, "guardrails": res.to_json(), "new_image": img_ref(s, res.image_id),
                    "new_model_version": mv_ref(s, res.model_version_id), "new_engine_version": ev_ref(s, res.engine_version_id)})
    included = [o for o in out if o["guardrails"]["outcome"] in ("ok", "warn")]
    resolves = defaultdict(set)
    for o in included:
        for v in o["deployment"]["vulns"]["desired"]:
            if v["status"] in FINDING_ACTIVE and not any(nv["vulnerability_id"] == v["vulnerability_id"]
                                                         for nv in _image_vulns(s, (o["new_image"] or {}).get("id"))):
                resolves[v["external_id"]].add(o["deployment"]["id"])
    impact = {
        "deployments": len(included),
        "replicas": sum((o["deployment"]["desired"] or {}).get("replicas", 0) for o in included),
        "by_environment": dict(Counter(o["deployment"]["target"]["environment"]["name"] for o in included)),
        "by_region": dict(Counter(o["deployment"]["target"]["region"]["name"] for o in included)),
        "outcomes": dict(Counter(o["guardrails"]["outcome"] for o in out)),
        "vulns_resolved": {k: len(v) for k, v in resolves.items()},
        "prod": sum(1 for o in included if o["deployment"]["target"]["environment"]["tier"] == "prod"),
    }
    return {"kind": kind, "target_model_version": mv_ref(s, mv_id), "target_engine_version": ev_ref(s, ev_id),
            "targets": out, "suggested_waves": waves, "impact": impact}


# ------------------------------------------------------------------ overview / attention
def overview(s: Store) -> Row:
    now = clock_now(s)
    rows = fleet(s)
    items: list[Row] = []

    def add(sev: str, cat: str, title: str, detail: str, link: str) -> None:
        items.append({"severity": sev, "category": cat, "title": title, "detail": detail, "link": link})

    for v in vulnerabilities(s):
        if not v["active"] or v["severity"] not in ("critical", "high"):
            continue
        ex = v["exposure"]
        if ex["observed"] or ex["desired"]:
            add(v["severity"], "vulnerability", f"{v['external_id']}: {v['title']}",
                f"Running on {ex['observed']} deployment(s) ({ex['prod_observed']} prod); "
                f"{ex['unverifiable']} cannot be verified.", f"/vulnerabilities/{v['id']}")
    for r in s.rows("rollouts"):
        if r["status"] == "paused":
            add("high", "rollout", f"Rollout paused: {r['title']}", r["pause_reason"] or "", f"/rollouts/{r['id']}")
        if r["approval_status"] == "pending" and r["status"] in ROLLOUT_ACTIVE:
            add("medium", "rollout", f"Awaiting prod approval: {r['title']}",
                f"Requested by {user_ref(s, r['requested_by'])['name']}", f"/rollouts/{r['id']}")
    label = lambda r: f"{r['service_name']} @ {r['target']['name']}"  # noqa: E731
    for r in rows:
        st = r["convergence"]["state"]
        prod = r["target"]["environment"]["tier"] == "prod"
        if st == "drifted":
            add("high" if prod else "medium", "drift", f"Drift: {label(r)}", r["convergence"]["detail"], f"/fleet/deployments/{r['id']}")
        elif st in ("not_observed_after_success", "apply_failed", "missing"):
            add("high" if prod else "medium", "convergence", f"{st.replace('_', ' ').capitalize()}: {label(r)}",
                r["convergence"]["detail"], f"/fleet/deployments/{r['id']}")
        elif st == "unmanaged":
            add("medium", "unmanaged", f"Unmanaged deployment: {label(r)}",
                f"Running {r['observed']['model_raw']} on {r['observed']['engine_raw']} outside FleetHub.",
                f"/fleet/deployments/{r['id']}")
        if r["health"] in ("unhealthy", "degraded"):
            add("high" if prod and r["health"] == "unhealthy" else "medium", "health", f"{r['health'].capitalize()}: {label(r)}",
                f"{r['observed']['replicas_ready']}/{r['observed']['replicas_total']} replicas ready.", f"/fleet/deployments/{r['id']}")
        d = r["desired"]
        if d and r["managed"]:
            if d["model_version"]["lifecycle"] in ("deprecated", "retired"):
                add("low", "lifecycle", f"{d['model_version']['lifecycle'].capitalize()} model in use: {label(r)}",
                    f"{d['model_version']['label']}", f"/fleet/deployments/{r['id']}")
            if d["engine_version"]["lifecycle"] in ("deprecated", "eol"):
                add("low", "lifecycle", f"{d['engine_version']['lifecycle'].capitalize()} engine in use: {label(r)}",
                    f"{d['engine_version']['label']}", f"/fleet/deployments/{r['id']}")
    by_src = defaultdict(list)
    for r in rows:
        if r["freshness"]["state"] != "fresh":
            by_src[r["freshness"]["source_id"]].append(r)
    for sid, rs in by_src.items():
        src = s.must("data_sources", sid)
        f = source_freshness(src, now)
        when = "has never reported" if src["last_sync_at"] is None else f"last synced {f.age_s // 60}m ago"
        add("high" if any(r["target"]["environment"]["tier"] == "prod" for r in rs) else "medium", "freshness",
            f"{len(rs)} deployment(s) unverifiable: {src['name']}", f"Source {when} ({f.state}). Health and versions are unknown.",
            "/fleet?freshness=stale,unknown")
    for f in s.rows("vulnerability_findings"):
        if f["status"] == "risk_accepted" and f["accepted_until"] and f["accepted_until"] - now < 3 * DAY:
            v = s.must("vulnerabilities", f["vulnerability_id"])
            add("medium", "vulnerability", f"Risk acceptance expiring: {v['external_id']}",
                f"Expires in {(f['accepted_until'] - now) // 3600}h.", f"/vulnerabilities/{v['id']}")
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    items.sort(key=lambda i: order[i["severity"]])
    conv = Counter(r["convergence"]["state"] for r in rows)
    return {
        "now": now, "attention": items,
        "counts": {
            "model_families": len(s.rows("model_families")), "model_versions": len(s.rows("model_versions")),
            "engines": len(s.rows("engines")), "engine_versions": len(s.rows("engine_versions")),
            "deployments": len(rows), "managed": sum(1 for r in rows if r["managed"]),
            "convergence": dict(conv), "health": dict(Counter(r["health"] for r in rows)),
            "freshness": dict(Counter(r["freshness"]["state"] for r in rows)),
            "active_rollouts": sum(1 for r in s.rows("rollouts") if r["status"] in ROLLOUT_ACTIVE),
            "open_findings": sum(1 for f in s.rows("vulnerability_findings") if f["status"] in FINDING_ACTIVE),
        },
        "sources": [source_view(s, src, now) for src in s.rows("data_sources")],
        "rollouts": [rollout_summary(s, r) for r in s.rows("rollouts") if r["status"] in ROLLOUT_ACTIVE],
        "environments": _env_matrix(rows),
    }


def _env_matrix(rows: list[Row]) -> list[Row]:
    out: dict[str, Row] = {}
    for r in rows:
        k = r["target"]["environment"]["name"]
        e = out.setdefault(k, {"environment": k, "tier": r["target"]["environment"]["tier"], "total": 0,
                               "converged": 0, "attention": 0, "unverifiable": 0})
        e["total"] += 1
        st = r["convergence"]["state"]
        if st == "converged":
            e["converged"] += 1
        elif st == "unverifiable":
            e["unverifiable"] += 1
        elif st not in ("converging", "verifying"):
            e["attention"] += 1
    return sorted(out.values(), key=lambda e: ["dev", "staging", "prod"].index(e["tier"]))


def sim_view(s: Store) -> Row:
    now = clock_now(s)
    sim = s.must("sim_state", "sim")
    return {
        "now": now, "playing": bool(sim["playing"]), "speed": sim["speed"],
        "sources": [{**source_view(s, x, now), "offline": any(f["kind"] == "source_offline" for f in s.where("sim_faults", source_id=x["id"]))}
                    for x in s.rows("data_sources") if x["kind"] != "deployer"],
        "faults": [{**f, "target": (s.get("deployment_targets", f["target_id"]) or {}).get("name"),
                    "source": (s.get("data_sources", f["source_id"]) or {}).get("name")} for f in s.rows("sim_faults")],
        "feed": [{"id": f["id"], "external_id": f["external_id"], "published": bool(f["published"]),
                  "publish_at": f["publish_at"], **{k: jload(f["payload_json"])[k] for k in ("title", "severity")}}
                 for f in s.rows("sim_cve_feed")],
        "running_operations": [{"id": o["id"], "target": s.must("deployment_targets", o["target_id"])["name"],
                                "service_name": o["service_name"], "due_at": o["due_at"], "outcome": o["outcome"]}
                               for o in s.where("sim_operations", status="running")],
        "targets": [{"id": t["id"], "name": t["name"]} for t in sorted(s.rows("deployment_targets"), key=lambda t: t["name"])],
    }
