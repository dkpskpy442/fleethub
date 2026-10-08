import { ArrowRight, Check } from "lucide-react";
import type { ReactNode } from "react";
import type { EvRef, ImgRef, MvRef, RolloutStatus, RolloutSummary, TargetStatus } from "../../lib/types";
import { EvLink, ImageTag, MvLink } from "../domain";
import { cx } from "../ui";

export type RolloutKind = RolloutSummary["kind"];

export const KIND_LABEL: Record<RolloutKind, string> = {
  model: "Model version",
  engine: "Engine version",
  model_and_engine: "Model + engine",
};

export const ACTIVE_STATUSES: RolloutStatus[] = ["draft", "ready", "in_progress", "paused", "rolling_back"];
export const isActiveRollout = (s: RolloutStatus) => ACTIVE_STATUSES.includes(s);

/** Human countdown for a future sim timestamp ("12m", "1h 5m", "40s"). */
export function fmtLeft(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.ceil(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

// ------------------------------------------------------------------ progress bar
const SEGMENTS: { key: string; statuses: TargetStatus[]; cls: string; label: string }[] = [
  { key: "succeeded", statuses: ["succeeded"], cls: "bg-emerald-500", label: "succeeded" },
  { key: "failed", statuses: ["failed"], cls: "bg-red-500", label: "failed" },
  { key: "inflight", statuses: ["applying", "verifying", "rolling_back"], cls: "bg-sky-500", label: "in flight" },
  { key: "rolled_back", statuses: ["rolled_back"], cls: "bg-orange-300", label: "rolled back" },
  { key: "skipped", statuses: ["skipped"], cls: "bg-slate-300", label: "skipped" },
  { key: "pending", statuses: ["pending"], cls: "bg-slate-100", label: "pending" },
];

export function RolloutProgress({ counts, total, className }: {
  counts: Partial<Record<TargetStatus, number>>; total: number; className?: string;
}) {
  const parts = SEGMENTS.map((s) => ({ ...s, n: s.statuses.reduce((a, st) => a + (counts[st] ?? 0), 0) })).filter((s) => s.n > 0);
  const succeeded = counts.succeeded ?? 0;
  const skipped = counts.skipped ?? 0;
  const title = parts.map((p) => `${p.n} ${p.label}`).join(" · ") || "no targets";
  return (
    <div className={cx("flex min-w-[9rem] items-center gap-2", className)} title={title}>
      <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-slate-100 ring-1 ring-inset ring-slate-200">
        {parts.map((p) => (
          <div key={p.key} className={p.cls} style={{ width: `${(p.n / Math.max(total, 1)) * 100}%` }} />
        ))}
      </div>
      <span className="whitespace-nowrap text-xs tabular-nums text-slate-600">
        {succeeded}/{total}
        {skipped > 0 && <span className="text-slate-400"> ({skipped} skipped)</span>}
        {(counts.failed ?? 0) > 0 && <span className="font-medium text-red-600"> · {counts.failed} failed</span>}
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ version change (from -> to)
export interface Spec { model_version: MvRef | null; engine_version: EvRef | null; image: ImgRef | null }

function Row({ label, from, to, same }: { label: string; from: ReactNode; to: ReactNode; same: boolean }) {
  return (
    <>
      <span className="text-slate-400">{label}</span>
      <span className="flex flex-wrap items-center gap-x-1.5">
        {same ? (
          <>
            <span className="text-slate-500">{to}</span>
            <span className="text-[11px] text-slate-400">unchanged</span>
          </>
        ) : (
          <>
            <span className="text-slate-500">{from}</span>
            <ArrowRight className="size-3 text-slate-400" />
            <span className="rounded bg-indigo-50 px-0.5 font-medium">{to}</span>
          </>
        )}
      </span>
    </>
  );
}

/** Current/previous desired spec vs the spec this rollout will apply. Only changed fields are emphasised. */
export function SpecChange({ from, to, fromLabel }: { from: Spec | null; to: Spec; fromLabel?: string }) {
  const none = <span className="italic text-slate-400">{fromLabel ?? "none"}</span>;
  return (
    <div className="grid grid-cols-[3rem_1fr] gap-x-2 gap-y-0.5 text-xs">
      <Row label="model" same={!!from && from.model_version?.id === to.model_version?.id}
        from={from ? <MvLink mv={from.model_version} lifecycle={false} /> : none} to={<MvLink mv={to.model_version} />} />
      <Row label="engine" same={!!from && from.engine_version?.id === to.engine_version?.id}
        from={from ? <EvLink ev={from.engine_version} lifecycle={false} /> : none} to={<EvLink ev={to.engine_version} />} />
      <Row label="image" same={!!from && from.image?.id === to.image?.id}
        from={from ? <ImageTag img={from.image} /> : none} to={<ImageTag img={to.image} />} />
    </div>
  );
}

// ------------------------------------------------------------------ wizard stepper header
export function StepperHeader({ steps, current, maxReached, onSelect }: {
  steps: string[]; current: number; maxReached: number; onSelect: (i: number) => void;
}) {
  return (
    <ol className="mb-5 flex flex-wrap items-center gap-y-2 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        const reachable = i <= maxReached;
        return (
          <li key={s} className="flex items-center">
            <button
              type="button"
              disabled={!reachable}
              onClick={() => onSelect(i)}
              className={cx(
                "flex items-center gap-2 rounded-md px-2 py-1 text-sm",
                active ? "font-semibold text-indigo-700" : done ? "text-slate-700 hover:bg-slate-50" : "text-slate-400",
                reachable && !active && "hover:bg-slate-50",
                !reachable && "cursor-not-allowed",
              )}
            >
              <span
                className={cx(
                  "flex size-6 items-center justify-center rounded-full text-xs font-semibold",
                  active ? "bg-indigo-600 text-white" : done ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500",
                )}
              >
                {done ? <Check className="size-3.5" /> : i + 1}
              </span>
              {s}
            </button>
            {i < steps.length - 1 && <span className="mx-1 h-px w-6 bg-slate-200 sm:w-10" />}
          </li>
        );
      })}
    </ol>
  );
}

/** Small horizontal bar list, e.g. deployments by environment. */
export function BarList({ data, tone = "bg-indigo-400" }: { data: Record<string, number>; tone?: string }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, n]) => n));
  if (!entries.length) return <span className="text-xs text-slate-400">—</span>;
  return (
    <ul className="space-y-1.5">
      {entries.map(([k, n]) => (
        <li key={k} className="grid grid-cols-[7rem_1fr_2rem] items-center gap-2 text-xs">
          <span className="truncate text-slate-600" title={k}>{k}</span>
          <span className="h-2 rounded-full bg-slate-100">
            <span className={cx("block h-2 rounded-full", tone)} style={{ width: `${(n / max) * 100}%` }} />
          </span>
          <span className="text-right tabular-nums text-slate-700">{n}</span>
        </li>
      ))}
    </ul>
  );
}
