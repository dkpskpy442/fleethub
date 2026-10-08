"""Database driver protocol.

Two implementations share this interface: ``SqliteDriver`` (local dev + tests) and ``D1Driver``
(Cloudflare Workers). D1 has no interactive transactions, so the only atomic write primitive is
``batch``; the rest of the app is built around "load, mutate in memory, flush one batch".
"""
from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Protocol

Statement = tuple[str, Sequence[Any]]


class Database(Protocol):
    async def fetch_all(self, sql: str, params: Sequence[Any] = ()) -> list[dict[str, Any]]: ...

    async def fetch_many(self, statements: list[Statement]) -> list[list[dict[str, Any]]]:
        """Run several read statements in one round trip."""
        ...

    async def batch(self, statements: list[Statement]) -> None:
        """Run write statements atomically (all or nothing)."""
        ...
