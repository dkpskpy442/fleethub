from __future__ import annotations

from typing import Any

from ..db.store import Store
from .clock import now
from .rbac import Actor
from .util import jdump


def record(
    store: Store,
    actor: Actor,
    action: str,
    entity_type: str,
    entity_id: str,
    summary: str,
    *,
    before: Any = None,
    after: Any = None,
    reason: str | None = None,
    correlation_id: str | None = None,
) -> None:
    store.insert("audit_log", {
        "id": store.new_id("aud"),
        "at": now(store),
        "actor_id": actor.id,
        "actor_role": actor.role,
        "action": action,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "summary": summary,
        "before_json": jdump(before) if before is not None else None,
        "after_json": jdump(after) if after is not None else None,
        "reason": reason,
        "correlation_id": correlation_id,
    })


def rollout_event(store: Store, rollout_id: str, kind: str, message: str, *,
                  actor: Actor | None = None, target_id: str | None = None) -> None:
    store.insert("rollout_events", {
        "id": store.new_id("rev"),
        "rollout_id": rollout_id,
        "target_id": target_id,
        "at": now(store),
        "kind": kind,
        "message": message,
        "actor_id": actor.id if actor else "system",
    })
