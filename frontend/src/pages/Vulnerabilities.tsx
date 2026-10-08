import { useState } from "react";
import { EvLink, RolloutLink, VulnLink } from "../components/domain";
import { FindingBadge, Pill, RolloutBadge, SeverityBadge } from "../components/status";
import { Card, Empty, ErrorBox, PageHeader, Spinner, Table, Td, Th, cx } from "../components/ui";
import { useApi } from "../lib/api";
import { fmtAgo, fmtTime, useNow } from "../lib/format";
import type { FindingStatus, VulnSummary } from "../lib/types";

const FINDING_ORDER: FindingStatus[] = ["open", "in_progress", "risk_accepted", "remediated", "false_positive"];

export function VulnerabilitiesPage() {
  const now = useNow();
  const [activeOnly, setActiveOnly] = useState(true);
  const { data, error, isLoading } = useApi<VulnSummary[]>("/vulnerabilities", { refetchInterval: 5000 });
  const rows = (data ?? []).filter((v) => !activeOnly || v.active);
  const inactive = (data ?? []).filter((v) => !v.active).length;

  return (
    <>
      <PageHeader
        title="Vulnerabilities"
        subtitle="Scanner findings on engine images, mapped to the deployments that run them (observed) or are meant to (desired)."
      />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 p-3 text-sm">
          <label className="flex items-center gap-1.5 text-slate-700">
            <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} className="size-4 rounded border-slate-300" />
            Active only
          </label>
          <span className="text-xs text-slate-500">
            {activeOnly && inactive > 0 ? `${inactive} fully remediated / dismissed hidden` : "Active = at least one finding open, in progress or risk-accepted"}
          </span>
          <span className="ml-auto text-xs text-slate-500">{rows.length} vulnerabilities</span>
        </div>
        {isLoading ? <Spinner /> : error ? <div className="p-3"><ErrorBox error={error} /></div> : !rows.length ? (
          <div className="p-4"><Empty>No {activeOnly ? "active " : ""}vulnerabilities.</Empty></div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Severity</Th><Th>ID</Th><Th>Title / package</Th><Th>Affected engine versions</Th><Th>Findings</Th>
                <Th>Exposure</Th><Th>Rollouts</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.id} className={cx("hover:bg-slate-50/60", !v.active && "opacity-60")}>
                  <Td className="whitespace-nowrap">
                    <SeverityBadge value={v.severity} />
                    <div className="mt-0.5 text-xs tabular-nums text-slate-500">CVSS {v.cvss.toFixed(1)}</div>
                  </Td>
                  <Td className="whitespace-nowrap">
                    <VulnLink v={{ id: v.id, external_id: v.external_id }} />
                    <div className="text-[11px] text-slate-400" title={fmtTime(v.published_at)}>published {fmtAgo(v.published_at, now)}</div>
                  </Td>
                  <Td className="min-w-[16rem] max-w-md">
                    <div className="font-medium text-slate-900">{v.title}</div>
                    <div className="text-xs text-slate-500">{v.package}{v.fixed_in_note && <> · {v.fixed_in_note}</>}</div>
                  </Td>
                  <Td><div className="flex flex-col gap-0.5">{v.engine_versions.map((ev) => <EvLink key={ev.id} ev={ev} />)}</div></Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {FINDING_ORDER.filter((s) => v.finding_statuses[s]).map((s) => (
                        <span key={s} className="inline-flex items-center gap-0.5"><FindingBadge value={s} /><span className="text-xs tabular-nums text-slate-600">×{v.finding_statuses[s]}</span></span>
                      ))}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap text-xs">
                    <div className="flex flex-col items-start gap-1">
                      <span title="Deployments where inventory reports an affected image (prod in brackets)">
                        <span className={cx("font-semibold tabular-nums", v.exposure.observed ? "text-red-700" : "text-slate-500")}>{v.exposure.observed}</span> running
                        <span className="text-slate-500"> ({v.exposure.prod_observed} prod)</span>
                      </span>
                      <span title="Deployments whose desired revision specifies an affected image">
                        <span className="font-semibold tabular-nums">{v.exposure.desired}</span> intended
                      </span>
                      {v.exposure.unverifiable > 0 && (
                        <Pill tone="unknown" title="Exposed deployments without fresh inventory data - actual exposure unknown">{v.exposure.unverifiable} unverifiable</Pill>
                      )}
                    </div>
                  </Td>
                  <Td>
                    {v.rollouts.length ? (
                      <div className="flex flex-col gap-1">
                        {v.rollouts.map((r) => <span key={r.id} className="flex flex-wrap items-center gap-1 text-xs"><RolloutLink r={r} /><RolloutBadge value={r.status} /></span>)}
                      </div>
                    ) : <span className="text-xs text-slate-400">none</span>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
