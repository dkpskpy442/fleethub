"""Load the generated seed into a database (local SQLite or D1)."""
from __future__ import annotations

from typing import Any

from ..db.driver import Database
from ..db.store import TABLE_ORDER


def to_sql(data: dict[str, list[dict[str, Any]]], chunk: int = 50) -> list[str]:
    """Multi-row INSERTs with inline literals (keeps the D1 statement count low)."""
    out = []
    for t in TABLE_ORDER:
        rows = data.get(t) or []
        for i in range(0, len(rows), chunk):
            part = rows[i:i + chunk]
            cols = list(part[0].keys())
            values = ",\n".join("(" + ", ".join(_lit(r[c]) for c in cols) + ")" for r in part)
            out.append(f"INSERT INTO {t} ({', '.join(cols)}) VALUES\n{values};")
    return out


def _lit(v: Any) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


async def reset(db: Database) -> None:
    """Atomically wipe all data and re-insert the demo seed."""
    from .seed_data import SEED

    stmts = [(f"DELETE FROM {t}", ()) for t in reversed(TABLE_ORDER)]
    stmts += [(sql, ()) for sql in to_sql(SEED)]
    await db.batch(stmts)


async def ensure_seeded(db: Database) -> bool:
    rows = await db.fetch_all("SELECT COUNT(*) AS n FROM sim_state")
    if rows and rows[0]["n"]:
        return False
    await reset(db)
    return True
