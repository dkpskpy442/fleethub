# FleetHub

A working prototype of a central hub for **AI models and their inference runtimes** across their
lifecycle and across an infrastructure fleet. It answers:

* **What do we have?** Model catalog (families → versions with lifecycle, ownership, artifacts) and
  engine catalog (engines → versions → container images with supported hardware and lifecycle).
* **Which combinations are supported?** Compatibility recorded per *model version × engine version ×
  hardware*; missing records are explicitly *untested*.
* **Where is it running, and is that what we intended?** Fleet inventory comparing FleetHub's
  **desired state** (versioned, the source of truth for intent) with **observed state** from
  inventory sources, with convergence, health and data freshness kept as separate signals.
* **What needs attention?** Vulnerabilities attached to image digests with observed/desired
  exposure, drift, unmanaged (hand-deployed) workloads, unhealthy or unverifiable deployments,
  deprecated versions in use, paused rollouts and pending approvals.
* **How do we roll out safely?** Guardrail-checked, staged rollouts with prod approval
  (no self-approval), inventory-verified gates, bake windows, auto-pause, retry, rollback, and a
  full audit trail.

> All data is synthetic. Deployment systems, inventory exporters and the vulnerability scanner are
> **simulated** behind real adapter interfaces — nothing is deployed anywhere.

Start with **[docs/architecture.md](docs/architecture.md)** (data model and the
desired → observed reconciliation lifecycle) and **[docs/demo-script.md](docs/demo-script.md)**
(a 15-minute walkthrough of the user stories).

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 19 + TypeScript, Vite, React Router, TanStack Query, Tailwind CSS |
| Backend | Python 3.12, FastAPI — runs on uvicorn locally and on **Cloudflare Python Workers** in production |
| Database | SQLite locally / in tests, **Cloudflare D1** in production (same SQL, same migrations) |
| CI/CD | GitHub Actions → Cloudflare Workers (API + static assets in one Worker) |

## Repository layout

```
backend/
  migrations/0001_init.sql        relational schema (D1 + SQLite)
  src/worker.py                   Workers entrypoint (ASGI adapter)
  src/fleethub/
    app.py                        FastAPI app
    api/                          routers, request context/auth, read models (views.py)
    db/                           Database protocol, sqlite + D1 drivers, Store (unit of work)
    domain/                       reconciler, desired_state, guardrails, rollouts, fleet, vulns,
                                  catalog, rbac, audit, simulation
    adapters/                     DeploymentSystem / InventorySource / VulnerabilityScanner
      simulated/                  simulated implementations ("the real world")
    seed/                         synthetic catalog + generator that *runs* 30h of history
  tests/                          pytest: reconciler, guardrails, end-to-end API flows, auth
  wrangler.jsonc                  Worker config (D1 binding, static assets)
frontend/
  src/pages/                      one file per page
  src/components/                 ui primitives, status badges (one per status family), domain widgets
  e2e/                            Playwright smoke tests against the Workers runtime
docs/                             architecture + demo script
.github/workflows/                ci.yml (PR checks), deploy.yml (main → Cloudflare)
```

## Running locally

Prerequisites: Node 22+, [uv](https://docs.astral.sh/uv/) (the Workers toolchain needs uv ≥ 0.12.3;
`uv sync` installs a suitable `uv` into `backend/.venv/bin` if your system one is older).

**Fast loop (uvicorn + Vite):**

```bash
cd backend && uv sync && uv run uvicorn fleethub.app:app --app-dir src --port 8010 --reload
```

```bash
cd frontend && npm install && npm run dev
```

Open http://localhost:5173. The database (`backend/fleethub.local.db`) is created and seeded on the
first request. Auth is disabled locally unless `DEMO_PASSWORD` is set.

**Workers runtime parity (pywrangler + local D1, single origin):**

```bash
cd frontend && npm run build
```

```bash
cd backend && npx wrangler d1 migrations apply fleethub --local && PATH="$PWD/.venv/bin:$PATH" uv run pywrangler dev
```

Open http://localhost:8787. On the Workers runtime auth fails closed, so local secrets come from
`backend/.dev.vars` (copy `backend/.dev.vars.example`; the demo password there is `fleethub-local`).

## Tests

```bash
cd backend && uv run pytest -q && uv run ruff check src tests
```

```bash
cd frontend && npm run build && npm run e2e
```

The backend suite covers the reconciler rules (table-driven), guardrails against the seeded catalog,
RBAC, auth, and end-to-end API flows: CVE → remediation rollout → approval → deploy → inventory →
finding remediated; phantom success → pause → retry/manual verify; stale inventory → unverifiable;
health gate → single-target rollback; whole-rollout rollback; drift → reconcile/accept (with
guardrails); adopt unmanaged → include in rollout; locks; mid-rollout guardrail re-check.

## Seed data

`backend/src/fleethub/seed/generate.py` inserts a static synthetic catalog and topology, then **runs
FleetHub** (real services + simulation) over ~30 simulated hours: initial fleet import, a completed
rollout, CVE publication and triage, hand-deployed workloads, an inventory outage, a hotfix drift, a
rollout mid-canary (with a phantom-success fault armed for its next wave) and a rollout awaiting
approval. The result is exported to `seed_data.py` / `seed/seed.sql` (deterministic; CI verifies it
is up to date). Regenerate with:

```bash
cd backend && PYTHONPATH=src uv run python -m fleethub.seed.generate
```

Admins can reset the demo from the **Simulator** page.

## Deployment (GitHub Actions → Cloudflare Workers)

`deploy.yml` runs on every push to `main`: CI (lint, tests, seed check, build, Playwright on the
Workers runtime) → resolve/create the `fleethub` D1 database → apply migrations → `pywrangler deploy`
→ sync Worker secrets → smoke-test the live URL (health, auth gate, login, data, SPA).

Repository secrets to configure (Settings → Secrets and variables → Actions):

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token with *Workers Scripts: Edit* and *D1: Edit* |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account id |
| `DEMO_PASSWORD` | Shared password for the demo (pushed to the Worker as a secret) |
| `SESSION_SECRET` | Random string used to sign session cookies |

On Workers, auth **fails closed**: if `DEMO_PASSWORD` is missing, all API calls are refused.
