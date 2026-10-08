import { ChevronDown, ChevronRight, Lock } from "lucide-react";
import { useState } from "react";
import type { ApiError } from "../../../lib/api";
import { DepLink, EnvTag, GuardrailChecklist } from "../../domain";
import { HealthBadge, OutcomeBadge } from "../../status";
import { Button, Card, Empty, ErrorBox, Spinner, Table, Td, Textarea, Th, cx } from "../../ui";
import { SpecChange } from "../shared";
import { blockChecks, type PreviewTarget } from "./common";

export function TargetsStep({
  rows, loading, error, selected, onToggle, onSetMany, justifications, onJustify, scopedToUrl, onShowAll,
}: {
  rows: PreviewTarget[] | undefined; loading: boolean; error: ApiError | null;
  selected: Set<string>; onToggle: (id: string) => void; onSetMany: (ids: string[], on: boolean) => void;
  justifications: Record<string, string>; onJustify: (id: string, text: string) => void;
  scopedToUrl: boolean; onShowAll: () => void;
}) {
  const [hideExcluded, setHideExcluded] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  if (loading) return <Card><Spinner label="Evaluating guardrails for every candidate deployment…" /></Card>;
  if (error) return <ErrorBox error={error} />;
  if (!rows) return null;

  const eligible = rows.filter((r) => r.guardrails.outcome === "ok" || r.guardrails.outcome === "warn");
  const blocked = rows.filter((r) => r.guardrails.outcome === "blocked");
  const noChange = rows.filter((r) => r.guardrails.outcome === "no_change");
  const needJust = eligible.filter((r) => r.guardrails.outcome === "warn" && selected.has(r.deployment.id));
  const missingJust = needJust.filter((r) => !justifications[r.deployment.id]?.trim());
  const shown = hideExcluded ? eligible : rows;
  const toggleExpand = (id: string) => setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <Card
      padded={false}
      title="Targets & guardrails"
      subtitle={
        <>
          {selected.size} selected of {eligible.length} eligible · <span className="text-red-600">{blocked.length} blocked</span> · {noChange.length} already at target
          {needJust.length > 0 && <> · <span className={missingJust.length ? "text-amber-700" : ""}>{needJust.length - missingJust.length}/{needJust.length} warnings justified</span></>}
        </>
      }
      actions={
        <>
          {scopedToUrl && <Button size="sm" variant="ghost" onClick={onShowAll}>Show all candidate deployments</Button>}
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input type="checkbox" checked={hideExcluded} onChange={(e) => setHideExcluded(e.target.checked)} className="accent-indigo-600" />
            Hide excluded
          </label>
          <Button size="sm" onClick={() => onSetMany(eligible.map((r) => r.deployment.id), true)}>Select all eligible</Button>
          <Button size="sm" variant="ghost" onClick={() => onSetMany(rows.map((r) => r.deployment.id), false)}>Clear</Button>
        </>
      }
    >
      {scopedToUrl && (
        <div className="border-b border-slate-100 bg-sky-50 px-4 py-2 text-xs text-sky-800">
          Showing only the deployments passed in the link. Use “Show all candidate deployments” to widen the scope.
        </div>
      )}
      {!rows.length ? (
        <div className="p-4"><Empty>No deployments can receive this change (no deployment serves this model family / engine).</Empty></div>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th className="w-8" /><Th>Deployment</Th><Th>Current desired → new</Th><Th>Outcome</Th><Th>Guardrails</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const d = r.deployment;
              const id = d.id;
              const outcome = r.guardrails.outcome;
              const excluded = outcome === "blocked" || outcome === "no_change";
              const isSel = selected.has(id);
              const open = expanded.has(id);
              const just = justifications[id] ?? "";
              return (
                <tr key={id} className={cx(excluded ? "bg-slate-50/70 text-slate-500" : isSel ? "bg-indigo-50/30" : "hover:bg-slate-50/60")}>
                  <Td>
                    <input
                      type="checkbox"
                      aria-label={`Include ${d.service_name} @ ${d.target.name}`}
                      checked={isSel && !excluded}
                      disabled={excluded}
                      onChange={() => onToggle(id)}
                      className="mt-1 accent-indigo-600 disabled:cursor-not-allowed"
                    />
                  </Td>
                  <Td className="min-w-[14rem]">
                    <div className="flex items-center gap-1"><DepLink d={d} />{d.lock && <span title={`Locked by rollout: ${d.lock.rollout.title}`}><Lock className="size-3 text-slate-400" /></span>}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <EnvTag tier={d.target.environment.tier} name={d.target.environment.name} />
                      <HealthBadge value={d.health} />
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">{d.target.region.name} · {d.target.hardware.name}</div>
                  </Td>
                  <Td className="min-w-[20rem]">
                    <SpecChange
                      from={d.desired}
                      fromLabel="unmanaged"
                      to={{ model_version: r.new_model_version, engine_version: r.new_engine_version, image: r.new_image }}
                    />
                  </Td>
                  <Td>
                    <OutcomeBadge value={outcome} />
                    {outcome === "blocked" && (
                      <div className="mt-1 max-w-[14rem] text-xs text-red-700">
                        excluded: {blockChecks(r.guardrails.checks).map((c) => c.message.replace(/\.$/, "")).join("; ")}
                      </div>
                    )}
                    {outcome === "no_change" && <div className="mt-1 text-xs text-slate-500">excluded: already at target</div>}
                  </Td>
                  <Td className="min-w-[18rem]">
                    <GuardrailChecklist checks={r.guardrails.checks} onlyIssues={!open} />
                    <button type="button" onClick={() => toggleExpand(id)} className="mt-1 inline-flex items-center gap-0.5 text-[11px] text-slate-500 hover:text-slate-800">
                      {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                      {open ? "issues only" : `all ${r.guardrails.checks.length} checks`}
                    </button>
                    {outcome === "warn" && isSel && (
                      <div className="mt-2">
                        <Textarea
                          rows={2}
                          placeholder="Justification for accepting these warnings (required, audited)"
                          value={just}
                          onChange={(e) => onJustify(id, e.target.value)}
                          className={cx(!just.trim() && "border-amber-400 bg-amber-50/40")}
                        />
                      </div>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {missingJust.length > 0 && (
        <div className="border-t border-slate-100 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          {missingJust.length} selected deployment(s) have guardrail warnings and need a written justification before you can continue — or deselect them.
        </div>
      )}
    </Card>
  );
}
