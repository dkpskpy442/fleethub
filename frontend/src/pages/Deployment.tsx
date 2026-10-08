import { CircleDashed, GitPullRequestArrow, Lock } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ActionButton, AuditList, EnvTag, EvLink, ImageTag, MvLink, RolloutLink, TargetLink, VulnLink } from "../components/domain";
import { OperationStatusPill, RequestStatusPill, SourcePill } from "../components/fleet/badges";
import { DiffTable, ReconciliationChain } from "../components/fleet/chain";
import { DesiredObservedCards } from "../components/fleet/StateCards";
import { ConvergenceBadge, FindingBadge, FreshnessBadge, HealthBadge, Pill, RolloutBadge, TargetBadge } from "../components/status";
import { Card, Empty, ErrorBox, Mono, PageHeader, Spinner, Table, Tabs, Td, Th, cx } from "../components/ui";
import { useApi } from "../lib/api";
import { fmtAgo, fmtTime, useNow } from "../lib/format";
import type { DeploymentDetail, ObservationView, VulnMini } from "../lib/types";

type Tab = "revisions" | "requests" | "observations" | "rollouts" | "vulns" | "events" | "audit";

const RECONCILABLE = ["drifted", "missing", "apply_failed", "not_observed_after_success"];
const ACCEPTABLE = ["drifted", "not_observed_after_success"];

export function DeploymentPage() {
  const { id = "" } = useParams();
  const now = useNow();
  const { data: d, error, isLoading } = useApi<DeploymentDetail>(`/deployments/${id}`, { refetchInterval: 4000 });
  const [tab, setTab] = useState<Tab>("revisions");

  if (isLoading) return <Spinner />;
  if (error || !d) return <ErrorBox error={error ?? new Error("Deployment not found")} />;

  const t = d.target;
  return (
    <>
      <PageHeader
        crumbs={<><Link to="/fleet" className="hover:underline">Fleet</Link> / <TargetLink id={t.id} name={t.name} /></>}
        title={<span>{d.service_name} <span className="font-normal text-slate-400">@</span> <TargetLink id={t.id} name={t.name} /></span>}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <EnvTag tier={t.environment.tier} name={t.environment.name} />
            <span>{t.region.name} ({t.region.cloud}) · {t.hardware.name}</span>
            {d.model_family && <span>· <Link className="text-indigo-700 hover:underline" to={`/models/${d.model_family.id}`}>{d.model_family.name}</Link></span>}
            <Mono className="text-slate-400">{d.id}</Mono>
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm">
            <span className="flex items-center gap-1.5"><span className="text-slate-500">Convergence</span><ConvergenceBadge value={d.convergence.state} title={d.convergence.detail} /></span>
            <span className="flex items-center gap-1.5"><span className="text-slate-500">Health</span><HealthBadge value={d.health} /></span>
            <span className="flex items-center gap-1.5"><span className="text-slate-500">Data</span><FreshnessBadge value={d.freshness.state} title={`${d.freshness.source_name}: last sync ${fmtAgo(d.freshness.last_sync_at, now)}`} /></span>
          </div>
        }
      />

      {d.lock && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-3 text-sm text-indigo-900">
          <Lock className="mt-0.5 size-4 shrink-0" />
          <div>
            Desired state locked by rollout <RolloutLink r={d.lock.rollout} /> <RolloutBadge value={d.lock.rollout.status} /> since{" "}
            {fmtAgo(d.lock.acquired_at, now)} - changes must go through that rollout.
          </div>
        </div>
      )}
      {!d.managed && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-indigo-200 bg-indigo-50/60 px-4 py-3 text-sm text-indigo-900">
          <CircleDashed className="mt-0.5 size-4 shrink-0" />
          <div>
            <strong>Unmanaged:</strong> this workload is running outside FleetHub (seen by inventory only). It has no desired state, so it can't drift,
            be reconciled or be included in rollouts until it is adopted.
          </div>
        </div>
      )}

      <div className="space-y-4">
        <Card title="Reconciliation chain" subtitle="Intent → request → deployer's claim → inventory evidence → verdict. Only inventory evidence decides convergence.">
          <ReconciliationChain d={d} />
          <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-slate-500">Desired vs observed diff</h3>
          <DiffTable d={d} />
        </Card>

        <DesiredObservedCards d={d} />

        <ActionsCard d={d} />

        <Card padded>
          <Tabs<Tab>
            value={tab}
            onChange={setTab}
            tabs={[
              { id: "revisions", label: `Revisions (${d.revisions.length})` },
              { id: "requests", label: `Requests (${d.requests.length})` },
              { id: "observations", label: "Observations" },
              { id: "rollouts", label: `Rollouts (${d.rollouts.length})` },
              { id: "vulns", label: `Vulns (${new Set([...d.vulns.observed, ...d.vulns.desired].map((v) => v.vulnerability_id)).size})` },
              { id: "events", label: `Events (${d.events.length})` },
              { id: "audit", label: `Audit (${d.audit.length})` },
            ]}
          />
          {tab === "revisions" && <Revisions d={d} />}
          {tab === "requests" && <Requests d={d} />}
          {tab === "observations" && <Observations d={d} />}
          {tab === "rollouts" && <Rollouts d={d} />}
          {tab === "vulns" && <Vulns d={d} />}
          {tab === "events" && <Events d={d} />}
          {tab === "audit" && <AuditList entries={d.audit} />}
        </Card>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ actions
function ActionsCard({ d }: { d: DeploymentDetail }) {
  const st = d.convergence.state;
  const lockReason = d.lock ? `Desired state is locked by rollout "${d.lock.rollout.title}" - act through that rollout.` : undefined;
  const why = (allowed: string[]) =>
    lockReason ?? (st === "unverifiable"
      ? "No fresh inventory evidence - the current state can't be verified, so there is nothing safe to act on."
      : `Only available when the deployment is ${allowed.map((s) => s.replace(/_/g, " ")).join(" / ")} (currently ${st.replace(/_/g, " ")}).`);
  return (
    <Card title="Actions" subtitle="Every action requires a reason and is recorded in the audit log.">
      <div className="grid gap-3 md:grid-cols-3">
        {!d.managed ? (
          <ActionItem
            button={
              <ActionButton
                label="Adopt deployment" variant="primary" perm="deployment.adopt" path={`/deployments/${d.id}/adopt`}
                disabled={!d.actions.can_adopt} disabledReason="Already managed" success="Deployment adopted"
                description="Adopting records the currently observed model, engine, image and replicas as revision 1 of the desired state. From then on FleetHub will detect drift and the deployment can be targeted by rollouts. The observed versions must be recognised by the catalog."
              />
            }
            text="Bring this out-of-band workload under FleetHub management: the observed state becomes the first desired revision."
          />
        ) : (
          <>
            <ActionItem
              button={
                <ActionButton
                  label="Reconcile" variant="primary" perm="deployment.reconcile" path={`/deployments/${d.id}/reconcile`}
                  disabled={!d.actions.can_reconcile} disabledReason={why(RECONCILABLE)} success="Reconcile requested"
                  description="Re-submits the current desired revision to the deployer (a new request attempt). Reality will be considered converged only once inventory reports the desired versions after the operation finishes."
                />
              }
              text="Re-apply the desired state: overwrite what is running with the current desired revision."
            />
            <ActionItem
              button={
                <ActionButton
                  label="Accept observed" variant="warning" perm="deployment.accept_drift" path={`/deployments/${d.id}/accept-observed`}
                  disabled={!d.actions.can_accept_observed} disabledReason={why(ACCEPTABLE)} reasonLabel="Justification" success="Observed state accepted as desired"
                  description="Makes the observed reality the new desired revision instead of changing what runs. The observed model/engine combination is checked against guardrails (lifecycle, compatibility, vulnerabilities) and the request is rejected if blocked."
                />
              }
              text="Make observed reality the new desired revision (guardrail-checked; may be rejected)."
            />
            <ActionItem
              button={
                <Link
                  to={`/rollouts/new?kind=engine&deployments=${encodeURIComponent(d.id)}`}
                  className={cx("inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-300 bg-white px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50",
                    d.lock && "pointer-events-none opacity-50")}
                  aria-disabled={!!d.lock}
                  title={lockReason}
                >
                  <GitPullRequestArrow className="size-3.5" /> Plan rollout
                </Link>
              }
              text="Plan a rollout for this deployment: change the desired model/engine via guarded, wave-based rollout."
            />
          </>
        )}
      </div>
    </Card>
  );
}

function ActionItem({ button, text }: { button: React.ReactNode; text: string }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="mb-1.5">{button}</div>
      <p className="text-xs text-slate-500">{text}</p>
    </div>
  );
}

// ------------------------------------------------------------------ tabs
function Revisions({ d }: { d: DeploymentDetail }) {
  const now = useNow();
  if (!d.revisions.length) return <Empty>No desired revisions - this deployment is unmanaged.</Empty>;
  return (
    <Table>
      <thead><tr><Th>Rev</Th><Th>Source</Th><Th>Model</Th><Th>Engine</Th><Th>Image</Th><Th>Replicas</Th><Th>Actor</Th><Th>Reason</Th><Th>Rollout</Th><Th>When</Th></tr></thead>
      <tbody>
        {d.revisions.map((r) => (
          <tr key={r.id} className={cx(r.current && "bg-indigo-50/40")}>
            <Td className="whitespace-nowrap font-medium">rev {r.rev_no} {r.current && <Pill tone="indigo">current</Pill>}</Td>
            <Td><SourcePill source={r.source} /></Td>
            <Td><MvLink mv={r.model_version} /></Td>
            <Td><EvLink ev={r.engine_version} /></Td>
            <Td><ImageTag img={r.image} /></Td>
            <Td className="tabular-nums">{r.replicas}</Td>
            <Td className="whitespace-nowrap">{r.actor?.name ?? "—"}{r.actor && <div className="text-xs text-slate-400">{r.actor.role}</div>}</Td>
            <Td className="max-w-xs text-xs text-slate-600">{r.reason ?? "—"}</Td>
            <Td>{r.rollout ? <RolloutLink r={r.rollout} /> : <span className="text-slate-400">—</span>}</Td>
            <Td className="whitespace-nowrap text-xs text-slate-500"><span title={fmtTime(r.created_at)}>{fmtAgo(r.created_at, now)}</span></Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function Requests({ d }: { d: DeploymentDetail }) {
  const now = useNow();
  if (!d.requests.length) return <Empty>No deployment requests have been issued for this deployment.</Empty>;
  return (
    <>
      <p className="mb-2 text-xs text-slate-500">
        A request is FleetHub asking the deployer to apply a revision; the operation is the deployer's own report. Superseded requests were replaced
        by a newer attempt or revision and no longer count.
      </p>
      <Table>
        <thead><tr><Th>Request</Th><Th>Rev / attempt</Th><Th>Status</Th><Th>Requested</Th><Th>Operation (deployer's claim)</Th><Th>Result</Th><Th>Finished</Th></tr></thead>
        <tbody>
          {d.requests.map((r) => {
            const sup = r.status === "superseded";
            return (
              <tr key={r.id} className={cx(sup && "text-slate-400 line-through decoration-slate-400")}>
                <Td><Mono>{r.id}</Mono><Mono className="block break-all text-slate-400" title="Idempotency key">{r.idempotency_key}</Mono></Td>
                <Td className="whitespace-nowrap">rev {r.rev_no} · #{r.attempt}</Td>
                <Td className="no-underline">
                  <RequestStatusPill value={r.status} />
                  {r.superseded_by_id && <div className="mt-0.5 text-[11px]">by <Mono>{r.superseded_by_id}</Mono></div>}
                </Td>
                <Td className="whitespace-nowrap text-xs">
                  <span title={fmtTime(r.requested_at)}>{fmtAgo(r.requested_at, now)}</span>
                  {r.requested_by && <div className="text-slate-400">{r.requested_by.name}</div>}
                </Td>
                <Td>
                  {r.operation ? (
                    <>
                      <OperationStatusPill value={r.operation.status} />
                      <div className="mt-0.5 text-[11px] text-slate-400">{r.operation.adapter} · <Mono>{r.operation.external_ref}</Mono></div>
                    </>
                  ) : <span className="text-xs text-slate-400">not submitted</span>}
                </Td>
                <Td className="max-w-xs text-xs">{r.operation?.result_message ?? "—"}</Td>
                <Td className="whitespace-nowrap text-xs text-slate-500">
                  {r.operation?.finished_at ? <span title={fmtTime(r.operation.finished_at)}>{fmtAgo(r.operation.finished_at, now)}</span>
                    : r.operation ? <span title={fmtTime(r.operation.timeout_at)}>timeout {fmtAgo(r.operation.timeout_at, now)}</span> : "—"}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </>
  );
}

function obsSig(o: ObservationView) {
  return [o.present, o.model_raw, o.engine_raw, o.image_digest, o.replicas_ready, o.replicas_total, o.health].join("|");
}

function Observations({ d }: { d: DeploymentDetail }) {
  const now = useNow();
  // Rows arrive newest first; collapse consecutive identical readings into one "unchanged since" row.
  const runs: { o: ObservationView; first: number; n: number }[] = [];
  for (const o of d.observations) {
    const last = runs[runs.length - 1];
    if (last && obsSig(last.o) === obsSig(o)) { last.first = o.observed_at; last.n += 1; }
    else runs.push({ o, first: o.observed_at, n: 1 });
  }
  if (!runs.length) {
    return (
      <div className="hatched rounded-lg border border-slate-300 p-6 text-center text-sm text-slate-700">
        Inventory has never reported this workload ({d.freshness.source_name}). Its state is unverifiable.
      </div>
    );
  }
  return (
    <>
      <p className="mb-2 text-xs text-slate-500">
        Raw evidence from <strong>{d.freshness.source_name}</strong>, newest first; identical consecutive readings are collapsed. Values not in the catalog
        are shown as reported. Health here is what the workload reported at that time.
      </p>
      <ol className="relative space-y-0 border-l border-slate-200 pl-4">
        {runs.map(({ o, first, n }, i) => (
          <li key={o.id} className="relative pb-4">
            <span className={cx("absolute -left-[21px] top-1.5 size-2.5 rounded-full ring-2 ring-white", i === 0 ? "bg-indigo-500" : "bg-slate-300")} />
            <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-slate-500">
              <span className="font-medium text-slate-700" title={fmtTime(o.observed_at)}>{fmtAgo(o.observed_at, now)}</span>
              {n > 1 && <span>unchanged since {fmtAgo(first, now)} ({n} readings)</span>}
              {i === 0 && <Pill tone="gray">latest</Pill>}
            </div>
            {!o.present ? (
              <div className="mt-1 text-sm font-medium text-red-700">absent - not running on this cluster</div>
            ) : (
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                {o.model_version ? <MvLink mv={o.model_version} lifecycle={false} /> : <Mono className="text-orange-700" title="Not recognised by catalog">{o.model_raw ?? "?"}</Mono>}
                <span className="text-slate-300">/</span>
                {o.engine_version ? <EvLink ev={o.engine_version} lifecycle={false} /> : <Mono className="text-orange-700" title="Not recognised by catalog">{o.engine_raw ?? "?"}</Mono>}
                <ImageTag img={o.image} digest={o.image_digest} />
                <span className="text-xs text-slate-500">{o.replicas_ready ?? "?"}/{o.replicas_total ?? "?"} ready</span>
                <HealthBadge value={o.health} title="Health as reported at the time of this observation" />
              </div>
            )}
          </li>
        ))}
      </ol>
    </>
  );
}

function Rollouts({ d }: { d: DeploymentDetail }) {
  if (!d.rollouts.length) return <Empty>This deployment has not been part of any rollout.</Empty>;
  return (
    <Table>
      <thead><tr><Th>Rollout</Th><Th>Rollout status</Th><Th>This deployment's target status</Th></tr></thead>
      <tbody>
        {d.rollouts.map((r) => (
          <tr key={r.target_id}>
            <Td><RolloutLink r={r} /></Td>
            <Td><RolloutBadge value={r.status} /></Td>
            <Td><TargetBadge value={r.target_status} /></Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function VulnList({ items, empty }: { items: VulnMini[]; empty: string }) {
  if (!items.length) return <div className="text-sm text-slate-500">{empty}</div>;
  return (
    <ul className="space-y-2">
      {items.map((v) => (
        <li key={v.finding_id} className="text-sm">
          <div className="flex flex-wrap items-center gap-1.5"><VulnLink v={{ id: v.vulnerability_id, external_id: v.external_id, severity: v.severity }} /><FindingBadge value={v.status} /></div>
          <div className="text-xs text-slate-500">{v.title}</div>
        </li>
      ))}
    </ul>
  );
}

function Vulns({ d }: { d: DeploymentDetail }) {
  const stale = d.freshness.state !== "fresh";
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className={cx("rounded-lg border p-3", stale ? "hatched border-slate-300" : "border-slate-200")}>
        <h3 className="mb-1 text-sm font-semibold">Running (observed image)</h3>
        <p className="mb-2 text-xs text-slate-500">
          {stale ? "Based on last-known inventory data - unverifiable until the source syncs again." : "Findings on the image inventory reports is running."}
        </p>
        <VulnList items={d.vulns.observed} empty={d.observed ? "No findings on the observed image." : "Never observed - exposure unknown."} />
      </div>
      <div className="rounded-lg border border-slate-200 p-3">
        <h3 className="mb-1 text-sm font-semibold">Intended (desired image)</h3>
        <p className="mb-2 text-xs text-slate-500">Findings on the image the current desired revision specifies.</p>
        <VulnList items={d.vulns.desired} empty={d.desired ? "No findings on the desired image." : "No desired state."} />
      </div>
    </div>
  );
}

function Events({ d }: { d: DeploymentDetail }) {
  const now = useNow();
  if (!d.events.length) return <Empty>No rollout events for this deployment.</Empty>;
  return (
    <Table>
      <thead><tr><Th>When</Th><Th>Kind</Th><Th>Message</Th><Th>Actor</Th><Th>Rollout</Th></tr></thead>
      <tbody>
        {d.events.map((e) => (
          <tr key={e.id}>
            <Td className="whitespace-nowrap text-xs text-slate-500"><span title={fmtTime(e.at)}>{fmtAgo(e.at, now)}</span></Td>
            <Td><Mono>{e.kind}</Mono></Td>
            <Td className="max-w-xl">{e.message}</Td>
            <Td className="whitespace-nowrap text-xs">{e.actor?.name ?? e.actor_id}</Td>
            <Td><Link to={`/rollouts/${e.rollout_id}`} className="text-xs text-indigo-700 hover:underline">{e.rollout_id}</Link></Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
