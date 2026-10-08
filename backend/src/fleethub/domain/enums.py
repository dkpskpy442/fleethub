"""Every status family is its own vocabulary. They are never mixed or inferred from each other."""
from __future__ import annotations

ROLES = ["viewer", "model_owner", "platform_engineer", "security_engineer", "release_approver", "admin"]

MODEL_LIFECYCLE = ["experimental", "production", "deprecated", "retired"]
MODEL_TRANSITIONS = {
    "experimental": {"production", "retired"},
    "production": {"deprecated"},
    "deprecated": {"production", "retired"},
    "retired": set(),
}

ENGINE_LIFECYCLE = ["preview", "supported", "deprecated", "eol"]
ENGINE_TRANSITIONS = {
    "preview": {"supported", "eol"},
    "supported": {"deprecated"},
    "deprecated": {"supported", "eol"},
    "eol": set(),
}

COMPAT_STATUS = ["certified", "compatible", "known_issues", "incompatible"]  # absent record = "untested"

HEALTH = ["healthy", "degraded", "unhealthy", "unknown"]
FRESHNESS = ["fresh", "stale", "unknown"]

CONVERGENCE = [
    "unmanaged", "converging", "verifying", "converged", "apply_failed",
    "not_observed_after_success", "drifted", "missing", "unverifiable",
]

FINDING_STATUS = ["open", "in_progress", "remediated", "risk_accepted", "false_positive"]
FINDING_ACTIVE = {"open", "in_progress"}

ROLLOUT_STATUS = ["draft", "ready", "in_progress", "paused", "completed", "rolling_back", "rolled_back", "cancelled"]
ROLLOUT_ACTIVE = {"ready", "in_progress", "paused", "rolling_back"}
TARGET_IN_FLIGHT = {"applying", "verifying", "rolling_back"}
TARGET_TERMINAL = {"succeeded", "skipped", "rolled_back"}

SEVERITY_ORDER = {"critical": 0, "high": 1, "medium": 2, "low": 3}
