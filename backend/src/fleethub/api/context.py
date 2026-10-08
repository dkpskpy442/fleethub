from __future__ import annotations

import hashlib
import hmac
import time
from dataclasses import dataclass
from typing import Any

from fastapi import Request

from ..db.driver import Database
from ..db.store import Store
from ..domain import simulation
from ..domain.errors import DomainError
from ..domain.rbac import Actor
from ..seed.loader import ensure_seeded
from ..settings import LOCAL_DB_PATH, env_value

_local_db: Database | None = None
_seeded: set[str] = set()

SESSION_COOKIE = "fh_session"
SESSION_TTL_S = 7 * 24 * 3600
DEFAULT_PERSONA = "u_priya"


class Unauthorized(DomainError):
    status = 401
    code = "unauthorized"


def _env(request: Request) -> Any:
    return request.scope.get("env")


async def get_db(request: Request) -> Database:
    global _local_db
    env = _env(request)
    if env is not None and getattr(env, "DB", None) is not None:
        from ..db.d1_driver import D1Driver

        db: Database = D1Driver(env.DB)
    else:
        if _local_db is None:
            from ..db.sqlite_driver import SqliteDriver

            drv = SqliteDriver(LOCAL_DB_PATH)
            drv.migrate()
            _local_db = drv
        db = _local_db
    key = "local" if env is None or getattr(env, "DB", None) is None else "d1"
    if key not in _seeded:
        await ensure_seeded(db)
        _seeded.add(key)
    return db


def set_local_db(db: Database | None) -> None:
    """Tests inject their own database."""
    global _local_db
    _local_db = db
    _seeded.clear()


# ------------------------------------------------------------------ auth (shared demo password)
NOT_CONFIGURED = object()


def demo_password(request: Request) -> str | object | None:
    """None = auth disabled (local dev only). On Workers a missing secret fails closed."""
    env = _env(request)
    pw = env_value(env, "DEMO_PASSWORD")
    if pw is None and env is not None:
        return NOT_CONFIGURED
    return pw


def _secret(request: Request) -> bytes:
    return (env_value(_env(request), "SESSION_SECRET") or "local-dev-secret").encode()


def make_session(request: Request) -> str:
    exp = int(time.time()) + SESSION_TTL_S
    sig = hmac.new(_secret(request), f"ok.{exp}".encode(), hashlib.sha256).hexdigest()
    return f"{exp}.{sig}"


def session_valid(request: Request) -> bool:
    pw = demo_password(request)
    if pw is None:
        return True  # auth disabled locally
    if pw is NOT_CONFIGURED:
        return False
    tok = request.cookies.get(SESSION_COOKIE) or ""
    try:
        exp_s, sig = tok.split(".", 1)
        exp = int(exp_s)
    except ValueError:
        return False
    want = hmac.new(_secret(request), f"ok.{exp}".encode(), hashlib.sha256).hexdigest()
    return exp > time.time() and hmac.compare_digest(want, sig)


async def require_session(request: Request) -> None:
    if not session_valid(request):
        raise Unauthorized("Sign in with the demo password.")


# ------------------------------------------------------------------ request context
@dataclass
class Ctx:
    db: Database
    store: Store
    actor: Actor
    adapters: simulation.Adapters

    async def commit(self, *, cycle: bool = True) -> None:
        if cycle:
            await simulation.run_cycle(self.store, self.adapters)
        await self.store.flush()


async def get_ctx(request: Request) -> Ctx:
    await require_session(request)
    db = await get_db(request)
    store = await Store.open(db)
    uid = request.headers.get("x-persona") or DEFAULT_PERSONA
    u = store.get("users", uid) or store.must("users", DEFAULT_PERSONA)
    actor = Actor(u["id"], u["name"], u["role"], u["team_id"])
    return Ctx(db, store, actor, simulation.adapters_for(store))


async def history(db: Database, table: str, where: str, params: list[Any], limit: int = 100,
                  order: str = "at DESC") -> list[dict[str, Any]]:
    return await db.fetch_all(f"SELECT * FROM {table} WHERE {where} ORDER BY {order} LIMIT {int(limit)}", params)
