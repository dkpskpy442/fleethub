import { useState } from "react";
import { fmtAgo, fmtTime } from "../../../lib/format";
import type { RolloutDetail } from "../../../lib/types";
import { Pill } from "../../status";
import { Button, Empty, Mono, cx } from "../../ui";

const EVENT_DOT: Record<string, string> = {
  target_failed: "bg-red-500", wave_failed: "bg-red-500", paused: "bg-amber-500", rejected: "bg-red-500",
  target_succeeded: "bg-emerald-500", wave_succeeded: "bg-emerald-500", completed: "bg-emerald-500", approved: "bg-emerald-500",
  manually_verified: "bg-violet-500", acknowledged: "bg-amber-400", awaiting_approval: "bg-amber-400",
  rollback_started: "bg-orange-500", target_rollback: "bg-orange-500", wave_rolling_back: "bg-orange-500", rollback_stuck: "bg-red-500",
};

export function EventsTimeline({ r, now }: { r: RolloutDetail; now: number }) {
  const [all, setAll] = useState(false);
  const labels = new Map(r.waves.flatMap((w) => w.targets.map((t) => [t.id, `${t.deployment.service_name} @ ${t.deployment.target.name}`] as const)));
  const events = [...r.events].sort((a, b) => b.at - a.at);
  const shown = all ? events : events.slice(0, 25);
  if (!events.length) return <Empty>No events yet.</Empty>;
  return (
    <>
      <ol className="space-y-2.5">
        {shown.map((e) => (
          <li key={e.id} className="flex gap-3 text-sm">
            <span className={cx("mt-1.5 size-2 shrink-0 rounded-full", EVENT_DOT[e.kind] ?? "bg-slate-300")} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <Mono className="text-slate-500">{e.kind}</Mono>
                {e.target_id && labels.get(e.target_id) && <span className="text-xs text-slate-400">{labels.get(e.target_id)}</span>}
                <span className="ml-auto whitespace-nowrap text-xs text-slate-400" title={fmtTime(e.at)}>{fmtAgo(e.at, now)}</span>
              </div>
              <div className="text-slate-700">{e.message}</div>
              <div className="text-xs text-slate-400">{e.actor ? `${e.actor.name}${e.actor.role !== "system" ? ` (${e.actor.role})` : ""}` : e.actor_id}</div>
            </div>
          </li>
        ))}
      </ol>
      {events.length > shown.length && (
        <Button size="sm" variant="ghost" className="mt-3" onClick={() => setAll(true)}>Show all {events.length} events</Button>
      )}
    </>
  );
}

export function ApprovalsList({ r, now }: { r: RolloutDetail; now: number }) {
  const prodWaves = r.waves.filter((w) => w.is_prod).length;
  return (
    <div className="space-y-3 text-sm">
      {r.approval_status === "not_required" && <p className="text-slate-500">No prod waves — no approval required.</p>}
      {r.approval_status === "pending" && (
        <p className="rounded-md bg-amber-50 px-2.5 py-2 text-xs text-amber-800">
          {prodWaves} prod wave(s) need one approval from a release approver who is not the requester ({r.requested_by.name}).
          Non-prod waves may run in the meantime.
        </p>
      )}
      {r.approvals.length === 0 && r.approval_status !== "not_required" && <p className="text-xs text-slate-500">No decisions yet.</p>}
      {r.approvals.map((a) => (
        <div key={a.id} className="flex items-start gap-2">
          <span className="shrink-0"><Pill tone={a.decision === "approved" ? "green" : "red"}>{a.decision}</Pill></span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{a.approver.name}</span>
              <span className="text-xs text-slate-400">{a.approver.role}</span>
              <span className="ml-auto text-xs text-slate-400" title={fmtTime(a.at)}>{fmtAgo(a.at, now)}</span>
            </div>
            {a.comment && <div className="mt-0.5 rounded bg-slate-50 px-2 py-1 text-xs text-slate-600">“{a.comment}”</div>}
          </div>
        </div>
      ))}
    </div>
  );
}
