# Future improvement: FleetHub as a governance layer over GitOps

**Status:** Proposed. Not implemented in the prototype.
**Applies when:** FleetHub moves beyond the prototype toward production use.

## Context

In the prototype, FleetHub is the **authoritative source of desired state**. It writes immutable
`desired_state_revisions` and pushes them to clusters through the `DeploymentSystem` adapter
(see [architecture.md §3](architecture.md#3-desired--observed-reconciliation-lifecycle)).

Most production fleets already run GitOps (Argo CD or Flux). There, Git is the desired state and a
controller applies it. If FleetHub stayed authoritative, it would become a second writer competing
with Git. This document proposes changing FleetHub's role: **Git owns desired runtime config**, and
FleetHub becomes the layer that governs and verifies changes to it.

## Proposed ownership

| Concern | Prototype | Governance over GitOps |
|---|---|---|
| Desired runtime config | FleetHub database | **Git** (Helm values / Kustomize per deployment) |
| Applying changes | FleetHub → `DeploymentSystem` adapter | **Argo CD / Flux** sync from Git |
| Proposing a change | Create a desired revision | **Open a pull request** against the GitOps repo |
| Approval | FleetHub approval record | **PR review / CODEOWNERS / GitHub environments**, plus a required FleetHub status check |
| Change audit | `audit_log` | **Git history**; FleetHub audits *decisions* (guardrail results, justifications, overrides) and links them to commits |
| Rollback | New `rollback` revision | **Revert PR** |
| Catalog, compatibility, vulnerabilities, risk acceptance | FleetHub | FleetHub (unchanged) |
| Reality | Inventory | Inventory, plus the controller's sync status |

In short: FleetHub is authoritative for **governance data and verification**, Git for **desired
config**, and inventory for **reality**. The prototype already keeps intent, claim and evidence
separate; this moves the owner of intent.

## What it buys

1. **No split brain.** Git is the single desired state, so FleetHub never fights the GitOps
   controller over what should run.
2. **FleetHub is not a chokepoint.** Teams can still ship through Git if FleetHub is down. Whether its
   PR check then fails open or closed is a policy decision (below).
3. **Smaller security footprint.** FleetHub needs rights to open PRs and read status. It never
   needs cluster credentials.
4. **No rebuilding solved problems.** Apply, retry, health assessment, self-heal, review workflows,
   signed history and revert come from the controller and Git.
5. **Mostly rebuildable database.** Desired state can be re-indexed from Git. Only governance data
   (catalog, compatibility, triage, justifications) needs backing up, and some of it could move to
   Git as code.
6. **Bypass becomes enforceable, not just detectable.** FleetHub's guardrails run as a **required
   status check** on any PR that touches managed paths. A change made in Git without the UI is still
   evaluated and can be blocked.
7. **Stronger verification evidence.** "Controller synced commit `abc123` and reports healthy" is
   stronger than a deployer's "succeeded". FleetHub can match the synced commit against the desired
   one, then confirm with inventory, as it does today.

## Costs and new problems

- **Longer chain, more states.** Plan → PR opened → approved → merged → synced to commit → observed.
  The reconciler gains states such as `proposed`, `merged_not_synced` and `synced_other_commit`.
- **Catalog-to-manifest mapping is the hard part.** Parsing and editing arbitrary Helm or Kustomize
  is brittle. Require a small structured contract per deployment (for example a `fleethub.yaml` or a
  dedicated values block holding model version, engine version and image digest) that FleetHub edits
  Renovate-style.
- **Locks become advisory.** Anyone can open a conflicting PR. Enforcement moves to the required
  check ("deployment is mid-rollout X") and merge-conflict handling.
- **Drift splits into three kinds:**
  - Git vs cluster: the controller already detects this (OutOfSync).
  - Git vs FleetHub policy: an ungoverned change was merged.
  - Cluster vs catalog: the model or engine running isn't the one in the catalog.

  Argo's `selfHeal` auto-reverts cluster drift, which contradicts the prototype's "flag, never
  auto-revert" policy. That needs a per-environment decision.
- **Approvals can end up in two places.** Keep human approval in GitHub; FleetHub records it and
  enforces it as a check rather than running a parallel approval system.
- **Waves span multiple PRs.** One PR per wave, merged only after the previous wave's gate passes.
  In-cluster canaries can be delegated to Argo Rollouts or Flagger.
- **Buy versus build.** [Kargo](https://kargo.io) already provides promotion with stages and
  verification on top of GitOps. Evaluate whether FleetHub should orchestrate promotions itself or
  supply catalog and policy data to a tool like it.

## Impact on the current code

Most of the prototype carries over, because the adapter boundaries are already in the right places.

| Area | Change |
|---|---|
| `domain/catalog.py`, `guardrails.py`, `vulns.py`, `rbac.py` | Unchanged |
| `domain/rollouts.py` (state machine, waves, gates) | Unchanged in shape. A target "apply" becomes "open/merge the wave PR" |
| `domain/reconciler.py` | Gains PR, merge and sync stages. "Inventory is evidence, the deployer is a claim" still holds |
| `adapters/interfaces.py` | `DeploymentSystem` is replaced by a **ChangeProposer** (open PR, poll review and merge state) and a **SyncStatusSource** (Argo/Flux app status and synced commit) |
| `desired_state_revisions` | Becomes an index of `(repo, path, commit)` fed by Git webhooks, instead of being authored by FleetHub |
| `deployment_locks` | Advisory; enforced through the required status check |
| Overview attention queue | New item: "ungoverned change merged in Git" |

## Open decisions

1. Can anyone merge to managed paths without FleetHub's check? Does the check fail open or closed
   when FleetHub is unavailable?
2. Should self-heal be on or off, per environment?
3. Do the catalog, compatibility and risk-acceptance data stay in a database, or move to Git?
4. How granular should PRs be: per wave, per deployment, or per environment?
5. Build promotion orchestration in FleetHub, or adopt Kargo or a similar tool?
