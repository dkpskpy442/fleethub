"""The simulated clock. All domain "now" values come from here so demos are deterministic."""
from __future__ import annotations

from ..db.store import Store


def now(store: Store) -> int:
    return int(store.must("sim_state", "sim")["now"])
