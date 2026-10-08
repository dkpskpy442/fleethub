# Future improvement: metric-based rollout gates

**Status:** Proposed. Not implemented in the prototype.
**Applies when:** rollouts run against live production traffic.

## Context

In the prototype, a rollout target succeeds when the deployer's operation finished, fresh inventory
confirms the desired model, engine and image digest, replicas are ready, and health stays `healthy`
through the bake window (see [architecture.md §3.5](architecture.md#35-what-counts-as-a-successful-deployment)).

That proves the new version is **running**. It doesn't prove it is **performing**. An inference
engine upgrade can be perfectly healthy while doubling time to first token, degrading inter-token
latency under load, or truncating outputs. Gates need to check that serving metrics stay within
acceptable ranges, not just that pods are up.

## Metrics to gate on

| Metric | What it catches | Notes |
|---|---|---|
| **TTFT**: time to first token | Prefill regressions, scheduler or queueing changes | Strongly depends on prompt length: compare within prompt-length buckets |
| **TBT / ITL**: time between tokens (inter-token latency) | Decode kernel regressions, KV-cache or batching changes | Depends on concurrency and batch size |
| **TTLT**: time to last token (end-to-end latency) | Overall user-visible latency | Depends on output length: normalize or bucket |
| Queue / wait time | Capacity or scheduler regressions | Separates "slower" from "busier" |
| Throughput | Output tokens/s per replica, requests/s | Capacity planning; cost per token |
| Error rate | 5xx, timeouts, OOM kills, engine restarts | Hard gate; usually triggers early abort |
| Saturation | GPU memory, KV-cache utilization, batch size | Early warning before latency degrades |
| Output health | Stop-reason distribution, empty or truncated outputs, refusal rate, safety-classifier flags, output-length shift | Online proxies for quality regressions |

Each metric is evaluated at defined percentiles (e.g. p50, p95, p99), per **workload profile**
(e.g. `chat-interactive`, `batch-long-context`; see
[future-compatibility-evidence.md](future-compatibility-evidence.md)), and within request-shape
buckets (prompt length × output length), so a change in traffic mix isn't mistaken for a regression.

## How a gate decides

Two kinds of thresholds, both versioned and owned by the service owner:

- **Absolute (SLO):** e.g. TTFT p95 < 800 ms for `chat-interactive`; error rate < 0.5%.
- **Relative to a baseline:** e.g. TTFT p95 no more than 10% worse than baseline; TBT p99 no more than
  5% worse.

Baselines, in order of preference:

1. **Concurrent control:** unchanged deployments of the same service in the same region over the same
   window (canary vs. control). This removes time-of-day and traffic-mix effects.
2. **Pre-change window:** the same deployment before the change, at a comparable time.
3. **Workload benchmark:** the performance claim recorded for the previous serving unit.

Comparisons are statistical, not single-point. Use percentile comparisons with confidence intervals
or a non-parametric test over request-level latencies, with a **minimum sample size**.

Each evaluation produces a verdict: `pass | fail | inconclusive`.

- **Inconclusive** (not enough traffic, missing metrics, metrics backend unavailable) never counts as
  a pass. Policy decides whether to extend the bake window or fail. This is the same principle as
  stale inventory being "unverifiable".

## Where gates run in the rollout lifecycle

1. **Convergence verified** (as today): the operation finished and inventory confirms the new digest.
2. **Analysis window** (replaces the plain bake window): metrics are evaluated at intervals.
   - **Early abort** on hard breaches (error-rate spike, crash loops, TTFT far beyond SLO).
   - **Pass** only at the end of the window, with every metric within range and sufficient samples.
3. **Outcome:** a failed or inconclusive gate auto-pauses the rollout (or auto-rolls back the target,
   per policy), with the failing metrics shown on the target.
4. **Evidence:** the evaluation (queries, windows, baseline, observed values, thresholds, sample
   sizes, verdict) is stored on the rollout target, audited, and recorded as a production performance
   claim for that serving unit.

In-cluster canary analysis (traffic splitting inside one deployment) can be delegated to Argo
Rollouts or Flagger analysis templates, with FleetHub consuming their results. FleetHub keeps
cross-cluster, cross-region wave gating.

## Traffic considerations

- **Low-traffic services** may never reach the minimum sample size. Options: extend the window,
  generate synthetic load, or replay a sample of recent production prompts against the canary.
- **Model changes** need output-health signals as well as latency, since a model can be fast and
  wrong. Pair online signals with the offline quality claims required by policy.
- **Metric series must separate old and new pods.** Serving metrics need a label carrying the image
  digest or desired revision, so canary and control series can't mix during a rollout.

## Impact on the current code

| Area | Change |
|---|---|
| New adapter: `MetricsSource` | Query interface for Prometheus / Datadog / similar, with per-metric query templates and label mapping (deployment → series, revision/digest labels) |
| New entities | `metric_definitions`, `gate_policies` (per service tier and workload profile, versioned), `gate_evaluations` (target, metric, window, baseline, observed, threshold, sample size, verdict, query) |
| `domain/rollouts.py` | Bake window becomes an analysis window: periodic evaluation, early abort, pass/fail/inconclusive outcome feeding auto-pause or rollback |
| `domain/guardrails.py` / preflight | Gate metrics must be queryable for every target before a wave starts |
| Rollout UI | Per-target metric panel: canary vs. baseline per metric, thresholds, verdict and sample size |
| Simulator | Emit synthetic serving metrics with injectable regressions (e.g. TTFT regression on MI300X only), so the demo can show a "healthy but slow" rollout being paused |

## Open decisions

1. Default metric set and thresholds per service tier and workload profile, and who owns them.
2. Which baseline strategy is the default, and the fallback when no concurrent control exists.
3. Minimum sample sizes and maximum analysis-window extension before an inconclusive gate fails.
4. Auto-pause versus auto-rollback on gate failure, per environment.
5. Which output-health signals are reliable enough to gate on, versus only to display.
