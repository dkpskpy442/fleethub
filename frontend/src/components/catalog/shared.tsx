/** Helpers shared by the catalog pages (models, engines, compatibility). */
import { ArrowUpDown, Info } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAction, useApi } from "../../lib/api";
import { fmtAgo, fmtTime, useNow } from "../../lib/format";
import type {
  CompatStatus, DeploymentRow, EngineLifecycle, Meta, ModelLifecycle, ModelVersionDetail, RolloutSummary,
} from "../../lib/types";
import { RolloutLink, useCan } from "../domain";
import { CompatBadge, EngineLifecycleBadge, ModelLifecycleBadge, Pill, RolloutBadge } from "../status";
import { Button, Empty, Field, Input, Modal, Select, Spinner, Table, Td, Textarea, Th, cx } from "../ui";

// ------------------------------------------------------------------ buttons
const btnBase = "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors";
const btnTone = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700",
  secondary: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
};

/** A router link styled as a button; renders a disabled button (with tooltip) when `disabledReason` is set. */
export function LinkButton({ to, children, variant = "primary", size = "md", disabledReason }: {
  to: string; children: ReactNode; variant?: "primary" | "secondary"; size?: "sm" | "md"; disabledReason?: string | null;
}) {
  if (disabledReason) {
    return <Button variant={variant} size={size} disabled title={disabledReason}>{children}</Button>;
  }
  return (
    <Link to={to} className={cx(btnBase, btnTone[variant], size === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3.5 text-sm")}>
      {children}
    </Link>
  );
}

/** Button gated by a permission: disabled with an explanatory tooltip when the current persona lacks it. */
export function PermButton({ perm, onClick, children, variant = "secondary", size = "md" }: {
  perm: string; onClick: () => void; children: ReactNode; variant?: "primary" | "secondary"; size?: "sm" | "md";
}) {
  const allowed = useCan(perm);
  return (
    <Button variant={variant} size={size} disabled={!allowed} title={allowed ? undefined : `Your role lacks permission: ${perm}`} onClick={onClick}>
      {children}
    </Button>
  );
}

// ------------------------------------------------------------------ version chips
const MODEL_CHIP: Record<ModelLifecycle, string> = {
  experimental: "bg-violet-50 text-violet-700 ring-violet-600/20",
  production: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  deprecated: "bg-amber-50 text-amber-800 ring-amber-600/25",
  retired: "bg-slate-100 text-slate-500 ring-slate-500/20 line-through",
};

export function ModelVersionChip({ id, version, lifecycle }: { id: string; version: string; lifecycle: ModelLifecycle }) {
  return (
    <Link
      to={`/model-versions/${id}`}
      title={`${version} — ${lifecycle}`}
      className={cx("inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset hover:underline", MODEL_CHIP[lifecycle])}
    >
      {version}
    </Link>
  );
}

// ------------------------------------------------------------------ lifecycle transitions
const MODEL_HINTS: Partial<Record<ModelLifecycle, string>> = {
  production: "Production versions are eligible for prod rollouts without extra justification.",
  deprecated: "Deprecated versions stay deployable, but new rollouts to them need justification.",
  retired: "Retiring is terminal. The server refuses if any deployment still targets this version.",
};
const ENGINE_HINTS: Partial<Record<EngineLifecycle, string>> = {
  supported: "Supported versions are eligible for prod rollouts.",
  deprecated: "Deprecated versions stay deployable, but new rollouts to them need justification.",
  eol: "End-of-life is terminal. Rollouts to this version will be blocked.",
};

/** Lifecycle transition control: allowed targets come from /meta (the server's transition table). */
export function LifecycleTransition({ kind, id, current, label }: {
  kind: "model" | "engine"; id: string; current: string; label: string;
}) {
  const { data: meta } = useApi<Meta>("/meta");
  const perm = kind === "model" ? "model.lifecycle" : "engine.lifecycle";
  const allowed = useCan(perm);
  const targets = (kind === "model" ? meta?.enums.model_transitions : meta?.enums.engine_transitions)?.[current] ?? [];
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const act = useAction("POST", {
    success: "Lifecycle updated",
    onSuccess: () => { setOpen(false); setReason(""); },
  });
  const target = to || targets[0] || "";
  const why = !allowed ? `Your role lacks permission: ${perm}` : !targets.length ? `${current} is terminal — no further transitions` : undefined;
  const hint = kind === "model" ? MODEL_HINTS[target as ModelLifecycle] : ENGINE_HINTS[target as EngineLifecycle];
  const badge = (v: string) => kind === "model"
    ? <ModelLifecycleBadge value={v as ModelLifecycle} />
    : <EngineLifecycleBadge value={v as EngineLifecycle} />;
  return (
    <>
      <Button disabled={!!why} title={why} onClick={() => setOpen(true)}>
        <ArrowUpDown className="size-3.5" /> Change lifecycle
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Change lifecycle — ${label}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant={target === "retired" || target === "eol" ? "danger" : "primary"}
              loading={act.isPending}
              disabled={!target || !reason.trim()}
              onClick={() => act.mutate({
                path: `/${kind === "model" ? "model-versions" : "engine-versions"}/${id}/lifecycle`,
                body: { to: target, reason },
              })}
            >
              Move to {target}
            </Button>
          </>
        }
      >
        <div className="flex items-center gap-2 text-slate-600">Current: {badge(current)}</div>
        <Field label="New lifecycle state" hint={hint}>
          <Select value={target} onChange={(e) => setTo(e.target.value)} options={targets.map((t) => ({ value: t, label: t }))} />
        </Field>
        <Field label="Reason" hint="Required. Recorded in the audit log.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </Field>
      </Modal>
    </>
  );
}

// ------------------------------------------------------------------ compatibility
export const COMPAT_EDITABLE: { value: CompatStatus; label: string; hint: string }[] = [
  { value: "certified", label: "certified", hint: "Validated by the owning team with evidence (benchmarks / eval run)." },
  { value: "compatible", label: "compatible", hint: "Known to work; not formally certified." },
  { value: "known_issues", label: "known issues", hint: "Works with caveats — describe them in the notes." },
  { value: "incompatible", label: "incompatible", hint: "Does not work. Rollouts to this combination are blocked." },
  { value: "untested", label: "untested (remove record)", hint: "Deletes the record. Untested is never treated as compatible." },
];

const COMPACT: Record<CompatStatus, [string, string]> = {
  certified: ["cert", "bg-emerald-50 text-emerald-700 ring-emerald-600/20"],
  compatible: ["compat", "bg-emerald-50/60 text-emerald-700 ring-emerald-600/10"],
  known_issues: ["issues", "bg-amber-50 text-amber-800 ring-amber-600/25"],
  incompatible: ["incompat", "bg-red-50 text-red-700 ring-red-600/25"],
  untested: ["untested", "hatched text-slate-600 ring-slate-400/40"],
  unsupported_hardware: ["no image", "bg-slate-100 text-slate-400 ring-slate-500/10"],
  "n/a": ["n/a", "bg-slate-100 text-slate-400 ring-slate-500/10"],
};

/** Compact compat chip for dense matrices; same color vocabulary as CompatBadge. */
export function CompactCompat({ value, title }: { value: CompatStatus; title?: string }) {
  const [label, cls] = COMPACT[value];
  return (
    <span title={title ?? value.replace("_", " ")} className={cx("inline-flex min-w-[3.25rem] justify-center rounded px-1 py-0.5 text-[10px] font-medium ring-1 ring-inset", cls)}>
      {label}
    </span>
  );
}

export function isNoImage(s: CompatStatus) {
  return s === "n/a" || s === "unsupported_hardware";
}

/** Wraps a matrix cell so it is clickable (opens the editor) only when the user may edit and the hardware has an image. */
export function CompatCellButton({ status, canEdit, onEdit, children }: {
  status: CompatStatus; canEdit: boolean; onEdit: () => void; children: ReactNode;
}) {
  if (!canEdit || isNoImage(status)) return <>{children}</>;
  return (
    <button type="button" onClick={onEdit} className="rounded hover:ring-2 hover:ring-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-500" title="Edit compatibility record">
      {children}
    </button>
  );
}

export function CompatLegend({ compact }: { compact?: boolean }) {
  const all: CompatStatus[] = ["certified", "compatible", "known_issues", "incompatible", "untested", compact ? "n/a" : "unsupported_hardware"];
  return (
    <div className="space-y-1.5 text-xs text-slate-600">
      <div className="flex flex-wrap items-center gap-2">
        {all.map((s) => compact ? <CompactCompat key={s} value={s} /> : <CompatBadge key={s} value={s} />)}
      </div>
      <p className="flex items-start gap-1">
        <Info className="mt-0.5 size-3 shrink-0 text-slate-400" />
        <span>
          <b>untested</b> = no compatibility record exists; it is never implied compatible and rollouts treat it as a warning.{" "}
          <b>{compact ? "n/a" : "no image"}</b> = the engine version ships no container image for that hardware, so it cannot run there at all.
        </span>
      </p>
    </div>
  );
}

export interface CompatEditTarget {
  mvId: string; mvLabel: string; evId: string; evLabel: string; hwId: string; hwName: string;
}

/**
 * Edit one (model version × engine version × hardware) record. Current notes/evidence are read from the model
 * version detail (cached when opened from that page), since the family-wide matrix only carries statuses.
 */
export function CompatEditModal({ target, onClose }: { target: CompatEditTarget; onClose: () => void }) {
  const { data, isLoading } = useApi<ModelVersionDetail>(`/model-versions/${target.mvId}`);
  const cell = data?.compat.rows.find((r) => r.engine_version.id === target.evId)?.cells[target.hwId];
  return (
    <Modal open onClose={onClose} title="Edit compatibility">
      <div className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-700">
        <b>{target.mvLabel}</b> on <b>{target.evLabel}</b> · <b>{target.hwName}</b>
      </div>
      {isLoading || !cell ? <Spinner /> : <CompatEditForm target={target} cell={cell} onClose={onClose} />}
    </Modal>
  );
}

function CompatEditForm({ target, cell, onClose }: {
  target: CompatEditTarget; cell: ModelVersionDetail["compat"]["rows"][number]["cells"][string]; onClose: () => void;
}) {
  const now = useNow();
  const [status, setStatus] = useState<CompatStatus>(isNoImage(cell.status) ? "untested" : cell.status);
  const [notes, setNotes] = useState(cell.notes ?? "");
  const [evidence, setEvidence] = useState(cell.evidence_url ?? "");
  const act = useAction("PUT", { success: "Compatibility updated", onSuccess: onClose });
  const opt = COMPAT_EDITABLE.find((o) => o.value === status);
  const needsNotes = status === "known_issues" || status === "incompatible";
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
        Current: <CompatBadge value={cell.status} />
        {cell.verified_by && <span>set by {cell.verified_by.name} <span title={fmtTime(cell.verified_at)}>{fmtAgo(cell.verified_at, now)}</span></span>}
      </div>
      <Field label="Status" hint={opt?.hint}>
        <Select value={status} onChange={(e) => setStatus(e.target.value as CompatStatus)} options={COMPAT_EDITABLE.map(({ value, label }) => ({ value, label }))} />
      </Field>
      {status !== "untested" && (
        <>
          <Field label={needsNotes ? "Notes (describe the issue)" : "Notes"} hint="Shown as a tooltip on the matrix and recorded in the audit log.">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <Field label="Evidence URL" hint="Link to the benchmark / eval run / incident.">
            <Input value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="https://…" />
          </Field>
        </>
      )}
      <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button
          variant={status === "untested" ? "danger" : "primary"}
          loading={act.isPending}
          disabled={needsNotes && !notes.trim()}
          title={needsNotes && !notes.trim() ? "Notes are required for known issues / incompatible" : undefined}
          onClick={() => act.mutate({
            path: "/compatibility",
            body: {
              model_version_id: target.mvId, engine_version_id: target.evId, hardware_type_id: target.hwId, status,
              notes: status === "untested" ? null : notes.trim() || null,
              evidence_url: status === "untested" ? null : evidence.trim() || null,
            },
          })}
        >
          {status === "untested" ? "Remove record" : "Save"}
        </Button>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ desired / observed match
type MatchKind = "model" | "engine";

function otherLabel(d: DeploymentRow, kind: MatchKind, side: "desired" | "observed"): string | null {
  if (side === "desired") {
    const r = kind === "model" ? d.desired?.model_version : d.desired?.engine_version;
    return r?.label ?? null;
  }
  if (!d.observed) return "never reported";
  if (!d.observed.present) return "absent";
  const r = kind === "model" ? d.observed.model_version : d.observed.engine_version;
  return r?.label ?? (kind === "model" ? d.observed.model_raw : d.observed.engine_raw) ?? null;
}

export function matchRank(d: DeploymentRow): number {
  const m = d.match ?? { desired: false, observed: false };
  if (m.desired && !m.observed) return 0;
  if (!m.desired && m.observed) return 1;
  return 2;
}

export function matchCounts(rows: DeploymentRow[]) {
  let desired = 0, observed = 0, desiredOnly = 0, observedOnly = 0;
  for (const d of rows) {
    if (d.match?.desired) desired++;
    if (d.match?.observed) observed++;
    if (d.match?.desired && !d.match.observed) desiredOnly++;
    if (!d.match?.desired && d.match?.observed) observedOnly++;
  }
  return { desired, observed, desiredOnly, observedOnly };
}

/** Extra DeploymentTable column: is *this* version the desired and/or the observed one? Mismatches are loud. */
export function MatchCell({ d, kind }: { d: DeploymentRow; kind: MatchKind }) {
  const m = d.match ?? { desired: false, observed: false };
  const stale = d.freshness.state !== "fresh";
  if (m.desired && m.observed) {
    return (
      <div className="space-y-0.5">
        <Pill tone="green">desired · running</Pill>
        {stale && <div className="text-[11px] text-slate-500">running = last known (data {d.freshness.state})</div>}
      </div>
    );
  }
  if (m.desired) {
    return (
      <div className="space-y-0.5">
        <Pill tone="orange">desired, not running</Pill>
        <div className="text-[11px] text-slate-500">observed: {otherLabel(d, kind, "observed") ?? "—"}</div>
      </div>
    );
  }
  if (m.observed) {
    return (
      <div className="space-y-0.5">
        {d.managed ? <Pill tone="amber">running, not desired</Pill> : <Pill tone="indigo">running (unmanaged)</Pill>}
        {d.managed && <div className="text-[11px] text-slate-500">desired: {otherLabel(d, kind, "desired") ?? "—"}</div>}
      </div>
    );
  }
  return <span className="text-xs text-slate-400">—</span>;
}

// ------------------------------------------------------------------ rollouts
export function RolloutList({ rollouts, empty = "No rollouts target this version." }: { rollouts: RolloutSummary[]; empty?: string }) {
  const now = useNow();
  if (!rollouts.length) return <Empty>{empty}</Empty>;
  return (
    <Table>
      <thead><tr><Th>Rollout</Th><Th>Status</Th><Th>Kind</Th><Th>Progress</Th><Th>Requested by</Th><Th>Created</Th></tr></thead>
      <tbody>
        {[...rollouts].sort((a, b) => b.created_at - a.created_at).map((r) => (
          <tr key={r.id}>
            <Td><RolloutLink r={r} /></Td>
            <Td><RolloutBadge value={r.status} /></Td>
            <Td className="text-xs text-slate-600">{r.kind.replace(/_/g, " ")}</Td>
            <Td className="text-xs tabular-nums text-slate-600">
              {r.target_counts.succeeded ?? 0}/{r.target_total} succeeded
              {!!r.target_counts.failed && <span className="ml-1 text-red-600">· {r.target_counts.failed} failed</span>}
            </Td>
            <Td className="text-xs">{r.requested_by.name}</Td>
            <Td className="whitespace-nowrap text-xs text-slate-500"><span title={fmtTime(r.created_at)}>{fmtAgo(r.created_at, now)}</span></Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
