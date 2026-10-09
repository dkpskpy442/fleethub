# FleetHub demo script (~15 minutes)

> **Prefer the in-app guided demo.** Click **Guided demo** in the header (or **Start guided demo** on
> the Overview). It resets the data, gives a three-step quick tour (Overview, a model version, an
> engine version), then plays one continuous story: remediating the critical CVE flagged in **Needs
> attention**. The tour operates the real UI (it clicks the attention item, the remediation button,
> each wizard step, Start, Approve, Retry…), switches persona at the hand-offs, and spotlights what to
> look at. Use the contextual button to perform each action, **I did it** if you did it by hand, or
> **Autoplay** for a hands-free run. Defined in `frontend/src/demo/steps.tsx`; nothing is mocked.

The script below is the same story for presenting manually.

Everything below runs on synthetic data and simulated infrastructure. Start from a clean seed
(**Reset** in the header, available to every persona). The sim clock starts at
`2026-10-08 09:00Z`. Switch personas with the **Acting as** menu in the header; time moves only when
you press **+5m / +30m / +2h** or **Play**.

## 1. What needs attention? (Overview) — as Jordan Kim, platform engineer

* The attention queue ranks: a **critical CVE** (SIM-2026-0142) running on 27 deployments (19 prod;
  4 unverifiable), a **drift** on `atlas-chat @ prd-use-h100-2`, an **unhealthy** Iris VL, two
  **unmanaged** workloads, a stale eu-west exporter and a **never-reporting** bare-metal exporter,
  a **pending prod approval**, deprecated versions still in use, and an expiring risk acceptance.
* Point out: "Unverifiable" is its own number — stale data is never counted as healthy.

## 2. Open a model version (user story 1)

**Models → Atlas Chat → 2.1**

* Lifecycle badge and allowed transitions (try *Change lifecycle* as Jordan → forbidden; model
  owners change lifecycle for their own team only — Marcus can).
* Compatibility matrix per hardware: vLLM 0.10.0 is certified on H100/A100/L4 but **untested** on
  MI300X; vLLM 0.10.1 has **no image** for MI300X.
* Deployed instances: desired vs observed side by side, with mismatches listed first (the hotfixed
  `prd-use-h100-2` shows an unregistered image digest).

## 3. Desired vs observed (user story 4)

**Fleet**: click the *unverifiable*, *drifted* and *unmanaged* chips.

* `atlas-chat @ prd-use-h100-2` → **Reconciliation chain**: desired rev → request → deployer claim
  → inventory evidence → verdict `drifted` (image digest differs, *unregistered*).
  *Accept observed* is refused (the hotfix image isn't in the catalog); *Reconcile* re-requests the
  desired revision.
* `sentinel-guard-shadow @ prd-use-l4-1` (deployed by hand with helm) → *Adopt* makes the observed
  state its first desired revision; it can then be included in rollouts.
* `atlas-chat @ prd-apne-mi300-bm` → *never reported*: health `unknown`, convergence `unverifiable`.

## 4. Engine vulnerability → remediation (user story 2)

**Vulnerabilities → SIM-2026-0142**

* Findings are per **image digest** (cuda and rocm builds of vLLM 0.8.5 and 0.9.1), rolled up to
  engine versions; exposure is shown both as *running* (observed) and *intended* (desired).
* Remediation options are guardrail-checked against every exposed deployment: **vLLM 0.10.0**
  (19 ok, 7 need justification, 1 blocked — Sentinel Guard on L4 is *incompatible*), 0.10.1
  (preview), 0.9.2 (carries its own high CVE).

## 5. Plan and run a staged rollout (user story 3)

*Plan remediation rollout* on vLLM 0.10.0:

1. **Targets & guardrails** — blocked targets are excluded with reasons; warnings (untested on
   MI300X, known issues on A100 for Mini 1.1, deprecated model, stale data) each need a written
   justification.
2. **Impact** — 26 deployments, 102 replicas, 19 prod, SIM-2026-0142 resolved on all of them.
3. **Waves** — non-prod → prod canary → us-east → us-west → eu-west → ap-northeast (editable).
4. **Submit for execution**. As Jordan, *Approve* is disabled (no self-approval). Click **Start**:
   non-prod runs while prod waits for approval. Press **+30m**.
5. Switch to **Taylor Brooks — release approver** → *Approve prod waves*. Press **+2h** twice.
6. The rollout **auto-pauses**: eu-west targets fail `unverifiable_stale_inventory` — the deployer
   said success, but there is no fresh inventory evidence.
7. As Jordan: **Simulator → bring the eu-west exporter online**, back on the rollout **Retry** the
   failed targets, **Resume**, **+2h**.
8. The bare-metal MI300X target fails the same way (its exporter has *never* reported). As
   **Alex — admin**, *Manually verify* with a justification: the target is flagged
   *manually verified* (never shown as observed success) and audited. **Resume** → completed.
9. Back on the vulnerability: findings on images with no remaining exposure flip to
   **remediated** automatically; remaining exposure is exactly Sentinel Guard on L4 (needs 0.10.1)
   and the two unmanaged workloads.

## 6. Phantom success, health gates and rollback

* The seeded **Forge Coder 3.1 rollout** is mid-canary with a *phantom success* fault armed on
  `prd-usw-h100-1`. After ~1h of sim time it pauses with `claimed_success_not_observed`; open the
  deployment to see the chain: deployer **reported success**, inventory shows 3.0.
  *Retry* → converges.
* **Simulator → arm "unhealthy"** on a cluster, roll something to it, and watch the **health gate**
  pause the rollout; *Roll back* the target → a new `rollback` desired revision converges to the
  previous version (history is never rewritten).
* Mid-rollout: deprecate the target engine version (**Engines → version → Change lifecycle**) and
  the next wave pauses for **re-acknowledgement**. Or publish **SIM-2026-0171** (critical, SGLang
  0.4.8) from the Simulator CVE feed and watch it appear on the Overview with no fix available.

## 7. Audit

**Audit log** shows every change with actor, role, reason and before/after — including
system-detected transitions (`convergence.drifted`, `deployment.discovered`, `finding.remediated`)
and simulated outside-world events (`sim.*`).
