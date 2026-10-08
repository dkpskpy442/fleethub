import { useQuery } from "@tanstack/react-query";
import { api, type ApiError } from "../../../lib/api";
import type { Check, RolloutPreview, WavePlan } from "../../../lib/types";
import type { RolloutKind } from "../shared";

export type PreviewTarget = RolloutPreview["targets"][number];

export interface Change { kind: RolloutKind; mvId: string; evId: string }

export interface EditableWave extends WavePlan { key: string }

export const needsModel = (k: RolloutKind) => k !== "engine";
export const needsEngine = (k: RolloutKind) => k !== "model";

export function changeValid(c: Change): boolean {
  return (!needsModel(c.kind) || !!c.mvId) && (!needsEngine(c.kind) || !!c.evId);
}

export function changeBody(c: Change) {
  return {
    kind: c.kind,
    target_model_version_id: needsModel(c.kind) ? c.mvId : null,
    target_engine_version_id: needsEngine(c.kind) ? c.evId : null,
  };
}

/** POST /rollouts/preview is read-only, so it is modelled as a query keyed by its inputs. */
export function usePreview(c: Change, deploymentIds: string[] | null, enabled: boolean) {
  const ids = deploymentIds ? [...deploymentIds].sort() : null;
  return useQuery<RolloutPreview, ApiError>({
    queryKey: ["rollout-preview", c.kind, needsModel(c.kind) ? c.mvId : "", needsEngine(c.kind) ? c.evId : "", ids?.join(",") ?? "*"],
    queryFn: () => api<RolloutPreview>("/rollouts/preview", { method: "POST", body: { ...changeBody(c), deployment_ids: ids ?? undefined } }),
    enabled: enabled && changeValid(c) && (ids === null || ids.length > 0),
    staleTime: 15_000,
    // Guardrail outcomes depend on live fleet state: never start a new wizard session from a cached preview.
    gcTime: 0,
  });
}

export const warnChecks = (checks: Check[]) => checks.filter((c) => c.level === "warn");
export const blockChecks = (checks: Check[]) => checks.filter((c) => c.level === "block");

export const isProd = (t: PreviewTarget | undefined) => t?.deployment.target.environment.tier === "prod";

export function depLabel(t: PreviewTarget | undefined, id: string): string {
  return t ? `${t.deployment.service_name} @ ${t.deployment.target.name}` : id;
}

let keySeq = 0;
export const newWaveKey = () => `w${++keySeq}`;

/** Every selected deployment must sit in exactly one wave; names and bake times must be sane. */
export function validateWaves(waves: EditableWave[], selected: string[]): string[] {
  const errs: string[] = [];
  const seen = new Map<string, number>();
  for (const w of waves) for (const d of w.deployment_ids) seen.set(d, (seen.get(d) ?? 0) + 1);
  const missing = selected.filter((d) => !seen.has(d));
  const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([d]) => d);
  const extra = [...seen.keys()].filter((d) => !selected.includes(d));
  if (missing.length) errs.push(`${missing.length} selected deployment(s) are not in any wave.`);
  if (dup.length) errs.push(`${dup.length} deployment(s) appear in more than one wave.`);
  if (extra.length) errs.push(`${extra.length} deployment(s) in waves are no longer selected.`);
  if (!waves.some((w) => w.deployment_ids.length)) errs.push("Add at least one non-empty wave.");
  waves.forEach((w, i) => {
    if (!w.name.trim()) errs.push(`Wave ${i + 1} needs a name.`);
    if (!Number.isFinite(w.bake_minutes) || w.bake_minutes < 0) errs.push(`Wave ${i + 1}: bake minutes must be 0 or more.`);
  });
  return errs;
}
