"""Vulnerabilities: findings are attached to image digests and rolled up to engine versions.

Exposure is computed two ways and shown separately:
  * observed - inventory reports a deployment running the affected digest (truth about reality)
  * desired  - a managed deployment's desired revision points at the affected image (intent)
"""
from __future__ import annotations

from typing import Any

from ..adapters.interfaces import SourceUnavailable, VulnerabilityScanner
from ..db.store import Store
from . import guardrails
from . import lookups as L
from .audit import record
from .clock import now as clock_now
from .enums import FINDING_ACTIVE, FINDING_STATUS
from .errors import DomainError
from .rbac import SYSTEM, Actor, require
from .reconciler import deployment_freshness

Row = dict[str, Any]


async def sync_scanner(store: Store, scanner: VulnerabilityScanner, source: Row) -> bool:
    now = clock_now(store)
    digests = [i["digest"] for i in store.rows("engine_images")]
    try:
        findings = await scanner.scan(source, digests)
    except SourceUnavailable as e:
        store.update("data_sources", source["id"], last_sync_status="error", last_error=str(e))
        return False
    for f in findings:
        v = store.first("vulnerabilities", external_id=f.external_id)
        if v is None:
            v = store.insert("vulnerabilities", {
                "id": store.new_id("vuln"), "external_id": f.external_id, "title": f.title,
                "severity": f.severity, "cvss": f.cvss, "package": f.package, "description": f.description,
                "fixed_in_note": f.fixed_in_note, "published_at": f.published_at,
            })
        img = L.image_by_digest(store, f.image_digest)
        if img is None or store.first("vulnerability_findings", vulnerability_id=v["id"], image_id=img["id"]):
            continue
        fnd = store.insert("vulnerability_findings", {
            "id": store.new_id("fnd"), "vulnerability_id": v["id"], "image_id": img["id"],
            "source_id": source["id"], "status": "open", "detected_at": now, "status_changed_at": now,
            "accepted_until": None, "notes": None, "updated_by": "system",
        })
        record(store, SYSTEM, "finding.detected", "vulnerability", v["id"],
               f"{source['name']} reported {f.external_id} ({f.severity}) on {img['repo']}:{img['tag']}",
               after={"finding_id": fnd["id"], "image": img["digest"]})
    store.update("data_sources", source["id"], last_sync_at=now, last_sync_status="ok", last_error=None)
    return True


def image_exposure(store: Store, image_id: str) -> dict[str, list[Row]]:
    observed, desired = [], []
    for dep in store.rows("deployments"):
        obs = L.latest_obs(store, dep)
        if obs and obs["present"] and obs["image_id"] == image_id:
            observed.append(dep)
        rev = L.current_revision(store, dep)
        if dep["managed"] and rev and rev["image_id"] == image_id:
            desired.append(dep)
    return {"observed": observed, "desired": desired}


def affected_images(store: Store, vuln_id: str, *, active_only: bool = False) -> list[Row]:
    out = []
    for f in store.where("vulnerability_findings", vulnerability_id=vuln_id):
        if active_only and f["status"] not in FINDING_ACTIVE:
            continue
        out.append(f)
    return out


def exposure(store: Store, vuln_id: str) -> list[Row]:
    """One row per (deployment) exposed via observed or desired image."""
    now = clock_now(store)
    rows: dict[str, Row] = {}
    for f in affected_images(store, vuln_id):
        ex = image_exposure(store, f["image_id"])
        for kind in ("observed", "desired"):
            for dep in ex[kind]:
                r = rows.setdefault(dep["id"], {"deployment_id": dep["id"], "observed": False, "desired": False,
                                                "finding_id": f["id"], "finding_status": f["status"]})
                r[kind] = True
    for r in rows.values():
        dep = store.must("deployments", r["deployment_id"])
        ctx = L.target_ctx(store, dep["target_id"])
        r["freshness"] = deployment_freshness(L.latest_obs(store, dep), ctx["source"], now).state
    return list(rows.values())


def remediation_options(store: Store, vuln_id: str) -> list[Row]:
    affected = affected_images(store, vuln_id)
    affected_image_ids = {f["image_id"] for f in affected}
    affected_evs = {store.must("engine_images", i)["engine_version_id"] for i in affected_image_ids}
    engine_ids = {store.must("engine_versions", ev)["engine_id"] for ev in affected_evs}
    exposed = [store.must("deployments", r["deployment_id"]) for r in exposure(store, vuln_id)]
    managed = [d for d in exposed if d["managed"]]
    options = []
    for ev in store.rows("engine_versions"):
        if ev["engine_id"] not in engine_ids or ev["id"] in affected_evs or ev["lifecycle"] == "eol":
            continue
        imgs = store.where("engine_images", engine_version_id=ev["id"])
        if any(i["id"] in affected_image_ids for i in imgs):
            continue
        per_dep = []
        counts = {"ok": 0, "warn": 0, "blocked": 0, "no_change": 0}
        for d in managed:
            mv, _ = guardrails.spec_for_change(store, d, "engine", None, ev["id"])
            res = guardrails.evaluate(store, d, mv, ev["id"], check_lock=True)
            counts[res.outcome] += 1
            per_dep.append(res.to_json())
        options.append({
            "engine_version_id": ev["id"],
            "label": L.engine_label(store, ev["id"]),
            "lifecycle": ev["lifecycle"],
            "released_at": ev["released_at"],
            "counts": counts,
            "unmanaged_exposed": len(exposed) - len(managed),
            "deployments": per_dep,
        })
    # Prefer the option that lets the most exposed deployments move without exceptions.
    options.sort(key=lambda o: (-o["counts"]["ok"], o["counts"]["blocked"], o["counts"]["warn"], -o["released_at"]))
    return options


def triage(store: Store, actor: Actor, finding: Row, status: str, notes: str, accepted_until: int | None) -> Row:
    require(actor, "finding.triage")
    if status not in FINDING_STATUS:
        raise DomainError(f"Unknown finding status {status}")
    now = clock_now(store)
    if status == "risk_accepted":
        if not accepted_until or accepted_until <= now:
            raise DomainError("Risk acceptance requires an expiry in the future.")
        if not notes.strip():
            raise DomainError("Risk acceptance requires a justification.")
    before = {"status": finding["status"], "accepted_until": finding["accepted_until"]}
    store.update("vulnerability_findings", finding["id"], status=status, notes=notes or finding["notes"],
                 accepted_until=accepted_until if status == "risk_accepted" else None,
                 status_changed_at=now, updated_by=actor.id)
    v = store.must("vulnerabilities", finding["vulnerability_id"])
    img = store.must("engine_images", finding["image_id"])
    record(store, actor, "finding.triage", "vulnerability", v["id"],
           f"{v['external_id']} on {img['repo']}:{img['tag']}: {before['status']} -> {status}",
           before=before, after={"status": status, "accepted_until": accepted_until}, reason=notes)
    return finding


def auto_maintain(store: Store) -> None:
    """System transitions: close findings with zero exposure; reopen expired risk acceptances."""
    now = clock_now(store)
    for f in store.rows("vulnerability_findings"):
        v = store.must("vulnerabilities", f["vulnerability_id"])
        if f["status"] == "risk_accepted" and f["accepted_until"] and f["accepted_until"] <= now:
            store.update("vulnerability_findings", f["id"], status="open", status_changed_at=now, updated_by="system")
            record(store, SYSTEM, "finding.risk_expired", "vulnerability", v["id"],
                   f"Risk acceptance for {v['external_id']} expired; finding reopened")
        elif f["status"] in FINDING_ACTIVE and _was_deployed(store, f["image_id"]):
            ex = image_exposure(store, f["image_id"])
            if not ex["observed"] and not ex["desired"]:
                store.update("vulnerability_findings", f["id"], status="remediated", status_changed_at=now,
                             updated_by="system")
                img = store.must("engine_images", f["image_id"])
                record(store, SYSTEM, "finding.remediated", "vulnerability", v["id"],
                       f"{v['external_id']}: no deployment runs or targets {img['repo']}:{img['tag']} any more; "
                       "finding marked remediated")


def _was_deployed(store: Store, image_id: str) -> bool:
    return any(r["image_id"] == image_id for r in store.rows("desired_state_revisions"))
