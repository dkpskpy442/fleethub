"""Simulated time. Workers have no background processes, so time only moves when someone
advances it (demo controls / play mode polling). Each cycle runs the full control loop:

  external world executes due operations
  -> FleetHub polls operation results (claims)
  -> inventory + scanner sources sync (evidence)
  -> reconciler derives convergence
  -> rollout engine advances gates/waves (may submit new requests)
  -> vulnerability findings maintained
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..adapters.simulated.world import (
    SimulatedDeploymentSystem,
    SimulatedInventory,
    SimulatedScanner,
    run_due_operations,
    source_offline,
)
from ..db.store import Store
from . import fleet, rollouts, vulns
from .audit import record
from .clock import now as clock_now
from .desired_state import poll_operations
from .errors import DomainError
from .rbac import Actor, require
from .util import HOUR, MINUTE, jload

MAX_ADVANCE_S = 12 * HOUR
PLAY_CAP_S = 30 * MINUTE

Row = dict[str, Any]


@dataclass
class Adapters:
    deployer: SimulatedDeploymentSystem
    inventory: SimulatedInventory
    scanner: SimulatedScanner


def adapters_for(store: Store) -> Adapters:
    return Adapters(SimulatedDeploymentSystem(store), SimulatedInventory(store), SimulatedScanner(store))


def _source_due(src: Row, now: int) -> bool:
    return src["last_sync_at"] is None or now - src["last_sync_at"] >= src["sync_interval_s"]


async def run_cycle(store: Store, ad: Adapters, *, force_sync: bool = False) -> None:
    now = clock_now(store)
    run_due_operations(store, now)
    await poll_operations(store, ad.deployer)
    for src in store.where("data_sources", kind="deployer"):
        store.update("data_sources", src["id"], last_sync_at=now, last_sync_status="ok")
    for src in store.rows("data_sources"):
        if src["kind"] == "deployer" or not (force_sync or _source_due(src, now)):
            continue
        if src["kind"] == "inventory":
            await fleet.sync_inventory_source(store, ad.inventory, src)
        elif src["kind"] == "scanner":
            await vulns.sync_scanner(store, ad.scanner, src)
    fleet.reconcile_all(store)
    await rollouts.step_all(store, ad.deployer)
    fleet.reconcile_all(store)
    vulns.auto_maintain(store)


def _next_event(store: Store, now: int) -> int | None:
    c: list[int] = []
    c += [o["due_at"] for o in store.where("sim_operations", status="running")]
    c += [o["timeout_at"] for o in store.where("external_operations", lambda o: o["status"] in ("pending", "running"))]
    for s in store.rows("data_sources"):
        if s["kind"] in ("inventory", "scanner") and not source_offline(store, s["id"]):
            c.append((s["last_sync_at"] or now) + s["sync_interval_s"])
    for t in store.rows("rollout_targets"):
        if t["status"] in ("verifying", "applying"):
            c += [x for x in (t["verify_deadline"], t["bake_until"]) if x]
    c += [f["publish_at"] for f in store.rows("sim_cve_feed") if f["publish_at"] and not f["published"]]
    c += [f["accepted_until"] for f in store.rows("vulnerability_findings")
          if f["status"] == "risk_accepted" and f["accepted_until"]]
    future = [x for x in c if x > now]
    return min(future) if future else None


def _set_now(store: Store, t: int) -> None:
    store.update("sim_state", "sim", now=t)


async def advance(store: Store, ad: Adapters, seconds: int) -> int:
    if seconds < 0 or seconds > MAX_ADVANCE_S:
        raise DomainError(f"Can advance between 0 and {MAX_ADVANCE_S // HOUR}h at a time.")
    start = clock_now(store)
    target = start + seconds
    await run_cycle(store, ad)
    for _ in range(2000):
        now = clock_now(store)
        if now >= target:
            break
        nxt = _next_event(store, now)
        nxt = target if nxt is None or nxt > target else nxt
        _set_now(store, max(nxt, now + 1))
        await run_cycle(store, ad)
    return clock_now(store) - start


async def tick(store: Store, ad: Adapters, real_ms: int) -> int:
    """Play mode: advance by elapsed real time x speed (capped)."""
    sim = store.must("sim_state", "sim")
    moved = 0
    if sim["playing"] and sim["last_real_ms"]:
        elapsed = max(0, real_ms - sim["last_real_ms"]) / 1000
        moved = await advance(store, ad, int(min(elapsed * sim["speed"], PLAY_CAP_S)))
    else:
        await run_cycle(store, ad)
    store.update("sim_state", "sim", last_real_ms=real_ms)
    return moved


# ------------------------------------------------------------------ demo controls ("the outside world")
def _sim_audit(store: Store, actor: Actor, action: str, summary: str, entity_type: str = "simulation",
               entity_id: str = "sim") -> None:
    record(store, actor, f"sim.{action}", entity_type, entity_id, f"[simulated external event] {summary}")


def set_playing(store: Store, actor: Actor, playing: bool, speed: int | None, real_ms: int) -> None:
    require(actor, "sim.control")
    changes: Row = {"playing": int(playing), "last_real_ms": real_ms}
    if speed:
        changes["speed"] = max(1, min(int(speed), 600))
    store.update("sim_state", "sim", **changes)


def inject_drift(store: Store, actor: Actor, deployment_id: str, kind: str) -> None:
    require(actor, "sim.control")
    dep = store.must("deployments", deployment_id)
    wl = store.first("sim_world_workloads", target_id=dep["target_id"], service_name=dep["service_name"])
    if wl is None:
        raise DomainError("Workload is not running in the simulated world.")
    now = clock_now(store)
    if kind == "image_hotfix":
        # Someone pushed a rebuilt image with the same tag directly to the cluster.
        digest = "sha256:" + "".join(store._rng.choice("0123456789abcdef") for _ in range(64))
        store.update("sim_world_workloads", wl["id"], image_digest=digest, changed_at=now, changed_by="manual")
        summary = f"Manual hotfix image pushed to {dep['service_name']} (unregistered digest)"
    elif kind == "engine_downgrade":
        imgs = []
        for ev in store.rows("engine_versions"):
            for img in store.where("engine_images", engine_version_id=ev["id"]):
                imgs.append((ev, img))
        cur = store.first("engine_images", digest=wl["image_digest"])
        same_engine = [(ev, img) for ev, img in imgs if cur and ev["engine_id"] ==
                       store.must("engine_versions", cur["engine_version_id"])["engine_id"] and img["id"] != cur["id"]
                       and img["accelerator"] == cur["accelerator"]]
        if not same_engine:
            raise DomainError("No alternative engine image available for this workload.")
        ev, img = sorted(same_engine, key=lambda p: p[0]["released_at"])[0]
        eng = store.must("engines", ev["engine_id"])
        store.update("sim_world_workloads", wl["id"], image_digest=img["digest"], engine_raw=f"{eng['slug']}:{ev['version']}",
                     changed_at=now, changed_by="manual")
        summary = f"Manual kubectl change: {dep['service_name']} switched to {eng['name']} {ev['version']}"
    elif kind == "unhealthy":
        store.update("sim_world_workloads", wl["id"], health="unhealthy",
                     replicas_ready=max(0, wl["replicas_total"] - 2), changed_at=now, changed_by="manual")
        summary = f"{dep['service_name']} started failing health checks"
    elif kind == "recover":
        store.update("sim_world_workloads", wl["id"], health="healthy", replicas_ready=wl["replicas_total"],
                     changed_at=now, changed_by="manual")
        summary = f"{dep['service_name']} recovered"
    elif kind == "delete":
        store.delete("sim_world_workloads", wl["id"])
        summary = f"{dep['service_name']} was deleted out-of-band"
    else:
        raise DomainError(f"Unknown drift kind {kind}")
    _sim_audit(store, actor, "inject_drift", summary, "deployment", deployment_id)


def set_source_offline(store: Store, actor: Actor, source_id: str, offline: bool) -> None:
    require(actor, "sim.control")
    src = store.must("data_sources", source_id)
    existing = [f for f in store.where("sim_faults", source_id=source_id) if f["kind"] == "source_offline"]
    if offline and not existing:
        store.insert("sim_faults", {"id": store.new_id("fault"), "kind": "source_offline", "target_id": None,
                                    "source_id": source_id, "remaining": -1, "created_at": clock_now(store),
                                    "note": "outage"})
    if not offline:
        for f in existing:
            store.delete("sim_faults", f["id"])
    _sim_audit(store, actor, "source_outage", f"{src['name']} {'went offline' if offline else 'came back online'}",
               "data_source", source_id)


def arm_fault(store: Store, actor: Actor, target_id: str, kind: str) -> None:
    require(actor, "sim.control")
    if kind not in ("fail", "phantom_success", "unhealthy", "no_result"):
        raise DomainError(f"Unknown fault {kind}")
    t = store.must("deployment_targets", target_id)
    store.insert("sim_faults", {"id": store.new_id("fault"), "kind": kind, "target_id": target_id, "source_id": None,
                                "remaining": 1, "created_at": clock_now(store), "note": None})
    _sim_audit(store, actor, "arm_fault", f"Next deployment on {t['name']} will: {kind.replace('_', ' ')}",
               "deployment_target", target_id)


def clear_fault(store: Store, actor: Actor, fault_id: str) -> None:
    require(actor, "sim.control")
    store.must("sim_faults", fault_id)
    store.delete("sim_faults", fault_id)


def publish_cve(store: Store, actor: Actor, feed_id: str) -> None:
    require(actor, "sim.control")
    item = store.must("sim_cve_feed", feed_id)
    if item["published"]:
        raise DomainError("Already published.")
    store.update("sim_cve_feed", feed_id, publish_at=clock_now(store))
    # Make the scanner pick it up on the next cycle.
    for s in store.where("data_sources", kind="scanner"):
        store.update("data_sources", s["id"], last_sync_at=(s["last_sync_at"] or 0) - s["sync_interval_s"])
    _sim_audit(store, actor, "publish_cve", f"{item['external_id']} published to the CVE feed: "
               f"{jload(item['payload_json'])['title']}")


def add_manual_workload(store: Store, actor: Actor, target_id: str, service_name: str, image_id: str,
                        model_version_id: str, replicas: int) -> None:
    require(actor, "sim.control")
    from . import lookups as L

    if store.first("sim_world_workloads", target_id=target_id, service_name=service_name):
        raise DomainError("A workload with that name already runs on this cluster.")
    img = store.must("engine_images", image_id)
    store.insert("sim_world_workloads", {
        "id": store.new_id("wl"), "target_id": target_id, "service_name": service_name,
        "model_raw": L.model_raw(store, model_version_id), "engine_raw": L.engine_raw(store, img["engine_version_id"]),
        "image_digest": img["digest"], "replicas_ready": replicas, "replicas_total": replicas, "health": "healthy",
        "changed_at": clock_now(store), "changed_by": "manual",
    })
    _sim_audit(store, actor, "manual_deploy", f"Engineer deployed '{service_name}' by hand with helm (outside FleetHub)",
               "deployment_target", target_id)
