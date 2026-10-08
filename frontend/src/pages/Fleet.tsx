import { Search, X } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { DeploymentTable } from "../components/domain";
import { ConvergenceBadge, FreshnessBadge, HealthBadge, Pill } from "../components/status";
import { Button, Card, ErrorBox, Input, PageHeader, Select, Spinner, cx } from "../components/ui";
import { useApi } from "../lib/api";
import type { ConvergenceState, DeploymentRow, Freshness, Health } from "../lib/types";

const CONVERGENCE: ConvergenceState[] = [
  "converged", "converging", "verifying", "drifted", "apply_failed", "not_observed_after_success", "missing", "unverifiable", "unmanaged",
];
const HEALTH: Health[] = ["healthy", "degraded", "unhealthy", "unknown"];
const FRESHNESS: Freshness[] = ["fresh", "stale", "unknown"];

type Filters = {
  env: string; region: string; cluster: string; family: string; managed: string; outdated: boolean; q: string;
  convergence: string[]; health: string[]; freshness: string[];
};

const MULTI = ["convergence", "health", "freshness"] as const;
type MultiKey = (typeof MULTI)[number];

function readFilters(sp: URLSearchParams): Filters {
  const list = (k: string) => (sp.get(k) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    env: sp.get("env") ?? "", region: sp.get("region") ?? "", cluster: sp.get("cluster") ?? "", family: sp.get("family") ?? "",
    managed: sp.get("managed") ?? "", outdated: sp.get("outdated") === "1" || sp.get("outdated") === "true", q: sp.get("q") ?? "",
    convergence: list("convergence"), health: list("health"), freshness: list("freshness"),
  };
}

const familyId = (d: DeploymentRow) => d.model_family?.id ?? d.observed?.model_version?.family_id ?? "";
const familyName = (d: DeploymentRow) => d.model_family?.name ?? d.observed?.model_version?.family_name ?? "";

/** Outdated = the version FleetHub intends to run (or, for unmanaged, what is observed) is past its supported lifecycle. */
function isOutdated(d: DeploymentRow): boolean {
  const mv = d.desired?.model_version ?? (d.managed ? null : d.observed?.model_version);
  const ev = d.desired?.engine_version ?? (d.managed ? null : d.observed?.engine_version);
  return (!!mv && (mv.lifecycle === "deprecated" || mv.lifecycle === "retired")) || (!!ev && (ev.lifecycle === "deprecated" || ev.lifecycle === "eol"));
}

function matches(d: DeploymentRow, f: Filters, skip?: MultiKey): boolean {
  if (f.env && d.target.environment.id !== f.env) return false;
  if (f.region && d.target.region.id !== f.region) return false;
  if (f.cluster && d.target.id !== f.cluster) return false;
  if (f.family && familyId(d) !== f.family) return false;
  if (f.managed === "true" && !d.managed) return false;
  if (f.managed === "false" && d.managed) return false;
  if (f.outdated && !isOutdated(d)) return false;
  if (skip !== "convergence" && f.convergence.length && !f.convergence.includes(d.convergence.state)) return false;
  if (skip !== "health" && f.health.length && !f.health.includes(d.health)) return false;
  if (skip !== "freshness" && f.freshness.length && !f.freshness.includes(d.freshness.state)) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const hay = [
      d.id, d.service_name, d.target.name, familyName(d), d.desired?.model_version?.label, d.desired?.engine_version?.label,
      d.desired?.image?.tag, d.observed?.model_raw, d.observed?.engine_raw, d.observed?.model_version?.label, d.observed?.engine_version?.label,
      d.observed?.image?.tag, d.observed?.image_digest,
    ].filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function uniq<T>(rows: DeploymentRow[], key: (d: DeploymentRow) => [string, T] | null): [string, T][] {
  const m = new Map<string, T>();
  for (const r of rows) { const kv = key(r); if (kv && kv[0]) m.set(kv[0], kv[1]); }
  return [...m.entries()];
}

export function FleetPage() {
  const [sp, setSp] = useSearchParams();
  const f = readFilters(sp);
  const { data, error, isLoading } = useApi<DeploymentRow[]>("/fleet", { refetchInterval: 5000 });
  const rows = useMemo(() => data ?? [], [data]);

  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(sp);
    if (v) next.set(k, v); else next.delete(k);
    setSp(next, { replace: true });
  };
  const toggle = (k: MultiKey, v: string) => {
    const cur = f[k];
    const nv = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    set(k, nv.join(",") || null);
  };

  const filtered = rows.filter((d) => matches(d, f));
  const facet = (k: MultiKey, get: (d: DeploymentRow) => string) => {
    const c: Record<string, number> = {};
    for (const d of rows) if (matches(d, f, k)) c[get(d)] = (c[get(d)] ?? 0) + 1;
    return c;
  };
  const convCounts = facet("convergence", (d) => d.convergence.state);
  const healthCounts = facet("health", (d) => d.health);
  const freshCounts = facet("freshness", (d) => d.freshness.state);

  const envs = uniq(rows, (d) => [d.target.environment.id, d.target.environment.name]);
  const regions = uniq(rows, (d) => [d.target.region.id, d.target.region.name]);
  const clusters = uniq(rows, (d) => (!f.env || d.target.environment.id === f.env) && (!f.region || d.target.region.id === f.region) ? [d.target.id, d.target.name] : null)
    .sort((a, b) => a[1].localeCompare(b[1]));
  const families = uniq(rows, (d) => [familyId(d), familyName(d)]).sort((a, b) => a[1].localeCompare(b[1]));
  const anyFilter = [...sp.keys()].length > 0;
  const unmanaged = rows.filter((d) => !d.managed).length;
  const outdated = rows.filter(isOutdated).length;

  return (
    <>
      <PageHeader
        title="Fleet"
        subtitle="Every deployment FleetHub knows about - managed or found by inventory - with intended state, observed reality, and how much the evidence can be trusted."
      />

      <div className="mb-4 grid gap-3 lg:grid-cols-[2fr_1fr_1fr]">
        <ChipGroup label="Convergence (desired vs observed)">
          {CONVERGENCE.filter((s) => convCounts[s] || f.convergence.includes(s)).map((s) => (
            <Chip key={s} active={f.convergence.includes(s)} count={convCounts[s] ?? 0} onClick={() => toggle("convergence", s)}>
              <ConvergenceBadge value={s} />
            </Chip>
          ))}
        </ChipGroup>
        <ChipGroup label="Health (fresh data only)">
          {HEALTH.filter((s) => healthCounts[s] || f.health.includes(s)).map((s) => (
            <Chip key={s} active={f.health.includes(s)} count={healthCounts[s] ?? 0} onClick={() => toggle("health", s)}>
              <HealthBadge value={s} />
            </Chip>
          ))}
        </ChipGroup>
        <ChipGroup label="Inventory data freshness">
          {FRESHNESS.filter((s) => freshCounts[s] || f.freshness.includes(s)).map((s) => (
            <Chip key={s} active={f.freshness.includes(s)} count={freshCounts[s] ?? 0} onClick={() => toggle("freshness", s)}>
              <FreshnessBadge value={s} />
            </Chip>
          ))}
        </ChipGroup>
      </div>

      <Legend />

      <Card padded={false}>
        <div className="grid grid-cols-1 gap-2 border-b border-slate-100 p-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2.5 size-3.5 text-slate-400" />
            <Input placeholder="Search service, cluster, version, digest…" value={f.q} onChange={(e) => set("q", e.target.value || null)} className="pl-7" />
          </div>
          <Select value={f.env} onChange={(e) => set("env", e.target.value || null)}
            options={[{ value: "", label: "All environments" }, ...envs.map(([v, l]) => ({ value: v, label: l }))]} />
          <Select value={f.region} onChange={(e) => set("region", e.target.value || null)}
            options={[{ value: "", label: "All regions" }, ...regions.map(([v, l]) => ({ value: v, label: l }))]} />
          <Select value={f.cluster} onChange={(e) => set("cluster", e.target.value || null)}
            options={[{ value: "", label: "All clusters" }, ...clusters.map(([v, l]) => ({ value: v, label: l }))]} />
          <Select value={f.family} onChange={(e) => set("family", e.target.value || null)}
            options={[{ value: "", label: "All model families" }, ...families.map(([v, l]) => ({ value: v, label: l }))]} />
          <Select value={f.convergence.length === 1 ? f.convergence[0] : f.convergence.length > 1 ? "__multi" : ""}
            onChange={(e) => e.target.value !== "__multi" && set("convergence", e.target.value || null)}
            options={[{ value: "", label: "Any convergence" }, ...(f.convergence.length > 1 ? [{ value: "__multi", label: `${f.convergence.length} states` }] : []),
              ...CONVERGENCE.map((c) => ({ value: c, label: c.replace(/_/g, " ") }))]} />
          <Select value={f.health.length === 1 ? f.health[0] : f.health.length > 1 ? "__multi" : ""}
            onChange={(e) => e.target.value !== "__multi" && set("health", e.target.value || null)}
            options={[{ value: "", label: "Any health" }, ...(f.health.length > 1 ? [{ value: "__multi", label: `${f.health.length} values` }] : []),
              ...HEALTH.map((c) => ({ value: c, label: c }))]} />
          <Select value={f.freshness.length === 1 ? f.freshness[0] : f.freshness.length > 1 ? "__multi" : ""}
            onChange={(e) => e.target.value !== "__multi" && set("freshness", e.target.value || null)}
            options={[{ value: "", label: "Any freshness" }, ...(f.freshness.length > 1 ? [{ value: "__multi", label: f.freshness.join(" + ") }] : []),
              ...FRESHNESS.map((c) => ({ value: c, label: c === "unknown" ? "no data" : c }))]} />
          <Select value={f.managed} onChange={(e) => set("managed", e.target.value || null)}
            options={[{ value: "", label: "Managed + unmanaged" }, { value: "true", label: "Managed only" }, { value: "false", label: `Unmanaged only (${unmanaged})` }]} />
          <div className="col-span-full flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm text-slate-700" title="Desired model is deprecated/retired or desired engine is deprecated/end-of-life">
            <input type="checkbox" checked={f.outdated} onChange={(e) => set("outdated", e.target.checked ? "1" : null)} className="size-4 rounded border-slate-300" />
            Outdated ({outdated})
          </label>
          {anyFilter && (
            <Button size="sm" variant="ghost" onClick={() => setSp(new URLSearchParams(), { replace: true })}><X className="size-3.5" />Clear filters</Button>
          )}
          <span className="ml-auto text-xs text-slate-500">{filtered.length} of {rows.length} deployments</span>
          </div>
        </div>
        {isLoading ? <Spinner /> : error ? <div className="p-3"><ErrorBox error={error} /></div> : (
          <DeploymentTable rows={filtered} empty={anyFilter ? "No deployments match these filters." : "No deployments."} />
        )}
      </Card>
    </>
  );
}

function ChipGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Chip({ active, count, onClick, children }: { active: boolean; count: number; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={active ? "Click to remove filter" : "Click to filter"}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-lg border px-1.5 py-1 text-xs transition-colors",
        active ? "border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500" : "border-slate-200 hover:border-slate-300 hover:bg-slate-50",
        count === 0 && !active && "opacity-50",
      )}
    >
      {children}
      <span className="min-w-[1.25rem] text-center font-semibold tabular-nums text-slate-800">{count}</span>
    </button>
  );
}

function Legend() {
  return (
    <div className="mb-4 grid gap-2 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600 shadow-sm md:grid-cols-4">
      <div><span className="font-semibold text-slate-800">Desired</span> - FleetHub's versioned revision: the source of truth for what <em>should</em> run.</div>
      <div><span className="font-semibold text-slate-800">Observed</span> - what the cluster's inventory source reports is running. Shown faded as <em>last known</em> when data isn't fresh.</div>
      <div><span className="font-semibold text-slate-800">Claim</span> - the deployer's own "succeeded/failed" report. Never treated as proof; open a deployment to see it next to the evidence.</div>
      <div className="flex flex-wrap items-center gap-1">
        <Pill tone="unknown">hatched</Pill> = no fresh evidence. Health, convergence and freshness are independent; stale data is never shown as healthy.
      </div>
    </div>
  );
}
