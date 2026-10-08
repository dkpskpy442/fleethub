/**
 * One badge per status family. Families never share a vocabulary or a component, so model lifecycle,
 * engine lifecycle, health, convergence, freshness, rollout and finding status can't be confused.
 * Unknown / stale / unverifiable always render gray + hatched - never green.
 */
import {
  AlertTriangle, Ban, CheckCircle2, CircleDashed, CircleHelp, Clock, GitCompareArrows, Loader2, PauseCircle,
  RotateCcw, ShieldAlert, ShieldCheck, ShieldQuestion, Undo2, XCircle,
} from "lucide-react";
import type { ReactNode } from "react";
import type {
  ApprovalStatus, CompatStatus, ConvergenceState, EngineLifecycle, FindingStatus, Freshness, Health, ModelLifecycle,
  RolloutStatus, Severity, TargetStatus, WaveStatus,
} from "../lib/types";
import { cx } from "./ui";

type Tone = "green" | "greenSoft" | "blue" | "violet" | "amber" | "orange" | "red" | "redSolid" | "gray" | "unknown" | "indigo";

const TONES: Record<Tone, string> = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  greenSoft: "bg-emerald-50/60 text-emerald-700 ring-emerald-600/10",
  blue: "bg-sky-50 text-sky-700 ring-sky-600/20",
  violet: "bg-violet-50 text-violet-700 ring-violet-600/20",
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
  amber: "bg-amber-50 text-amber-800 ring-amber-600/25",
  orange: "bg-orange-50 text-orange-700 ring-orange-600/25",
  red: "bg-red-50 text-red-700 ring-red-600/25",
  redSolid: "bg-red-600 text-white ring-red-700",
  gray: "bg-slate-100 text-slate-600 ring-slate-500/20",
  unknown: "hatched text-slate-600 ring-slate-400/40",
};

export function Pill({ tone, icon, children, title, className }: { tone: Tone; icon?: ReactNode; children: ReactNode; title?: string; className?: string }) {
  return (
    <span
      title={title}
      className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset", TONES[tone], className)}
    >
      {icon}
      {children}
    </span>
  );
}

const ic = "size-3";

export function ModelLifecycleBadge({ value }: { value: ModelLifecycle }) {
  const t: Record<ModelLifecycle, Tone> = { experimental: "violet", production: "green", deprecated: "amber", retired: "gray" };
  return <Pill tone={t[value]} title="Model lifecycle" className={value === "retired" ? "line-through" : ""}>{value}</Pill>;
}

export function EngineLifecycleBadge({ value }: { value: EngineLifecycle }) {
  const t: Record<EngineLifecycle, Tone> = { preview: "violet", supported: "green", deprecated: "amber", eol: "gray" };
  return <Pill tone={t[value]} title="Engine lifecycle" className={value === "eol" ? "line-through" : ""}>{value === "eol" ? "end-of-life" : value}</Pill>;
}

export function HealthBadge({ value, title }: { value: Health; title?: string }) {
  const map: Record<Health, [Tone, ReactNode]> = {
    healthy: ["green", <span className="size-1.5 rounded-full bg-emerald-500" />],
    degraded: ["amber", <span className="size-1.5 rounded-full bg-amber-500" />],
    unhealthy: ["red", <span className="size-1.5 rounded-full bg-red-500" />],
    unknown: ["unknown", <CircleHelp className={ic} />],
  };
  const [tone, icon] = map[value];
  return <Pill tone={tone} icon={icon} title={title ?? (value === "unknown" ? "No fresh inventory data - health cannot be known" : "Observed health")}>{value}</Pill>;
}

const CONV: Record<ConvergenceState, [Tone, ReactNode, string, string]> = {
  converged: ["green", <CheckCircle2 className={ic} />, "converged", "Fresh inventory evidence matches desired model, engine and image digest"],
  converging: ["blue", <Loader2 className={cx(ic, "animate-spin")} />, "converging", "A deployment request is in flight"],
  verifying: ["blue", <Clock className={ic} />, "verifying", "Deployer finished; waiting for inventory to confirm"],
  drifted: ["orange", <GitCompareArrows className={ic} />, "drifted", "Out-of-band change: reality no longer matches desired state"],
  apply_failed: ["red", <XCircle className={ic} />, "apply failed", "The deployer reported a failure"],
  not_observed_after_success: ["red", <AlertTriangle className={ic} />, "success not observed", "Deployer claimed success but inventory still shows another version"],
  missing: ["red", <Ban className={ic} />, "missing", "Desired but not reported by inventory"],
  unverifiable: ["unknown", <CircleHelp className={ic} />, "unverifiable", "No fresh inventory data - state cannot be verified"],
  unmanaged: ["indigo", <CircleDashed className={ic} />, "unmanaged", "Running outside FleetHub (no desired state)"],
};

export function ConvergenceBadge({ value, title }: { value: ConvergenceState; title?: string }) {
  const [tone, icon, label, desc] = CONV[value];
  return <Pill tone={tone} icon={icon} title={title ?? desc}>{label}</Pill>;
}

export function FreshnessBadge({ value, title }: { value: Freshness; title?: string }) {
  const t: Record<Freshness, Tone> = { fresh: "greenSoft", stale: "amber", unknown: "unknown" };
  return <Pill tone={t[value]} title={title ?? "Data freshness"}>{value === "unknown" ? "no data" : value}</Pill>;
}

export function SeverityBadge({ value }: { value: Severity }) {
  const t: Record<Severity, Tone> = { critical: "redSolid", high: "orange", medium: "amber", low: "gray" };
  return <Pill tone={t[value]} title="Severity">{value}</Pill>;
}

export function FindingBadge({ value }: { value: FindingStatus }) {
  const map: Record<FindingStatus, [Tone, ReactNode]> = {
    open: ["red", <ShieldAlert className={ic} />],
    in_progress: ["amber", <Clock className={ic} />],
    remediated: ["green", <ShieldCheck className={ic} />],
    risk_accepted: ["violet", <ShieldQuestion className={ic} />],
    false_positive: ["gray", <Ban className={ic} />],
  };
  const [tone, icon] = map[value];
  return <Pill tone={tone} icon={icon} title="Finding status">{value.replace("_", " ")}</Pill>;
}

export function CompatBadge({ value, title }: { value: CompatStatus; title?: string }) {
  const t: Record<CompatStatus, Tone> = {
    certified: "green", compatible: "greenSoft", known_issues: "amber", incompatible: "red", untested: "unknown",
    unsupported_hardware: "gray", "n/a": "gray",
  };
  const label = value === "unsupported_hardware" ? "no image" : value.replace("_", " ");
  return <Pill tone={t[value]} title={title ?? "Compatibility (model version × engine version × hardware)"}>{label}</Pill>;
}

export function RolloutBadge({ value }: { value: RolloutStatus }) {
  const map: Record<RolloutStatus, [Tone, ReactNode]> = {
    draft: ["gray", null], ready: ["indigo", null],
    in_progress: ["blue", <Loader2 className={cx(ic, "animate-spin")} />],
    paused: ["amber", <PauseCircle className={ic} />], completed: ["green", <CheckCircle2 className={ic} />],
    rolling_back: ["orange", <RotateCcw className={ic} />], rolled_back: ["gray", <Undo2 className={ic} />], cancelled: ["gray", <Ban className={ic} />],
  };
  const [tone, icon] = map[value];
  return <Pill tone={tone} icon={icon} title="Rollout status">{value.replace("_", " ")}</Pill>;
}

export function ApprovalBadge({ value }: { value: ApprovalStatus }) {
  const t: Record<ApprovalStatus, Tone> = { not_required: "gray", pending: "amber", approved: "green", rejected: "red" };
  return <Pill tone={t[value]} title="Prod approval">{value === "not_required" ? "no approval needed" : `approval ${value}`}</Pill>;
}

export function WaveBadge({ value }: { value: WaveStatus }) {
  const t: Record<WaveStatus, Tone> = {
    pending: "gray", awaiting_approval: "amber", in_progress: "blue", succeeded: "green", failed: "red", rolling_back: "orange", rolled_back: "gray",
  };
  return <Pill tone={t[value]} title="Wave status">{value.replace("_", " ")}</Pill>;
}

export function TargetBadge({ value, manual }: { value: TargetStatus; manual?: boolean }) {
  const t: Record<TargetStatus, Tone> = {
    pending: "gray", applying: "blue", verifying: "blue", succeeded: "green", failed: "red", skipped: "gray", rolling_back: "orange", rolled_back: "gray",
  };
  if (value === "succeeded" && manual) {
    return <Pill tone="violet" icon={<AlertTriangle className={ic} />} title="Marked succeeded by an admin WITHOUT inventory evidence">manually verified</Pill>;
  }
  return <Pill tone={t[value]} title="Target status">{value.replace("_", " ")}</Pill>;
}

export function CheckLevelIcon({ level }: { level: "block" | "warn" | "ok" | "info" }) {
  if (level === "block") return <XCircle className="size-4 shrink-0 text-red-600" />;
  if (level === "warn") return <AlertTriangle className="size-4 shrink-0 text-amber-500" />;
  if (level === "ok") return <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />;
  return <CircleHelp className="size-4 shrink-0 text-slate-400" />;
}

export function OutcomeBadge({ value }: { value: "ok" | "warn" | "blocked" | "no_change" }) {
  const map: Record<string, [Tone, string]> = { ok: ["green", "ok"], warn: ["amber", "needs justification"], blocked: ["red", "blocked"], no_change: ["gray", "no change"] };
  const [tone, label] = map[value];
  return <Pill tone={tone}>{label}</Pill>;
}
