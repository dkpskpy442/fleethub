import { AlertTriangle, Rocket } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { LifecycleTransition, LinkButton, MatchCell, RolloutList, matchCounts, matchRank } from "../components/catalog/shared";
import { AuditList, DeploymentTable, EvLink, MvLink, VulnLink } from "../components/domain";
import { CompatBadge, EngineLifecycleBadge, FindingBadge, SeverityBadge } from "../components/status";
import { Card, Empty, ErrorBox, Mono, PageHeader, Spinner, Stat, Table, Td, Th } from "../components/ui";
import { useApi } from "../lib/api";
import { fmtAgo, fmtTime, shortDigest, useNow } from "../lib/format";
import type { CompatStatus, EngineVersionDetail, Severity } from "../lib/types";

const SEV_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const ACTIVE = new Set(["open", "in_progress"]);

export function EngineVersionPage() {
  const { id = "" } = useParams();
  const now = useNow();
  const { data: ev, error, isLoading } = useApi<EngineVersionDetail>(`/engine-versions/${id}`);
  if (isLoading) return <Spinner />;
  if (error || !ev) return <ErrorBox error={error ?? new Error("Engine version not found")} />;

  const label = `${ev.engine.name} ${ev.version}`;
  const counts = matchCounts(ev.deployments);
  const rows = [...ev.deployments].sort((a, b) => matchRank(a) - matchRank(b));
  const activeVulns = ev.images.flatMap((i) => i.vulns).filter((v) => ACTIVE.has(v.status));
  const worst = activeVulns.map((v) => v.severity).sort((a, b) => SEV_RANK[a] - SEV_RANK[b])[0];
  const imageHw = new Set(ev.images.flatMap((i) => i.hardware));
  const hwCols = [...new Set([...imageHw, ...ev.compat.flatMap((c) => c.records.map((r) => r.hardware))])].sort();

  return (
    <>
      <PageHeader
        crumbs={<><Link to="/engines" className="hover:underline">Engines</Link> / {ev.engine.name} / {ev.version}</>}
        title={<span className="inline-flex items-center gap-2">{label} <EngineLifecycleBadge value={ev.lifecycle} /></span>}
        subtitle={
          <>
            Released <span title={fmtTime(ev.released_at)}>{fmtAgo(ev.released_at, now)}</span>
            <span className="text-slate-400"> · </span>{ev.lifecycle} since <span title={fmtTime(ev.lifecycle_changed_at)}>{fmtAgo(ev.lifecycle_changed_at, now)}</span>
            {ev.engine.repo_url && <><span className="text-slate-400"> · </span><a href={ev.engine.repo_url} target="_blank" rel="noreferrer" className="text-indigo-700 hover:underline">repo</a></>}
          </>
        }
        actions={
          <>
            <LifecycleTransition kind="engine" id={ev.id} current={ev.lifecycle} label={label} />
            <LinkButton
              to={`/rollouts/new?kind=engine&ev=${ev.id}`}
              disabledReason={ev.lifecycle === "eol" ? "End-of-life versions cannot be rolled out" : null}
            >
              <Rocket className="size-4" /> Roll out this version
            </LinkButton>
          </>
        }
      />

      {worst && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-orange-200 bg-orange-50 p-3 text-sm text-orange-900">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            This version has {activeVulns.length} open finding{activeVulns.length === 1 ? "" : "s"} (worst: <b>{worst}</b>), running on {counts.observed} deployment{counts.observed === 1 ? "" : "s"}.
            {ev.newer_versions.length ? (
              <span> Newer versions: {ev.newer_versions.map((n, i) => <span key={n.id}>{i > 0 && ", "}<EvLink ev={n} />{n.worst_vuln ? <> (<SeverityBadge value={n.worst_vuln} />)</> : " (no open findings)"}</span>)}</span>
            ) : <span> No newer version exists yet.</span>}
          </div>
        </div>
      )}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Desired on" value={counts.desired} hint="deployments targeting this version" />
        <Stat label="Observed running on" value={counts.observed} hint="per latest inventory (may be stale)" />
        <Stat
          label="Mismatched"
          value={counts.desiredOnly + counts.observedOnly}
          tone={counts.desiredOnly + counts.observedOnly ? "amber" : "green"}
          hint={`${counts.desiredOnly} desired but not running · ${counts.observedOnly} running but not desired`}
        />
        <Stat label="Open findings" value={activeVulns.length} tone={activeVulns.length ? "red" : "green"} hint="open or in progress, across all images" />
      </div>

      <div className="space-y-4">
        {ev.release_notes && <Card title="Release notes"><p className="whitespace-pre-wrap text-sm text-slate-700">{ev.release_notes}</p></Card>}

        <Card title="Container images" subtitle="Exposure = deployments running (observed) or targeting (desired) the image digest." padded={false}>
          {!ev.images.length ? <div className="p-4"><Empty>No images.</Empty></div> : (
            <Table>
              <thead><tr><Th>Image</Th><Th>Accelerator</Th><Th>Hardware</Th><Th>Vulnerabilities</Th><Th>Exposure (obs / des)</Th></tr></thead>
              <tbody>
                {ev.images.map((img) => (
                  <tr key={img.id}>
                    <Td>
                      <Mono className="font-medium">{img.tag}</Mono>
                      <div><Mono className="text-slate-500" title={img.digest}>{img.repo} @ {shortDigest(img.digest)}</Mono></div>
                      <div className="text-[11px] text-slate-400" title={fmtTime(img.built_at)}>built {fmtAgo(img.built_at, now)}</div>
                    </Td>
                    <Td><Mono>{img.accelerator}</Mono></Td>
                    <Td className="text-xs">{img.hardware.join(", ") || <span className="text-slate-400">none</span>}</Td>
                    <Td className="min-w-[16rem]">
                      {!img.vulns.length ? <span className="text-xs text-slate-400">no findings</span> : (
                        <ul className="space-y-1">
                          {[...img.vulns].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]).map((v) => (
                            <li key={v.finding_id} className="flex items-center gap-1.5 whitespace-nowrap" title={v.title}>
                              <VulnLink v={{ id: v.vulnerability_id, external_id: v.external_id, severity: v.severity }} />
                              <FindingBadge value={v.status} />
                            </li>
                          ))}
                        </ul>
                      )}
                    </Td>
                    <Td className="tabular-nums">{img.exposure.observed} / {img.exposure.desired}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card
          title="Compatible models"
          subtitle={<>Model versions with compatibility records for this engine version. Missing cells: <CompatBadge value="untested" /> = no record; <CompatBadge value="unsupported_hardware" /> = this version ships no image for that hardware.</>}
          actions={<Link to={`/compatibility?engine=${ev.engine.id}`} className="text-xs text-indigo-700 hover:underline">full matrix →</Link>}
          padded={false}
        >
          {!ev.compat.length ? <div className="p-4"><Empty>No compatibility records — every model is untested on this engine version.</Empty></div> : (
            <Table>
              <thead><tr><Th>Model version</Th>{hwCols.map((h) => <Th key={h}>{h}</Th>)}</tr></thead>
              <tbody>
                {ev.compat.map((c) => (
                  <tr key={c.model_version.id}>
                    <Td className="whitespace-nowrap"><MvLink mv={c.model_version} /></Td>
                    {hwCols.map((h) => {
                      const rec = c.records.find((r) => r.hardware === h);
                      const status: CompatStatus = rec?.status ?? (imageHw.has(h) ? "untested" : "unsupported_hardware");
                      return <Td key={h}><CompatBadge value={status} title={rec?.notes ?? undefined} /></Td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card
          title="Deployments using this version"
          subtitle={<>Desired on <b>{counts.desired}</b>, observed running on <b>{counts.observed}</b>. Mismatches listed first.</>}
          padded={false}
        >
          <DeploymentTable rows={rows} empty="No deployment desires or runs this version." extra={{ header: "This version", cell: (d) => <MatchCell d={d} kind="engine" /> }} />
        </Card>

        <Card title="Newer versions" subtitle="Candidates to move to, e.g. when this version is vulnerable or deprecated.">
          {!ev.newer_versions.length ? <span className="text-sm text-slate-500">This is the newest {ev.engine.name} version.</span> : (
            <div className="flex flex-wrap gap-3">{ev.newer_versions.map((n) => (
              <span key={n.id} className="inline-flex items-center gap-1"><EvLink ev={n} />{n.worst_vuln ? <SeverityBadge value={n.worst_vuln} /> : <span className="text-xs text-emerald-700">no open findings</span>}</span>
            ))}</div>
          )}
        </Card>

        <Card title="Rollouts targeting this version" padded={false}>
          <RolloutList rollouts={ev.rollouts} />
        </Card>

        <Card title="Audit">
          <AuditList entries={ev.audit} />
        </Card>
      </div>
    </>
  );
}
