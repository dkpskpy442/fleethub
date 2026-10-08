import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  CompactCompat, CompatCellButton, CompatEditModal, CompatLegend, type CompatEditTarget,
} from "../components/catalog/shared";
import { EvLink, MvLink, useCan } from "../components/domain";
import { Card, Empty, ErrorBox, PageHeader, Select, Spinner, cx } from "../components/ui";
import { useApi } from "../lib/api";
import type { CompatMatrix, EngineSummary, ModelFamilySummary } from "../lib/types";

const ALL = "__all";
const observed = (e: EngineSummary) => e.versions.reduce((n, v) => n + v.observed_count, 0);

export function CompatibilityPage() {
  const [params, setParams] = useSearchParams();
  const canEdit = useCan("compat.edit");
  const [editing, setEditing] = useState<CompatEditTarget | null>(null);
  const families = useApi<ModelFamilySummary[]>("/models");
  const engines = useApi<EngineSummary[]>("/engines");

  const familyParam = params.get("family");
  const familyId = familyParam === ALL ? "" : familyParam ?? families.data?.[0]?.id ?? "";
  // Default to the most-deployed engine: that's the matrix people usually need.
  const busiest = [...(engines.data ?? [])].sort((a, b) => observed(b) - observed(a))[0];
  const engineId = params.get("engine") ?? busiest?.id ?? "";
  const ready = families.data && engines.data && engineId;
  const qs = new URLSearchParams();
  if (familyId) qs.set("family_id", familyId);
  if (engineId) qs.set("engine_id", engineId);
  const { data: m, error, isLoading } = useApi<CompatMatrix>(ready ? `/compatibility?${qs}` : null);

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(k, v);
    setParams(next, { replace: true });
  };

  const hw = m?.hardware ?? [];
  return (
    <>
      <PageHeader
        title="Compatibility"
        subtitle="Model version × engine version × hardware. Rollouts are blocked on incompatible combinations and warn on untested ones."
      />
      <Card padded={false}>
        <div className="flex flex-wrap items-end gap-3 border-b border-slate-100 p-3">
          <label className="text-xs text-slate-600">
            <span className="mb-1 block font-medium">Model family</span>
            <Select
              className="w-56"
              value={familyParam === ALL ? ALL : familyId}
              onChange={(e) => setParam("family", e.target.value)}
              options={[...(families.data ?? []).map((f) => ({ value: f.id, label: f.name })), { value: ALL, label: "All families" }]}
            />
          </label>
          <label className="text-xs text-slate-600">
            <span className="mb-1 block font-medium">Engine</span>
            <Select
              className="w-56"
              value={engineId}
              onChange={(e) => setParam("engine", e.target.value)}
              options={(engines.data ?? []).map((e) => ({ value: e.id, label: e.name }))}
            />
          </label>
        </div>
        <div className="border-b border-slate-100 px-3 py-2"><CompatLegend compact /></div>
        <ErrorBox error={families.error ?? engines.error ?? error} />
        {(families.isLoading || engines.isLoading || isLoading) && <Spinner />}
        {m && (!m.rows.length || !m.engine_versions.length) && (
          <div className="p-4"><Empty>{!m.rows.length ? "No non-retired model versions in this family." : "This engine has no versions."}</Empty></div>
        )}
        {m && !!m.rows.length && !!m.engine_versions.length && (
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0 text-left text-sm">
              <thead>
                <tr>
                  <th rowSpan={2} className="sticky left-0 z-10 border-b border-r border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                    Model version
                  </th>
                  {m.engine_versions.map((ev) => (
                    <th key={ev.id} colSpan={hw.length} className="whitespace-nowrap border-b border-r border-slate-200 bg-slate-50 px-2 py-1.5 text-center text-xs font-medium">
                      <EvLink ev={ev} />
                    </th>
                  ))}
                </tr>
                <tr>
                  {m.engine_versions.flatMap((ev) => hw.map((h, i) => (
                    <th
                      key={`${ev.id}|${h.id}`}
                      title={h.name}
                      className={cx("whitespace-nowrap border-b border-slate-200 bg-slate-50 px-1 py-1 text-center text-[10px] font-normal text-slate-500", i === hw.length - 1 && "border-r")}
                    >
                      {h.name.split("-")[0]}
                    </th>
                  )))}
                </tr>
              </thead>
              <tbody>
                {m.rows.map((r) => (
                  <tr key={r.model_version.id} className="hover:bg-slate-50/60">
                    <td className="sticky left-0 z-10 whitespace-nowrap border-b border-r border-slate-100 bg-white px-3 py-1.5">
                      <MvLink mv={r.model_version} />
                    </td>
                    {m.engine_versions.flatMap((ev) => hw.map((h, i) => {
                      const status = r.cells[`${ev.id}|${h.id}`] ?? "n/a";
                      return (
                        <td key={`${ev.id}|${h.id}`} className={cx("border-b border-slate-100 px-1 py-1.5 text-center", i === hw.length - 1 && "border-r border-r-slate-200")}>
                          <CompatCellButton
                            status={status}
                            canEdit={canEdit}
                            onEdit={() => setEditing({
                              mvId: r.model_version.id, mvLabel: r.model_version.label, evId: ev.id, evLabel: ev.label, hwId: h.id, hwName: h.name,
                            })}
                          >
                            <CompactCompat
                              value={status}
                              title={`${r.model_version.label} × ${ev.label} on ${h.name}: ${status === "n/a" ? "no image for this hardware" : status.replace("_", " ")}`}
                            />
                          </CompatCellButton>
                        </td>
                      );
                    }))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {m && (
          <div className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
            Retired model versions are hidden. {canEdit ? "Click a cell to set its record (model owners can only edit their own team's models)." : "Read-only for your role (needs compat.edit)."}
          </div>
        )}
      </Card>
      {editing && <CompatEditModal target={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
