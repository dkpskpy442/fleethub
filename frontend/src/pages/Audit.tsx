import { useState } from "react";
import { Link } from "react-router-dom";
import { useMe } from "../components/domain";
import { Card, ErrorBox, Input, Mono, PageHeader, Select, Spinner, Table, Td, Th } from "../components/ui";
import { useApi } from "../lib/api";
import { fmtAgo, fmtTime, useNow } from "../lib/format";
import type { AuditEntry } from "../lib/types";

const ENTITY_LINK: Record<string, (id: string) => string> = {
  deployment: (id) => `/fleet/deployments/${id}`,
  rollout: (id) => `/rollouts/${id}`,
  vulnerability: (id) => `/vulnerabilities/${id}`,
  model_version: (id) => `/model-versions/${id}`,
  engine_version: (id) => `/engine-versions/${id}`,
  deployment_target: (id) => `/fleet/targets/${id}`,
};

export function AuditPage() {
  const now = useNow();
  const { data: me } = useMe();
  const [entity, setEntity] = useState("");
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const qs = new URLSearchParams({ limit: "300" });
  if (entity) qs.set("entity_type", entity);
  if (actor) qs.set("actor_id", actor);
  if (action) qs.set("action", action);
  const { data, error, isLoading } = useApi<AuditEntry[]>(`/audit?${qs}`);
  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Every change made through FleetHub (and every system-detected transition) with actor, role, reason and before/after."
      />
      <Card padded={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <Select value={entity} onChange={(e) => setEntity(e.target.value)} className="w-48"
            options={[{ value: "", label: "All entities" }, ...Object.keys(ENTITY_LINK).map((k) => ({ value: k, label: k.replace("_", " ") })), { value: "simulation", label: "simulation" }, { value: "data_source", label: "data source" }]} />
          <Select value={actor} onChange={(e) => setActor(e.target.value)} className="w-56"
            options={[{ value: "", label: "All actors" }, { value: "system", label: "FleetHub (system)" }, ...(me?.personas ?? []).map((p) => ({ value: p.id, label: `${p.name} (${p.role})` }))]} />
          <Input placeholder="Action prefix, e.g. rollout." value={action} onChange={(e) => setAction(e.target.value)} className="w-64" />
        </div>
        {isLoading ? <Spinner /> : <ErrorBox error={error} />}
        {data && (
          <Table>
            <thead><tr><Th>When</Th><Th>Actor</Th><Th>Action</Th><Th>Entity</Th><Th>Summary</Th><Th>Reason</Th></tr></thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <Td className="whitespace-nowrap text-xs text-slate-500"><span title={fmtTime(a.at)}>{fmtAgo(a.at, now)}</span></Td>
                  <Td className="whitespace-nowrap">{a.actor.name}<div className="text-xs text-slate-400">{a.actor_role}</div></Td>
                  <Td><Mono>{a.action}</Mono></Td>
                  <Td className="whitespace-nowrap text-xs">
                    {ENTITY_LINK[a.entity_type] ? <Link className="text-indigo-700 hover:underline" to={ENTITY_LINK[a.entity_type](a.entity_id)}>{a.entity_type.replace("_", " ")}</Link> : a.entity_type}
                  </Td>
                  <Td className="max-w-xl">{a.summary}</Td>
                  <Td className="max-w-xs text-xs text-slate-600">{a.reason}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
