import { AlertTriangle, PauseCircle, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { AuditList, EvLink, MvLink, VulnLink } from "../components/domain";
import { RolloutActions } from "../components/rollouts/detail/RolloutActions";
import { ApprovalsList, EventsTimeline } from "../components/rollouts/detail/Timeline";
import { WaveStepper } from "../components/rollouts/detail/WaveStepper";
import { KIND_LABEL, RolloutProgress } from "../components/rollouts/shared";
import { ApprovalBadge, RolloutBadge } from "../components/status";
import { Card, ErrorBox, KV, PageHeader, Spinner } from "../components/ui";
import { useApi } from "../lib/api";
import { fmtAgo, fmtTime, useNow } from "../lib/format";
import type { Meta, RolloutDetail } from "../lib/types";

export function RolloutPage() {
  const { id } = useParams();
  const { data: r, error, isLoading } = useApi<RolloutDetail>(`/rollouts/${id}`, { refetchInterval: 3000 });
  useApi<Meta>("/meta", { refetchInterval: 3000 }); // keeps the sim clock (countdowns) moving while this page is open
  const now = useNow();

  if (isLoading) return <Spinner />;
  if (error || !r) return <ErrorBox error={error ?? new Error("Rollout not found")} />;

  const targets = r.waves.flatMap((w) => w.targets);
  const failed = targets.filter((t) => t.status === "failed");
  const unack = targets.filter((t) => t.status === "pending" && t.unacknowledged.length > 0);
  const manual = targets.filter((t) => t.manually_verified).length;
  const when = (label: string, ts: number | null): [string, ReactNode] => [
    label,
    ts ? <span>{fmtAgo(ts, now)} <span className="text-xs text-slate-400">· {fmtTime(ts)}</span></span> : <span className="text-slate-400">—</span>,
  ];

  return (
    <>
      <PageHeader
        crumbs={<Link to="/rollouts" className="hover:underline">Rollouts</Link>}
        title={r.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <RolloutBadge value={r.status} />
            <ApprovalBadge value={r.approval_status} />
            <span>{KIND_LABEL[r.kind]} change</span>
            <span className="text-slate-300">·</span>
            <span>requested by <span className="text-slate-700">{r.requested_by.name}</span> ({r.requested_by.role})</span>
          </span>
        }
        actions={<RolloutActions r={r} />}
      />

      {r.status === "paused" && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900">
          <div className="flex items-center gap-2 font-semibold"><PauseCircle className="size-5 text-amber-600" /> Rollout paused</div>
          {r.pause_reason && <div className="mt-1 text-sm">{r.pause_reason}</div>}
          <div className="mt-2 text-sm">
            {failed.length > 0 && <>Resolve {failed.length} failed target{failed.length > 1 ? "s" : ""} — retry, roll back, or (admin only) manually verify — </>}
            {unack.length > 0 && <>{failed.length ? "and " : ""}acknowledge new guardrail warnings on {unack.length} target{unack.length > 1 ? "s" : ""}, </>}
            {failed.length || unack.length ? "then Resume." : "Nothing is blocking: Resume to continue, or Roll back / Cancel."}
          </div>
        </div>
      )}
      {r.status === "rolling_back" && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-orange-300 bg-orange-50 p-4 text-sm text-orange-900">
          <RotateCcw className="mt-0.5 size-4" /> Rolling back: applied targets are being restored to their pre-rollout revisions in reverse wave order; each is confirmed by inventory.
        </div>
      )}
      {manual > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-violet-300 bg-violet-50 p-3 text-sm text-violet-900">
          <AlertTriangle className="mt-0.5 size-4" /> {manual} target{manual > 1 ? "s were" : " was"} marked succeeded by an admin without inventory evidence.
        </div>
      )}

      <div className="mb-5 grid gap-4 lg:grid-cols-[1fr_22rem]">
        <Card title="Details">
          <KV
            items={[
              ["Target", (
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {r.target_model_version && <span>model <MvLink mv={r.target_model_version} /></span>}
                  {r.target_engine_version && <span>engine <EvLink ev={r.target_engine_version} /></span>}
                </span>
              )],
              ["Progress", <RolloutProgress counts={r.target_counts} total={r.target_total} className="max-w-md" />],
              ["Vulnerability", r.linked_vulnerability ? <VulnLink v={r.linked_vulnerability} /> : <span className="text-slate-400">—</span>],
              ["Reason", r.reason ? <span className="whitespace-pre-line">{r.reason}</span> : <span className="text-slate-400">—</span>],
              when("Created", r.created_at),
              when("Submitted", r.submitted_at),
              when("Started", r.started_at),
              when("Finished", r.finished_at),
            ]}
          />
        </Card>
        <Card title="Prod approval" actions={<ApprovalBadge value={r.approval_status} />}>
          <ApprovalsList r={r} now={now} />
        </Card>
      </div>

      <h2 className="mb-3 text-sm font-semibold text-slate-900">Waves</h2>
      <WaveStepper r={r} now={now} />

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card title="Events" subtitle="Newest first: what the rollout engine and people did">
          <EventsTimeline r={r} now={now} />
        </Card>
        <Card title="Audit" subtitle="Every human decision on this rollout, with reasons">
          <AuditList entries={r.audit} />
        </Card>
      </div>
    </>
  );
}
