import { ArrowLeft, ArrowRight, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { NoPermission, useCan, VulnLink } from "../components/domain";
import { StepperHeader, type RolloutKind } from "../components/rollouts/shared";
import { ChangeStep } from "../components/rollouts/wizard/ChangeStep";
import {
  changeBody, changeValid, newWaveKey, usePreview, validateWaves, type Change, type EditableWave, type PreviewTarget,
} from "../components/rollouts/wizard/common";
import { ImpactStep, impactProblems } from "../components/rollouts/wizard/ImpactStep";
import { SubmitStep } from "../components/rollouts/wizard/SubmitStep";
import { TargetsStep } from "../components/rollouts/wizard/TargetsStep";
import { WavesStep } from "../components/rollouts/wizard/WavesStep";
import { Button, PageHeader } from "../components/ui";
import { useAction, useApi } from "../lib/api";
import type { RolloutDetail, VulnDetail, WavePlan } from "../lib/types";

const STEPS = ["Change", "Targets & guardrails", "Impact review", "Waves", "Submit"];
const KINDS: RolloutKind[] = ["model", "engine", "model_and_engine"];

export function RolloutNewPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const canCreate = useCan("rollout.create");

  // ---- URL prefill
  const urlMv = params.get("mv") ?? "";
  const urlEv = params.get("ev") ?? "";
  const urlKind = params.get("kind") as RolloutKind | null;
  const vulnId = params.get("vuln");
  const urlIds = useMemo(() => (params.get("deployments") ?? "").split(",").map((s) => s.trim()).filter(Boolean), [params]);
  const initialKind: RolloutKind = urlKind && KINDS.includes(urlKind) ? urlKind : urlMv && urlEv ? "model_and_engine" : urlMv ? "model" : "engine";

  const [step, setStep] = useState(0);
  const [visited, setVisited] = useState(0);
  const [change, setChange] = useState<Change>({ kind: initialKind, mvId: urlMv, evId: urlEv });
  const [scopeAll, setScopeAll] = useState(urlIds.length === 0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [justifications, setJustifications] = useState<Record<string, string>>({});
  const [waves, setWaves] = useState<EditableWave[]>([]);
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [reason, setReason] = useState("");

  const { data: vuln } = useApi<VulnDetail>(vulnId ? `/vulnerabilities/${vulnId}` : null);

  // ---- step 2: candidates
  const changeKey = `${change.kind}|${change.mvId}|${change.evId}`;
  const candidates = usePreview(change, scopeAll ? null : urlIds, step >= 1);
  const [selectionFor, setSelectionFor] = useState<string | null>(null);
  useEffect(() => {
    // Only preselect from fresh results (never from data that is being refreshed).
    if (!candidates.data || candidates.isFetching || selectionFor === changeKey) return;
    const eligible = candidates.data.targets
      .filter((t) => t.guardrails.outcome === "ok" || t.guardrails.outcome === "warn")
      .map((t) => t.deployment.id);
    setSelected(new Set(urlIds.length ? eligible.filter((id) => urlIds.includes(id)) : eligible));
    setSelectionFor(changeKey);
  }, [candidates.data, candidates.isFetching, changeKey, selectionFor, urlIds]);

  // Remember every row we've seen so labels survive scope changes.
  const [seen, setSeen] = useState<Map<string, PreviewTarget>>(new Map());
  useEffect(() => {
    if (!candidates.data) return;
    setSeen((m) => {
      const n = new Map(m);
      for (const t of candidates.data.targets) n.set(t.deployment.id, t);
      return n;
    });
  }, [candidates.data]);

  const selectedIds = useMemo(() => [...selected].sort(), [selected]);
  const selKey = `${changeKey}#${selectedIds.join(",")}`;

  // ---- step 3: impact of the exact selection (also yields suggested waves)
  const impact = usePreview(change, selectedIds, step >= 2 && selectedIds.length > 0);
  const byId = useMemo(() => {
    const m = new Map(seen);
    for (const t of impact.data?.targets ?? []) m.set(t.deployment.id, t);
    return m;
  }, [seen, impact.data]);

  // ---- step 4: waves (initialised from suggestion; regenerated when selection changes)
  const [wavesFor, setWavesFor] = useState<string | null>(null);
  const [regenerated, setRegenerated] = useState(false);
  const fromSuggested = (ws: WavePlan[]) => ws.map((w) => ({ ...w, deployment_ids: [...w.deployment_ids], key: newWaveKey() }));
  useEffect(() => {
    if (step < 3 || !impact.data || wavesFor === selKey) return;
    setRegenerated(wavesFor !== null);
    setWaves(fromSuggested(impact.data.suggested_waves));
    setWavesFor(selKey);
  }, [step, impact.data, selKey, wavesFor]);

  // ---- defaults for title
  const mvRef = candidates.data?.target_model_version ?? impact.data?.target_model_version ?? null;
  const evRef = candidates.data?.target_engine_version ?? impact.data?.target_engine_version ?? null;
  const defaultTitle = useMemo(() => {
    const families = [...new Set(selectedIds.map((id) => byId.get(id)?.deployment.model_family?.name).filter(Boolean))] as string[];
    const what = change.kind === "model" ? mvRef?.label : change.kind === "engine" ? evRef?.label : `${mvRef?.label ?? "model"} on ${evRef?.label ?? "engine"}`;
    if (!what) return "";
    if (vuln) return `Remediate ${vuln.external_id}: ${what}`;
    if (change.kind === "engine") return `${families.length === 1 ? families[0] : "Fleet"} → ${what}`;
    return `${what} rollout`;
  }, [selectedIds, byId, change.kind, mvRef, evRef, vuln]);
  const effectiveTitle = titleTouched ? title : defaultTitle;

  // ---- validation per step
  const justifiedOk = (ids: string[], rows: Map<string, PreviewTarget>) =>
    ids.every((id) => rows.get(id)?.guardrails.outcome !== "warn" || !!justifications[id]?.trim());
  const canNext = [
    changeValid(change),
    !!candidates.data && selectionFor === changeKey && selectedIds.length > 0 && justifiedOk(selectedIds, byId),
    !!impact.data && impactProblems(impact.data, justifications).length === 0,
    validateWaves(waves, selectedIds).length === 0,
    true,
  ];
  const firstInvalid = canNext.findIndex((ok) => !ok);
  const reachable = Math.min(visited, firstInvalid === -1 ? STEPS.length - 1 : firstInvalid);
  // Glide back to the top first, then turn the page (avoids a jump when the next screen is shorter).
  const go = (i: number) => {
    const turn = () => {
      setStep(i);
      setVisited((v) => Math.max(v, i));
    };
    if (window.scrollY < 120) return turn();
    window.scrollTo({ top: 0, behavior: "smooth" });
    const started = performance.now();
    const wait = () => (window.scrollY < 40 || performance.now() - started > 700 ? turn() : requestAnimationFrame(wait));
    requestAnimationFrame(wait);
  };

  // ---- submit
  const create = useAction<unknown, RolloutDetail>("POST", {
    success: "Rollout created",
    onSuccess: (r) => navigate(`/rollouts/${r.id}`),
  });
  const save = (submit: boolean) => {
    const sel = new Set(selectedIds);
    create.mutate({
      path: "/rollouts",
      body: {
        title: effectiveTitle.trim(),
        ...changeBody(change),
        linked_vulnerability_id: vulnId,
        reason,
        waves: waves.filter((w) => w.deployment_ids.length).map((w) => ({ name: w.name.trim(), bake_minutes: w.bake_minutes, deployment_ids: w.deployment_ids })),
        justifications: Object.fromEntries(Object.entries(justifications).filter(([id, j]) => sel.has(id) && j.trim() && byId.get(id)?.guardrails.outcome === "warn")),
        submit,
      },
    });
  };

  const justifiedCount = selectedIds.filter((id) => byId.get(id)?.guardrails.outcome === "warn").length;

  return (
    <>
      <PageHeader
        crumbs={<Link to="/rollouts" className="hover:underline">Rollouts</Link>}
        title="New rollout"
        subtitle="Pick a replacement version, check it against every affected deployment, review the impact and stage it in waves."
      />
      {!canCreate && <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3"><NoPermission perm="rollout.create" /></div>}
      {vulnId && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          <ShieldAlert className="size-4 text-red-600" />
          <span className="font-medium">Remediation rollout for</span>
          {vuln ? <><VulnLink v={vuln} /><span>{vuln.title}</span></> : <span className="mono text-xs">{vulnId}</span>}
          {vuln?.fixed_in_note && <span className="text-xs text-red-700">· {vuln.fixed_in_note}</span>}
        </div>
      )}
      <StepperHeader steps={STEPS} current={step} maxReached={reachable} onSelect={go} />

      {step === 0 && <ChangeStep change={change} onChange={setChange} vuln={vuln} />}
      {step === 1 && (
        <TargetsStep
          rows={candidates.data?.targets}
          loading={candidates.isLoading}
          error={candidates.error}
          selected={selected}
          onToggle={(id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
          onSetMany={(ids, on) => setSelected((s) => { const n = new Set(s); ids.forEach((id) => (on ? n.add(id) : n.delete(id))); return n; })}
          justifications={justifications}
          onJustify={(id, text) => setJustifications((j) => ({ ...j, [id]: text }))}
          scopedToUrl={!scopeAll}
          onShowAll={() => setScopeAll(true)}
        />
      )}
      {step === 2 && (
        <ImpactStep preview={impact.data} loading={impact.isLoading} error={impact.error} justifications={justifications} vuln={vuln} />
      )}
      {step === 3 && (
        <WavesStep
          waves={waves}
          setWaves={setWaves}
          selected={selectedIds}
          byId={byId}
          regenerated={regenerated}
          onReset={() => { if (impact.data) { setWaves(fromSuggested(impact.data.suggested_waves)); setRegenerated(false); } }}
        />
      )}
      {step === 4 && (
        <SubmitStep
          kind={change.kind}
          mv={change.kind !== "engine" ? mvRef : null}
          ev={change.kind !== "model" ? evRef : null}
          vuln={vuln}
          waves={waves}
          byId={byId}
          justified={justifiedCount}
          title={effectiveTitle}
          setTitle={(t) => { setTitle(t); setTitleTouched(true); }}
          reason={reason}
          setReason={setReason}
          onSave={save}
          pending={create.isPending}
          error={create.error}
        />
      )}

      <div className="mt-5 flex items-center justify-between border-t border-slate-200 pt-4">
        <Button variant="ghost" disabled={step === 0} onClick={() => go(step - 1)}><ArrowLeft className="size-4" /> Back</Button>
        {step < STEPS.length - 1 && (
          <div className="flex items-center gap-3">
            {!canNext[step] && <span className="text-xs text-slate-500">{blockedHint(step)}</span>}
            <Button variant="primary" disabled={!canNext[step]} onClick={() => go(step + 1)}>
              Next: {STEPS[step + 1]} <ArrowRight className="size-4" />
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

function blockedHint(step: number): string {
  return [
    "Choose the target version(s).",
    "Select at least one deployment and justify every accepted warning.",
    "Resolve the issues above (go back to Targets).",
    "Every selected deployment must be in exactly one wave.",
    "",
  ][step];
}
