import { CloudOff, Cloud, Radio, RotateCcw, Wrench, Zap } from "lucide-react";
import { useState } from "react";
import { useCan, useMe } from "../components/domain";
import { FreshnessBadge, Pill, SeverityBadge } from "../components/status";
import { Button, Card, Empty, ErrorBox, Field, Input, Modal, Mono, PageHeader, Select, Spinner, Table, Td, Th } from "../components/ui";
import { useAction, useApi } from "../lib/api";
import { fmtAgo, fmtTime } from "../lib/format";
import type { DeploymentRow, EngineSummary, ModelFamilySummary, SimView } from "../lib/types";

const FAULTS = [
  { value: "phantom_success", label: "Phantom success — deployer reports success, nothing changes" },
  { value: "fail", label: "Fail — deployer reports failure" },
  { value: "unhealthy", label: "Unhealthy — applies, then fails health checks" },
  { value: "no_result", label: "No result — applies, deployer never answers" },
];

const DRIFTS = [
  { value: "image_hotfix", label: "Hotfix image pushed by hand (unregistered digest)" },
  { value: "engine_downgrade", label: "Engine changed with kubectl (older version)" },
  { value: "unhealthy", label: "Workload starts failing health checks" },
  { value: "recover", label: "Workload recovers" },
  { value: "delete", label: "Workload deleted out-of-band" },
];

export function SimulatorPage() {
  const { data, error, isLoading } = useApi<SimView>("/sim", { refetchInterval: 3000 });
  const { data: fleet } = useApi<DeploymentRow[]>("/fleet");
  const { data: me } = useMe();
  const canReset = useCan("sim.reset");
  const act = useAction("POST", { success: "Simulated event applied" });
  const del = useAction("DELETE", { success: "Fault cleared" });
  const [faultTarget, setFaultTarget] = useState("");
  const [faultKind, setFaultKind] = useState(FAULTS[0].value);
  const [driftDep, setDriftDep] = useState("");
  const [driftKind, setDriftKind] = useState(DRIFTS[0].value);
  const [speed, setSpeed] = useState<number | null>(null);
  const [manualOpen, setManualOpen] = useState(false);

  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorBox error={error} />;
  const managed = (fleet ?? []).filter((d) => d.observed?.present);

  return (
    <>
      <PageHeader
        title="Simulator"
        subtitle={<>The "outside world" FleetHub integrates with: a deployment system, inventory exporters and an image scanner — all simulated. Events here are things that happen <em>to</em> FleetHub, not actions taken in it.</>}
        actions={canReset && (
          <Button variant="danger" onClick={() => confirm("Reset all demo data to the initial seed?") && act.mutate({ path: "/sim/reset" })}>
            <RotateCcw className="size-4" /> Reset demo data
          </Button>
        )}
      />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Simulated clock" subtitle="Workers have no background jobs: time advances only when you advance it or press Play (the browser drives ticks).">
          <div className="space-y-3 text-sm">
            <div>Now: <Mono className="text-sm">{fmtTime(data.now)}</Mono> · {data.playing ? <Pill tone="blue">playing at {data.speed}×</Pill> : <Pill tone="gray">paused</Pill>}</div>
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Play speed (sim seconds per real second)">
                <Select value={String(speed ?? data.speed)} onChange={(e) => setSpeed(Number(e.target.value))}
                  options={[30, 60, 120, 300, 600].map((s) => ({ value: String(s), label: `${s}×` }))} className="w-32" />
              </Field>
              <Button variant="primary" onClick={() => act.mutate({ path: "/sim/play", body: { playing: !data.playing, speed: speed ?? data.speed } })}>
                {data.playing ? "Pause" : "Play"}
              </Button>
              {[5, 15, 60, 240].map((m) => (
                <Button key={m} onClick={() => act.mutate({ path: "/sim/advance", body: { minutes: m } })}>+{m < 60 ? `${m}m` : `${m / 60}h`}</Button>
              ))}
              <Button onClick={() => act.mutate({ path: "/sim/sync" })}><Radio className="size-4" /> Sync all now</Button>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-slate-600">Deployer operations in flight</div>
              {data.running_operations.length === 0 ? <div className="text-xs text-slate-500">None.</div> : (
                <ul className="space-y-1 text-xs">
                  {data.running_operations.map((o) => (
                    <li key={o.id}><Mono>{o.id}</Mono> {o.service_name} @ {o.target} · completes {fmtAgo(o.due_at, data.now)}{o.outcome !== "success" && <> · <Pill tone="red">{o.outcome.replace("_", " ")}</Pill></>}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Card>

        <Card title="Data sources" subtitle="Take an inventory exporter or the scanner offline to see data go stale → unverifiable.">
          <Table>
            <thead><tr><Th>Source</Th><Th>Last sync</Th><Th>Freshness</Th><Th></Th></tr></thead>
            <tbody>
              {data.sources.map((s) => (
                <tr key={s.id}>
                  <Td>{s.name}{s.last_error && <div className="text-xs text-red-600">{s.last_error}</div>}</Td>
                  <Td className="whitespace-nowrap text-xs">{s.last_sync_at ? fmtAgo(s.last_sync_at, data.now) : "never"}</Td>
                  <Td><FreshnessBadge value={s.freshness} /></Td>
                  <Td>
                    <Button size="sm" variant={s.offline ? "primary" : "secondary"}
                      onClick={() => act.mutate({ path: "/sim/source", body: { source_id: s.id, offline: !s.offline } })}>
                      {s.offline ? <><Cloud className="size-3" /> Bring online</> : <><CloudOff className="size-3" /> Take offline</>}
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card title="Deployment faults" subtitle="Arm a one-shot fault: the next deployment on that cluster misbehaves.">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Cluster">
              <Select value={faultTarget} onChange={(e) => setFaultTarget(e.target.value)} className="w-56"
                options={[{ value: "", label: "Choose…" }, ...data.targets.map((t) => ({ value: t.id, label: t.name }))]} />
            </Field>
            <Field label="Fault"><Select value={faultKind} onChange={(e) => setFaultKind(e.target.value)} options={FAULTS} className="w-80" /></Field>
            <Button disabled={!faultTarget} onClick={() => act.mutate({ path: "/sim/fault", body: { target_id: faultTarget, kind: faultKind } })}>
              <Zap className="size-4" /> Arm fault
            </Button>
          </div>
          <div className="mt-3">
            {data.faults.length === 0 ? <div className="text-xs text-slate-500">No faults armed.</div> : (
              <ul className="space-y-1 text-xs">
                {data.faults.map((f) => (
                  <li key={f.id} className="flex items-center gap-2">
                    <Pill tone={f.kind === "source_offline" ? "gray" : "red"}>{f.kind.replace("_", " ")}</Pill>
                    {f.target ?? f.source} {f.remaining > 0 && <span className="text-slate-500">({f.remaining} use)</span>}
                    {f.kind !== "source_offline" && <button className="text-indigo-700 hover:underline" onClick={() => del.mutate({ path: `/sim/fault/${f.id}` })}>clear</button>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card title="Out-of-band changes" subtitle="Someone changes a cluster by hand. Inventory will report it; FleetHub flags drift but never auto-reverts.">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Deployment">
              <Select value={driftDep} onChange={(e) => setDriftDep(e.target.value)} className="w-72"
                options={[{ value: "", label: "Choose…" }, ...managed.map((d) => ({ value: d.id, label: `${d.service_name} @ ${d.target.name}` }))]} />
            </Field>
            <Field label="Change"><Select value={driftKind} onChange={(e) => setDriftKind(e.target.value)} options={DRIFTS} className="w-80" /></Field>
            <Button disabled={!driftDep} onClick={() => act.mutate({ path: "/sim/drift", body: { deployment_id: driftDep, kind: driftKind } })}>
              <Wrench className="size-4" /> Apply
            </Button>
          </div>
          <div className="mt-3">
            <Button size="sm" onClick={() => setManualOpen(true)}>Deploy a workload by hand (unmanaged)…</Button>
          </div>
        </Card>

        <Card title="CVE feed" subtitle="Publishing makes the scanner report findings on matching images at its next sync." className="lg:col-span-2">
          {data.feed.length === 0 ? <Empty>No feed items.</Empty> : (
            <Table>
              <thead><tr><Th>ID</Th><Th>Severity</Th><Th>Title</Th><Th>Status</Th><Th></Th></tr></thead>
              <tbody>
                {data.feed.map((f) => (
                  <tr key={f.id}>
                    <Td><Mono>{f.external_id}</Mono></Td>
                    <Td><SeverityBadge value={f.severity} /></Td>
                    <Td>{f.title}</Td>
                    <Td className="text-xs">{f.published ? `published ${fmtAgo(f.publish_at, data.now)}` : f.publish_at ? `scheduled ${fmtAgo(f.publish_at, data.now)}` : "unpublished"}</Td>
                    <Td>{!f.published && <Button size="sm" onClick={() => act.mutate({ path: "/sim/publish-cve", body: { feed_id: f.id } })}>Publish now</Button>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
      <ManualWorkload open={manualOpen} onClose={() => setManualOpen(false)} targets={data.targets} />
      <p className="mt-6 text-xs text-slate-400">Acting as {me?.user.name}. Simulated events are recorded in the audit log as <Mono>sim.*</Mono> so demos stay explainable.</p>
    </>
  );
}

function ManualWorkload({ open, onClose, targets }: { open: boolean; onClose: () => void; targets: { id: string; name: string }[] }) {
  const { data: models } = useApi<ModelFamilySummary[]>("/models");
  const { data: engines } = useApi<EngineSummary[]>("/engines");
  const [target, setTarget] = useState("");
  const [name, setName] = useState("adhoc-eval");
  const [mv, setMv] = useState("");
  const [ev, setEv] = useState("");
  const { data: evd } = useApi<{ images: { id: string; tag: string; hardware: string[] }[] }>(ev ? `/engine-versions/${ev}` : null);
  const [img, setImg] = useState("");
  const act = useAction("POST", { success: "Workload deployed by hand", onSuccess: onClose });
  return (
    <Modal open={open} onClose={onClose} title="Deploy a workload by hand"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!target || !mv || !img || !name} loading={act.isPending}
          onClick={() => act.mutate({ path: "/sim/manual-workload", body: { target_id: target, service_name: name, image_id: img, model_version_id: mv, replicas: 1 } })}>
          Deploy</Button></>}>
      <p className="text-slate-600">Simulates an engineer running <Mono>helm install</Mono> directly. Inventory will discover it as an unmanaged deployment.</p>
      <Field label="Cluster"><Select value={target} onChange={(e) => setTarget(e.target.value)} options={[{ value: "", label: "Choose…" }, ...targets.map((t) => ({ value: t.id, label: t.name }))]} /></Field>
      <Field label="Service name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Model version">
        <Select value={mv} onChange={(e) => setMv(e.target.value)} options={[{ value: "", label: "Choose…" },
          ...(models ?? []).flatMap((f) => f.versions.map((v) => ({ value: v.id, label: `${f.name} ${v.version} (${v.lifecycle})` })))]} />
      </Field>
      <Field label="Engine version">
        <Select value={ev} onChange={(e) => { setEv(e.target.value); setImg(""); }} options={[{ value: "", label: "Choose…" },
          ...(engines ?? []).flatMap((en) => en.versions.map((v) => ({ value: v.id, label: `${en.name} ${v.version}` })))]} />
      </Field>
      {evd && (
        <Field label="Image">
          <Select value={img} onChange={(e) => setImg(e.target.value)} options={[{ value: "", label: "Choose…" },
            ...evd.images.map((i) => ({ value: i.id, label: `${i.tag} (${i.hardware.join(", ")})` }))]} />
        </Field>
      )}
    </Modal>
  );
}
