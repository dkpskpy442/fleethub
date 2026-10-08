# Future improvement: compatibility evidence bound to immutable identity

**Status:** Proposed. Not implemented in the prototype.
**Applies when:** FleetHub moves beyond the prototype toward production use.

## Context

The prototype records compatibility per **model version × engine version × hardware type**, with one
status: `certified | compatible | known_issues | incompatible` (absent = `untested`). That has two
problems:

1. **Those are labels, not identities.** Weights, image builds, serving config and platform can all
   change underneath the same labels, and the record keeps saying "certified".
2. **One status conflates different claims.** Loading, numerical correctness, model quality,
   performance, stability and safety have different owners, tests, workloads, thresholds and
   lifetimes. A combination certified for batch throughput can silently be used for an interactive,
   latency-sensitive service.

## Part 1: what evidence binds to

### Where the label-based grouping breaks

| What changes | Grouping unchanged? | Prototype behaviour |
|---|---|---|
| **Weights re-uploaded under the same version** (re-quantized, fixed shard, new tokenizer or chat template) | Yes | Compatibility is keyed on `model_version_id`, so it stays certified. Inventory resolves the model from the string `slug:version`, so the swap isn't even detectable. `model_versions.artifact_digest` exists but nothing checks it. |
| **Engine image rebuilt** (base-OS patch, CUDA bump, compiler flags) | Yes | Compatibility is keyed on `engine_version_id`, so the new digest inherits certification silently. (Desired state and drift *do* pin the image digest.) |
| **Serving config changes** (tensor parallelism, dtype, KV-cache dtype, max length, speculative decoding, LoRA adapters) | Yes | Not modelled. Seeded records already depend on it: "mitigate with `--max-model-len 32768`" and "FP8 KV-cache kernel missing for L4". |
| **Platform changes** (driver / CUDA / ROCm version, SXM vs PCIe, GPUs per replica, node image) | Yes | Hardware is a coarse SKU; a driver upgrade changes nothing in FleetHub. |

### Immutable identities

Evidence binds to content-addressed identities; version labels become views over them.

1. **Model artifact digest:** a manifest digest over everything that affects outputs: weight
   shards, tokenizer, `config.json`, generation config and chat template (an OCI artifact digest
   works). Versions become immutable pointers: re-pushing an existing version is rejected or creates
   a new build (`2.1+b2`) with a new digest.
2. **Engine image digest:** never a tag or version. Ideally accompanied by build provenance and an
   SBOM, so the difference between two digests can be explained.
3. **Serving config hash:** a canonical hash over **behaviour-relevant** parameters only
   (parallelism, dtypes, quantization, KV-cache settings, max length, speculative decoding,
   adapters). Operational settings (replicas, autoscaling, labels) are excluded, so scaling never
   voids evidence.
4. **Platform profile:** GPU SKU, topology (GPUs per replica, interconnect), supported driver and
   runtime version **ranges**, and node image. Ranges, not exact pins, or evidence becomes unusable.

The first three together form a **serving unit digest** (*what* runs). The platform profile stays a
separate axis (*where* it runs).

## Part 2: what a claim asserts

### Dimensions

| Dimension | Asserts | Typical evidence | Typical threshold | Owner |
|---|---|---|---|---|
| **Functional** | Loads and serves; API conformance (tokenization, streaming, stop sequences, tool calling, structured output) | Conformance suite | Pass/fail | Platform |
| **Numerical fidelity** | Outputs match a reference implementation within tolerance (catches kernel, dtype and quantization bugs) | Logprob divergence, top-k agreement, greedy token-match rate vs a reference engine/hardware | Tolerance per dtype / quantization | Platform |
| **Model quality** | No task regression | Eval suites, ideally **paired** against the current production serving unit | Relative: no regression beyond X, with confidence intervals | Model owner |
| **Performance** | Meets latency/throughput **for a specific workload** | Time to first token, inter-token latency (p50/p99), throughput per GPU under a declared load profile | The service's SLO | Service owner |
| **Stability** | Survives max context, sustained load and memory pressure | Soak tests, out-of-memory probes, error rates | Error budget, memory headroom | Platform |
| **Safety / behaviour** | Refusal, jailbreak and chat-template behaviour unchanged | Safety eval suites | Policy-defined | Safety team |

Security stays separate: it is already modelled as findings on image digests.

### First-class workload, tests and thresholds

- **Workload profiles:** e.g. `chat-interactive`, `batch-long-context-128k`, `rag-32k`, each defining
  prompt/output length distributions, concurrency, prefix-cache hit ratio and generation parameters.
  Every deployment declares its profile and SLO class.
- **Test suites:** versioned, so it is always known exactly what was run.
- **Acceptance policies:** versioned thresholds. Changing a threshold re-evaluates verdicts; it never
  rewrites old evidence.

## Part 3: claims and policy-derived eligibility

### Claims replace the stored status

Each claim records:

- **Subject:** serving unit digest + platform profile.
- **Dimension** and **workload profile**.
- **Test suite version** and raw metrics, including sample size and confidence intervals.
- **Acceptance policy version**.
- **Verdict:** `pass | fail | inconclusive | conditional` (benchmarks are noisy, so "inconclusive" is
  a real outcome).
- **Conditions:** checkable predicates that replace free-text "known issues", e.g. *valid only if
  `max_model_len ≤ 32768`*, evaluated against the serving config.
- **Attester, evidence links, signature and expiry.** Evidence ages; expired claims don't count.

### Eligibility is computed, never stored

Each deployment tier has a **requirement policy**, for example:

- **dev:** functional.
- **staging:** functional + numerical.
- **prod-interactive:** all six dimensions, with performance measured against `chat-interactive` and
  the service's SLO.

Guardrails answer *"is this change eligible for this deployment under its policy?"*. Failures are
specific, for example:

- "no performance evidence for `chat-interactive` on L4"
- "quality claim is conditional on `max_len ≤ 32k`, but the desired config sets 64k"

Any one-word rollup in the UI is always **relative to a policy**, e.g. "eligible for
prod-interactive", with a per-dimension breakdown.

### Inheritance, per dimension

Exact-identity binding alone would make CVE remediation slow (every base-image rebuild would need a
full eval cycle), so inheritance rules are explicit and recorded as evidence of their own:

| Change | Claims kept | Claims to re-establish |
|---|---|---|
| Image rebuild, same engine source commit, SBOM diff limited to base/OS layers | Quality, safety | Functional, numerical, performance smoke |
| Config change to a parameter classified as operational-only | All | None |
| Config change to a behaviour parameter (e.g. `max_len`) | Numerical | Performance, stability (and quality if generation-affecting) |
| Driver / runtime outside the certified range | Quality, safety | Numerical, performance |
| New weights digest | None | All |

### Rollouts produce evidence

Rollout bake windows already observe real traffic on the real workload. Their health and latency
results are recorded as production stability and performance claims for that serving unit and
platform, so canaries strengthen the evidence base instead of being discarded.

## Impact on the current code

| Area | Change |
|---|---|
| `model_versions` | New immutable, digest-keyed `model_artifacts`; versions point at an artifact build |
| `engine_images` | Already digest-keyed; becomes the engine side of a serving unit |
| New entities | `serving_configs` (canonical hash), `platform_profiles`, `workload_profiles`, `test_suites`, `acceptance_policies`, `requirement_policies` |
| `compatibility_records` | Replaced by `claims` (dimension, subject, workload, verdict, conditions, evidence, expiry, inheritance link). The version × version × hardware matrix becomes a derived summary |
| `desired_state_revisions` | Pin model artifact digest, image digest and config hash (today: image only) |
| Inventory / `deployment_observations` | Report the loaded model digest (e.g. a sidecar or init container that verifies weights at load time), the effective config hash and the node driver version. Drift gains `model_artifact`, `config` and `platform` fields |
| `domain/guardrails.py` | Evaluate the deployment's requirement policy dimension by dimension; a version-level "certified" is no longer sufficient |
| `domain/rollouts.py` | Bake-window results are written back as production claims |

The prototype already applies this principle in one place: drift and vulnerability matching use the
image **digest**, which is why the same-tag hotfix is caught. This proposal applies the same rule to
weights, config and platform, and splits "certified" into claims a policy can reason about.

## Open decisions

1. Which runtime parameters count as behaviour-relevant (inside the config hash) versus operational?
2. Where do weights get verified at load time, and how is the loaded digest reported to inventory?
3. Who owns each dimension's acceptance policy, and who may change thresholds?
4. Default evidence lifetime per dimension, and what happens when prod evidence expires mid-flight?
5. Which inheritance rules are allowed, and who approves adding a new one?
