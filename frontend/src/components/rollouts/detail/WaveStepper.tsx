import { AlertTriangle, CheckCircle2, CircleDashed, Clock, Loader2, RotateCcw, ShieldAlert, Undo2, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { fmtAgo, fmtTime } from "../../../lib/format";
import type { OperationView, RolloutDetail, RolloutTargetView, RolloutWaveView, WaveStatus } from "../../../lib/types";
import { ActionButton, DepLink, EnvTag, GuardrailChecklist, useCan } from "../../domain";
import { ConvergenceBadge, FreshnessBadge, HealthBadge, Pill, TargetBadge, WaveBadge } from "../../status";
import { Card, Table, Td, Th, cx } from "../../ui";
import { SpecChange, fmtLeft } from "../shared";

const WAVE_ICON: Record<WaveStatus, [ReactNode, string]> = {
  pending: [<CircleDashed className="size-4" />, "bg-slate-100 text-slate-400 ring-slate-200"],
  awaiting_approval: [<ShieldAlert className="size-4" />, "bg-amber-50 text-amber-600 ring-amber-300"],
  in_progress: [<Loader2 className="size-4 animate-spin" />, "bg-sky-50 text-sky-600 ring-sky-300"],
  succeeded: [<CheckCircle2 className="size-4" />, "bg-emerald-50 text-emerald-600 ring-emerald-300"],
  failed: [<XCircle className="size-4" />, "bg-red-50 text-red-600 ring-red-300"],
  rolling_back: [<RotateCcw className="size-4" />, "bg-orange-50 text-orange-600 ring-orange-300"],
  rolled_back: [<Undo2 className="size-4" />, "bg-slate-100 text-slate-500 ring-slate-300"],
};

export function WaveStepper({ r, now }: { r: RolloutDetail; now: number }) {
  return (
    <ol className="space-y-4">
      {r.waves.map((w, i) => {
        const [icon, cls] = WAVE_ICON[w.status];
        const last = i === r.waves.length - 1;
        return (
          <li key={w.id} className="relative pl-11">
            {!last && <span className="absolute bottom-[-1rem] left-[15px] top-8 w-px bg-slate-200" aria-hidden />}
            <span className={cx("absolute left-0 top-2 flex size-8 items-center justify-center rounded-full ring-1", cls)}>{icon}</span>
            <WaveCard r={r} w={w} idx={i} now={now} />
          </li>
        );
      })}
    </ol>
  );
}

function WaveCard({ r, w, idx, now }: { r: RolloutDetail; w: RolloutWaveView; idx: number; now: number }) {
  const ok = w.targets.filter((t) => t.status === "succeeded").length;
  return (
    <Card
      padded={false}
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-slate-400">Wave {idx + 1}</span> {w.name} <WaveBadge value={w.status} />
          {w.is_prod && (
            <Pill tone={r.approval_status === "approved" ? "green" : "amber"} icon={<ShieldAlert className="size-3" />} title="Waves touching prod need one approval from a release approver who is not the requester">
              prod — {r.approval_status === "approved" ? "approved" : "needs approval"}
            </Pill>
          )}
        </span>
      }
      subtitle={
        <>
          {ok}/{w.targets.length} succeeded · bake {w.bake_minutes}m
          {w.started_at && <> · started <span title={fmtTime(w.started_at)}>{fmtAgo(w.started_at, now)}</span></>}
          {w.finished_at && <> · finished <span title={fmtTime(w.finished_at)}>{fmtAgo(w.finished_at, now)}</span></>}
          {w.status === "awaiting_approval" && <span className="text-amber-700"> · waiting for a release approver</span>}
        </>
      }
    >
      <Table>
        <thead>
          <tr>
            <Th>Deployment</Th><Th>Revision change</Th><Th>Target status</Th>
            <Th><span title="What the deployer says vs. what inventory observes">Evidence: claim vs inventory</span></Th>
            <Th>Guardrails</Th><Th className="text-right">Actions</Th>
          </tr>
        </thead>
        <tbody>
          {w.targets.map((t) => <TargetRow key={t.id} r={r} t={t} now={now} />)}
        </tbody>
      </Table>
    </Card>
  );
}

function TargetRow({ r, t, now }: { r: RolloutDetail; t: RolloutTargetView; now: number }) {
  const d = t.deployment;
  const from = t.prev ?? (t.status === "pending" ? d.desired : null);
  const attention = t.status === "failed" || (t.unacknowledged.length > 0 && t.status === "pending");
  return (
    <tr className={cx(attention ? "bg-red-50/40" : t.manually_verified ? "bg-violet-50/40" : "hover:bg-slate-50/60")}>
      <Td className="min-w-[11rem]">
        <DepLink d={d} />
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <EnvTag tier={d.target.environment.tier} name={d.target.environment.name} />
          <span className="text-xs text-slate-500">{d.target.region.name} · {d.target.hardware.name}</span>
        </div>
      </Td>
      <Td className="min-w-[16rem]">
        {t.prev && <div className="mb-0.5 text-[11px] text-slate-400">from rev {t.prev.rev_no}</div>}
        <SpecChange
          from={from}
          fromLabel={t.status === "pending" ? "current" : "—"}
          to={{ model_version: t.new_model_version, engine_version: t.new_engine_version, image: t.new_image }}
        />
      </Td>
      <Td className="min-w-[9rem]">
        <TargetBadge value={t.status} manual={t.manually_verified} />
        <Timing t={t} now={now} />
        {t.failure_reason && (
          <div className={cx("mt-1 max-w-xs break-words text-xs", t.manually_verified ? "text-violet-700" : t.status === "skipped" ? "text-slate-500" : "font-medium text-red-700")}>
            {t.failure_reason}
          </div>
        )}
        {t.manually_verified && <div className="mt-1 text-[11px] text-violet-700">Marked succeeded by an admin without inventory evidence.</div>}
      </Td>
      <Td className="min-w-[14rem]"><Evidence t={t} now={now} /></Td>
      <Td className="min-w-[12rem] max-w-xs">
        {t.unacknowledged.length > 0 && (
          <div className="mb-1.5 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900">
            <div className="flex items-center gap-1 font-medium"><AlertTriangle className="size-3.5" /> New warning{t.unacknowledged.length > 1 ? "s" : ""} need acknowledgement</div>
            <ul className="mt-0.5 space-y-0.5">
              {t.guardrails.checks.filter((c) => t.unacknowledged.includes(c.code)).map((c) => <li key={c.code}>{c.message}</li>)}
            </ul>
          </div>
        )}
        <GuardrailChecklist checks={t.guardrails.checks.filter((c) => !t.unacknowledged.includes(c.code))} onlyIssues />
        {t.justification && (
          <div className="mt-1.5 whitespace-pre-line rounded bg-slate-50 px-2 py-1 text-xs text-slate-600" title="Justification for accepted warnings (audited)">
            “{t.justification}”
          </div>
        )}
      </Td>
      <Td className="text-right"><TargetActions r={r} t={t} /></Td>
    </tr>
  );
}

function Timing({ t, now }: { t: RolloutTargetView; now: number }) {
  const op = t.request?.operation;
  let text: ReactNode = null;
  if (t.status === "applying") {
    text = op ? <>deployer {op.status.replace("_", " ")}; times out {fmtAgo(op.timeout_at, now)}</> : "request queued";
  } else if (t.status === "verifying") {
    if (t.bake_until != null) {
      text = now < t.bake_until
        ? <span className="text-sky-700"><Clock className="mr-0.5 inline size-3" />baking, {fmtLeft(t.bake_until - now)} left</span>
        : "bake complete; waiting for a post-bake inventory sync";
    } else if (t.verify_deadline != null) {
      text = now < t.verify_deadline
        ? <span title={fmtTime(t.verify_deadline)}>verify by {fmtTime(t.verify_deadline).slice(11)} ({fmtLeft(t.verify_deadline - now)} left)</span>
        : <span className="text-red-700">verify deadline passed</span>;
    }
  } else if (t.status === "rolling_back") {
    text = "restoring previous revision";
  } else if (t.finished_at) {
    text = <span title={fmtTime(t.finished_at)}>{fmtAgo(t.finished_at, now)}</span>;
  }
  return text ? <div className="mt-1 text-xs text-slate-500">{text}</div> : null;
}

const OP_TONE: Record<OperationView["status"], "blue" | "gray" | "red" | "amber"> = {
  pending: "blue", running: "blue", reported_succeeded: "gray", reported_failed: "red", timed_out: "amber", cancelled: "gray",
};

function Claim({ op, label }: { op: OperationView | null | undefined; label: string }) {
  if (!op) return <span className="italic text-slate-400">{label === "deployer" ? "not requested yet" : "—"}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Pill tone={OP_TONE[op.status]} title={`${op.adapter} ${op.external_ref}: ${op.result_message ?? ""}`}>
        <span className="mono">{op.status}</span>
      </Pill>
      {op.status === "reported_succeeded" && <span className="text-[11px] text-slate-400">(claim only)</span>}
    </span>
  );
}

/** Deployer claim on one line, inventory verdict on another — they are deliberately never merged. */
function Evidence({ t, now }: { t: RolloutTargetView; now: number }) {
  const d = t.deployment;
  const op = t.request?.operation;
  const conv = d.convergence.state;
  const unconfirmed = op?.status === "reported_succeeded" && conv !== "converged" && ["applying", "verifying", "failed"].includes(t.status);
  return (
    <div className="grid grid-cols-[4.25rem_1fr] items-start gap-x-2 gap-y-1 text-xs">
      <span className="pt-0.5 text-slate-400">deployer</span>
      <Claim op={op} label="deployer" />
      {t.rollback_request && (
        <>
          <span className="pt-0.5 text-slate-400">rollback</span>
          <Claim op={t.rollback_request.operation} label="rollback" />
        </>
      )}
      <span className="pt-0.5 text-slate-400">inventory</span>
      <span className="inline-flex flex-wrap items-center gap-1">
        {d.managed && <ConvergenceBadge value={conv} title={d.convergence.detail} />}
        <HealthBadge value={d.health} />
        {d.freshness.state !== "fresh" && <FreshnessBadge value={d.freshness.state} />}
        <span className="text-[11px] text-slate-400">{d.freshness.last_sync_at ? `synced ${fmtAgo(d.freshness.last_sync_at, now)}` : "never synced"}</span>
      </span>
      {(t.status === "pending" || t.status === "skipped") && (
        <span className="col-span-2 text-[11px] text-slate-400">Inventory describes the current (unchanged) deployment.</span>
      )}
      {unconfirmed && (
        <span className="col-span-2 text-[11px] text-amber-700">Deployer claims success; inventory has not confirmed it{conv === "unverifiable" ? " (no fresh data)" : ""}.</span>
      )}
    </div>
  );
}

function TargetActions({ r, t }: { r: RolloutDetail; t: RolloutTargetView }) {
  const canManual = useCan("rollout.manual_verify");
  const base = `/rollouts/${r.id}/targets/${t.id}`;
  const label = `${t.deployment.service_name} @ ${t.deployment.target.name}`;
  const running = ["in_progress", "paused"].includes(r.status);
  const out: ReactNode[] = [];

  if (t.status === "failed" && running) {
    out.push(
      <ActionButton key="retry" label="Retry" perm="rollout.execute" field="comment" requireReason={false} path={`${base}/retry`}
        success="Retry requested" title={`Retry ${label}`} reasonLabel="Comment (optional)"
        description="Re-sends the same desired revision to the deployer (new attempt, same idempotency chain). It must again be confirmed by inventory." />,
    );
  }
  if (t.status === "failed" || (t.status === "verifying" && canManual)) {
    if (running) {
      out.push(
        <ActionButton key="verify" label="Manually verify" variant="warning" perm="rollout.manual_verify" field="comment" path={`${base}/verify`}
          success="Target manually verified" title={`Manually verify ${label}`} reasonLabel="Justification (required, audited)"
          description={
            <div className="rounded-md border border-violet-300 bg-violet-50 p-3 text-violet-900">
              <div className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="size-4" /> This marks the target succeeded WITHOUT inventory evidence.</div>
              <p className="mt-1 text-xs">
                FleetHub could not confirm that {label} is running the new version and healthy. Only do this if you have verified it out of band
                (e.g. directly on the cluster). The target will be permanently flagged “manually verified”, and your name and justification are recorded in the audit log.
              </p>
            </div>
          } />,
      );
    }
  }
  if (["applying", "verifying", "succeeded", "failed"].includes(t.status) && ["in_progress", "paused", "completed"].includes(r.status)) {
    out.push(
      <ActionButton key="rb" label="Roll back" variant="danger" perm="rollout.execute" field="comment" path={`${base}/rollback`}
        success="Target rollback started" title={`Roll back ${label}`} reasonLabel="Reason (required)"
        description={<>Writes a new desired revision equal to the pre-rollout revision{t.prev ? ` (rev ${t.prev.rev_no})` : ""} and asks the deployer to apply it. The rollback is confirmed against inventory.</>} />,
    );
  }
  if (t.status === "rolling_back" && t.failure_reason?.startsWith("rollback_")) {
    out.push(
      <ActionButton key="rbr" label="Retry rollback" variant="danger" perm="rollout.execute" field="comment" path={`${base}/rollback`}
        success="Rollback re-requested" title={`Retry rollback of ${label}`} reasonLabel="Reason (required)"
        description="The previous rollback was not confirmed by inventory. This issues a fresh rollback request." />,
    );
  }
  if (t.status === "pending" && t.unacknowledged.length > 0 && ["draft", "ready", "in_progress", "paused"].includes(r.status)) {
    out.push(
      <ActionButton key="ack" label="Acknowledge" variant="warning" perm="rollout.execute" field="comment" path={`${base}/acknowledge`}
        success="Warnings acknowledged" title={`Acknowledge new warnings for ${label}`} reasonLabel="Justification (required, audited)"
        description={
          <ul className="space-y-1">
            {t.guardrails.checks.filter((c) => t.unacknowledged.includes(c.code)).map((c) => (
              <li key={c.code} className="flex items-start gap-1.5 text-amber-800"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{c.message}</li>
            ))}
          </ul>
        } />,
    );
  }
  if (t.status === "pending" && ["draft", "ready", "in_progress", "paused"].includes(r.status)) {
    out.push(
      <ActionButton key="skip" label="Skip" variant="ghost" perm="rollout.execute" field="comment" path={`${base}/skip`}
        success="Target skipped" title={`Skip ${label}`} reasonLabel="Reason (required)"
        description="The deployment is left on its current version and its lock is released. This cannot be undone within this rollout." />,
    );
  }
  if (!out.length) return null;
  return <div className="flex flex-col items-end gap-1">{out}</div>;
}
