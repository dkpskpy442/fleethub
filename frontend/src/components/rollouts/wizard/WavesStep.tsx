import { ArrowDown, ArrowUp, Plus, RotateCcw, ShieldAlert, Trash2 } from "lucide-react";
import { DepLink, EnvTag } from "../../domain";
import { Pill } from "../../status";
import { Button, Card, Input } from "../../ui";
import { isProd, newWaveKey, validateWaves, type EditableWave, type PreviewTarget } from "./common";

export function WavesStep({ waves, setWaves, selected, byId, onReset, regenerated }: {
  waves: EditableWave[]; setWaves: (w: EditableWave[]) => void; selected: string[];
  byId: Map<string, PreviewTarget>; onReset: () => void; regenerated: boolean;
}) {
  const errors = validateWaves(waves, selected);
  const assigned = new Set(waves.flatMap((w) => w.deployment_ids));
  const unassigned = selected.filter((d) => !assigned.has(d));

  const update = (i: number, patch: Partial<EditableWave>) => setWaves(waves.map((w, j) => (j === i ? { ...w, ...patch } : w)));
  const swap = (i: number, j: number) => {
    const n = [...waves];
    [n[i], n[j]] = [n[j], n[i]];
    setWaves(n);
  };
  /** Move a deployment into wave `to` (-1 = unassign). */
  const move = (dep: string, to: number) =>
    setWaves(waves.map((w, j) => {
      const ids = w.deployment_ids.filter((d) => d !== dep);
      return { ...w, deployment_ids: j === to ? [...ids, dep] : ids };
    }));
  const addWave = () => setWaves([...waves, { key: newWaveKey(), name: `Wave ${waves.length + 1}`, bake_minutes: 15, deployment_ids: [] }]);

  const waveOptions = waves.map((w, i) => ({ value: String(i), label: `${i + 1}. ${w.name || "(unnamed)"}` }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">
          Waves run top to bottom. Each target must converge (verified by inventory) and stay healthy for the wave's bake time before the next wave starts.
          A failed gate pauses the whole rollout.
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onReset}><RotateCcw className="size-3.5" /> Reset to suggested</Button>
          <Button size="sm" onClick={addWave}><Plus className="size-3.5" /> Add wave</Button>
        </div>
      </div>
      {regenerated && (
        <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
          Waves were regenerated from the suggestion because the change or target selection changed.
        </div>
      )}
      {waves.map((w, i) => {
        const prod = w.deployment_ids.some((d) => isProd(byId.get(d)));
        return (
          <Card key={w.key} padded={false}>
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">{i + 1}</span>
              <span className="block w-72 max-w-full"><Input aria-label="Wave name" value={w.name} onChange={(e) => update(i, { name: e.target.value })} className="font-medium" /></span>
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                bake
                <span className="block w-20">
                  <Input
                    type="number" min={0} aria-label="Bake minutes" value={Number.isFinite(w.bake_minutes) ? w.bake_minutes : ""}
                    onChange={(e) => update(i, { bake_minutes: e.target.value === "" ? NaN : Math.round(Number(e.target.value)) })}
                  />
                </span>
                min
              </label>
              {prod && <Pill tone="amber" icon={<ShieldAlert className="size-3" />} title="Waves touching prod need one approval from a release approver who is not the requester">prod — requires approval</Pill>}
              <span className="text-xs text-slate-400">{w.deployment_ids.length} deployment{w.deployment_ids.length === 1 ? "" : "s"}</span>
              <div className="ml-auto flex gap-1">
                <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => swap(i, i - 1)} title="Move wave up" aria-label="Move wave up"><ArrowUp className="size-3.5" /></Button>
                <Button size="sm" variant="ghost" disabled={i === waves.length - 1} onClick={() => swap(i, i + 1)} title="Move wave down" aria-label="Move wave down"><ArrowDown className="size-3.5" /></Button>
                <Button
                  size="sm" variant="ghost" disabled={w.deployment_ids.length > 0}
                  title={w.deployment_ids.length ? "Move its deployments to other waves first" : "Delete wave"} aria-label="Delete wave"
                  onClick={() => setWaves(waves.filter((_, j) => j !== i))}
                ><Trash2 className="size-3.5" /></Button>
              </div>
            </div>
            {!w.deployment_ids.length ? (
              <div className="px-4 py-3 text-xs italic text-slate-400">Empty wave — move deployments here, or delete it. Empty waves are dropped on save.</div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {w.deployment_ids.map((d) => (
                  <DeploymentLine key={d} id={d} t={byId.get(d)} value={String(i)} options={waveOptions} onMove={(to) => move(d, to)} />
                ))}
              </ul>
            )}
          </Card>
        );
      })}
      {unassigned.length > 0 && (
        <Card title={<span className="text-amber-700">Not in any wave — assign each to a wave</span>}>
          <ul className="divide-y divide-slate-100">
            {unassigned.map((d) => <DeploymentLine key={d} id={d} t={byId.get(d)} value="-1" options={waveOptions} onMove={(to) => move(d, to)} />)}
          </ul>
        </Card>
      )}
      {errors.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <ul className="list-disc space-y-0.5 pl-5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function DeploymentLine({ id, t, value, options, onMove }: {
  id: string; t: PreviewTarget | undefined; value: string; options: { value: string; label: string }[]; onMove: (to: number) => void;
}) {
  const d = t?.deployment;
  return (
    <li className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
      <span className="min-w-[16rem]">{d ? <DepLink d={d} /> : id}</span>
      {d && <EnvTag tier={d.target.environment.tier} name={d.target.environment.name} />}
      {d && <span className="text-xs text-slate-500">{d.target.region.name} · {d.target.hardware.name} · {d.desired?.replicas ?? 0} replicas</span>}
      {t?.guardrails.outcome === "warn" && <Pill tone="amber">warning accepted</Pill>}
      <label className="ml-auto flex items-center gap-1.5 text-xs text-slate-500">
        wave
        <select
          aria-label="Move to wave"
          value={value}
          onChange={(e) => onMove(Number(e.target.value))}
          className="rounded-md border border-slate-300 bg-white px-1.5 py-1 text-xs"
        >
          {value === "-1" && <option value="-1">— choose —</option>}
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
    </li>
  );
}
