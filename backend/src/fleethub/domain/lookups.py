"""Small read helpers shared by services and views."""
from __future__ import annotations

from typing import Any

from ..db.store import Store

Row = dict[str, Any]


def model_label(store: Store, mv_id: str | None) -> str | None:
    mv = store.get("model_versions", mv_id)
    if mv is None:
        return None
    fam = store.must("model_families", mv["family_id"])
    return f"{fam['name']} {mv['version']}"


def engine_label(store: Store, ev_id: str | None) -> str | None:
    ev = store.get("engine_versions", ev_id)
    if ev is None:
        return None
    eng = store.must("engines", ev["engine_id"])
    return f"{eng['name']} {ev['version']}"


def model_raw(store: Store, mv_id: str) -> str:
    mv = store.must("model_versions", mv_id)
    fam = store.must("model_families", mv["family_id"])
    return f"{fam['slug']}:{mv['version']}"


def engine_raw(store: Store, ev_id: str) -> str:
    ev = store.must("engine_versions", ev_id)
    eng = store.must("engines", ev["engine_id"])
    return f"{eng['slug']}:{ev['version']}"


def resolve_model_raw(store: Store, raw: str | None) -> str | None:
    if not raw or ":" not in raw:
        return None
    slug, version = raw.split(":", 1)
    fam = store.first("model_families", slug=slug)
    if fam is None:
        return None
    mv = store.first("model_versions", family_id=fam["id"], version=version)
    return mv["id"] if mv else None


def resolve_engine_raw(store: Store, raw: str | None) -> str | None:
    if not raw or ":" not in raw:
        return None
    slug, version = raw.split(":", 1)
    eng = store.first("engines", slug=slug)
    if eng is None:
        return None
    ev = store.first("engine_versions", engine_id=eng["id"], version=version)
    return ev["id"] if ev else None


def image_by_digest(store: Store, digest: str | None) -> Row | None:
    if not digest:
        return None
    return store.first("engine_images", digest=digest)


def image_hardware(store: Store, image_id: str) -> set[str]:
    return {r["hardware_type_id"] for r in store.where("engine_image_hardware", image_id=image_id)}


def pick_image(store: Store, ev_id: str, hardware_type_id: str) -> Row | None:
    """Newest image of an engine version that supports the given hardware."""
    candidates = [
        img for img in store.where("engine_images", engine_version_id=ev_id)
        if hardware_type_id in image_hardware(store, img["id"])
    ]
    candidates.sort(key=lambda i: i["built_at"], reverse=True)
    return candidates[0] if candidates else None


def target_ctx(store: Store, target_id: str) -> dict[str, Row]:
    t = store.must("deployment_targets", target_id)
    return {
        "target": t,
        "environment": store.must("environments", t["environment_id"]),
        "region": store.must("regions", t["region_id"]),
        "hardware": store.must("hardware_types", t["hardware_type_id"]),
        "source": store.must("data_sources", t["inventory_source_id"]),
    }


def is_prod(store: Store, deployment: Row) -> bool:
    return target_ctx(store, deployment["target_id"])["environment"]["tier"] == "prod"


def current_revision(store: Store, deployment: Row) -> Row | None:
    return store.get("desired_state_revisions", deployment.get("current_revision_id"))


def latest_obs(store: Store, deployment: Row) -> Row | None:
    return store.get("deployment_observations", deployment.get("latest_observation_id"))


def latest_request(store: Store, deployment_id: str, revision_id: str | None) -> Row | None:
    if revision_id is None:
        return None
    reqs = store.where("deployment_requests", deployment_id=deployment_id, revision_id=revision_id)
    reqs = [r for r in reqs if r["status"] != "superseded"]
    reqs.sort(key=lambda r: (r["requested_at"], r["attempt"]))
    return reqs[-1] if reqs else None


def request_operation(store: Store, request_id: str | None) -> Row | None:
    if request_id is None:
        return None
    ops = store.where("external_operations", request_id=request_id)
    ops.sort(key=lambda o: o["started_at"])
    return ops[-1] if ops else None


def user_name(store: Store, user_id: str | None) -> str | None:
    if user_id in (None, "system"):
        return "FleetHub (system)" if user_id == "system" else None
    u = store.get("users", user_id)
    return u["name"] if u else user_id
