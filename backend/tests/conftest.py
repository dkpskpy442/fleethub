from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient

from fleethub.api.context import set_local_db
from fleethub.app import app
from fleethub.db.sqlite_driver import SqliteDriver
from fleethub.db.store import Store
from fleethub.seed.loader import reset


def fresh_db() -> SqliteDriver:
    db = SqliteDriver(":memory:")
    db.migrate()
    asyncio.run(reset(db))
    return db


class Api:
    def __init__(self, client: TestClient):
        self.c = client

    def _do(self, method: str, path: str, persona: str, body: Any = None, expect: int | None = 200) -> Any:
        r = self.c.request(method, f"/api{path}", json=body, headers={"x-persona": persona})
        if expect is not None:
            assert r.status_code == expect, f"{method} {path} -> {r.status_code}: {r.text[:600]}"
        return r.json()

    def get(self, path: str, persona: str = "u_priya", **kw: Any) -> Any:
        return self._do("GET", path, persona, **kw)

    def post(self, path: str, body: Any = None, persona: str = "u_jordan", **kw: Any) -> Any:
        return self._do("POST", path, persona, body if body is not None else {}, **kw)

    def put(self, path: str, body: Any, persona: str = "u_jordan", **kw: Any) -> Any:
        return self._do("PUT", path, persona, body, **kw)

    def advance(self, minutes: int) -> None:
        while minutes > 0:
            step = min(minutes, 600)
            self.post("/sim/advance", {"minutes": step})
            minutes -= step

    def deployment(self, service: str, cluster: str) -> dict:
        return next(d for d in self.get("/fleet") if d["service_name"] == service and d["target"]["name"] == cluster)


@pytest.fixture
def db() -> SqliteDriver:
    return fresh_db()


@pytest.fixture
def api(db: SqliteDriver):
    set_local_db(db)
    with TestClient(app) as client:
        yield Api(client)
    set_local_db(None)


@pytest.fixture
def store(db: SqliteDriver) -> Store:
    return asyncio.run(Store.open(db))
