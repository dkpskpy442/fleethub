import { Link } from "react-router-dom";
import { ModelVersionChip } from "../components/catalog/shared";
import { ModelLifecycleBadge } from "../components/status";
import { Card, Empty, ErrorBox, PageHeader, Spinner, Table, Td, Th } from "../components/ui";
import { useApi } from "../lib/api";
import type { ModelFamilySummary, ModelLifecycle } from "../lib/types";

const ORDER: ModelLifecycle[] = ["production", "experimental", "deprecated", "retired"];

export function ModelsPage() {
  const { data, error, isLoading } = useApi<ModelFamilySummary[]>("/models");
  return (
    <>
      <PageHeader
        title="Models"
        subtitle="Model families and their versions. Open a family to register versions, or a version to see compatibility, lifecycle and every deployed instance."
        actions={<Link to="/compatibility" className="text-sm text-indigo-700 hover:underline">Compatibility matrix →</Link>}
      />
      <Card padded={false}>
        {isLoading ? <Spinner /> : <ErrorBox error={error} />}
        {data && !data.length && <div className="p-4"><Empty>No model families registered.</Empty></div>}
        {data && !!data.length && (
          <Table>
            <thead>
              <tr><Th>Family</Th><Th>Modality</Th><Th>Owner</Th><Th>Lifecycle</Th><Th>Deployments</Th><Th>Versions (newest first)</Th></tr>
            </thead>
            <tbody>
              {data.map((f) => (
                <tr key={f.id} className="hover:bg-slate-50/60">
                  <Td className="max-w-sm">
                    <Link to={`/models/${f.id}`} className="font-medium text-indigo-700 hover:underline">{f.name}</Link>
                    <div className="text-xs text-slate-500">{f.description}</div>
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-slate-600">{f.modality}</Td>
                  <Td className="whitespace-nowrap text-xs">{f.owner_team}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {ORDER.filter((l) => f.lifecycle_counts[l]).map((l) => (
                        <span key={l} className="inline-flex items-center gap-0.5">
                          <ModelLifecycleBadge value={l} /><span className="text-xs tabular-nums text-slate-500">×{f.lifecycle_counts[l]}</span>
                        </span>
                      ))}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap tabular-nums">
                    {f.deployment_count}
                    {f.unmanaged_count > 0 && (
                      <div className="text-xs text-indigo-700" title="Running outside FleetHub (no desired state)">{f.unmanaged_count} unmanaged</div>
                    )}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {f.versions.map((v) => <ModelVersionChip key={v.id} {...v} />)}
                    </div>
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
