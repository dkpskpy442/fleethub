"""Model / engine catalogs and compatibility records."""
from __future__ import annotations

import re
from typing import Any

from ..db.store import Store
from . import lookups as L
from .audit import record
from .clock import now as clock_now
from .enums import COMPAT_STATUS, ENGINE_TRANSITIONS, MODEL_TRANSITIONS
from .errors import Conflict, DomainError
from .rbac import Actor, require

Row = dict[str, Any]

DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def transition_model(store: Store, actor: Actor, mv: Row, to: str, reason: str) -> Row:
    fam = store.must("model_families", mv["family_id"])
    require(actor, "model.lifecycle", owner_team_id=fam["owner_team_id"])
    frm = mv["lifecycle"]
    if to not in MODEL_TRANSITIONS.get(frm, set()):
        allowed = ", ".join(sorted(MODEL_TRANSITIONS.get(frm, set()))) or "none (terminal)"
        raise Conflict(f"Cannot move model version from {frm} to {to}. Allowed: {allowed}.", code="invalid_transition")
    if not reason.strip():
        raise DomainError("A reason is required for lifecycle changes.")
    if to == "retired":
        running = [d for d in store.rows("deployments")
                   if (L.current_revision(store, d) or {}).get("model_version_id") == mv["id"]]
        if running:
            raise Conflict(f"Cannot retire: {len(running)} deployment(s) still target this version. Roll them forward first.",
                           code="in_use", details=[d["id"] for d in running])
    store.update("model_versions", mv["id"], lifecycle=to, lifecycle_changed_at=clock_now(store))
    record(store, actor, "model_version.lifecycle", "model_version", mv["id"],
           f"{fam['name']} {mv['version']}: {frm} -> {to}", before={"lifecycle": frm}, after={"lifecycle": to},
           reason=reason)
    return mv


def transition_engine(store: Store, actor: Actor, ev: Row, to: str, reason: str) -> Row:
    require(actor, "engine.lifecycle")
    eng = store.must("engines", ev["engine_id"])
    frm = ev["lifecycle"]
    if to not in ENGINE_TRANSITIONS.get(frm, set()):
        allowed = ", ".join(sorted(ENGINE_TRANSITIONS.get(frm, set()))) or "none (terminal)"
        raise Conflict(f"Cannot move engine version from {frm} to {to}. Allowed: {allowed}.", code="invalid_transition")
    if not reason.strip():
        raise DomainError("A reason is required for lifecycle changes.")
    store.update("engine_versions", ev["id"], lifecycle=to, lifecycle_changed_at=clock_now(store))
    record(store, actor, "engine_version.lifecycle", "engine_version", ev["id"],
           f"{eng['name']} {ev['version']}: {frm} -> {to}", before={"lifecycle": frm}, after={"lifecycle": to},
           reason=reason)
    return ev


def register_model_version(store: Store, actor: Actor, fam: Row, p: Row) -> Row:
    require(actor, "model.edit", owner_team_id=fam["owner_team_id"])
    version = (p.get("version") or "").strip()
    if not version:
        raise DomainError("Version is required.")
    if store.first("model_versions", family_id=fam["id"], version=version):
        raise Conflict(f"{fam['name']} {version} already exists.")
    if not DIGEST_RE.match(p.get("artifact_digest") or ""):
        raise DomainError("artifact_digest must look like sha256:<64 hex>.")
    now = clock_now(store)
    mv = store.insert("model_versions", {
        "id": store.new_id("mv"), "family_id": fam["id"], "version": version, "lifecycle": "experimental",
        "artifact_uri": p["artifact_uri"], "artifact_digest": p["artifact_digest"], "format": p.get("format") or "safetensors",
        "quantization": p.get("quantization") or "bf16", "params_b": float(p.get("params_b") or 0),
        "context_len": int(p.get("context_len") or 8192), "released_at": now, "lifecycle_changed_at": now,
        "notes": p.get("notes"),
    })
    record(store, actor, "model_version.register", "model_version", mv["id"],
           f"Registered {fam['name']} {version} (experimental)", after={"artifact_uri": mv["artifact_uri"]})
    return mv


def register_engine_version(store: Store, actor: Actor, eng: Row, p: Row) -> Row:
    require(actor, "engine.edit")
    version = (p.get("version") or "").strip()
    if not version:
        raise DomainError("Version is required.")
    if store.first("engine_versions", engine_id=eng["id"], version=version):
        raise Conflict(f"{eng['name']} {version} already exists.")
    images = p.get("images") or []
    if not images:
        raise DomainError("At least one container image is required.")
    now = clock_now(store)
    ev = store.insert("engine_versions", {
        "id": store.new_id("ev"), "engine_id": eng["id"], "version": version, "lifecycle": "preview",
        "released_at": now, "lifecycle_changed_at": now, "release_notes": p.get("release_notes"),
    })
    for im in images:
        if not DIGEST_RE.match(im.get("digest") or ""):
            raise DomainError("Image digest must look like sha256:<64 hex>.")
        if store.first("engine_images", digest=im["digest"]):
            raise Conflict(f"Image digest {im['digest'][:19]}... is already registered.")
        if not im.get("hardware_type_ids"):
            raise DomainError("Each image must list supported hardware.")
        img = store.insert("engine_images", {
            "id": store.new_id("img"), "engine_version_id": ev["id"], "repo": im["repo"], "tag": im["tag"],
            "digest": im["digest"], "accelerator": im.get("accelerator") or "cuda", "built_at": now,
        })
        for hw in im["hardware_type_ids"]:
            store.must("hardware_types", hw)
            store.insert("engine_image_hardware", {"id": f"{img['id']}:{hw}", "image_id": img["id"],
                                                   "hardware_type_id": hw})
    record(store, actor, "engine_version.register", "engine_version", ev["id"],
           f"Registered {eng['name']} {version} (preview) with {len(images)} image(s)")
    return ev


def upsert_compat(store: Store, actor: Actor, mv_id: str, ev_id: str, hw_id: str, status: str,
                  notes: str | None, evidence_url: str | None) -> Row | None:
    mv = store.must("model_versions", mv_id)
    fam = store.must("model_families", mv["family_id"])
    store.must("engine_versions", ev_id)
    store.must("hardware_types", hw_id)
    require(actor, "compat.edit", owner_team_id=fam["owner_team_id"])
    rec = store.first("compatibility_records", model_version_id=mv_id, engine_version_id=ev_id, hardware_type_id=hw_id)
    before = {"status": rec["status"]} if rec else {"status": "untested"}
    label = f"{L.model_label(store, mv_id)} x {L.engine_label(store, ev_id)} on {store.must('hardware_types', hw_id)['name']}"
    now = clock_now(store)
    if status == "untested":
        if rec:
            store.delete("compatibility_records", rec["id"])
        out = None
    elif status not in COMPAT_STATUS:
        raise DomainError(f"Unknown compatibility status {status}")
    elif rec:
        out = store.update("compatibility_records", rec["id"], status=status, notes=notes, evidence_url=evidence_url,
                           verified_by=actor.id, verified_at=now)
    else:
        out = store.insert("compatibility_records", {
            "id": store.new_id("cmp"), "model_version_id": mv_id, "engine_version_id": ev_id, "hardware_type_id": hw_id,
            "status": status, "evidence_url": evidence_url, "notes": notes, "verified_by": actor.id, "verified_at": now,
        })
    record(store, actor, "compatibility.set", "model_version", mv_id, f"{label}: {before['status']} -> {status}",
           before=before, after={"status": status}, reason=notes)
    return out
