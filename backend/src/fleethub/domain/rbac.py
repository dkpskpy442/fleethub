"""Role-based permissions. Checked by domain services on every mutation (never only in the UI)."""
from __future__ import annotations

from dataclasses import dataclass

from .errors import Forbidden


@dataclass(frozen=True)
class Actor:
    id: str
    name: str
    role: str
    team_id: str | None = None


SYSTEM = Actor(id="system", name="FleetHub reconciler", role="system")

PERMISSIONS: dict[str, set[str]] = {
    "model.edit": {"model_owner", "admin"},
    "model.lifecycle": {"model_owner", "admin"},
    "engine.edit": {"platform_engineer", "admin"},
    "engine.lifecycle": {"platform_engineer", "admin"},
    "compat.edit": {"model_owner", "platform_engineer", "admin"},
    "deployment.adopt": {"platform_engineer", "admin"},
    "deployment.reconcile": {"platform_engineer", "admin"},
    "deployment.accept_drift": {"platform_engineer", "admin"},
    "rollout.create": {"model_owner", "platform_engineer", "security_engineer", "admin"},
    "rollout.submit": {"model_owner", "platform_engineer", "admin"},
    "rollout.execute": {"platform_engineer", "admin"},
    "rollout.approve": {"release_approver", "admin"},
    "rollout.manual_verify": {"admin"},
    "finding.triage": {"security_engineer", "admin"},
    "sim.control": {"viewer", "model_owner", "platform_engineer", "security_engineer", "release_approver", "admin"},
    # Demo infrastructure, not governed data: any persona may reset the shared demo world.
    "sim.reset": {"viewer", "model_owner", "platform_engineer", "security_engineer", "release_approver", "admin"},
}

# Permissions scoped to the actor's own team for model owners.
TEAM_SCOPED = {"model.edit", "model.lifecycle", "compat.edit"}

DESCRIPTIONS = {
    "viewer": "Read-only access to catalogs, fleet, vulnerabilities and rollouts.",
    "model_owner": "Registers model versions, manages lifecycle and compatibility for their team's models, plans model rollouts.",
    "platform_engineer": "Manages engines, compatibility, adopts/reconciles deployments, plans and executes rollouts.",
    "security_engineer": "Triages vulnerability findings, accepts risk, drafts remediation rollouts.",
    "release_approver": "Approves or rejects rollouts that touch production (never their own).",
    "admin": "Everything, plus manual verification overrides.",
}


def can(actor: Actor, perm: str, *, owner_team_id: str | None = None) -> bool:
    if actor.role == "system":
        return True
    if actor.role not in PERMISSIONS.get(perm, set()):
        return False
    if perm in TEAM_SCOPED and actor.role == "model_owner" and owner_team_id is not None:
        return actor.team_id == owner_team_id
    return True


def require(actor: Actor, perm: str, *, owner_team_id: str | None = None) -> None:
    if not can(actor, perm, owner_team_id=owner_team_id):
        scope = " for this team's models" if perm in TEAM_SCOPED and actor.role == "model_owner" else ""
        raise Forbidden(f"{actor.name} ({actor.role}) is not allowed to {perm}{scope}", code="forbidden")


def permissions_for(actor: Actor) -> list[str]:
    return sorted(p for p, roles in PERMISSIONS.items() if actor.role in roles or actor.role == "admin")
