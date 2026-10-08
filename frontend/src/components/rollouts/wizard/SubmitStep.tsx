import { Save, Send, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import type { ApiError } from "../../../lib/api";
import type { Check, MvRef, EvRef, VulnDetail } from "../../../lib/types";
import { EvLink, MvLink, NoPermission, VulnLink, useCan } from "../../domain";
import { CheckLevelIcon } from "../../status";
import { Button, Card, Field, Input, KV, Textarea } from "../../ui";
import { KIND_LABEL, type RolloutKind } from "../shared";
import { depLabel, isProd, type EditableWave, type PreviewTarget } from "./common";

export function SubmitStep({
  kind, mv, ev, vuln, waves, byId, justified, title, setTitle, reason, setReason, onSave, pending, error,
}: {
  kind: RolloutKind; mv: MvRef | null; ev: EvRef | null; vuln?: VulnDetail; waves: EditableWave[];
  byId: Map<string, PreviewTarget>; justified: number; title: string; setTitle: (s: string) => void;
  reason: string; setReason: (s: string) => void; onSave: (submit: boolean) => void; pending: boolean; error: ApiError | null;
}) {
  const canCreate = useCan("rollout.create");
  const canSubmit = useCan("rollout.submit");
  const nonEmpty = waves.filter((w) => w.deployment_ids.length);
  const total = nonEmpty.reduce((a, w) => a + w.deployment_ids.length, 0);
  const prodWaves = nonEmpty.filter((w) => w.deployment_ids.some((d) => isProd(byId.get(d))));
  const ready = !!title.trim() && canCreate;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <Card title="Describe the rollout">
        <div className="space-y-4">
          <Field label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Atlas Chat → vLLM 0.10.0" />
          </Field>
          <Field label="Reason" hint="Why this change, why now. Shown to approvers and recorded in the audit log.">
            <Textarea rows={4} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          {error && <SubmitError error={error} byId={byId} />}
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
            <Button
              disabled={!ready} loading={pending} onClick={() => onSave(false)}
              title={!canCreate ? "Your role lacks permission: rollout.create" : undefined}
            >
              <Save className="size-4" /> Save draft
            </Button>
            <Button
              variant="primary" disabled={!ready || !canSubmit} loading={pending} onClick={() => onSave(true)}
              title={!canSubmit ? "Your role lacks permission: rollout.submit (you can still save a draft for someone else to submit)" : undefined}
            >
              <Send className="size-4" /> Submit for execution
            </Button>
            {!canSubmit && canCreate && <span className="text-xs text-slate-500">Your role can only save drafts; a platform engineer or model owner submits.</span>}
            {!canCreate && <NoPermission perm="rollout.create" />}
          </div>
          <p className="text-xs text-slate-500">
            Submitting re-checks every guardrail, locks the target deployments against other rollouts and
            {prodWaves.length ? " requests prod approval from a release approver (not you)." : " makes the rollout ready to start."}
          </p>
        </div>
      </Card>
      <Card title="Summary">
        <KV
          items={[
            ["Kind", KIND_LABEL[kind]],
            ...(mv ? [["Model", <MvLink mv={mv} />] as [string, ReactNode]] : []),
            ...(ev ? [["Engine", <EvLink ev={ev} />] as [string, ReactNode]] : []),
            ...(vuln ? [["Remediates", <VulnLink v={vuln} />] as [string, ReactNode]] : []),
            ["Targets", `${total} deployment${total === 1 ? "" : "s"}`],
            ["Waves", nonEmpty.length],
            ["Warnings accepted", justified],
            ["Approval", prodWaves.length ? <span className="inline-flex items-start gap-1 text-amber-700"><ShieldAlert className="mt-0.5 size-3.5 shrink-0" />{prodWaves.length} prod wave(s) need release approval</span> : "not required"],
          ]}
        />
        <ol className="mt-4 space-y-1 border-t border-slate-100 pt-3 text-xs">
          {nonEmpty.map((w, i) => (
            <li key={w.key} className="flex justify-between gap-2">
              <span className="truncate">{i + 1}. {w.name}</span>
              <span className="whitespace-nowrap text-slate-500">{w.deployment_ids.length} · bake {w.bake_minutes}m</span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

interface Problem { deployment_id: string; issue: string; checks?: Check[]; warnings?: string[] }

function SubmitError({ error, byId }: { error: ApiError; byId: Map<string, PreviewTarget> }) {
  const d = error.details;
  const problems: Problem[] = Array.isArray(d) ? (d as Problem[]).filter((x) => x && typeof x === "object" && "deployment_id" in x) : [];
  const checks: Check[] = !Array.isArray(d) && d && typeof d === "object" && "checks" in d ? (d as { checks: Check[] }).checks : [];
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <div className="font-medium">{error.message}</div>
      {problems.length > 0 && (
        <ul className="mt-2 space-y-2">
          {problems.map((p, i) => (
            <li key={i} className="text-xs">
              <span className="font-medium">{depLabel(byId.get(p.deployment_id), p.deployment_id)}</span>{" "}
              <span className="rounded bg-red-100 px-1">{p.issue.replace(/_/g, " ")}</span>
              {p.warnings && <span> — warnings: {p.warnings.join(", ")}</span>}
              {p.checks && (
                <ul className="mt-1 space-y-0.5 pl-2">
                  {p.checks.filter((c) => c.level === "block" || c.level === "warn").map((c) => (
                    <li key={c.code} className="flex items-start gap-1"><CheckLevelIcon level={c.level} />{c.message}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {checks.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs">
          {checks.filter((c) => c.level === "block" || c.level === "warn").map((c) => (
            <li key={c.code} className="flex items-start gap-1"><CheckLevelIcon level={c.level} />{c.message}</li>
          ))}
        </ul>
      )}
      {(problems.length > 0 || checks.length > 0) && <div className="mt-2 text-xs">Go back to <b>Targets</b> to deselect or justify these deployments.</div>}
    </div>
  );
}
