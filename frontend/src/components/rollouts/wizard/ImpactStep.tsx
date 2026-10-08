import { AlertTriangle, ShieldCheck } from "lucide-react";
import type { ApiError } from "../../../lib/api";
import { useApi } from "../../../lib/api";
import type { RolloutPreview, VulnDetail, VulnSummary } from "../../../lib/types";
import { DepLink, EnvTag, VulnLink } from "../../domain";
import { CheckLevelIcon, OutcomeBadge } from "../../status";
import { Card, Empty, ErrorBox, Mono, Spinner, Stat, Table, Td, Th } from "../../ui";
import { BarList } from "../shared";
import { blockChecks, warnChecks } from "./common";

/** Problems with the current selection according to the fresh preview (things can change between steps). */
export function impactProblems(p: RolloutPreview | undefined, justifications: Record<string, string>): string[] {
  if (!p) return [];
  const out: string[] = [];
  for (const t of p.targets) {
    const label = `${t.deployment.service_name} @ ${t.deployment.target.name}`;
    if (t.guardrails.outcome === "blocked") out.push(`${label} is now blocked: ${blockChecks(t.guardrails.checks).map((c) => c.message).join(" ")}`);
    if (t.guardrails.outcome === "warn" && !justifications[t.deployment.id]?.trim()) out.push(`${label} now has warnings that need a justification (go back to Targets).`);
  }
  return out;
}

export function ImpactStep({ preview, loading, error, justifications, vuln }: {
  preview: RolloutPreview | undefined; loading: boolean; error: ApiError | null;
  justifications: Record<string, string>; vuln?: VulnDetail;
}) {
  const { data: vulns } = useApi<VulnSummary[]>("/vulnerabilities");
  if (loading) return <Card><Spinner label="Computing impact of the selection…" /></Card>;
  if (error) return <ErrorBox error={error} />;
  if (!preview) return null;
  const im = preview.impact;
  const byExt = new Map((vulns ?? []).map((v) => [v.external_id, v]));
  const warned = preview.targets.filter((t) => t.guardrails.outcome === "warn");
  const problems = impactProblems(preview, justifications);
  const resolved = Object.entries(im.vulns_resolved).sort((a, b) => b[1] - a[1]);
  const linkedResolved = vuln ? im.vulns_resolved[vuln.external_id] : undefined;

  return (
    <div className="space-y-4">
      {problems.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <div className="mb-1 font-medium">The fleet changed since you selected targets:</div>
          <ul className="list-disc space-y-0.5 pl-5 text-xs">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </div>
      )}
      {vuln && (
        linkedResolved ? (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            <ShieldCheck className="size-4" /> Resolves {vuln.external_id} on {linkedResolved} deployment(s) in this selection.
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <AlertTriangle className="size-4" /> This selection does not resolve the linked vulnerability {vuln.external_id} on any deployment.
          </div>
        )
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Deployments" value={im.deployments} />
        <Stat label="Replicas" value={im.replicas} hint="desired replicas that will be replaced" />
        <Stat label="Prod deployments" value={im.prod} tone={im.prod ? "amber" : "gray"} hint={im.prod ? "prod waves need release approval" : "no approval required"} />
        <Stat label="Warnings accepted" value={warned.length} tone={warned.length ? "amber" : "gray"} hint="each with an audited justification" />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="By environment"><BarList data={im.by_environment} /></Card>
        <Card title="By region"><BarList data={im.by_region} tone="bg-sky-400" /></Card>
        <Card title="Vulnerabilities resolved" subtitle="Active findings on the current image that the new image doesn't have">
          {!resolved.length ? <span className="text-xs text-slate-500">None — this change does not remove any known finding.</span> : (
            <ul className="space-y-1.5 text-sm">
              {resolved.map(([ext, n]) => {
                const v = byExt.get(ext);
                return (
                  <li key={ext} className="flex items-center justify-between gap-2">
                    {v ? <VulnLink v={v} /> : <Mono>{ext}</Mono>}
                    <span className="text-xs text-slate-500">on {n} deployment{n === 1 ? "" : "s"}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
      <Card title="Guardrail outcomes" subtitle="For the selected deployments, re-evaluated just now">
        <div className="flex flex-wrap gap-3">
          {Object.entries(im.outcomes).map(([k, n]) => (
            <span key={k} className="inline-flex items-center gap-1.5 text-sm">
              <OutcomeBadge value={k as "ok" | "warn" | "blocked" | "no_change"} /> <span className="tabular-nums">{n}</span>
            </span>
          ))}
        </div>
      </Card>
      <Card title="Warnings being accepted" subtitle="Recorded in the audit log with your justification when the rollout is created" padded={false}>
        {!warned.length ? <div className="p-4"><Empty>No warnings — every selected deployment passed all guardrails.</Empty></div> : (
          <Table>
            <thead><tr><Th>Deployment</Th><Th>Warnings</Th><Th>Justification</Th></tr></thead>
            <tbody>
              {warned.map((t) => (
                <tr key={t.deployment.id}>
                  <Td className="whitespace-nowrap">
                    <DepLink d={t.deployment} />
                    <div className="mt-0.5"><EnvTag tier={t.deployment.target.environment.tier} name={t.deployment.target.environment.name} /></div>
                  </Td>
                  <Td>
                    <ul className="space-y-1">
                      {warnChecks(t.guardrails.checks).map((c) => (
                        <li key={c.code} className="flex items-start gap-1.5 text-xs text-amber-800"><CheckLevelIcon level="warn" />{c.message}</li>
                      ))}
                    </ul>
                  </Td>
                  <Td className="max-w-md text-xs">
                    {justifications[t.deployment.id]?.trim()
                      ? <span className="text-slate-700">“{justifications[t.deployment.id]}”</span>
                      : <span className="font-medium text-red-600">missing</span>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
