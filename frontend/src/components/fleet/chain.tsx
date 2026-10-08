/**
 * The reconciliation chain: desired revision -> request -> deployer operation (claim) -> inventory evidence -> verdict.
 * Each step is judged independently so a deployer "success" can sit next to "no evidence" without being merged.
 */
import { ArrowDown, ArrowRight, CheckCircle2, CircleDashed, CircleHelp, Clock, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { fmtAgo, fmtTime, shortDigest, useNow } from "../../lib/format";
import type { DeploymentDetail, DiffEntry } from "../../lib/types";
import { MvLink, EvLink, ImageTag } from "../domain";
import { ConvergenceBadge, FreshnessBadge, Pill } from "../status";
import { Empty, Mono, Table, Td, Th, cx } from "../ui";
import { OperationStatusPill, RequestStatusPill, SourcePill } from "./badges";

type StepState = "ok" | "pending" | "problem" | "unknown" | "na";

const STEP_STYLE: Record<StepState, { box: string; icon: ReactNode; label: string }> = {
  ok: { box: "border-emerald-200 bg-emerald-50/50", icon: <CheckCircle2 className="size-4 text-emerald-600" />, label: "ok" },
  pending: { box: "border-sky-200 bg-sky-50/50", icon: <Clock className="size-4 text-sky-600" />, label: "pending" },
  problem: { box: "border-red-200 bg-red-50/50", icon: <XCircle className="size-4 text-red-600" />, label: "problem" },
  unknown: { box: "hatched border-slate-300", icon: <CircleHelp className="size-4 text-slate-500" />, label: "unknown" },
  na: { box: "border-dashed border-slate-300 bg-white", icon: <CircleDashed className="size-4 text-slate-400" />, label: "n/a" },
};

function Step({ n, title, kind, state, children }: { n: number; title: string; kind: string; state: StepState; children: ReactNode }) {
  const s = STEP_STYLE[state];
  return (
    <div className={cx("min-w-0 flex-1 rounded-lg border p-3", s.box)}>
      <div className="mb-1.5 flex items-center gap-1.5">
        {s.icon}
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{n}. {title}</span>
      </div>
      <div className="mb-2 text-[11px] italic text-slate-500">{kind}</div>
      <div className="space-y-1 text-xs text-slate-700">{children}</div>
    </div>
  );
}

function Connector() {
  return (
    <div className="flex shrink-0 items-center justify-center text-slate-300">
      <ArrowRight className="hidden size-5 lg:block" />
      <ArrowDown className="size-5 lg:hidden" />
    </div>
  );
}

export function ReconciliationChain({ d }: { d: DeploymentDetail }) {
  const now = useNow();
  const { revision, request, operation, inventory, verdict } = d.chain;
  const src = inventory.source;
  const opDoneAt = operation ? operation.finished_at ?? operation.timeout_at : revision?.created_at ?? null;
  const postOp = src.last_sync_at != null && opDoneAt != null && src.last_sync_at > opDoneAt;

  const s1: StepState = revision ? "ok" : "na";
  const s2: StepState = !request ? (revision ? "unknown" : "na")
    : request.status === "completed" ? "ok"
    : request.status === "queued" || request.status === "submitted" ? "pending"
    : request.status === "superseded" ? "na" : "problem";
  const s3: StepState = !operation ? (request ? "pending" : "na")
    : operation.status === "reported_succeeded" ? "ok"
    : operation.status === "pending" || operation.status === "running" ? "pending" : "problem";
  const s4: StepState = src.freshness === "fresh" ? (inventory.latest_observation_at ? "ok" : "problem")
    : "unknown";
  const s5: StepState = verdict.state === "converged" ? "ok"
    : verdict.state === "converging" || verdict.state === "verifying" ? "pending"
    : verdict.state === "unverifiable" ? "unknown"
    : verdict.state === "unmanaged" ? "na" : "problem";

  return (
    <div className="flex flex-col gap-2 lg:flex-row lg:items-stretch">
      <Step n={1} title="Desired revision" kind="FleetHub intent (source of truth)" state={s1}>
        {revision ? (
          <>
            <div className="text-sm font-semibold text-slate-900">rev {revision.rev_no}</div>
            <div className="flex items-center gap-1"><SourcePill source={revision.source} /></div>
            <div title={fmtTime(revision.created_at)}>created {fmtAgo(revision.created_at, now)}</div>
          </>
        ) : <div>No desired state - this workload is not managed by FleetHub.</div>}
      </Step>
      <Connector />
      <Step n={2} title="Deployment request" kind="FleetHub asks the deployer" state={s2}>
        {request ? (
          <>
            <div className="flex flex-wrap items-center gap-1"><RequestStatusPill value={request.status} /><span>rev {request.rev_no} · attempt {request.attempt}</span></div>
            <Mono className="block break-all text-slate-500" title="Idempotency key">{request.idempotency_key}</Mono>
            <div title={fmtTime(request.requested_at)}>requested {fmtAgo(request.requested_at, now)}{request.requested_by ? ` by ${request.requested_by.name}` : ""}</div>
          </>
        ) : <div>{revision ? "No request recorded for the current revision." : "—"}</div>}
      </Step>
      <Connector />
      <Step n={3} title="External operation" kind="Deployer's CLAIM - not proof" state={s3}>
        {operation ? (
          <>
            <div><OperationStatusPill value={operation.status} /></div>
            {operation.result_message && <div className="italic">“{operation.result_message}”</div>}
            <div className="text-slate-500">{operation.adapter} · <Mono>{operation.external_ref}</Mono></div>
            <div title={fmtTime(operation.finished_at)}>
              {operation.finished_at ? `finished ${fmtAgo(operation.finished_at, now)}` : `times out ${fmtAgo(operation.timeout_at, now)}`}
            </div>
          </>
        ) : <div>{request ? "Not yet submitted to the deployer." : "—"}</div>}
      </Step>
      <Connector />
      <Step n={4} title="Inventory evidence" kind="What is actually running (reality)" state={s4}>
        <div className="flex flex-wrap items-center gap-1"><FreshnessBadge value={src.freshness} /><span className="font-medium">{src.name}</span></div>
        <div title={fmtTime(src.last_sync_at)}>{src.last_sync_at ? `last sync ${fmtAgo(src.last_sync_at, now)}` : "never synced"}</div>
        <div title={fmtTime(inventory.latest_observation_at)}>
          {inventory.latest_observation_at ? `latest change observed ${fmtAgo(inventory.latest_observation_at, now)}` : "workload never reported"}
        </div>
        {revision && opDoneAt != null && (
          <div className={cx(postOp ? "text-emerald-700" : "text-amber-700")}>
            {postOp ? "Evidence gathered after the operation finished" : "No sync since the operation finished yet"}
          </div>
        )}
        {src.last_error && <div className="text-red-700">{src.last_error}</div>}
      </Step>
      <Connector />
      <Step n={5} title="Verdict" kind="FleetHub convergence evaluation" state={s5}>
        <div><ConvergenceBadge value={verdict.state} /></div>
        <div>{verdict.detail}</div>
        <div className="text-slate-500" title={fmtTime(verdict.since)}>since {fmtAgo(verdict.since, now)}</div>
        {verdict.verify_deadline != null && verdict.state !== "unmanaged" && (
          <div className="text-slate-500" title={fmtTime(verdict.verify_deadline)}>
            verify window {verdict.verify_deadline > now ? `closes ${fmtAgo(verdict.verify_deadline, now)}` : `closed ${fmtAgo(verdict.verify_deadline, now)}`}
          </div>
        )}
      </Step>
    </div>
  );
}

/** Field-level diff between desired revision and the latest observation (ids resolved to catalog labels where possible). */
export function DiffTable({ d }: { d: DeploymentDetail }) {
  const diff = d.convergence.diff;
  if (!d.managed) return <Empty>Unmanaged deployments have no desired state, so there is nothing to diff against.</Empty>;
  if (!diff.length) return <Empty>No differences: the latest observation matches the desired model, engine and image digest.</Empty>;
  const stale = d.freshness.state !== "fresh";
  return (
    <>
      {stale && (
        <div className="hatched mb-2 rounded-md border border-slate-300 px-3 py-2 text-xs text-slate-700">
          Inventory data is {d.freshness.state === "stale" ? "stale" : "missing"} - this diff compares against the last-known observation
          {d.observed ? "" : " (none exists)"} and may not reflect what is running now.
        </div>
      )}
      <Table>
        <thead><tr><Th>Field</Th><Th>Desired</Th><Th>Observed</Th><Th>Raw reported value</Th><Th>Catalog</Th></tr></thead>
        <tbody>
          {diff.map((e) => (
            <tr key={e.field}>
              <Td className="font-medium">{e.field.replace(/_/g, " ")}</Td>
              <Td><DiffValue d={d} e={e} side="desired" /></Td>
              <Td className="bg-orange-50/50"><DiffValue d={d} e={e} side="observed" /></Td>
              <Td>{e.observed_raw ? <Mono className="break-all" title={e.observed_raw}>{e.observed_raw.startsWith("sha256:") ? `sha256:${shortDigest(e.observed_raw)}…` : e.observed_raw}</Mono> : <span className="text-slate-400">—</span>}</Td>
              <Td>{e.unrecognized
                ? <Pill tone="orange" title="The observed value does not match any catalog entry">unrecognized by catalog</Pill>
                : e.field === "presence" ? <span className="text-slate-400">—</span> : <span className="text-xs text-slate-500">known</span>}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}

function DiffValue({ d, e, side }: { d: DeploymentDetail; e: DiffEntry; side: "desired" | "observed" }) {
  const id = side === "desired" ? e.desired : e.observed;
  if (e.field === "presence") return <span className={side === "observed" ? "font-medium text-red-700" : ""}>{id ?? "—"}</span>;
  if (id == null) {
    if (side === "observed" && e.observed_raw) return <Mono className="text-orange-700">{e.observed_raw.startsWith("sha256:") ? `unregistered ${shortDigest(e.observed_raw)}` : e.observed_raw}</Mono>;
    return <span className="text-slate-400">—</span>;
  }
  const src = side === "desired" ? d.desired : d.observed;
  if (e.field === "model_version" && src?.model_version?.id === id) return <MvLink mv={src.model_version} />;
  if (e.field === "engine_version" && src?.engine_version?.id === id) return <EvLink ev={src.engine_version} />;
  if (e.field === "image" && src?.image?.id === id) return <ImageTag img={src.image} />;
  return <Mono>{id}</Mono>;
}
