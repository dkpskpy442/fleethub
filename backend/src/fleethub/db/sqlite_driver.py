from __future__ import annotations

import sqlite3
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from .driver import Statement

MIGRATIONS_DIR = Path(__file__).resolve().parents[3] / "migrations"


class SqliteDriver:
    def __init__(self, path: str = ":memory:"):
        self.conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")

    async def fetch_all(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        return [dict(r) for r in self.conn.execute(sql, tuple(params)).fetchall()]

    async def fetch_many(self, statements: list[Statement]) -> list[list[dict[str, Any]]]:
        return [await self.fetch_all(sql, params) for sql, params in statements]

    async def batch(self, statements: list[Statement]) -> None:
        cur = self.conn.cursor()
        cur.execute("BEGIN")
        try:
            for sql, params in statements:
                cur.execute(sql, tuple(params))
            cur.execute("COMMIT")
        except Exception:
            cur.execute("ROLLBACK")
            raise

    def migrate(self) -> None:
        self.conn.execute("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)")
        done = {r[0] for r in self.conn.execute("SELECT name FROM _migrations")}
        for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if f.name in done:
                continue
            self.conn.executescript(f.read_text())
            self.conn.execute("INSERT INTO _migrations (name) VALUES (?)", (f.name,))

    def is_empty(self) -> bool:
        return self.conn.execute("SELECT COUNT(*) FROM sim_state").fetchone()[0] == 0
