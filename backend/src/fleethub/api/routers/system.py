from __future__ import annotations

import time

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel

from ...domain import simulation
from ...domain.enums import (
    COMPAT_STATUS,
    CONVERGENCE,
    ENGINE_LIFECYCLE,
    ENGINE_TRANSITIONS,
    FINDING_STATUS,
    FRESHNESS,
    HEALTH,
    MODEL_LIFECYCLE,
    MODEL_TRANSITIONS,
    ROLES,
    ROLLOUT_STATUS,
)
from ...domain.errors import DomainError
from ...domain.rbac import DESCRIPTIONS, Actor, permissions_for, require
from ...seed.loader import reset
from .. import views
from ..context import (
    NOT_CONFIGURED,
    SESSION_COOKIE,
    SESSION_TTL_S,
    Ctx,
    demo_password,
    get_ctx,
    history,
    make_session,
    session_valid,
)

public = APIRouter()
router = APIRouter()


@public.get("/health")
async def health() -> dict:
    return {"ok": True}


class LoginBody(BaseModel):
    password: str


@public.get("/auth/status")
async def auth_status(request: Request) -> dict:
    return {"required": demo_password(request) is not None, "authenticated": session_valid(request)}


@public.post("/auth/login")
async def login(body: LoginBody, request: Request, response: Response) -> dict:
    pw = demo_password(request)
    if pw is NOT_CONFIGURED:
        raise DomainError("DEMO_PASSWORD is not configured for this deployment.", code="auth_not_configured")
    if pw is not None and body.password != pw:
        raise DomainError("Incorrect password.", code="bad_password")
    response.set_cookie(SESSION_COOKIE, make_session(request), max_age=SESSION_TTL_S, httponly=True,
                        samesite="lax", secure=request.url.scheme == "https")
    return {"ok": True}


@public.post("/auth/logout")
async def logout(response: Response) -> dict:
    response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


def _me(ctx: Ctx) -> dict:
    s = ctx.store
    users = sorted(s.rows("users"), key=lambda u: ROLES.index(u["role"]))
    return {
        "user": {**s.must("users", ctx.actor.id), "permissions": permissions_for(ctx.actor)},
        "personas": [{**u, "team": s.must("teams", u["team_id"])["name"], "role_description": DESCRIPTIONS[u["role"]],
                      "permissions": permissions_for(Actor(u["id"], u["name"], u["role"], u["team_id"]))} for u in users],
    }


@router.get("/me")
async def me(ctx: Ctx = Depends(get_ctx)) -> dict:
    return _me(ctx)


@router.get("/meta")
async def meta(ctx: Ctx = Depends(get_ctx)) -> dict:
    s = ctx.store
    return {
        "enums": {"model_lifecycle": MODEL_LIFECYCLE, "engine_lifecycle": ENGINE_LIFECYCLE, "compat_status": COMPAT_STATUS,
                  "health": HEALTH, "freshness": FRESHNESS, "convergence": CONVERGENCE, "finding_status": FINDING_STATUS,
                  "rollout_status": ROLLOUT_STATUS, "roles": ROLES,
                  "model_transitions": {k: sorted(v) for k, v in MODEL_TRANSITIONS.items()},
                  "engine_transitions": {k: sorted(v) for k, v in ENGINE_TRANSITIONS.items()}},
        "environments": sorted(s.rows("environments"), key=lambda e: e["sort"]),
        "regions": sorted(s.rows("regions"), key=lambda r: r["sort"]),
        "hardware": sorted(s.rows("hardware_types"), key=lambda h: h["name"]),
        "teams": s.rows("teams"),
        "targets": [views.target_view(s, t) for t in sorted(s.rows("deployment_targets"), key=lambda t: t["name"])],
        "sim": {k: v for k, v in views.sim_view(s).items() if k in ("now", "playing", "speed")},
    }


@router.get("/overview")
async def overview(ctx: Ctx = Depends(get_ctx)) -> dict:
    return views.overview(ctx.store)


@router.get("/audit")
async def audit(entity_type: str | None = None, entity_id: str | None = None, actor_id: str | None = None,
                action: str | None = None, limit: int = 200, ctx: Ctx = Depends(get_ctx)) -> list[dict]:
    where, params = ["1=1"], []
    for col, val in (("entity_type", entity_type), ("entity_id", entity_id), ("actor_id", actor_id)):
        if val:
            where.append(f"{col} = ?")
            params.append(val)
    if action:
        where.append("action LIKE ?")
        params.append(f"{action}%")
    rows = await history(ctx.db, "audit_log", " AND ".join(where), params, min(limit, 500), "at DESC, id DESC")
    return [views.audit_view(ctx.store, a) for a in rows]


# ------------------------------------------------------------------ simulation / demo controls
@router.get("/sim")
async def sim(ctx: Ctx = Depends(get_ctx)) -> dict:
    return views.sim_view(ctx.store)


def _real_ms() -> int:
    return int(time.time() * 1000)


class AdvanceBody(BaseModel):
    minutes: int


@router.post("/sim/advance")
async def sim_advance(body: AdvanceBody, ctx: Ctx = Depends(get_ctx)) -> dict:
    require(ctx.actor, "sim.control")
    moved = await simulation.advance(ctx.store, ctx.adapters, body.minutes * 60)
    await ctx.store.flush()
    return {"moved_s": moved, **views.sim_view(ctx.store)}


@router.post("/sim/tick")
async def sim_tick(ctx: Ctx = Depends(get_ctx)) -> dict:
    moved = await simulation.tick(ctx.store, ctx.adapters, _real_ms())
    await ctx.store.flush()
    sim = ctx.store.must("sim_state", "sim")
    return {"moved_s": moved, "now": sim["now"], "playing": bool(sim["playing"]), "speed": sim["speed"]}


class PlayBody(BaseModel):
    playing: bool
    speed: int | None = None


@router.post("/sim/play")
async def sim_play(body: PlayBody, ctx: Ctx = Depends(get_ctx)) -> dict:
    simulation.set_playing(ctx.store, ctx.actor, body.playing, body.speed, _real_ms())
    await ctx.store.flush()
    return views.sim_view(ctx.store)


@router.post("/sim/sync")
async def sim_sync(ctx: Ctx = Depends(get_ctx)) -> dict:
    require(ctx.actor, "sim.control")
    await simulation.run_cycle(ctx.store, ctx.adapters, force_sync=True)
    await ctx.store.flush()
    return views.sim_view(ctx.store)


class DriftBody(BaseModel):
    deployment_id: str
    kind: str


@router.post("/sim/drift")
async def sim_drift(body: DriftBody, ctx: Ctx = Depends(get_ctx)) -> dict:
    simulation.inject_drift(ctx.store, ctx.actor, body.deployment_id, body.kind)
    await ctx.commit()
    return views.sim_view(ctx.store)


class SourceBody(BaseModel):
    source_id: str
    offline: bool


@router.post("/sim/source")
async def sim_source(body: SourceBody, ctx: Ctx = Depends(get_ctx)) -> dict:
    simulation.set_source_offline(ctx.store, ctx.actor, body.source_id, body.offline)
    await ctx.commit()
    return views.sim_view(ctx.store)


class FaultBody(BaseModel):
    target_id: str
    kind: str


@router.post("/sim/fault")
async def sim_fault(body: FaultBody, ctx: Ctx = Depends(get_ctx)) -> dict:
    simulation.arm_fault(ctx.store, ctx.actor, body.target_id, body.kind)
    await ctx.store.flush()
    return views.sim_view(ctx.store)


@router.delete("/sim/fault/{fault_id}")
async def sim_fault_clear(fault_id: str, ctx: Ctx = Depends(get_ctx)) -> dict:
    simulation.clear_fault(ctx.store, ctx.actor, fault_id)
    await ctx.store.flush()
    return views.sim_view(ctx.store)


class PublishBody(BaseModel):
    feed_id: str


@router.post("/sim/publish-cve")
async def sim_publish(body: PublishBody, ctx: Ctx = Depends(get_ctx)) -> dict:
    simulation.publish_cve(ctx.store, ctx.actor, body.feed_id)
    await ctx.commit()
    return views.sim_view(ctx.store)


class ManualWorkloadBody(BaseModel):
    target_id: str
    service_name: str
    image_id: str
    model_version_id: str
    replicas: int = 1


@router.post("/sim/manual-workload")
async def sim_manual(body: ManualWorkloadBody, ctx: Ctx = Depends(get_ctx)) -> dict:
    simulation.add_manual_workload(ctx.store, ctx.actor, body.target_id, body.service_name, body.image_id,
                                   body.model_version_id, body.replicas)
    await ctx.commit()
    return views.sim_view(ctx.store)


@router.post("/sim/reset")
async def sim_reset(ctx: Ctx = Depends(get_ctx)) -> dict:
    require(ctx.actor, "sim.reset")
    await reset(ctx.db)
    return {"ok": True}
