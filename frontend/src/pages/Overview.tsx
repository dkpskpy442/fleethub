import { ArrowRight, Boxes, Cpu, GitPullRequestArrow, Network, ShieldAlert, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { ApprovalBadge, FreshnessBadge, RolloutBadge, SeverityBadge } from "../components/status";
import { Button, Card, Empty, ErrorBox, PageHeader, Spinner, Stat, cx } from "../components/ui";
import { useTour } from "../demo/tour";
import { useApi } from "../lib/api";
import { fmtAgo, fmtDuration } from "../lib/format";
import type { AttentionItem, Overview } from "../lib/types";

const CATEGORY_LABEL: Record<string, string> = {
  vulnerability: "Security", rollout: "Rollouts", drift: "Drift", convergence: "Convergence", unmanaged: "Unmanaged",
  health: "Health", lifecycle: "Lifecycle", freshness: "Data freshness",
};

export function OverviewPage() {
  const { data, error, isLoading } = useApi<Overview>("/overview", { refetchInterval: 5000 });
  const tour = useTour();
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorBox error={error} />;
  const c = data.counts;
  const attention = c.convergence;
  const needs = (attention.drifted ?? 0) + (attention.apply_failed ?? 0) + (attention.not_observed_after_success ?? 0) + (attention.missing ?? 0);
  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="What do we run, where, is it what we intended, and what needs attention?"
      />
      {!tour.active && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3">
          <Sparkles className="size-5 text-indigo-600" />
          <div className="min-w-0 flex-1 text-sm text-indigo-900">
            <span className="font-medium">New here?</span> Take the guided demo: remediate a critical CVE across the fleet end to end,
            step by step or on autoplay. It resets the demo data first.
          </div>
          <Button variant="primary" size="sm" onClick={tour.start}>Start guided demo</Button>
        </div>
      )}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Stat label="Deployments" value={c.deployments} hint={`${c.managed} managed · ${c.deployments - c.managed} unmanaged`} />
        <Stat label="Converged" value={attention.converged ?? 0} tone="green" hint="verified by fresh inventory" />
        <Stat label="Needs action" value={needs} tone={needs ? "red" : "green"} hint="drift / failed / not observed" />
        <Stat label="Unverifiable" value={attention.unverifiable ?? 0} tone="gray" hint="stale or missing inventory data" />
        <Stat label="Open findings" value={c.open_findings} tone={c.open_findings ? "amber" : "green"} hint="open + in progress" />
        <Stat label="Active rollouts" value={c.active_rollouts} hint="ready, running, paused" />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <Card title="Needs attention" subtitle="Ranked by severity. Each item links to where you can act on it." padded={false}>
          {data.attention.length === 0 ? <div className="p-4"><Empty>Nothing needs attention.</Empty></div> : (
            <ul className="divide-y divide-slate-100">
              {data.attention.map((a, i) => <AttentionRow key={i} a={a} />)}
            </ul>
          )}
        </Card>

        <div className="space-y-5">
          <Card title="Fleet by environment">
            <div className="space-y-3">
              {data.environments.map((e) => (
                <div key={e.environment}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="font-medium text-slate-700">{e.environment}</span>
                    <span className="text-slate-500">{e.converged}/{e.total} converged</span>
                  </div>
                  <div className="flex h-2.5 overflow-hidden rounded-full bg-slate-100">
                    <div className="bg-emerald-500" style={{ width: `${(e.converged / e.total) * 100}%` }} title="converged" />
                    <div className="bg-orange-500" style={{ width: `${(e.attention / e.total) * 100}%` }} title="needs attention" />
                    <div className="hatched" style={{ width: `${(e.unverifiable / e.total) * 100}%` }} title="unverifiable" />
                  </div>
                </div>
              ))}
              <div className="flex gap-3 text-[11px] text-slate-500">
                <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-emerald-500" />converged</span>
                <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-orange-500" />attention</span>
                <span className="flex items-center gap-1"><span className="hatched size-2 rounded-sm ring-1 ring-slate-300" />unverifiable</span>
              </div>
            </div>
          </Card>

          <Card title="Active rollouts" actions={<Link to="/rollouts" className="text-xs text-indigo-700 hover:underline">All rollouts</Link>}>
            {data.rollouts.length === 0 ? <Empty>No active rollouts.</Empty> : (
              <ul className="space-y-3">
                {data.rollouts.map((r) => (
                  <li key={r.id}>
                    <Link to={`/rollouts/${r.id}`} className="text-sm font-medium text-indigo-700 hover:underline">{r.title}</Link>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <RolloutBadge value={r.status} />
                      {r.approval_status !== "not_required" && <ApprovalBadge value={r.approval_status} />}
                      {r.current_wave && <span className="text-xs text-slate-500">wave {r.current_wave.idx + 1}/{r.wave_count}: {r.current_wave.name}</span>}
                    </div>
                    {r.pause_reason && <div className="mt-1 text-xs text-amber-700">{r.pause_reason}</div>}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Data sources" subtitle="Freshness thresholds are per source. Stale data is never shown as healthy.">
            <ul className="space-y-2">
              {data.sources.map((s) => (
                <li key={s.id} className="flex items-start justify-between gap-2 text-xs">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-slate-700">{s.name}</div>
                    <div className="text-slate-500">
                      {s.last_sync_at ? `synced ${fmtAgo(s.last_sync_at, data.now)}` : "never reported"} · fresh &lt; {fmtDuration(s.fresh_threshold_s)}
                      {s.last_error && <span className="text-red-600"> · {s.last_error}</span>}
                    </div>
                  </div>
                  <FreshnessBadge value={s.freshness} />
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Catalog">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <QuickLink to="/models" icon={<Boxes className="size-4" />} label={`${c.model_families} model families`} sub={`${c.model_versions} versions`} />
              <QuickLink to="/engines" icon={<Cpu className="size-4" />} label={`${c.engines} engines`} sub={`${c.engine_versions} versions`} />
              <QuickLink to="/fleet" icon={<Network className="size-4" />} label="Fleet inventory" sub="desired vs observed" />
              <QuickLink to="/vulnerabilities" icon={<ShieldAlert className="size-4" />} label="Vulnerabilities" sub="exposure & remediation" />
              <QuickLink to="/rollouts/new" icon={<GitPullRequestArrow className="size-4" />} label="Plan a rollout" sub="guardrail-checked" />
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function AttentionRow({ a }: { a: AttentionItem }) {
  return (
    <li>
      <Link to={a.link} className="group flex items-start gap-3 px-4 py-3 hover:bg-slate-50">
        <div className="w-16 shrink-0 pt-0.5"><SeverityBadge value={a.severity} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium text-slate-900">{a.title}</span>
            <span className={cx("text-[11px] uppercase tracking-wide text-slate-400")}>{CATEGORY_LABEL[a.category] ?? a.category}</span>
          </div>
          <div className="mt-0.5 text-xs text-slate-600">{a.detail}</div>
        </div>
        <ArrowRight className="mt-1 size-4 shrink-0 text-slate-300 group-hover:text-slate-500" />
      </Link>
    </li>
  );
}

function QuickLink({ to, icon, label, sub }: { to: string; icon: React.ReactNode; label: string; sub: string }) {
  return (
    <Link to={to} className="flex items-start gap-2 rounded-lg border border-slate-200 p-2.5 hover:border-indigo-300 hover:bg-indigo-50/40">
      <span className="mt-0.5 text-slate-500">{icon}</span>
      <span>
        <span className="block text-xs font-medium text-slate-800">{label}</span>
        <span className="block text-[11px] text-slate-500">{sub}</span>
      </span>
    </Link>
  );
}
