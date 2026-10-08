"""Runtime settings. On Workers they come from the env binding; locally from os.environ."""
from __future__ import annotations

import os
from typing import Any


def env_value(env: Any, name: str) -> str | None:
    if env is not None:
        try:
            v = getattr(env, name, None)
        except Exception:  # JS proxy may raise for missing keys
            v = None
        if v is not None and str(v) not in ("", "undefined"):
            return str(v)
    v = os.environ.get(name)
    return v or None


LOCAL_DB_PATH = os.environ.get("FLEETHUB_DB", "fleethub.local.db")
