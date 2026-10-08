"""Cloudflare D1 driver (only importable inside the Workers runtime)."""
from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from .driver import Statement


def _rows(result: Any) -> list[dict[str, Any]]:
    return [dict(r) for r in (result.results or [])]


class D1Driver:
    def __init__(self, binding: Any):
        self.db = binding

    def _prepare(self, sql: str, params: Sequence[Any]):
        stmt = self.db.prepare(sql)
        return stmt.bind(*params) if params else stmt

    async def fetch_all(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]:
        return _rows(await self._prepare(sql, params).all())

    async def fetch_many(self, statements: list[Statement]) -> list[list[dict[str, Any]]]:
        if not statements:
            return []
        results = await self.db.batch([self._prepare(sql, p) for sql, p in statements])
        return [_rows(r) for r in results]

    async def batch(self, statements: list[Statement]) -> None:
        if not statements:
            return
        await self.db.batch([self._prepare(sql, p) for sql, p in statements])
