from __future__ import annotations

import json
from typing import Any


def jdump(v: Any) -> str:
    return json.dumps(v, separators=(",", ":"), sort_keys=True)


def jload(s: str | None, default: Any = None) -> Any:
    if s is None or s == "":
        return default
    return json.loads(s)


MINUTE = 60
HOUR = 3600
DAY = 86400
