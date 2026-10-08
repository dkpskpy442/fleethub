// Response shapes mirror backend/src/fleethub/api/views.py.

export type ModelLifecycle = "experimental" | "production" | "deprecated" | "retired";
export type EngineLifecycle = "preview" | "supported" | "deprecated" | "eol";
export type CompatStatus = "certified" | "compatible" | "known_issues" | "incompatible" | "untested" | "unsupported_hardware" | "n/a";
export type Health = "healthy" | "degraded" | "unhealthy" | "unknown";
export type Freshness = "fresh" | "stale" | "unknown";
export type ConvergenceState =
  | "unmanaged" | "converging" | "verifying" | "converged" | "apply_failed"
  | "not_observed_after_success" | "drifted" | "missing" | "unverifiable";
export type FindingStatus = "open" | "in_progress" | "remediated" | "risk_accepted" | "false_positive";
export type Severity = "critical" | "high" | "medium" | "low";
export type RolloutStatus = "draft" | "ready" | "in_progress" | "paused" | "completed" | "rolling_back" | "rolled_back" | "cancelled";
export type ApprovalStatus = "not_required" | "pending" | "approved" | "rejected";
export type WaveStatus = "pending" | "awaiting_approval" | "in_progress" | "succeeded" | "failed" | "rolling_back" | "rolled_back";
export type TargetStatus = "pending" | "applying" | "verifying" | "succeeded" | "failed" | "skipped" | "rolling_back" | "rolled_back";
export type Role = "viewer" | "model_owner" | "platform_engineer" | "security_engineer" | "release_approver" | "admin";

export interface MvRef { id: string; version: string; label: string; family_id: string; family_name: string; lifecycle: ModelLifecycle }
export interface EvRef { id: string; version: string; label: string; engine_id: string; engine_name: string; lifecycle: EngineLifecycle }
export interface ImgRef { id: string; tag: string; repo: string; digest: string; accelerator: string; engine_version_id: string }
export interface UserRef { id: string; name: string; role: string }
export interface RolloutRef { id: string; title: string; status: RolloutStatus }

export interface TargetView {
  id: string; name: string;
  environment: { id: string; name: string; tier: "dev" | "staging" | "prod" };
  region: { id: string; name: string; cloud: string };
  hardware: { id: string; name: string; vendor: string; accelerator: string };
  inventory_source_id: string;
}

export interface VulnMini { finding_id: string; vulnerability_id: string; external_id: string; severity: Severity; status: FindingStatus; title: string }

export interface DiffEntry { field: string; desired: string | null; observed: string | null; observed_raw?: string | null; unrecognized?: boolean }

export interface DeploymentRow {
  id: string; service_name: string; managed: boolean; target: TargetView;
  model_family: { id: string; name: string } | null;
  desired: null | {
    revision_id: string; rev_no: number; source: string; created_at: number;
    model_version: MvRef | null; engine_version: EvRef | null; image: ImgRef | null; replicas: number;
  };
  observed: null | {
    observation_id: string; present: boolean; observed_at: number; valid_through: number | null;
    model_raw: string | null; model_version: MvRef | null; engine_raw: string | null; engine_version: EvRef | null;
    image_digest: string | null; image: ImgRef | null; replicas_ready: number | null; replicas_total: number | null;
    reported_health: Health | null;
  };
  convergence: { state: ConvergenceState; detail: string; diff: DiffEntry[]; since: number; verify_deadline: number | null };
  health: Health;
  freshness: { state: Freshness; last_sync_at: number | null; age_s: number | null; source_id: string; source_name: string };
  lock: null | { rollout: RolloutRef; acquired_at: number };
  vulns: { observed_worst: Severity | null; desired_worst: Severity | null; observed: VulnMini[]; desired: VulnMini[] };
  match?: { desired: boolean; observed: boolean };
}

export interface OperationView {
  id: string; adapter: string; external_ref: string;
  status: "pending" | "running" | "reported_succeeded" | "reported_failed" | "timed_out" | "cancelled";
  result_message: string | null; started_at: number; finished_at: number | null; timeout_at: number; last_polled_at: number | null;
}

export interface RequestView {
  id: string; idempotency_key: string; attempt: number;
  status: "queued" | "submitted" | "completed" | "failed" | "superseded" | "cancelled";
  rev_no: number; requested_at: number; submitted_at: number | null; completed_at: number | null;
  requested_by: UserRef | null; superseded_by_id: string | null; operation: OperationView | null;
}

export interface SourceView {
  id: string; kind: "inventory" | "scanner" | "deployer"; name: string; description: string;
  sync_interval_s: number; fresh_threshold_s: number; stale_threshold_s: number;
  last_sync_at: number | null; last_sync_status: string | null; last_error: string | null;
  freshness: Freshness; age_s: number | null;
}

export interface AuditEntry {
  id: string; at: number; actor: UserRef; actor_role: string; action: string; entity_type: string; entity_id: string;
  summary: string; before: unknown; after: unknown; reason: string | null; correlation_id: string | null;
}

export interface RevisionView {
  id: string; rev_no: number; source: string; created_at: number; actor: UserRef | null; reason: string | null;
  rollout: RolloutRef | null; model_version: MvRef | null; engine_version: EvRef | null; image: ImgRef | null;
  replicas: number; current: boolean;
}

export interface ObservationView {
  id: string; observed_at: number; present: boolean; model_raw: string | null; engine_raw: string | null;
  image_digest: string | null; image: ImgRef | null; model_version: MvRef | null; engine_version: EvRef | null;
  replicas_ready: number | null; replicas_total: number | null; health: Health;
}

export interface DeploymentDetail extends DeploymentRow {
  revisions: RevisionView[];
  requests: RequestView[];
  chain: {
    revision: { rev_no: number; created_at: number; source: string } | null;
    request: RequestView | null;
    operation: OperationView | null;
    inventory: { source: SourceView; latest_observation_at: number | null };
    verdict: DeploymentRow["convergence"];
  };
  observations: ObservationView[];
  rollouts: (RolloutRef & { target_status: TargetStatus; target_id: string })[];
  audit: AuditEntry[];
  events: RolloutEvent[];
  actions: { can_adopt: boolean; can_reconcile: boolean; can_accept_observed: boolean };
}

export interface RolloutEvent { id: string; rollout_id: string; target_id: string | null; at: number; kind: string; message: string; actor_id: string; actor?: UserRef }

export interface Check { code: string; level: "block" | "warn" | "ok" | "info"; message: string }
export interface GuardrailResult {
  deployment_id: string; model_version_id: string | null; engine_version_id: string | null; image_id: string | null;
  outcome: "ok" | "warn" | "blocked" | "no_change"; checks: Check[];
}

export interface RolloutSummary {
  id: string; title: string; kind: "model" | "engine" | "model_and_engine"; status: RolloutStatus; approval_status: ApprovalStatus;
  pause_reason: string | null; target_model_version: MvRef | null; target_engine_version: EvRef | null;
  requested_by: UserRef; created_at: number; updated_at: number; started_at: number | null; finished_at: number | null;
  linked_vulnerability: { id: string; external_id: string; severity: Severity } | null;
  target_counts: Partial<Record<TargetStatus, number>>; target_total: number; wave_count: number;
  current_wave: { idx: number; name: string; status: WaveStatus } | null;
}

export interface RolloutTargetView {
  id: string; status: TargetStatus; failure_reason: string | null; manually_verified: boolean;
  verify_deadline: number | null; bake_until: number | null; started_at: number | null; finished_at: number | null;
  justification: string | null; guardrails: GuardrailResult; acknowledged: string[]; unacknowledged: string[];
  new_model_version: MvRef | null; new_engine_version: EvRef | null; new_image: ImgRef | null;
  prev: null | { rev_no: number; model_version: MvRef | null; engine_version: EvRef | null; image: ImgRef | null };
  request: RequestView | null; rollback_request: RequestView | null; deployment: DeploymentRow;
}

export interface RolloutWaveView {
  id: string; rollout_id: string; idx: number; name: string; bake_minutes: number; is_prod: boolean; status: WaveStatus;
  started_at: number | null; finished_at: number | null; targets: RolloutTargetView[];
}

export interface RolloutDetail extends RolloutSummary {
  reason: string | null; submitted_at: number | null; waves: RolloutWaveView[];
  approvals: { id: string; approver: UserRef; decision: "approved" | "rejected"; comment: string; at: number }[];
  events: RolloutEvent[]; audit: AuditEntry[];
}

export interface WavePlan { name: string; bake_minutes: number; deployment_ids: string[] }

export interface RolloutPreview {
  kind: string; target_model_version: MvRef | null; target_engine_version: EvRef | null;
  targets: { deployment: DeploymentRow; guardrails: GuardrailResult; new_image: ImgRef | null; new_model_version: MvRef | null; new_engine_version: EvRef | null }[];
  suggested_waves: WavePlan[];
  impact: {
    deployments: number; replicas: number; prod: number; by_environment: Record<string, number>; by_region: Record<string, number>;
    outcomes: Record<string, number>; vulns_resolved: Record<string, number>;
  };
}

export interface ModelFamilySummary {
  id: string; name: string; slug: string; description: string; modality: string; owner_team_id: string; owner_team: string;
  versions: { id: string; version: string; lifecycle: ModelLifecycle }[];
  lifecycle_counts: Partial<Record<ModelLifecycle, number>>; deployment_count: number; unmanaged_count: number;
}

export interface ModelVersionRow {
  id: string; family_id: string; version: string; lifecycle: ModelLifecycle; artifact_uri: string; artifact_digest: string;
  format: string; quantization: string; params_b: number; context_len: number; released_at: number; lifecycle_changed_at: number; notes: string | null;
}

export interface ModelFamilyDetail extends Omit<ModelFamilySummary, "versions" | "lifecycle_counts" | "deployment_count" | "unmanaged_count"> {
  versions: (ModelVersionRow & { desired_count: number; observed_count: number; compat_counts: Partial<Record<CompatStatus, number>> })[];
}

export interface CompatCell { status: CompatStatus; notes: string | null; evidence_url: string | null; verified_at: number | null; verified_by: UserRef | null }

export interface ModelVersionDetail extends ModelVersionRow {
  family: { id: string; name: string; slug: string; owner_team: string; owner_team_id: string };
  compat: { hardware: { id: string; name: string }[]; rows: { engine_version: EvRef; has_records: boolean; cells: Record<string, CompatCell> }[]; family: string };
  deployments: DeploymentRow[];
  rollouts: RolloutSummary[];
  audit: AuditEntry[];
}

export interface EngineSummary {
  id: string; name: string; slug: string; description: string; owner_team: string; repo_url: string;
  versions: { id: string; version: string; lifecycle: EngineLifecycle; released_at: number; worst_vuln: Severity | null; observed_count: number; desired_count: number }[];
}

export interface EngineVersionDetail {
  id: string; engine_id: string; version: string; lifecycle: EngineLifecycle; released_at: number; lifecycle_changed_at: number; release_notes: string | null;
  engine: { id: string; name: string; slug: string; repo_url: string };
  images: (ImgRef & { built_at: number; hardware: string[]; vulns: VulnMini[]; exposure: { observed: number; desired: number } })[];
  compat: { model_version: MvRef; records: { hardware: string; status: CompatStatus; notes: string | null }[] }[];
  deployments: DeploymentRow[];
  newer_versions: (EvRef & { worst_vuln: Severity | null })[];
  rollouts: RolloutSummary[];
  audit: AuditEntry[];
}

export interface CompatMatrix {
  hardware: { id: string; name: string }[];
  engine_versions: EvRef[];
  rows: { model_version: MvRef; cells: Record<string, CompatStatus> }[];
}

export interface VulnSummary {
  id: string; external_id: string; title: string; severity: Severity; cvss: number; package: string; description: string;
  fixed_in_note: string; published_at: number; finding_statuses: Partial<Record<FindingStatus, number>>;
  engine_versions: EvRef[];
  exposure: { observed: number; desired: number; prod_observed: number; unverifiable: number };
  active: boolean; rollouts: RolloutSummary[];
}

export interface FindingView {
  id: string; vulnerability_id: string; image_id: string; source_id: string; status: FindingStatus; detected_at: number;
  status_changed_at: number; accepted_until: number | null; notes: string | null; updated_by: UserRef | null;
  image: ImgRef; engine_version: EvRef; exposure: { observed: number; desired: number };
}

export interface RemediationOption {
  engine_version_id: string; label: string; lifecycle: EngineLifecycle; released_at: number;
  counts: { ok: number; warn: number; blocked: number; no_change: number }; unmanaged_exposed: number;
  deployments: GuardrailResult[];
}

export interface VulnDetail extends Omit<VulnSummary, "finding_statuses" | "engine_versions" | "exposure" | "active"> {
  findings: FindingView[];
  exposure: (DeploymentRow & { exposure: { observed: boolean; desired: boolean } })[];
  remediation_options: RemediationOption[];
  rollouts: RolloutSummary[];
  audit: AuditEntry[];
}

export interface AttentionItem { severity: Severity; category: string; title: string; detail: string; link: string }

export interface Overview {
  now: number; attention: AttentionItem[];
  counts: {
    model_families: number; model_versions: number; engines: number; engine_versions: number; deployments: number; managed: number;
    convergence: Partial<Record<ConvergenceState, number>>; health: Partial<Record<Health, number>>; freshness: Partial<Record<Freshness, number>>;
    active_rollouts: number; open_findings: number;
  };
  sources: SourceView[];
  rollouts: RolloutSummary[];
  environments: { environment: string; tier: string; total: number; converged: number; attention: number; unverifiable: number }[];
}

export interface Persona {
  id: string; name: string; email: string; title: string; role: Role; team_id: string; team: string;
  role_description: string; permissions: string[];
}

export interface Me { user: Persona; personas: Persona[] }

export interface Meta {
  enums: Record<string, unknown> & { model_transitions: Record<string, string[]>; engine_transitions: Record<string, string[]> };
  environments: { id: string; name: string; tier: string }[];
  regions: { id: string; name: string; cloud: string }[];
  hardware: { id: string; name: string; vendor: string; memory_gb: number; accelerator: string }[];
  teams: { id: string; name: string }[];
  targets: TargetView[];
  sim: { now: number; playing: boolean; speed: number };
}

export interface SimView {
  now: number; playing: boolean; speed: number;
  sources: (SourceView & { offline: boolean })[];
  faults: { id: string; kind: string; target_id: string | null; source_id: string | null; remaining: number; target: string | null; source: string | null }[];
  feed: { id: string; external_id: string; published: boolean; publish_at: number | null; title: string; severity: Severity }[];
  running_operations: { id: string; target: string; service_name: string; due_at: number; outcome: string }[];
  targets: { id: string; name: string }[];
}

export interface TargetDetail extends TargetView { deployer: string; source: SourceView; deployments: DeploymentRow[] }
