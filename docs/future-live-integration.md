# Future improvement: phased integration with live systems

**Status:** Proposed. Not implemented in the prototype.
**Applies when:** FleetHub moves beyond the prototype and starts replacing simulated data with real
systems.

## Context

Everything outside FleetHub is simulated in the prototype: the deployment system, inventory sources,
the vulnerability scanner and the CVE feed (`adapters/simulated/`). The adapter interfaces in
`adapters/interfaces.py` are the seams where real systems plug in.

The guiding principle for going live is **operational health first**: FleetHub must prove that it
sees the fleet correctly, that its own dependencies are healthy, and that its decisions are right,
*before* it is allowed to change anything. Read paths go live before write paths, non-prod before
prod, and every phase has explicit exit criteria.

## Principles

1. **Observe before acting.** Each integration starts read-only. Writes are enabled only after the
   read side has met its exit criteria.
2. **FleetHub's own health gates its actions.** If any dependency a decision relies on is unhealthy
   (stale inventory, scanner lag, deployer API errors, metrics backend down), FleetHub refuses to start
   or advance a rollout. This generalizes the prototype's rule that stale inventory is "unverifiable",
   never "OK".
3. **Per-adapter, per-environment modes.** Each integration has a mode flag
   (`off → read → shadow → write`) set per environment, so prod can stay read-only while staging writes.
4. **Fail open to the existing process.** Turning FleetHub off must never block deployments. Teams
   fall back to today's tooling (GitOps or manual) and FleetHub catches up from inventory.
5. **Keep the simulator.** It becomes the test harness for adapter contract tests, CI and game days,
   not the source of production data.

## Integration modes

| Mode | FleetHub reads | FleetHub writes | Alerts |
|---|---|---|---|
| `off` | — | — | — |
| `read` | Yes | No | Dashboards only |
| `shadow` | Yes | Computes and records what it *would* do (plans, diffs, guardrail decisions); no side effects | Notifications marked dry-run |
| `write` | Yes | Yes, behind approvals, rate limits and a kill switch | Paging allowed |

## Phases

### Phase 0: production foundations

- Real identity: SSO/OIDC replaces the persona switcher; roles map from IdP groups; team ownership
  comes from the org directory.
- Production database decision (D1 vs. Postgres), backups, migrations with rollback, audit-log
  retention and tamper evidence.
- **FleetHub's own observability:** request and error rates, per-adapter latency and error rates,
  inventory sync lag, scanner lag, reconciler cycle time. Define SLOs for FleetHub itself.
- **Dependency health model:** a `system_health` view that every gate consults (see principle 2).
- Global kill switch and per-adapter mode flags.

**Exit:** auth, audit and FleetHub's own SLO dashboards are live; the kill switch is tested.

### Phase 1: read-only inventory

- Real `InventorySource` adapters (Kubernetes API, GitOps controller app status, cloud APIs), rolled
  out one non-prod cluster first, then all clusters.
- Every workload is discovered as **unmanaged**; no desired state is authored yet.
- Catalog import: model artifacts from the model registry, engine images from the container registry
  (by digest).
- Measure:
  - **Coverage:** percentage of clusters reporting.
  - **Freshness:** percentage of deployments `fresh` against per-source thresholds.
  - **Resolution rate:** percentage of observations that resolve to catalog digests (unresolvable =
    unregistered images or models to chase down).
  - **Accuracy:** periodic spot checks of FleetHub's view against ground truth.

**Exit:** 100% of clusters reporting; freshness SLO met for N consecutive weeks; unresolvable rate
below an agreed threshold.

### Phase 2: read-only security and evidence

- Real `VulnerabilityScanner` adapters (registry scanning), and the CVE feed from the security team's
  source of record.
- Compatibility evidence pipelines from eval and benchmark systems (see
  [future-compatibility-evidence.md](future-compatibility-evidence.md)).
- Reconcile FleetHub's findings and exposure counts against the security team's existing reports.

**Exit:** parity with existing vulnerability reporting; security team signs off on exposure numbers.

### Phase 3: desired state and shadow mode

- Establish desired state: bulk-adopt observed state as desired revision 1, or index it from GitOps
  repos (see [future-gitops-governance.md](future-gitops-governance.md)).
- Turn on the reconciler, guardrails and rollout planning in **shadow mode**: FleetHub records the
  drift alerts it would raise and the rollouts it would plan, and the deployment adapter produces
  plans and diffs only (e.g. Argo CD diff, `helm diff`, a draft PR).
- Compare shadow decisions with what humans actually did; tune guardrails and alert thresholds.

**Exit:** no false-positive drift alerts for N weeks; shadow guardrail decisions reviewed and agreed by
platform and security owners.

### Phase 4: gated writes in non-prod

- Enable the write adapter (deployer, or PR proposer under GitOps) for **dev and staging only**.
- Every rollout requires human approval; per-day change limits and blast-radius caps apply.
- **Game days** that mirror the simulator's fault injection against real systems: inventory outage,
  deployer failure, a deployer claiming success it didn't achieve, unhealthy release, scanner outage.
  Each must produce the same safe behaviour the prototype demonstrates (pause, unverifiable,
  rollback).
- Rollback drills on every engine family.

**Exit:** N successful non-prod rollouts; all game-day scenarios behave as designed; rollback drills
pass.

### Phase 5: progressive production

- Start with low-risk prod services (internal traffic, single region), canary plus **metric gates**
  (see [future-metric-gates.md](future-metric-gates.md)).
- Expand by service tier and region. Humans approve every prod rollout throughout this phase.
- Only after a sustained record, consider automating approval for low-risk change classes (e.g. base
  image patch rebuilds that inherit evidence).

**Exit:** prod rollouts routinely go through FleetHub; incident reviews show no FleetHub-caused
regressions.

### Phase 6: retire simulation from production

- Remove simulated adapters and seed data from production builds.
- Keep the simulator for adapter contract tests, CI, demos and game-day rehearsal.

## Rollout preflight: "all systems functional"

Before a rollout starts, and again before each wave, FleetHub evaluates a preflight checklist. Any
red item blocks; unknown counts as red.

| Check | Example criterion |
|---|---|
| Inventory freshness | Every target's source is `fresh` |
| Scanner freshness | Last scan of target images within threshold |
| Deployer / GitOps controller | API reachable, error rate below threshold, no stuck operations |
| Metrics backend | Queries for the gate metrics return data for every target |
| Approvals and locks | Required approvals present; no conflicting locks |
| FleetHub itself | Within its own SLOs; reconciler cycle not lagging |
| Change freeze / incidents | No active freeze or open incident on target services |

## Impact on the current code

| Area | Change |
|---|---|
| `adapters/` | Real implementations per system, each with a contract test suite that the simulated adapter also passes |
| New: adapter mode flags | `off / read / shadow / write` per adapter per environment; shadow writes record intended actions without side effects |
| New: `system_health` | Aggregates dependency health; consulted by every gate and by the preflight check |
| `domain/rollouts.py` | Preflight checklist before start and before each wave |
| `api/context.py` | Real identity (OIDC) replaces the persona switcher |
| `seed/`, simulator | Excluded from production builds; kept for tests, demos and game days |

## Open decisions

1. Which clusters and services make up the Phase 1 and Phase 5 pilot set?
2. N (weeks) and the thresholds for each phase's exit criteria, and who signs them off.
3. Database for production (D1 vs. Postgres) and audit retention requirements.
4. Who can flip an adapter from `shadow` to `write`, per environment?
5. Change-freeze and incident data sources the preflight check should consult.
