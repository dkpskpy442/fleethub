import { Boxes, Cpu, Layers } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useApi } from "../../../lib/api";
import type { EngineSummary, ModelFamilySummary, VulnDetail } from "../../../lib/types";
import { EngineLifecycleBadge, ModelLifecycleBadge, Pill, SeverityBadge } from "../../status";
import { Card, ErrorBox, Field, Select, Spinner, cx } from "../../ui";
import type { RolloutKind } from "../shared";
import { needsEngine, needsModel, type Change } from "./common";

const KINDS: { id: RolloutKind; label: string; desc: string; icon: ReactNode }[] = [
  { id: "engine", label: "Engine version", desc: "Swap the inference engine (and image) under the models already running. Typical for vulnerability remediation.", icon: <Cpu className="size-5" /> },
  { id: "model", label: "Model version", desc: "Serve a new version of a model family on its current engine.", icon: <Boxes className="size-5" /> },
  { id: "model_and_engine", label: "Model + engine", desc: "Change both at once — e.g. a model that needs a newer engine.", icon: <Layers className="size-5" /> },
];

export function ChangeStep({ change, onChange, vuln }: { change: Change; onChange: (c: Change) => void; vuln?: VulnDetail }) {
  return (
    <div className="space-y-4">
      <Card title="What kind of change?">
        <div className="grid gap-3 md:grid-cols-3">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => onChange({ ...change, kind: k.id })}
              className={cx(
                "flex gap-3 rounded-lg border p-3 text-left transition-colors",
                change.kind === k.id ? "border-indigo-500 bg-indigo-50/60 ring-1 ring-indigo-500" : "border-slate-200 hover:border-slate-300 hover:bg-slate-50",
              )}
            >
              <span className={cx("mt-0.5", change.kind === k.id ? "text-indigo-600" : "text-slate-400")}>{k.icon}</span>
              <span>
                <span className="block text-sm font-medium text-slate-900">{k.label}</span>
                <span className="mt-0.5 block text-xs text-slate-500">{k.desc}</span>
              </span>
            </button>
          ))}
        </div>
      </Card>
      <div className={cx("grid gap-4", needsModel(change.kind) && needsEngine(change.kind) && "lg:grid-cols-2")}>
        {needsModel(change.kind) && <ModelPicker value={change.mvId} onChange={(mvId) => onChange({ ...change, mvId })} />}
        {needsEngine(change.kind) && <EnginePicker value={change.evId} onChange={(evId) => onChange({ ...change, evId })} vuln={vuln} />}
      </div>
    </div>
  );
}

function OptionRow({ checked, onSelect, children, name }: { checked: boolean; onSelect: () => void; children: ReactNode; name: string }) {
  return (
    <label
      className={cx(
        "flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm",
        checked ? "border-indigo-500 bg-indigo-50/60" : "border-slate-200 hover:bg-slate-50",
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onSelect} className="accent-indigo-600" />
      {children}
    </label>
  );
}

function ModelPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { data, error, isLoading } = useApi<ModelFamilySummary[]>("/models");
  const owning = data?.find((f) => f.versions.some((v) => v.id === value));
  const [famId, setFamId] = useState<string>("");
  const fam = data?.find((f) => f.id === (famId || owning?.id)) ?? null;
  return (
    <Card title="Target model version" subtitle="Applies to every deployment serving this model family.">
      {isLoading ? <Spinner /> : <ErrorBox error={error} />}
      {data && (
        <div className="space-y-3">
          <Field label="Model family">
            <Select
              value={fam?.id ?? ""}
              onChange={(e) => { setFamId(e.target.value); onChange(""); }}
              options={[{ value: "", label: "Choose a model family…" }, ...data.map((f) => ({ value: f.id, label: `${f.name} (${f.deployment_count} deployments)` }))]}
            />
          </Field>
          {fam && (
            <div className="space-y-1.5">
              {fam.versions.map((v) => (
                <OptionRow key={v.id} name="mv" checked={value === v.id} onSelect={() => onChange(v.id)}>
                  <span className="font-medium">{fam.name} {v.version}</span>
                  <ModelLifecycleBadge value={v.lifecycle} />
                  {v.lifecycle === "retired" && <span className="ml-auto text-xs text-red-600">guardrails will block</span>}
                  {v.lifecycle === "deprecated" && <span className="ml-auto text-xs text-amber-700">needs justification</span>}
                  {v.lifecycle === "experimental" && <span className="ml-auto text-xs text-amber-700">prod targets need justification</span>}
                </OptionRow>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function EnginePicker({ value, onChange, vuln }: { value: string; onChange: (id: string) => void; vuln?: VulnDetail }) {
  const { data, error, isLoading } = useApi<EngineSummary[]>("/engines");
  const remediates = new Map((vuln?.remediation_options ?? []).map((o) => [o.engine_version_id, o]));
  const affected = new Set((vuln?.findings ?? []).map((f) => f.engine_version.engine_id));
  const engines = [...(data ?? [])].sort((a, b) => Number(affected.has(b.id)) - Number(affected.has(a.id)));
  return (
    <Card title="Target engine version" subtitle="Applies to deployments currently running the same engine; the matching image per accelerator is chosen automatically.">
      {isLoading ? <Spinner /> : <ErrorBox error={error} />}
      <div className="space-y-4">
        {engines.map((e) => (
          <div key={e.id}>
            <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {e.name}
              {affected.has(e.id) && vuln && <Pill tone="red">affected by {vuln.external_id}</Pill>}
            </div>
            <div className="space-y-1.5">
              {e.versions.map((v) => {
                const fix = remediates.get(v.id);
                return (
                  <OptionRow key={v.id} name="ev" checked={value === v.id} onSelect={() => onChange(v.id)}>
                    <span className="min-w-[6rem] font-medium">{e.name} {v.version}</span>
                    <EngineLifecycleBadge value={v.lifecycle} />
                    {v.worst_vuln ? <span className="inline-flex items-center gap-1 text-xs text-slate-500">worst vuln <SeverityBadge value={v.worst_vuln} /></span>
                      : <span className="text-xs text-emerald-700">no known vulns</span>}
                    {fix && (
                      <Pill tone="green" title={`${fix.counts.ok} ok · ${fix.counts.warn} need justification · ${fix.counts.blocked} blocked`}>
                        fixes {vuln!.external_id} · {fix.counts.ok + fix.counts.warn} eligible
                      </Pill>
                    )}
                    <span className="ml-auto whitespace-nowrap text-xs text-slate-400">{v.observed_count} running · {v.desired_count} desired</span>
                  </OptionRow>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
