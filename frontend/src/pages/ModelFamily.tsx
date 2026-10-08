import { Plus } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { DIGEST_RE, LinkButton, PermButton } from "../components/catalog/shared";
import { CompatBadge, ModelLifecycleBadge } from "../components/status";
import { Button, Card, ErrorBox, Field, Input, Modal, Mono, PageHeader, Spinner, Table, Td, Textarea, Th } from "../components/ui";
import { useAction, useApi } from "../lib/api";
import { fmtAgo, fmtTime, useNow } from "../lib/format";
import type { CompatStatus, ModelFamilyDetail } from "../lib/types";

const COMPAT_ORDER: CompatStatus[] = ["certified", "compatible", "known_issues", "incompatible"];

export function ModelFamilyPage() {
  const { familyId = "" } = useParams();
  const now = useNow();
  const { data: f, error, isLoading } = useApi<ModelFamilyDetail>(`/models/${familyId}`);
  const [registering, setRegistering] = useState(false);
  if (isLoading) return <Spinner />;
  if (error || !f) return <ErrorBox error={error ?? new Error("Model family not found")} />;
  return (
    <>
      <PageHeader
        crumbs={<><Link to="/models" className="hover:underline">Models</Link> / {f.name}</>}
        title={f.name}
        subtitle={<>{f.description} <span className="text-slate-400">·</span> {f.modality} <span className="text-slate-400">·</span> owned by <b className="font-medium text-slate-700">{f.owner_team}</b></>}
        actions={
          <>
            <LinkButton to={`/compatibility?family=${f.id}`} variant="secondary">Compatibility matrix</LinkButton>
            <PermButton perm="model.edit" variant="primary" onClick={() => setRegistering(true)}>
              <Plus className="size-4" /> Register version
            </PermButton>
          </>
        }
      />
      <Card title="Versions" subtitle="Desired = deployments whose desired state targets the version; observed = inventory reports it running." padded={false}>
        <Table>
          <thead>
            <tr>
              <Th>Version</Th><Th>Lifecycle</Th><Th>Quant.</Th><Th>Params</Th><Th>Context</Th><Th>Released</Th>
              <Th>Desired</Th><Th>Observed</Th><Th>Compatibility records</Th>
            </tr>
          </thead>
          <tbody>
            {f.versions.map((v) => (
              <tr key={v.id} className="hover:bg-slate-50/60">
                <Td>
                  <Link to={`/model-versions/${v.id}`} className="font-medium text-indigo-700 hover:underline">{v.version}</Link>
                  <div><Mono className="text-slate-400" title={v.artifact_digest}>{v.format}</Mono></div>
                </Td>
                <Td>
                  <ModelLifecycleBadge value={v.lifecycle} />
                  <div className="mt-0.5 text-[11px] text-slate-400" title={fmtTime(v.lifecycle_changed_at)}>since {fmtAgo(v.lifecycle_changed_at, now)}</div>
                </Td>
                <Td><Mono>{v.quantization}</Mono></Td>
                <Td className="tabular-nums">{v.params_b}B</Td>
                <Td className="tabular-nums">{v.context_len.toLocaleString()}</Td>
                <Td className="whitespace-nowrap text-xs text-slate-500"><span title={fmtTime(v.released_at)}>{fmtAgo(v.released_at, now)}</span></Td>
                <Td className="tabular-nums">{v.desired_count}</Td>
                <Td className={v.observed_count !== v.desired_count ? "font-medium tabular-nums text-orange-700" : "tabular-nums"}>
                  <span title={v.observed_count !== v.desired_count ? "Observed differs from desired — open the version to see which deployments" : undefined}>
                    {v.observed_count}
                  </span>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {COMPAT_ORDER.filter((s) => v.compat_counts[s]).map((s) => (
                      <span key={s} className="inline-flex items-center gap-0.5">
                        <CompatBadge value={s} /><span className="text-xs tabular-nums text-slate-500">×{v.compat_counts[s]}</span>
                      </span>
                    ))}
                    {!COMPAT_ORDER.some((s) => v.compat_counts[s]) && <CompatBadge value="untested" title="No compatibility records yet" />}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      {registering && <RegisterModelVersion familyId={f.id} familyName={f.name} onClose={() => setRegistering(false)} />}
    </>
  );
}

function RegisterModelVersion({ familyId, familyName, onClose }: { familyId: string; familyName: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    version: "", artifact_uri: "", artifact_digest: "", format: "safetensors", quantization: "bf16", params_b: "", context_len: "", notes: "",
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((s) => ({ ...s, [k]: e.target.value }));
  const act = useAction<unknown, { id: string }>("POST", {
    success: `Registered ${familyName} ${form.version} (experimental)`,
    onSuccess: (r) => { onClose(); navigate(`/model-versions/${r.id}`); },
  });
  const digestOk = DIGEST_RE.test(form.artifact_digest.trim());
  const valid = form.version.trim() && form.artifact_uri.trim() && digestOk;
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={`Register ${familyName} version`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={act.isPending}
            disabled={!valid}
            onClick={() => act.mutate({
              path: `/models/${familyId}/versions`,
              body: {
                version: form.version.trim(), artifact_uri: form.artifact_uri.trim(), artifact_digest: form.artifact_digest.trim(),
                format: form.format.trim() || null, quantization: form.quantization.trim() || null,
                params_b: form.params_b ? Number(form.params_b) : null, context_len: form.context_len ? Number(form.context_len) : null,
                notes: form.notes.trim() || null,
              },
            })}
          >
            Register
          </Button>
        </>
      }
    >
      <p className="text-slate-600">New versions start as <ModelLifecycleBadge value="experimental" /> with no compatibility records (everything untested).</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Version *"><Input value={form.version} onChange={set("version")} placeholder="e.g. 2.3" autoFocus /></Field>
        <Field label="Format"><Input value={form.format} onChange={set("format")} /></Field>
      </div>
      <Field label="Artifact URI *"><Input value={form.artifact_uri} onChange={set("artifact_uri")} placeholder="s3://model-registry/…/" /></Field>
      <Field
        label="Artifact digest *"
        hint={form.artifact_digest && !digestOk ? <span className="text-red-600">Must be sha256: followed by 64 lowercase hex characters.</span> : "sha256:<64 hex> of the weights manifest"}
      >
        <Input value={form.artifact_digest} onChange={set("artifact_digest")} placeholder="sha256:…" className="mono text-xs" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Quantization"><Input value={form.quantization} onChange={set("quantization")} /></Field>
        <Field label="Params (B)"><Input type="number" min={0} step="0.1" value={form.params_b} onChange={set("params_b")} /></Field>
        <Field label="Context length"><Input type="number" min={0} value={form.context_len} onChange={set("context_len")} placeholder="8192" /></Field>
      </div>
      <Field label="Notes"><Textarea value={form.notes} onChange={set("notes")} /></Field>
    </Modal>
  );
}
