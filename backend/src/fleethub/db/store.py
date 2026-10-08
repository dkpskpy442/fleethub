"""In-memory unit of work over the relational schema.

A request loads the (small) working set into memory, domain code reads and mutates plain dict rows,
and ``flush`` writes the net changes as ONE atomic batch: inserts in FK order, then column-level
updates, then deletes. This is what lets the same domain code run on SQLite and on D1, which has
no interactive transactions.
"""
from __future__ import annotations

import json
import random
from collections.abc import Callable, Iterable
from typing import Any

from .driver import Database, Statement

# Parent tables first, so inserts in one batch satisfy foreign keys.
TABLE_ORDER = [
    "teams", "users", "hardware_types", "model_families", "model_versions", "engines",
    "engine_versions", "engine_images", "engine_image_hardware", "compatibility_records",
    "environments", "regions", "data_sources", "deployment_targets", "deployments",
    "desired_state_revisions", "deployment_requests", "external_operations",
    "deployment_observations", "deployment_convergence", "deployment_locks", "vulnerabilities",
    "vulnerability_findings", "rollouts", "rollout_waves", "rollout_targets", "rollout_approvals",
    "rollout_events", "audit_log", "sim_state", "sim_world_workloads", "sim_operations",
    "sim_faults", "sim_cve_feed",
]

# Append-only history tables that are not loaded wholesale.
HISTORY_TABLES = {"audit_log", "rollout_events", "deployment_observations"}
CORE_TABLES = [t for t in TABLE_ORDER if t not in HISTORY_TABLES]

Row = dict[str, Any]


class Store:
    def __init__(self, db: Database, *, seed: int | None = None):
        self.db = db
        self.tables: dict[str, dict[str, Row]] = {}
        self._inserted: dict[str, dict[str, Row]] = {}
        self._dirty: dict[str, dict[str, set[str]]] = {}
        self._deleted: dict[str, set[str]] = {}
        self._rng = random.Random(seed) if seed is not None else random.SystemRandom()

    # ------------------------------------------------------------------ loading
    @classmethod
    async def open(cls, db: Database, *, seed: int | None = None) -> Store:
        s = cls(db, seed=seed)
        stmts: list[Statement] = [(f"SELECT * FROM {t}", ()) for t in CORE_TABLES]
        stmts.append((
            "SELECT o.* FROM deployment_observations o JOIN deployments d ON d.latest_observation_id = o.id",
            (),
        ))
        results = await db.fetch_many(stmts)
        for t, rows in zip(CORE_TABLES, results, strict=False):
            s.tables[t] = {r["id"]: r for r in rows}
        s.tables["deployment_observations"] = {r["id"]: r for r in results[-1]}
        s.tables["audit_log"] = {}
        s.tables["rollout_events"] = {}
        return s

    # ------------------------------------------------------------------ reads
    def rows(self, table: str) -> list[Row]:
        return list(self.tables[table].values())

    def get(self, table: str, id_: str | None) -> Row | None:
        if id_ is None:
            return None
        return self.tables[table].get(id_)

    def must(self, table: str, id_: str | None) -> Row:
        row = self.get(table, id_)
        if row is None:
            from ..domain.errors import NotFound

            raise NotFound(f"{table} {id_} not found")
        return row

    def where(self, table: str, pred: Callable[[Row], bool] | None = None, **eq: Any) -> list[Row]:
        out = []
        for r in self.tables[table].values():
            if all(r.get(k) == v for k, v in eq.items()) and (pred is None or pred(r)):
                out.append(r)
        return out

    def first(self, table: str, **eq: Any) -> Row | None:
        rows = self.where(table, **eq)
        return rows[0] if rows else None

    # ------------------------------------------------------------------ writes
    def new_id(self, prefix: str) -> str:
        sim = self.tables.get("sim_state", {}).get("sim")
        if sim is not None:
            sim["seq"] += 1
            self._mark("sim_state", "sim", ["seq"])
            seq = sim["seq"]
        else:
            seq = self._rng.randrange(1 << 30)
        return f"{prefix}_{seq:05d}{self._rng.randrange(36 ** 2):02x}"

    def insert(self, table: str, row: Row) -> Row:
        if "id" not in row:
            raise ValueError(f"insert into {table} requires id")
        self.tables.setdefault(table, {})[row["id"]] = row
        self._inserted.setdefault(table, {})[row["id"]] = row
        self._deleted.get(table, set()).discard(row["id"])
        return row

    def update(self, table: str, id_: str, **changes: Any) -> Row:
        row = self.tables[table][id_]
        changed = [k for k, v in changes.items() if row.get(k) != v]
        row.update(changes)
        if changed:
            self._mark(table, id_, changed)
        return row

    def delete(self, table: str, id_: str) -> None:
        self.tables[table].pop(id_, None)
        if id_ in self._inserted.get(table, {}):
            self._inserted[table].pop(id_)
        else:
            self._deleted.setdefault(table, set()).add(id_)
        self._dirty.get(table, {}).pop(id_, None)

    def _mark(self, table: str, id_: str, cols: Iterable[str]) -> None:
        if id_ in self._inserted.get(table, {}):
            return  # the INSERT will carry the final values
        self._dirty.setdefault(table, {}).setdefault(id_, set()).update(cols)

    @property
    def has_changes(self) -> bool:
        return any(self._inserted.values()) or any(self._dirty.values()) or any(self._deleted.values())

    def statements(self) -> list[Statement]:
        stmts: list[Statement] = []
        for t in TABLE_ORDER:
            for row in self._inserted.get(t, {}).values():
                cols = list(row.keys())
                stmts.append((
                    f"INSERT INTO {t} ({', '.join(cols)}) VALUES ({', '.join('?' for _ in cols)})",
                    [_param(row[c]) for c in cols],
                ))
        for t in TABLE_ORDER:
            for id_, cols in self._dirty.get(t, {}).items():
                row = self.tables[t].get(id_)
                if row is None or not cols:
                    continue
                cl = sorted(cols)
                stmts.append((
                    f"UPDATE {t} SET {', '.join(f'{c} = ?' for c in cl)} WHERE id = ?",
                    [_param(row[c]) for c in cl] + [id_],
                ))
        for t in reversed(TABLE_ORDER):
            for id_ in self._deleted.get(t, set()):
                stmts.append((f"DELETE FROM {t} WHERE id = ?", [id_]))
        return stmts

    async def flush(self) -> int:
        stmts = self.statements()
        if stmts:
            await self.db.batch(stmts)
        self._inserted.clear()
        self._dirty.clear()
        self._deleted.clear()
        return len(stmts)


def _param(v: Any) -> Any:
    if isinstance(v, bool):
        return int(v)
    if isinstance(v, (dict, list)):
        return json.dumps(v)
    return v
