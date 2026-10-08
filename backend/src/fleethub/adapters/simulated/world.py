"""Simulated adapters. They read and write the ``sim_*`` tables, which play the role of
"what is actually running in the clusters". FleetHub's own tables never get written by them
directly - only through the adapter interfaces - so desired vs observed is genuinely computed.
"""
from __future__ import annotations

from typing import Any

from ...db.store import Store
from ...domain.clock import now as clock_now
from ...domain.util import MINUTE, jdump, jload
from ..interfaces import DeploySpec, ObservedWorkload, OperationStatus, ScanFinding, SourceUnavailable

OP_DURATION_S = (3 * MINUTE, 7 * MINUTE)


def _take_fault(store: Store, kind_filter: set[str], target_id: str) -> str | None:
    for f in sorted(store.where("sim_faults", target_id=target_id), key=lambda f: f["created_at"]):
        if f["kind"] in kind_filter:
            if f["remaining"] > 0:
                if f["remaining"] == 1:
                    store.delete("sim_faults", f["id"])
                else:
                    store.update("sim_faults", f["id"], remaining=f["remaining"] - 1)
            return f["kind"]
    return None


def source_offline(store: Store, source_id: str) -> bool:
    return any(f["kind"] == "source_offline" for f in store.where("sim_faults", source_id=source_id))


class SimulatedDeploymentSystem:
    name = "sim-deployer"

    def __init__(self, store: Store):
        self.store = store

    async def submit(self, spec: DeploySpec) -> str:
        s = self.store
        now = clock_now(s)
        outcome = _take_fault(s, {"fail", "phantom_success", "unhealthy", "no_result"}, spec.target_id) or "success"
        ref = s.new_id("simop")
        s.insert("sim_operations", {
            "id": ref,
            "target_id": spec.target_id,
            "service_name": spec.service_name,
            "spec_json": jdump(spec.__dict__),
            "submitted_at": now,
            "due_at": now + s._rng.randint(*OP_DURATION_S),
            "outcome": outcome,
            "status": "running",
            "reported": None,
        })
        return ref

    async def poll(self, external_ref: str) -> OperationStatus:
        op = self.store.get("sim_operations", external_ref)
        if op is None:
            return OperationStatus("failed", clock_now(self.store), "unknown operation")
        if op["status"] == "running" or op["reported"] is None:
            return OperationStatus("running", None)
        if op["reported"] == "succeeded":
            return OperationStatus("succeeded", op["due_at"], "Rollout complete")
        return OperationStatus("failed", op["due_at"], "Pods failed readiness: CrashLoopBackOff (simulated)")

    async def cancel(self, external_ref: str) -> None:
        op = self.store.get("sim_operations", external_ref)
        if op and op["status"] == "running":
            self.store.update("sim_operations", external_ref, status="cancelled")


def run_due_operations(store: Store, upto: int) -> None:
    """The 'real world' executes operations that are due. This is where faults bite."""
    for op in sorted(store.where("sim_operations", status="running"), key=lambda o: o["due_at"]):
        if op["due_at"] > upto:
            continue
        spec = jload(op["spec_json"])
        outcome = op["outcome"]
        reported = {"success": "succeeded", "phantom_success": "succeeded", "unhealthy": "succeeded",
                    "fail": "failed", "no_result": None}[outcome]
        store.update("sim_operations", op["id"], status="done", reported=reported)
        if outcome in ("fail", "phantom_success"):
            continue  # nothing changes in reality
        wl = store.first("sim_world_workloads", target_id=op["target_id"], service_name=op["service_name"])
        health = "unhealthy" if outcome == "unhealthy" else "healthy"
        ready = max(0, spec["replicas"] - 2) if outcome == "unhealthy" else spec["replicas"]
        vals = {
            "model_raw": spec["model_raw"], "engine_raw": spec["engine_raw"], "image_digest": spec["image_digest"],
            "replicas_ready": ready, "replicas_total": spec["replicas"], "health": health,
            "changed_at": op["due_at"], "changed_by": "deployer",
        }
        if wl is None:
            store.insert("sim_world_workloads", {"id": store.new_id("wl"), "target_id": op["target_id"],
                                                 "service_name": op["service_name"], **vals})
        else:
            store.update("sim_world_workloads", wl["id"], **vals)


class SimulatedInventory:
    def __init__(self, store: Store):
        self.store = store

    async def collect(self, source: dict[str, Any], target: dict[str, Any]) -> list[ObservedWorkload]:
        if source_offline(self.store, source["id"]):
            raise SourceUnavailable(f"{source['name']}: connection timed out (simulated outage)")
        return [
            ObservedWorkload(
                service_name=w["service_name"], model_raw=w["model_raw"], engine_raw=w["engine_raw"],
                image_digest=w["image_digest"], replicas_ready=w["replicas_ready"],
                replicas_total=w["replicas_total"], health=w["health"],
            )
            for w in self.store.where("sim_world_workloads", target_id=target["id"])
        ]


class SimulatedScanner:
    def __init__(self, store: Store):
        self.store = store

    async def scan(self, source: dict[str, Any], image_digests: list[str]) -> list[ScanFinding]:
        if source_offline(self.store, source["id"]):
            raise SourceUnavailable(f"{source['name']}: scanner API unavailable (simulated outage)")
        now = clock_now(self.store)
        wanted = set(image_digests)
        out: list[ScanFinding] = []
        for item in self.store.rows("sim_cve_feed"):
            if item["publish_at"] is None or item["publish_at"] > now:
                continue
            if not item["published"]:
                self.store.update("sim_cve_feed", item["id"], published=1)
            p = jload(item["payload_json"])
            for d in jload(item["image_digests_json"], []):
                if d in wanted:
                    out.append(ScanFinding(image_digest=d, published_at=item["publish_at"], **p))
        return out
