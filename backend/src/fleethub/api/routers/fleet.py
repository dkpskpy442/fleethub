from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ...domain import fleet, vulns
from .. import views
from ..context import Ctx, get_ctx, history

router = APIRouter()


@router.get("/fleet")
async def list_fleet(ctx: Ctx = Depends(get_ctx)) -> list[dict]:
    return views.fleet(ctx.store)


async def _detail(ctx: Ctx, dep_id: str) -> dict:
    dep = ctx.store.must("deployments", dep_id)
    audit = await history(ctx.db, "audit_log", "entity_type = 'deployment' AND entity_id = ?", [dep_id], 50)
    obs = await history(ctx.db, "deployment_observations", "deployment_id = ?", [dep_id], 30, "observed_at DESC, id DESC")
    tids = [t["id"] for t in ctx.store.where("rollout_targets", deployment_id=dep_id)]
    events: list[dict] = []
    if tids:
        marks = ",".join("?" for _ in tids)
        events = await history(ctx.db, "rollout_events", f"target_id IN ({marks})", tids, 40)
    return views.deployment_detail(ctx.store, dep, audit, obs, events)


@router.get("/deployments/{dep_id}")
async def get_deployment(dep_id: str, ctx: Ctx = Depends(get_ctx)) -> dict:
    return await _detail(ctx, dep_id)


class ReasonBody(BaseModel):
    reason: str = ""


@router.post("/deployments/{dep_id}/adopt")
async def adopt(dep_id: str, body: ReasonBody, ctx: Ctx = Depends(get_ctx)) -> dict:
    fleet.adopt(ctx.store, ctx.actor, ctx.store.must("deployments", dep_id), body.reason)
    await ctx.commit()
    return await _detail(ctx, dep_id)


@router.post("/deployments/{dep_id}/reconcile")
async def reconcile(dep_id: str, body: ReasonBody, ctx: Ctx = Depends(get_ctx)) -> dict:
    await fleet.reconcile(ctx.store, ctx.adapters.deployer, ctx.actor, ctx.store.must("deployments", dep_id), body.reason)
    await ctx.commit()
    return await _detail(ctx, dep_id)


@router.post("/deployments/{dep_id}/accept-observed")
async def accept_observed(dep_id: str, body: ReasonBody, ctx: Ctx = Depends(get_ctx)) -> dict:
    fleet.accept_observed(ctx.store, ctx.actor, ctx.store.must("deployments", dep_id), body.reason)
    await ctx.commit()
    return await _detail(ctx, dep_id)


@router.get("/targets/{target_id}")
async def get_target(target_id: str, ctx: Ctx = Depends(get_ctx)) -> dict:
    s = ctx.store
    t = s.must("deployment_targets", target_id)
    now = s.must("sim_state", "sim")["now"]
    rows = [r for r in views.fleet(s) if r["target"]["id"] == target_id]
    return {**views.target_view(s, t), "deployer": t["deployer"],
            "source": views.source_view(s, s.must("data_sources", t["inventory_source_id"]), now),
            "deployments": rows}


# ------------------------------------------------------------------ vulnerabilities
@router.get("/vulnerabilities")
async def list_vulns(ctx: Ctx = Depends(get_ctx)) -> list[dict]:
    return views.vulnerabilities(ctx.store)


@router.get("/vulnerabilities/{vuln_id}")
async def get_vuln(vuln_id: str, ctx: Ctx = Depends(get_ctx)) -> dict:
    v = ctx.store.must("vulnerabilities", vuln_id)
    audit = await history(ctx.db, "audit_log", "entity_type = 'vulnerability' AND entity_id = ?", [vuln_id], 50)
    return views.vulnerability(ctx.store, v, audit)


class TriageBody(BaseModel):
    status: str
    notes: str = ""
    accepted_until: int | None = None


@router.post("/findings/{finding_id}/triage")
async def triage(finding_id: str, body: TriageBody, ctx: Ctx = Depends(get_ctx)) -> dict:
    f = ctx.store.must("vulnerability_findings", finding_id)
    vulns.triage(ctx.store, ctx.actor, f, body.status, body.notes, body.accepted_until)
    await ctx.commit()
    return {"ok": True}
