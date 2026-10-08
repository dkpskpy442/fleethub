import { ExternalLink, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DIGEST_RE, PermButton } from "../components/catalog/shared";
import { EngineLifecycleBadge, SeverityBadge } from "../components/status";
import { Button, Card, Empty, ErrorBox, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Textarea, Th, cx } from "../components/ui";
import { useAction, useApi } from "../lib/api";
import { fmtAgo, fmtTime, useNow } from "../lib/format";
import type { EngineSummary, Meta } from "../lib/types";

export function EnginesPage() {
  const now = useNow();
  const { data, error, isLoading } = useApi<EngineSummary[]>("/engines");
  const [registering, setRegistering] = useState<EngineSummary | null>(null);
  return (
    <>
      <PageHeader
        title="Inference engines"
        subtitle="Serving runtimes, their versions and container images. Vulnerability status is the worst open finding across a version's images."
        actions={<Link to="/compatibility" className="text-sm text-indigo-700 hover:underline">Compatibility matrix →</Link>}
      />
      {isLoading ? <Spinner /> : <ErrorBox error={error} />}
      {data && !data.length && <Empty>No engines registered.</Empty>}
      <div className="space-y-4">
        {data?.map((e) => (
          <Card
            key={e.id}
            padded={false}
            title={<span>{e.name} <span className="font-normal text-slate-400">· {e.owner_team}</span></span>}
            subtitle={e.description}
            actions={
              <>
                {e.repo_url && (
                  <a href={e.repo_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-indigo-700 hover:underline">
                    repo <ExternalLink className="size-3" />
                  </a>
                )}
                <Link to={`/compatibility?engine=${e.id}`} className="text-xs text-indigo-700 hover:underline">compatibility</Link>
                <PermButton perm="engine.edit" size="sm" onClick={() => setRegistering(e)}><Plus className="size-3.5" /> Register version</PermButton>
              </>
            }
          >
            {!e.versions.length ? <div className="p-4"><Empty>No versions yet.</Empty></div> : (
              <Table>
                <thead><tr><Th>Version</Th><Th>Lifecycle</Th><Th>Released</Th><Th>Worst open vuln</Th><Th>Observed / desired</Th></tr></thead>
                <tbody>
                  {e.versions.map((v) => (
                    <tr key={v.id} className="hover:bg-slate-50/60">
                      <Td><Link to={`/engine-versions/${v.id}`} className="font-medium text-indigo-700 hover:underline">{v.version}</Link></Td>
                      <Td><EngineLifecycleBadge value={v.lifecycle} /></Td>
                      <Td className="whitespace-nowrap text-xs text-slate-500"><span title={fmtTime(v.released_at)}>{fmtAgo(v.released_at, now)}</span></Td>
                      <Td>{v.worst_vuln ? <SeverityBadge value={v.worst_vuln} /> : <span className="text-xs text-slate-400">none</span>}</Td>
                      <Td className={cx("tabular-nums", v.observed_count !== v.desired_count && "font-medium text-orange-700")}>
                        {v.observed_count} / {v.desired_count}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        ))}
      </div>
      {registering && <RegisterEngineVersion engine={registering} onClose={() => setRegistering(null)} />}
    </>
  );
}

interface ImageForm { repo: string; tag: string; digest: string; accelerator: "cuda" | "rocm"; hardware_type_ids: string[] }

function RegisterEngineVersion({ engine, onClose }: { engine: EngineSummary; onClose: () => void }) {
  const navigate = useNavigate();
  const { data: meta } = useApi<Meta>("/meta");
  const hardware = meta?.hardware ?? [];
  const hwFor = (acc: string) => hardware.filter((h) => h.accelerator === acc).map((h) => h.id);
  const blank = (acc: "cuda" | "rocm" = "cuda"): ImageForm => ({
    repo: `registry.example.test/inference/${engine.slug}`, tag: "", digest: "", accelerator: acc, hardware_type_ids: hwFor(acc),
  });
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState("");
  const [images, setImages] = useState<ImageForm[]>(() => [blank()]);
  const patch = (i: number, p: Partial<ImageForm>) => setImages((xs) => xs.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const act = useAction<unknown, { id: string }>("POST", {
    success: `Registered ${engine.name} ${version} (preview)`,
    onSuccess: (r) => { onClose(); navigate(`/engine-versions/${r.id}`); },
  });
  const imgOk = (x: ImageForm) => x.repo.trim() && x.tag.trim() && DIGEST_RE.test(x.digest.trim()) && x.hardware_type_ids.length > 0;
  const valid = version.trim() && images.length > 0 && images.every(imgOk);
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={`Register ${engine.name} version`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={act.isPending}
            disabled={!valid}
            onClick={() => act.mutate({
              path: `/engines/${engine.id}/versions`,
              body: {
                version: version.trim(), release_notes: notes.trim() || null,
                images: images.map((x) => ({ ...x, repo: x.repo.trim(), tag: x.tag.trim(), digest: x.digest.trim() })),
              },
            })}
          >
            Register
          </Button>
        </>
      }
    >
      <p className="text-slate-600">
        New versions start as <EngineLifecycleBadge value="preview" />. The vulnerability scanner picks up the new images on its next cycle;
        until then their scan status is unknown.
      </p>
      <Field label="Version *"><Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="e.g. 0.11.0" autoFocus /></Field>
      <Field label="Release notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-700">Container images *</span>
          <Button size="sm" variant="ghost" onClick={() => setImages((xs) => [...xs, blank(xs.some((x) => x.accelerator === "cuda") ? "rocm" : "cuda")])}>
            <Plus className="size-3.5" /> Add image
          </Button>
        </div>
        {images.map((x, i) => {
          const badDigest = x.digest.trim() !== "" && !DIGEST_RE.test(x.digest.trim());
          return (
            <div key={i} className="space-y-2 rounded-lg border border-slate-200 p-3">
              <div className="flex items-center justify-between text-xs font-medium text-slate-500">
                Image {i + 1}
                {images.length > 1 && (
                  <button className="text-slate-400 hover:text-red-600" onClick={() => setImages((xs) => xs.filter((_, j) => j !== i))} aria-label="Remove image">
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-[2fr_1fr_8rem]">
                <Field label="Repository"><Input value={x.repo} onChange={(e) => patch(i, { repo: e.target.value })} /></Field>
                <Field label="Tag"><Input value={x.tag} onChange={(e) => patch(i, { tag: e.target.value })} placeholder="0.11.0-cu124" /></Field>
                <Field label="Accelerator">
                  <Select
                    value={x.accelerator}
                    onChange={(e) => { const acc = e.target.value as "cuda" | "rocm"; patch(i, { accelerator: acc, hardware_type_ids: hwFor(acc) }); }}
                    options={[{ value: "cuda", label: "cuda" }, { value: "rocm", label: "rocm" }]}
                  />
                </Field>
              </div>
              <Field label="Digest" hint={badDigest ? <span className="text-red-600">Must be sha256: followed by 64 lowercase hex characters.</span> : undefined}>
                <Input value={x.digest} onChange={(e) => patch(i, { digest: e.target.value })} placeholder="sha256:…" className="mono text-xs" />
              </Field>
              <div>
                <span className="mb-1 block text-xs font-medium text-slate-700">Supported hardware</span>
                <div className="flex flex-wrap gap-3">
                  {hardware.map((h) => {
                    const on = x.hardware_type_ids.includes(h.id);
                    return (
                      <label key={h.id} className={cx("flex items-center gap-1.5 text-xs", h.accelerator !== x.accelerator && "text-slate-400")}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => patch(i, { hardware_type_ids: on ? x.hardware_type_ids.filter((y) => y !== h.id) : [...x.hardware_type_ids, h.id] })}
                        />
                        {h.name} <span className="text-slate-400">({h.accelerator})</span>
                      </label>
                    );
                  })}
                </div>
                {!x.hardware_type_ids.length && <span className="mt-1 block text-xs text-red-600">Select at least one hardware type.</span>}
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
