import { Plus } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { EvLink, MvLink, VulnLink, useCan } from "../components/domain";
import { KIND_LABEL, RolloutProgress, isActiveRollout } from "../components/rollouts/shared";
import { ApprovalBadge, RolloutBadge, WaveBadge } from "../components/status";
import { Button, Card, Empty, ErrorBox, PageHeader, Spinner, Table, Tabs, Td, Th } from "../components/ui";
import { useApi } from "../lib/api";
import { fmtAgo, fmtTime, useNow } from "../lib/format";
import type { RolloutSummary } from "../lib/types";

type Filter = "active" | "finished" | "all";

export function RolloutsPage() {
  const now = useNow();
  const navigate = useNavigate();
  const canCreate = useCan("rollout.create");
  const [filter, setFilter] = useState<Filter>("active");
  const { data, error, isLoading } = useApi<RolloutSummary[]>("/rollouts", { refetchInterval: 5000 });

  const all = [...(data ?? [])].sort((a, b) => b.updated_at - a.updated_at);
  const active = all.filter((r) => isActiveRollout(r.status));
  const finished = all.filter((r) => !isActiveRollout(r.status));
  const rows = filter === "active" ? active : filter === "finished" ? finished : all;
  const attention = active.filter((r) => r.status === "paused" || r.approval_status === "pending").length;

  return (
    <>
      <PageHeader
        title="Rollouts"
        subtitle="Staged changes of model and/or engine versions. A target only succeeds on fresh inventory evidence plus a healthy bake window — never on the deployer's word alone."
        actions={
          <Button
            variant="primary"
            disabled={!canCreate}
            title={canCreate ? undefined : "Your role lacks permission: rollout.create"}
            onClick={() => navigate("/rollouts/new")}
          >
            <Plus className="size-4" /> New rollout
          </Button>
        }
      />
      <Tabs<Filter>
        value={filter}
        onChange={setFilter}
        tabs={[
          { id: "active", label: <>Active <Count n={active.length} />{attention > 0 && <span className="ml-1 text-xs text-amber-600">({attention} need attention)</span>}</> },
          { id: "finished", label: <>Finished <Count n={finished.length} /></> },
          { id: "all", label: <>All <Count n={all.length} /></> },
        ]}
      />
      <Card padded={false}>
        {isLoading ? <Spinner /> : <ErrorBox error={error} />}
        {data && !rows.length && (
          <div className="p-4">
            <Empty>{filter === "active" ? "No active rollouts." : "No rollouts here yet."}</Empty>
          </div>
        )}
        {rows.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Rollout</Th><Th>Target version</Th><Th>Status</Th><Th>Current wave</Th><Th>Progress</Th>
                <Th>Requested by</Th><Th>Vulnerability</Th><Th>Updated</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50/60">
                  <Td className="min-w-[14rem]">
                    <Link to={`/rollouts/${r.id}`} className="font-medium text-indigo-700 hover:text-indigo-900 hover:underline">{r.title}</Link>
                    <div className="mt-0.5 text-xs text-slate-500">{KIND_LABEL[r.kind]} · {r.wave_count} wave{r.wave_count === 1 ? "" : "s"}</div>
                    {r.status === "paused" && r.pause_reason && (
                      <div className="mt-1 line-clamp-2 max-w-sm text-xs text-amber-700" title={r.pause_reason}>{r.pause_reason}</div>
                    )}
                  </Td>
                  <Td className="text-xs">
                    {r.target_model_version && <div><MvLink mv={r.target_model_version} /></div>}
                    {r.target_engine_version && <div><EvLink ev={r.target_engine_version} /></div>}
                  </Td>
                  <Td>
                    <div className="flex flex-col items-start gap-1">
                      <RolloutBadge value={r.status} />
                      {r.approval_status !== "not_required" && <ApprovalBadge value={r.approval_status} />}
                    </div>
                  </Td>
                  <Td className="text-xs">
                    {r.current_wave && isActiveRollout(r.status) ? (
                      <div className="flex flex-col items-start gap-1">
                        <span className="text-slate-700">{r.current_wave.idx + 1}/{r.wave_count} · {r.current_wave.name}</span>
                        <WaveBadge value={r.current_wave.status} />
                      </div>
                    ) : <span className="text-slate-400">—</span>}
                  </Td>
                  <Td><RolloutProgress counts={r.target_counts} total={r.target_total} /></Td>
                  <Td className="whitespace-nowrap">
                    {r.requested_by.name}
                    <div className="text-xs text-slate-400">{r.requested_by.role}</div>
                  </Td>
                  <Td>{r.linked_vulnerability ? <VulnLink v={r.linked_vulnerability} /> : <span className="text-slate-400">—</span>}</Td>
                  <Td className="whitespace-nowrap text-xs text-slate-500"><span title={fmtTime(r.updated_at)}>{fmtAgo(r.updated_at, now)}</span></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}

function Count({ n }: { n: number }) {
  return <span className="ml-1 rounded-full bg-slate-100 px-1.5 text-xs text-slate-600">{n}</span>;
}
