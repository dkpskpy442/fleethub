from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from ...domain import catalog
from .. import views
from ..context import Ctx, get_ctx, history

router = APIRouter()


async def _entity_audit(ctx: Ctx, entity_type: str, entity_id: str) -> list[dict]:
    return await history(ctx.db, "audit_log", "entity_type = ? AND entity_id = ?", [entity_type, entity_id], 50)


# ------------------------------------------------------------------ models
@router.get("/models")
async def list_models(ctx: Ctx = Depends(get_ctx)) -> list[dict]:
    return views.models(ctx.store)


@router.get("/models/{family_id}")
async def get_family(family_id: str, ctx: Ctx = Depends(get_ctx)) -> dict:
    return views.model_family(ctx.store, ctx.store.must("model_families", family_id))


@router.get("/model-versions/{mv_id}")
async def get_model_version(mv_id: str, ctx: Ctx = Depends(get_ctx)) -> dict:
    mv = ctx.store.must("model_versions", mv_id)
    return views.model_version(ctx.store, mv, await _entity_audit(ctx, "model_version", mv_id))


class LifecycleBody(BaseModel):
    to: str
    reason: str


@router.post("/model-versions/{mv_id}/lifecycle")
async def model_lifecycle(mv_id: str, body: LifecycleBody, ctx: Ctx = Depends(get_ctx)) -> dict:
    mv = ctx.store.must("model_versions", mv_id)
    catalog.transition_model(ctx.store, ctx.actor, mv, body.to, body.reason)
    await ctx.commit()
    return views.model_version(ctx.store, mv, await _entity_audit(ctx, "model_version", mv_id))


class NewModelVersion(BaseModel):
    version: str
    artifact_uri: str
    artifact_digest: str
    format: str | None = None
    quantization: str | None = None
    params_b: float | None = None
    context_len: int | None = None
    notes: str | None = None


@router.post("/models/{family_id}/versions")
async def create_model_version(family_id: str, body: NewModelVersion, ctx: Ctx = Depends(get_ctx)) -> dict:
    fam = ctx.store.must("model_families", family_id)
    mv = catalog.register_model_version(ctx.store, ctx.actor, fam, body.model_dump())
    await ctx.commit(cycle=False)
    return {"id": mv["id"]}


# ------------------------------------------------------------------ engines
@router.get("/engines")
async def list_engines(ctx: Ctx = Depends(get_ctx)) -> list[dict]:
    return views.engines(ctx.store)


@router.get("/engine-versions/{ev_id}")
async def get_engine_version(ev_id: str, ctx: Ctx = Depends(get_ctx)) -> dict:
    ev = ctx.store.must("engine_versions", ev_id)
    return views.engine_version(ctx.store, ev, await _entity_audit(ctx, "engine_version", ev_id))


@router.post("/engine-versions/{ev_id}/lifecycle")
async def engine_lifecycle(ev_id: str, body: LifecycleBody, ctx: Ctx = Depends(get_ctx)) -> dict:
    ev = ctx.store.must("engine_versions", ev_id)
    catalog.transition_engine(ctx.store, ctx.actor, ev, body.to, body.reason)
    await ctx.commit()
    return views.engine_version(ctx.store, ev, await _entity_audit(ctx, "engine_version", ev_id))


class NewImage(BaseModel):
    repo: str
    tag: str
    digest: str
    accelerator: str = "cuda"
    hardware_type_ids: list[str]


class NewEngineVersion(BaseModel):
    version: str
    release_notes: str | None = None
    images: list[NewImage]


@router.post("/engines/{engine_id}/versions")
async def create_engine_version(engine_id: str, body: NewEngineVersion, ctx: Ctx = Depends(get_ctx)) -> dict:
    eng = ctx.store.must("engines", engine_id)
    ev = catalog.register_engine_version(ctx.store, ctx.actor, eng, body.model_dump())
    await ctx.commit()  # the scanner will look at the new images on its next cycle
    return {"id": ev["id"]}


# ------------------------------------------------------------------ compatibility
@router.get("/compatibility")
async def compat(family_id: str | None = None, engine_id: str | None = None, ctx: Ctx = Depends(get_ctx)) -> dict:
    return views.compat_matrix(ctx.store, family_id, engine_id)


class CompatBody(BaseModel):
    model_version_id: str
    engine_version_id: str
    hardware_type_id: str
    status: str
    notes: str | None = None
    evidence_url: str | None = None


@router.put("/compatibility")
async def set_compat(body: CompatBody, ctx: Ctx = Depends(get_ctx)) -> dict:
    catalog.upsert_compat(ctx.store, ctx.actor, body.model_version_id, body.engine_version_id, body.hardware_type_id,
                          body.status, body.notes, body.evidence_url)
    await ctx.commit()
    return {"ok": True}
