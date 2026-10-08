import { Rocket } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  CompatCellButton, CompatEditModal, CompatLegend, LifecycleTransition, LinkButton, MatchCell, RolloutList, isNoImage, matchCounts,
  matchRank, type CompatEditTarget,
} from "../components/catalog/shared";
import { AuditList, DeploymentTable, EvLink, useCan } from "../components/domain";
import { CompatBadge, ModelLifecycleBadge } from "../components/status";
import { Card, ErrorBox, KV, Mono, PageHeader, Spinner, Stat, Table, Td, Th } from "../components/ui";
import { useApi } from "../lib/api";
import { fmtAgo, fmtTime, useNow } from "../lib/format";
import type { ModelVersionDetail } from "../lib/types";

export function ModelVersionPage() {
  const { id = "" } = useParams();
  const now = useNow();
  const { data: mv, error, isLoading } = useApi<ModelVersionDetail>(`/model-versions/${id}`);
  if (isLoading) return <Spinner />;
  if (error || !mv) return <ErrorBox error={error ?? new Error("Model version not found")} />;

  const label = `${mv.family.name} ${mv.version}`;
  const counts = matchCounts(mv.deployments);
  const rows = [...mv.deployments].sort((a, b) => matchRank(a) - matchRank(b));
  const usable = mv.compat.rows.reduce(
    (n, r) => n + Object.values(r.cells).filter((c) => c.status === "certified" || c.status === "compatible").length, 0);

  return (
    <>
      <PageHeader
        crumbs={<><Link to="/models" className="hover:underline">Models</Link> / <Link to={`/models/${mv.family.id}`} className="hover:underline">{mv.family.name}</Link> / {mv.version}</>}
        title={<span className="inline-flex items-center gap-2">{label} <ModelLifecycleBadge value={mv.lifecycle} /></span>}
        subtitle={
          <>
            Owned by <b className="font-medium text-slate-700">{mv.family.owner_team}</b>
            <span className="text-slate-400"> · </span>released <span title={fmtTime(mv.released_at)}>{fmtAgo(mv.released_at, now)}</span>
            <span className="text-slate-400"> · </span>{mv.lifecycle} since <span title={fmtTime(mv.lifecycle_changed_at)}>{fmtAgo(mv.lifecycle_changed_at, now)}</span>
          </>
        }
        actions={
          <>
            <LifecycleTransition kind="model" id={mv.id} current={mv.lifecycle} label={label} />
            <LinkButton
              to={`/rollouts/new?kind=model&mv=${mv.id}`}
              disabledReason={mv.lifecycle === "retired" ? "Retired versions cannot be rolled out" : null}
            >
              <Rocket className="size-4" /> Plan rollout to this version
            </LinkButton>
          </>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Desired on" value={counts.desired} hint="deployments whose desired state targets this version" />
        <Stat label="Observed running on" value={counts.observed} hint="per latest inventory (may be stale)" />
        <Stat
          label="Mismatched"
          value={counts.desiredOnly + counts.observedOnly}
          tone={counts.desiredOnly + counts.observedOnly ? "amber" : "green"}
          hint={`${counts.desiredOnly} desired but not running · ${counts.observedOnly} running but not desired`}
        />
        <Stat label="Usable engine × hw" value={usable} tone={usable ? undefined : "red"} hint="certified or compatible combinations" />
      </div>

      <div className="space-y-4">
        <Card title="Artifact">
          <KV items={[
            ["Artifact URI", <Mono>{mv.artifact_uri}</Mono>],
            ["Artifact digest", <Mono className="break-all">{mv.artifact_digest}</Mono>],
            ["Format", mv.format],
            ["Quantization", <Mono>{mv.quantization}</Mono>],
            ["Parameters", `${mv.params_b}B`],
            ["Context length", `${mv.context_len.toLocaleString()} tokens`],
            ...(mv.notes ? [["Notes", mv.notes] as [string, string]] : []),
          ]} />
        </Card>

        <CompatSection mv={mv} label={label} />

        <Card
          title="Deployed instances"
          subtitle={<>Desired on <b>{counts.desired}</b> deployment{counts.desired === 1 ? "" : "s"}, observed running on <b>{counts.observed}</b>. Mismatches listed first.</>}
          padded={false}
        >
          <DeploymentTable
            rows={rows}
            empty="No deployment desires or runs this version."
            extra={{ header: "This version", cell: (d) => <MatchCell d={d} kind="model" /> }}
          />
        </Card>

        <Card title="Rollouts targeting this version" padded={false}>
          <RolloutList rollouts={mv.rollouts} />
        </Card>

        <Card title="Audit">
          <AuditList entries={mv.audit} />
        </Card>
      </div>
    </>
  );
}

function CompatSection({ mv, label }: { mv: ModelVersionDetail; label: string }) {
  const canEdit = useCan("compat.edit");
  const [onlyRecords, setOnlyRecords] = useState(true);
  const [editing, setEditing] = useState<CompatEditTarget | null>(null);
  const rows = onlyRecords ? mv.compat.rows.filter((r) => r.has_records) : mv.compat.rows;
  return (
    <Card
      title="Compatibility"
      subtitle={canEdit ? "Click a cell to set or change its record." : "Read-only for your role (needs compat.edit)."}
      actions={
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={onlyRecords} onChange={(e) => setOnlyRecords(e.target.checked)} />
          Only engine versions with records
          <span className="text-slate-400">({mv.compat.rows.filter((r) => r.has_records).length}/{mv.compat.rows.length})</span>
        </label>
      }
    >
      <div className="mb-3"><CompatLegend /></div>
      {!rows.length ? (
        <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
          No compatibility records yet — every combination is <CompatBadge value="untested" />. Untick the filter to add records.
        </div>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Engine version</Th>
              {mv.compat.hardware.map((h) => <Th key={h.id}>{h.name}</Th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.engine_version.id}>
                <Td className="whitespace-nowrap"><EvLink ev={r.engine_version} /></Td>
                {mv.compat.hardware.map((h) => {
                  const c = r.cells[h.id];
                  const title = [
                    c.notes,
                    c.verified_by ? `set by ${c.verified_by.name}` : null,
                    c.evidence_url ? `evidence: ${c.evidence_url}` : null,
                    isNoImage(c.status) ? `${r.engine_version.label} ships no image for ${h.name}` : null,
                    c.status === "untested" ? "No record — not implied compatible" : null,
                  ].filter(Boolean).join("\n") || undefined;
                  return (
                    <Td key={h.id}>
                      <CompatCellButton
                        status={c.status}
                        canEdit={canEdit}
                        onEdit={() => setEditing({
                          mvId: mv.id, mvLabel: label, evId: r.engine_version.id, evLabel: r.engine_version.label, hwId: h.id, hwName: h.name,
                        })}
                      >
                        <CompatBadge value={c.status} title={title} />
                      </CompatCellButton>
                      {c.notes && <div className="mt-0.5 max-w-[12rem] truncate text-[11px] text-slate-500" title={c.notes}>{c.notes}</div>}
                    </Td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {editing && <CompatEditModal target={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}
