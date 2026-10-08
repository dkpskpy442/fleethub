from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ...domain import rollouts as R
from .. import views
from ..context import Ctx, get_ctx, history

router = APIRouter()


@router.get("/rollouts")
async def list_rollouts(ctx: Ctx = Depends(get_ctx)) -> list[dict]:
    return views.rollouts(ctx.store)


class PreviewBody(BaseModel):
    kind: str
    target_model_version_id: str | None = None
    target_engine_version_id: str | None = None
    deployment_ids: list[str] | None = None


@router.post("/rollouts/preview")
async def preview(body: PreviewBody, ctx: Ctx = Depends(get_ctx)) -> dict:
    s = ctx.store
    ids = body.deployment_ids
    if ids is None:
        ids = [d["id"] for d in R.candidate_deployments(s, body.kind, body.target_model_version_id,
                                                         body.target_engine_version_id)]
    results = R.preview(s, body.kind, body.target_model_version_id, body.target_engine_version_id, ids)
    eligible = [r.deployment_id for r in results if r.outcome in ("ok", "warn")]
    return views.rollout_preview(s, body.kind, body.target_model_version_id, body.target_engine_version_id, results,
                                 R.generate_waves(s, eligible))


class WaveIn(BaseModel):
    name: str
    bake_minutes: int
    deployment_ids: list[str]


class CreateBody(BaseModel):
    title: str
    kind: str
    target_model_version_id: str | None = None
    target_engine_version_id: str | None = None
    linked_vulnerability_id: str | None = None
    reason: str = ""
    waves: list[WaveIn]
    justifications: dict[str, str] = {}
    submit: bool = False


async def _detail(ctx: Ctx, rid: str) -> dict:
    r = ctx.store.must("rollouts", rid)
    events = await history(ctx.db, "rollout_events", "rollout_id = ?", [rid], 300, "at DESC, id DESC")
    audit = await history(ctx.db, "audit_log", "correlation_id = ?", [rid], 100)
    return views.rollout_detail(ctx.store, r, events, audit)


@router.post("/rollouts")
async def create(body: CreateBody, ctx: Ctx = Depends(get_ctx)) -> dict:
    r = R.create_draft(ctx.store, ctx.actor, title=body.title, kind=body.kind,
                       target_model_version_id=body.target_model_version_id,
                       target_engine_version_id=body.target_engine_version_id, reason=body.reason,
                       waves=[w.model_dump() for w in body.waves], justifications=body.justifications,
                       linked_vulnerability_id=body.linked_vulnerability_id)
    if body.submit:
        R.submit(ctx.store, ctx.actor, r)
    await ctx.commit()
    return await _detail(ctx, r["id"])


@router.get("/rollouts/{rid}")
async def get(rid: str, ctx: Ctx = Depends(get_ctx)) -> dict:
    return await _detail(ctx, rid)


class ActionBody(BaseModel):
    comment: str = ""


@router.post("/rollouts/{rid}/{action}")
async def act(rid: str, action: str, body: ActionBody, ctx: Ctx = Depends(get_ctx)) -> dict:
    s, a = ctx.store, ctx.actor
    r = s.must("rollouts", rid)
    if action == "submit":
        R.submit(s, a, r)
    elif action == "approve":
        R.decide(s, a, r, "approved", body.comment)
    elif action == "reject":
        R.decide(s, a, r, "rejected", body.comment)
    elif action == "start":
        R.start(s, a, r)
    elif action == "pause":
        R.pause(s, a, r, body.comment)
    elif action == "resume":
        R.resume(s, a, r)
    elif action == "rollback":
        R.rollback_all(s, a, r, body.comment)
    elif action == "cancel":
        R.cancel(s, a, r, body.comment)
    else:
        from ...domain.errors import NotFound

        raise NotFound(f"Unknown action {action}")
    await ctx.commit()
    return await _detail(ctx, rid)


@router.post("/rollouts/{rid}/targets/{tid}/{action}")
async def target_act(rid: str, tid: str, action: str, body: ActionBody, ctx: Ctx = Depends(get_ctx)) -> dict:
    s, a = ctx.store, ctx.actor
    r = s.must("rollouts", rid)
    t = s.must("rollout_targets", tid)
    if t["rollout_id"] != rid:
        from ...domain.errors import NotFound

        raise NotFound("Target does not belong to this rollout")
    dep = ctx.adapters.deployer
    if action == "retry":
        await R.retry_target(s, dep, a, r, t)
    elif action == "rollback":
        await R.rollback_target(s, dep, a, r, t, body.comment or "manual rollback")
    elif action == "skip":
        R.skip_target(s, a, r, t, body.comment or "skipped")
    elif action == "verify":
        R.manual_verify(s, a, r, t, body.comment)
    elif action == "acknowledge":
        R.acknowledge(s, a, r, t, body.comment)
    else:
        from ...domain.errors import NotFound

        raise NotFound(f"Unknown action {action}")
    await ctx.commit()
    return await _detail(ctx, rid)
