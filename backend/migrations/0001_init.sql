-- FleetHub schema. All ids are TEXT, all timestamps are INTEGER epoch seconds (simulated clock).
-- "Pointer" columns that form cycles (e.g. deployments.current_revision_id) intentionally have no FK
-- constraint so a unit of work can insert both sides in one atomic batch.

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  title TEXT,
  role TEXT NOT NULL CHECK (role IN ('viewer','model_owner','platform_engineer','security_engineer','release_approver','admin')),
  team_id TEXT REFERENCES teams(id)
);

CREATE TABLE hardware_types (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  vendor TEXT NOT NULL,
  memory_gb INTEGER NOT NULL,
  accelerator TEXT NOT NULL            -- image build family: cuda | rocm
);

-- ---------------------------------------------------------------- models
CREATE TABLE model_families (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  modality TEXT NOT NULL,
  owner_team_id TEXT NOT NULL REFERENCES teams(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE model_versions (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES model_families(id),
  version TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('experimental','production','deprecated','retired')),
  artifact_uri TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  format TEXT NOT NULL,
  quantization TEXT NOT NULL,
  params_b REAL NOT NULL,
  context_len INTEGER NOT NULL,
  released_at INTEGER NOT NULL,
  lifecycle_changed_at INTEGER NOT NULL,
  notes TEXT,
  UNIQUE (family_id, version)
);

-- ---------------------------------------------------------------- engines
CREATE TABLE engines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  owner_team_id TEXT NOT NULL REFERENCES teams(id),
  repo_url TEXT
);

CREATE TABLE engine_versions (
  id TEXT PRIMARY KEY,
  engine_id TEXT NOT NULL REFERENCES engines(id),
  version TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('preview','supported','deprecated','eol')),
  released_at INTEGER NOT NULL,
  lifecycle_changed_at INTEGER NOT NULL,
  release_notes TEXT,
  UNIQUE (engine_id, version)
);

CREATE TABLE engine_images (
  id TEXT PRIMARY KEY,
  engine_version_id TEXT NOT NULL REFERENCES engine_versions(id),
  repo TEXT NOT NULL,
  tag TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  accelerator TEXT NOT NULL,
  built_at INTEGER NOT NULL
);

CREATE TABLE engine_image_hardware (
  image_id TEXT NOT NULL REFERENCES engine_images(id),
  hardware_type_id TEXT NOT NULL REFERENCES hardware_types(id),
  id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (image_id, hardware_type_id)
);

-- ---------------------------------------------------------------- compatibility
CREATE TABLE compatibility_records (
  id TEXT PRIMARY KEY,
  model_version_id TEXT NOT NULL REFERENCES model_versions(id),
  engine_version_id TEXT NOT NULL REFERENCES engine_versions(id),
  hardware_type_id TEXT NOT NULL REFERENCES hardware_types(id),
  status TEXT NOT NULL CHECK (status IN ('certified','compatible','known_issues','incompatible')),
  evidence_url TEXT,
  notes TEXT,
  verified_by TEXT REFERENCES users(id),
  verified_at INTEGER NOT NULL,
  UNIQUE (model_version_id, engine_version_id, hardware_type_id)
);

-- ---------------------------------------------------------------- fleet topology
CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('dev','staging','prod')),
  sort INTEGER NOT NULL
);

CREATE TABLE regions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cloud TEXT NOT NULL,
  sort INTEGER NOT NULL
);

CREATE TABLE data_sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('inventory','deployer','scanner')),
  name TEXT NOT NULL,
  description TEXT,
  sync_interval_s INTEGER NOT NULL,
  fresh_threshold_s INTEGER NOT NULL,
  stale_threshold_s INTEGER NOT NULL,
  last_sync_at INTEGER,
  last_sync_status TEXT,
  last_error TEXT
);

CREATE TABLE deployment_targets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  environment_id TEXT NOT NULL REFERENCES environments(id),
  region_id TEXT NOT NULL REFERENCES regions(id),
  hardware_type_id TEXT NOT NULL REFERENCES hardware_types(id),
  inventory_source_id TEXT NOT NULL REFERENCES data_sources(id),
  deployer TEXT NOT NULL
);

-- ---------------------------------------------------------------- desired -> observed chain
CREATE TABLE deployments (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES deployment_targets(id),
  service_name TEXT NOT NULL,
  model_family_id TEXT REFERENCES model_families(id),
  managed INTEGER NOT NULL,
  current_revision_id TEXT,                  -- pointer: latest desired_state_revisions row
  latest_observation_id TEXT,                -- pointer: latest deployment_observations row
  created_at INTEGER NOT NULL,
  adopted_at INTEGER,
  UNIQUE (target_id, service_name)
);

CREATE TABLE desired_state_revisions (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id),
  rev_no INTEGER NOT NULL,
  model_version_id TEXT NOT NULL REFERENCES model_versions(id),
  engine_version_id TEXT NOT NULL REFERENCES engine_versions(id),
  image_id TEXT NOT NULL REFERENCES engine_images(id),
  replicas INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('seed','rollout','rollback','adopt','accept_drift','reconcile')),
  rollout_id TEXT,
  rollout_target_id TEXT,
  actor_id TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (deployment_id, rev_no)
);

CREATE TABLE deployment_requests (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id),
  revision_id TEXT NOT NULL REFERENCES desired_state_revisions(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','submitted','completed','failed','superseded','cancelled')),
  superseded_by_id TEXT,
  rollout_target_id TEXT,
  requested_by TEXT,
  requested_at INTEGER NOT NULL,
  submitted_at INTEGER,
  completed_at INTEGER
);

CREATE TABLE external_operations (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES deployment_requests(id),
  adapter TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','reported_succeeded','reported_failed','timed_out','cancelled')),
  result_message TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  timeout_at INTEGER NOT NULL,
  last_polled_at INTEGER
);

-- Observations are de-duplicated: a new row is written only when what the inventory reports changes.
-- A row is valid from observed_at until the next row; the latest row is valid as of its source's last_sync_at.
CREATE TABLE deployment_observations (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL REFERENCES deployments(id),
  source_id TEXT NOT NULL REFERENCES data_sources(id),
  observed_at INTEGER NOT NULL,
  present INTEGER NOT NULL,                  -- 0 = inventory reports the workload is absent
  model_raw TEXT,
  model_version_id TEXT,
  engine_raw TEXT,
  engine_version_id TEXT,
  image_digest_raw TEXT,
  image_id TEXT,
  replicas_ready INTEGER,
  replicas_total INTEGER,
  health TEXT CHECK (health IN ('healthy','degraded','unhealthy','unknown'))
);
CREATE INDEX idx_obs_deployment ON deployment_observations(deployment_id, observed_at);

CREATE TABLE deployment_convergence (
  id TEXT PRIMARY KEY,                       -- = deployment id
  deployment_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  diff_json TEXT,
  detail TEXT,
  since INTEGER NOT NULL,
  evaluated_at INTEGER NOT NULL,
  last_converged_at INTEGER,
  last_converged_revision_id TEXT
);

CREATE TABLE deployment_locks (
  id TEXT PRIMARY KEY,                       -- = deployment id
  deployment_id TEXT NOT NULL UNIQUE,
  rollout_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------- vulnerabilities
CREATE TABLE vulnerabilities (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  cvss REAL NOT NULL,
  package TEXT NOT NULL,
  description TEXT,
  fixed_in_note TEXT,
  published_at INTEGER NOT NULL
);

CREATE TABLE vulnerability_findings (
  id TEXT PRIMARY KEY,
  vulnerability_id TEXT NOT NULL REFERENCES vulnerabilities(id),
  image_id TEXT NOT NULL REFERENCES engine_images(id),
  source_id TEXT NOT NULL REFERENCES data_sources(id),
  status TEXT NOT NULL CHECK (status IN ('open','in_progress','remediated','risk_accepted','false_positive')),
  detected_at INTEGER NOT NULL,
  status_changed_at INTEGER NOT NULL,
  accepted_until INTEGER,
  notes TEXT,
  updated_by TEXT,
  UNIQUE (vulnerability_id, image_id)
);

-- ---------------------------------------------------------------- rollouts
CREATE TABLE rollouts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('model','engine','model_and_engine')),
  target_model_version_id TEXT,
  target_engine_version_id TEXT,
  linked_vulnerability_id TEXT,
  reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft','ready','in_progress','paused','completed','rolling_back','rolled_back','cancelled')),
  approval_status TEXT NOT NULL CHECK (approval_status IN ('not_required','pending','approved','rejected')),
  pause_reason TEXT,
  requested_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  submitted_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE rollout_waves (
  id TEXT PRIMARY KEY,
  rollout_id TEXT NOT NULL REFERENCES rollouts(id),
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  bake_minutes INTEGER NOT NULL,
  is_prod INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','awaiting_approval','in_progress','succeeded','failed','rolling_back','rolled_back')),
  started_at INTEGER,
  finished_at INTEGER
);

CREATE TABLE rollout_targets (
  id TEXT PRIMARY KEY,
  rollout_id TEXT NOT NULL REFERENCES rollouts(id),
  wave_id TEXT NOT NULL REFERENCES rollout_waves(id),
  deployment_id TEXT NOT NULL REFERENCES deployments(id),
  new_model_version_id TEXT NOT NULL,
  new_engine_version_id TEXT NOT NULL,
  new_image_id TEXT NOT NULL,
  prev_revision_id TEXT,
  new_revision_id TEXT,
  request_id TEXT,
  rollback_revision_id TEXT,
  rollback_request_id TEXT,
  guardrail_json TEXT NOT NULL,
  acknowledged_json TEXT NOT NULL,
  justification TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','applying','verifying','succeeded','failed','skipped','rolling_back','rolled_back')),
  failure_reason TEXT,
  manually_verified INTEGER NOT NULL DEFAULT 0,
  verify_deadline INTEGER,
  bake_until INTEGER,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE TABLE rollout_approvals (
  id TEXT PRIMARY KEY,
  rollout_id TEXT NOT NULL REFERENCES rollouts(id),
  approver_id TEXT NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  comment TEXT,
  at INTEGER NOT NULL
);

CREATE TABLE rollout_events (
  id TEXT PRIMARY KEY,
  rollout_id TEXT NOT NULL,
  target_id TEXT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  actor_id TEXT
);
CREATE INDEX idx_rollout_events ON rollout_events(rollout_id, at);

-- ---------------------------------------------------------------- audit
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  correlation_id TEXT
);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_at ON audit_log(at);

-- ---------------------------------------------------------------- simulation ("the real world")
CREATE TABLE sim_state (
  id TEXT PRIMARY KEY,
  now INTEGER NOT NULL,
  playing INTEGER NOT NULL,
  speed INTEGER NOT NULL,                    -- sim seconds per real second while playing
  last_real_ms INTEGER,
  seq INTEGER NOT NULL                       -- monotonic counter for generated ids
);

CREATE TABLE sim_world_workloads (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  service_name TEXT NOT NULL,
  model_raw TEXT NOT NULL,
  engine_raw TEXT NOT NULL,
  image_digest TEXT NOT NULL,
  replicas_ready INTEGER NOT NULL,
  replicas_total INTEGER NOT NULL,
  health TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  changed_by TEXT NOT NULL,                  -- 'deployer' | 'manual' | 'seed'
  UNIQUE (target_id, service_name)
);

CREATE TABLE sim_operations (
  id TEXT PRIMARY KEY,                       -- = external_ref
  target_id TEXT NOT NULL,
  service_name TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success','fail','phantom_success','unhealthy','no_result')),
  status TEXT NOT NULL CHECK (status IN ('running','done','cancelled')),
  reported TEXT                              -- what the deployer API returns once done
);

CREATE TABLE sim_faults (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('fail','phantom_success','unhealthy','no_result','source_offline')),
  target_id TEXT,
  source_id TEXT,
  remaining INTEGER NOT NULL,                -- uses left; -1 = until cleared
  created_at INTEGER NOT NULL,
  note TEXT
);

CREATE TABLE sim_cve_feed (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  image_digests_json TEXT NOT NULL,
  publish_at INTEGER,
  published INTEGER NOT NULL
);
