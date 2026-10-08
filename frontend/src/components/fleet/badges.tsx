/**
 * Fleet-local status pills for the deployment request / deployer operation families.
 * Kept separate from status.tsx so the "claim" vocabulary (operation) never looks like convergence.
 */
import { CheckCircle2, Clock, Loader2, Timer, XCircle } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import type { OperationView, RequestView } from "../../lib/types";
import { Pill } from "../status";

export type Tone = ComponentProps<typeof Pill>["tone"];

const ic = "size-3";

export function RequestStatusPill({ value }: { value: RequestView["status"] }) {
  const map: Record<RequestView["status"], [Tone, ReactNode]> = {
    queued: ["gray", <Clock className={ic} />],
    submitted: ["blue", <Loader2 className={`${ic} animate-spin`} />],
    completed: ["green", <CheckCircle2 className={ic} />],
    failed: ["red", <XCircle className={ic} />],
    superseded: ["gray", null],
    cancelled: ["gray", null],
  };
  const [tone, icon] = map[value];
  return <Pill tone={tone} icon={icon} title="Deployment request status (FleetHub side)" className={value === "superseded" ? "line-through" : ""}>{value}</Pill>;
}

/** The deployer's own report. Success here is only a claim until inventory confirms it. */
export function OperationStatusPill({ value }: { value: OperationView["status"] }) {
  const map: Record<OperationView["status"], [Tone, ReactNode, string]> = {
    pending: ["gray", <Clock className={ic} />, "pending"],
    running: ["blue", <Loader2 className={`${ic} animate-spin`} />, "running"],
    reported_succeeded: ["greenSoft", <CheckCircle2 className={ic} />, "reported success"],
    reported_failed: ["red", <XCircle className={ic} />, "reported failure"],
    timed_out: ["orange", <Timer className={ic} />, "timed out"],
    cancelled: ["gray", null, "cancelled"],
  };
  const [tone, icon, label] = map[value];
  return <Pill tone={tone} icon={icon} title="Deployer's claim - not proof of what is running">{label}</Pill>;
}

export function SourcePill({ source }: { source: string }) {
  const tone: Tone = source === "rollout" ? "indigo" : source === "adopt" ? "violet"
    : source === "accept_drift" ? "orange" : source === "rollback" ? "amber" : "gray";
  return <Pill tone={tone} title="How this desired revision was created">{source.replace(/_/g, " ")}</Pill>;
}
