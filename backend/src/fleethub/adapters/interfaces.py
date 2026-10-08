"""Integration boundaries. Real implementations (Argo/Spinnaker deployer, k8s inventory exporter,
Trivy/Grype scanner, ...) would implement these; the prototype ships simulated ones."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


class SourceUnavailable(Exception):
    """The external system did not answer (outage, auth failure, network partition)."""


@dataclass
class DeploySpec:
    deployment_id: str
    target_id: str
    service_name: str
    model_raw: str
    engine_raw: str
    image_digest: str
    replicas: int


@dataclass
class OperationStatus:
    status: str              # running | succeeded | failed
    finished_at: int | None
    message: str | None = None


class DeploymentSystem(Protocol):
    name: str

    async def submit(self, spec: DeploySpec) -> str:
        """Ask the external system to converge to ``spec``. Returns its operation reference."""
        ...

    async def poll(self, external_ref: str) -> OperationStatus: ...

    async def cancel(self, external_ref: str) -> None: ...


@dataclass
class ObservedWorkload:
    service_name: str
    model_raw: str
    engine_raw: str
    image_digest: str
    replicas_ready: int
    replicas_total: int
    health: str


class InventorySource(Protocol):
    async def collect(self, source: dict[str, Any], target: dict[str, Any]) -> list[ObservedWorkload]:
        """Everything currently running on a target. Raises ``SourceUnavailable``."""
        ...


@dataclass
class ScanFinding:
    external_id: str
    title: str
    severity: str
    cvss: float
    package: str
    description: str
    fixed_in_note: str
    published_at: int
    image_digest: str


class VulnerabilityScanner(Protocol):
    async def scan(self, source: dict[str, Any], image_digests: list[str]) -> list[ScanFinding]: ...
