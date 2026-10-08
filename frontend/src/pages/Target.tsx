import { Link, useParams } from "react-router-dom";
import { DeploymentTable, EnvTag, SourceLine } from "../components/domain";
import { Card, ErrorBox, KV, Mono, PageHeader, Spinner, cx } from "../components/ui";
import { useApi } from "../lib/api";
import { fmtAgo, fmtDuration, fmtTime, useNow } from "../lib/format";
import type { TargetDetail } from "../lib/types";

export function TargetPage() {
  const { id = "" } = useParams();
  const now = useNow();
  const { data: t, error, isLoading } = useApi<TargetDetail>(`/targets/${id}`, { refetchInterval: 4000 });
  if (isLoading) return <Spinner />;
  if (error || !t) return <ErrorBox error={error ?? new Error("Cluster not found")} />;
  const s = t.source;
  const unmanaged = t.deployments.filter((d) => !d.managed).length;

  return (
    <>
      <PageHeader
        crumbs={<Link to="/fleet" className="hover:underline">Fleet</Link>}
        title={t.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <EnvTag tier={t.environment.tier} name={t.environment.name} />
            <span>{t.region.name} ({t.region.cloud}) · {t.hardware.vendor} {t.hardware.name}</span>
          </span>
        }
        actions={<Link to={`/fleet?cluster=${encodeURIComponent(t.id)}`} className="text-sm text-indigo-700 hover:underline">Open in fleet view →</Link>}
      />
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card title="Cluster">
          <KV items={[
            ["Environment", <EnvTag tier={t.environment.tier} name={t.environment.name} />],
            ["Region", `${t.region.name} · ${t.region.cloud}`],
            ["Hardware", `${t.hardware.vendor} ${t.hardware.name} (${t.hardware.accelerator})`],
            ["Deployer", <Mono>{t.deployer}</Mono>],
            ["Inventory source", s.name],
            ["Deployments", `${t.deployments.length}${unmanaged ? ` (${unmanaged} unmanaged)` : ""}`],
          ]} />
        </Card>
        <Card
          title="Inventory source freshness"
          subtitle="All observed state, health and convergence on this cluster depend on this source."
          className={cx(s.freshness !== "fresh" && "ring-1 ring-amber-300")}
        >
          <div className="mb-3"><SourceLine name={s.name} lastSync={s.last_sync_at} freshness={s.freshness} /></div>
          <KV items={[
            ["Description", s.description],
            ["Last sync", s.last_sync_at ? <span title={fmtTime(s.last_sync_at)}>{fmtAgo(s.last_sync_at, now)}</span> : <span className="text-slate-500">never</span>],
            ["Last sync status", s.last_sync_status ?? "—"],
            ["Sync interval", `every ${fmtDuration(s.sync_interval_s)}`],
            ["Thresholds", <span>fresh ≤ {fmtDuration(s.fresh_threshold_s)} · stale ≤ {fmtDuration(s.stale_threshold_s)} · older or never = no data</span>],
          ]} />
          {s.last_error && <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{s.last_error}</div>}
          {s.freshness !== "fresh" && (
            <div className="hatched mt-3 rounded-md border border-slate-300 px-3 py-2 text-xs text-slate-700">
              Without fresh data every deployment on this cluster shows health <strong>unknown</strong> and convergence <strong>unverifiable</strong>,
              regardless of what the deployer last claimed.
            </div>
          )}
        </Card>
      </div>
      <Card title="Deployments on this cluster" padded={false}>
        <DeploymentTable rows={t.deployments} empty="No deployments on this cluster." />
      </Card>
    </>
  );
}
