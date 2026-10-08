/**
 * Guided demo: a scripted walkthrough that drives the real app.
 *
 * Steps operate the actual UI (click the attention item, the remediation button, each wizard step,
 * Start, Approve, Retry…) so the walkthrough follows the same path a person would. Nothing is
 * mocked: the backend really evaluates guardrails, runs the simulation and reconciles inventory.
 */
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Loader2, Pause, Play, Sparkles, UserRound, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button, cx } from "../components/ui";
import { api, ApiError, getPersona, setPersona } from "../lib/api";
import { PERSONA_NAMES, STEPS, type Step, type TourVars } from "./steps";
import { findTarget } from "./ui";

const STORAGE_KEY = "fleethub.tour";

interface TourState {
  active: boolean;
  preparing: boolean;
  index: number;
  vars: TourVars;
  done: Record<string, boolean>;
}

const INITIAL: TourState = { active: false, preparing: false, index: 0, vars: {}, done: {} };

function load(): TourState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...INITIAL, ...JSON.parse(raw) } : INITIAL;
  } catch {
    return INITIAL;
  }
}

function save(s: TourState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: tour state lives in memory only */
  }
}

interface TourApi {
  active: boolean;
  start: () => void;
}

const Ctx = createContext<TourApi>({ active: false, start: () => {} });

export function useTour() {
  return useContext(Ctx);
}

export function TourProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TourState>(load);
  const update = useCallback((fn: (s: TourState) => TourState) => {
    setState((prev) => {
      const next = fn(prev);
      save(next);
      return next;
    });
  }, []);
  const value = useMemo<TourApi>(() => ({
    active: state.active,
    start: () => update(() => ({ ...INITIAL, active: true, preparing: true })),
  }), [state.active, update]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {state.active && <TourPanel state={state} update={update} />}
    </Ctx.Provider>
  );
}

// ------------------------------------------------------------------ spotlight
function useSpotlight(spec: string | undefined, key: string) {
  useEffect(() => {
    if (!spec) return;
    let el: HTMLElement | null = null;
    let tries = 0;
    const t = setInterval(() => {
      el = findTarget(spec);
      if (el || ++tries > 40) {
        clearInterval(t);
        if (el) {
          el.classList.add("tour-target");
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    }, 250);
    return () => {
      clearInterval(t);
      el?.classList.remove("tour-target");
    };
  }, [spec, key]);
}

// ------------------------------------------------------------------ panel
const readingMs = (step: Step) => Math.min(13000, Math.max(4500, step.narration.length * 42));

function TourPanel({ state, update }: { state: TourState; update: (fn: (s: TourState) => TourState) => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const step = STEPS[Math.min(state.index, STEPS.length - 1)];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoplay, setAutoplay] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [spotKey, setSpotKey] = useState(0);
  const [entering, setEntering] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const enteringRef = useRef(entering);
  enteringRef.current = entering;

  // Starting: put the demo world back to its known initial state.
  useEffect(() => {
    if (!state.preparing) return;
    (async () => {
      try {
        await api("/sim/reset", { method: "POST", body: {}, persona: "u_alex" });
        setPersona("u_jordan");
        navigate("/");
        await qc.invalidateQueries();
        update((s) => ({ ...s, preparing: false }));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [state.preparing, navigate, qc, update]);

  // Entering a step: switch persona if needed; navigate only if we're not already where it happens.
  useEffect(() => {
    if (state.preparing) return;
    let cancelled = false;
    setError(null);
    setEntering(true);
    (async () => {
      if (step.persona && step.persona !== getPersona()) {
        setPersona(step.persona);
        await qc.invalidateQueries();
      }
      // A completed step's action may have moved us on (e.g. clicked through to the finding): stay there.
      if (step.route && !stateRef.current.done[step.id]) {
        try {
          const to = typeof step.route === "function" ? await step.route(stateRef.current.vars) : step.route;
          if (!cancelled && to && to.split("?")[0] !== location.pathname) navigate(to);
        } catch (e) {
          if (!cancelled) setError(e instanceof Error ? e.message : String(e));
        }
      }
      if (!cancelled) {
        setSpotKey((k) => k + 1);
        setEntering(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.id, state.preparing]);

  const isDone = !!state.done[step.id];
  const spotlight = isDone && step.highlightDone ? step.highlightDone : step.highlight;
  useSpotlight(state.preparing || busy ? undefined : spotlight, `${step.id}:${spotKey}:${location.pathname}:${isDone}`);

  const runAction = useCallback(async (): Promise<boolean> => {
    if (!step.action || stateRef.current.done[step.id]) return true;
    for (let i = 0; i < 80 && enteringRef.current; i++) await new Promise((r) => setTimeout(r, 100));
    setBusy(true);
    setError(null);
    try {
      const vars = { ...stateRef.current.vars };
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        step.action.run({ vars, setVars: (v) => Object.assign(vars, v), say: setStatus }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("This step took too long. Check the page, then try again or use “I did it”.")), 60_000); }),
      ]).finally(() => clearTimeout(timer));
      const advance = !!step.action.advances && stateRef.current.index < STEPS.length - 1;
      // Transition actions land on the next step's screen: move the narration with them.
      update((s) => ({ ...s, vars, done: { ...s.done, [step.id]: true }, index: advance ? s.index + 1 : s.index }));
      if (!advance) {
        await qc.invalidateQueries();
        setSpotKey((k) => k + 1);
      }
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      setAutoplay(false);
      return false;
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }, [step, update, qc]);

  const go = useCallback((delta: number) => {
    update((s) => ({ ...s, index: Math.max(0, Math.min(STEPS.length - 1, s.index + delta)) }));
  }, [update]);

  const next = useCallback(() => {
    if (stateRef.current.index >= STEPS.length - 1) {
      update(() => INITIAL);
      return;
    }
    go(1);
  }, [go, update]);

  // Autoplay: read, act, let the result sink in, move on.
  useEffect(() => {
    if (!autoplay || state.preparing) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      if (cancelled) return;
      const hadAction = !!step.action && !stateRef.current.done[step.id];
      if (hadAction && !(await runAction())) return;
      if (cancelled || (hadAction && step.action?.advances)) return; // already moved on
      if (stateRef.current.index >= STEPS.length - 1) {
        setAutoplay(false);
        return;
      }
      setTimeout(() => !cancelled && go(1), hadAction ? 3500 : 0);
    }, readingMs(step));
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [autoplay, step, runAction, go, state.preparing]);

  const exit = () => update(() => INITIAL);
  const pct = Math.round(((state.index + 1) / STEPS.length) * 100);
  const chapterStart = STEPS.findIndex((s) => s.chapter === step.chapter);
  const chapterLen = STEPS.filter((s) => s.chapter === step.chapter).length;
  const pending = !!step.action && !isDone;
  const last = state.index >= STEPS.length - 1;

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="fixed bottom-4 left-4 z-[55] flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-lg hover:bg-indigo-700"
      >
        <Sparkles className="size-4" /> Guided demo · {state.index + 1}/{STEPS.length}
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-label="Guided demo"
      data-testid="tour-panel"
      className="fixed bottom-4 left-4 z-[55] w-[min(25rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-indigo-200 bg-white shadow-2xl"
    >
      <div className="h-1 bg-indigo-100"><div className="h-1 bg-indigo-600 transition-all duration-500" style={{ width: `${pct}%` }} /></div>
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2">
        <Sparkles className="size-4 text-indigo-600" />
        <span className="text-xs font-medium uppercase tracking-wide text-indigo-700">{step.chapter}</span>
        <span className="text-xs text-slate-400">{state.index - chapterStart + 1}/{chapterLen}</span>
        <div className="ml-auto flex items-center gap-1">
          <button className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Minimize" onClick={() => setCollapsed(true)}>
            <ChevronLeft className="size-4 -rotate-90" />
          </button>
          <button className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Exit demo" onClick={exit}>
            <X className="size-4" />
          </button>
        </div>
      </div>

      {state.preparing ? (
        <div className="space-y-1 px-4 py-6 text-sm text-slate-600">
          <div className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Setting up a fresh demo environment…</div>
          {error && <div className="text-red-700">{error}</div>}
        </div>
      ) : (
        <div key={step.id} className="tour-fade max-h-[45vh] space-y-2 overflow-y-auto px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-slate-900">{step.title}</h3>
            {step.persona && (
              <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                <UserRound className="size-3" /> {PERSONA_NAMES[step.persona]}
              </span>
            )}
          </div>
          <div className="space-y-2 text-sm leading-relaxed text-slate-700">{step.body}</div>
          {step.action && (busy ? (
            <div className="flex items-center gap-2 rounded-md bg-indigo-50 px-2.5 py-1.5 text-xs text-indigo-900" aria-live="polite">
              <Loader2 className="size-3.5 shrink-0 animate-spin" /> {status ?? `${step.action.button}…`}
            </div>
          ) : (
            <div className={cx("rounded-md px-2.5 py-1.5 text-xs", isDone ? "bg-emerald-50 text-emerald-800" : "bg-indigo-50 text-indigo-900")}>
              {isDone ? <>✓ {step.action.button}</> : <>Try it yourself: {step.action.hint}</>}
            </div>
          ))}
          {error && <div className="rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-800">{error}</div>}
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-slate-100 px-4 py-2.5">
        <Button size="sm" variant="ghost" disabled={state.index === 0 || busy || state.preparing} onClick={() => go(-1)}>
          <ChevronLeft className="size-3.5" />Back
        </Button>
        <Button size="sm" variant={autoplay ? "warning" : "ghost"} disabled={state.preparing} onClick={() => setAutoplay((a) => !a)} title="Narrate and perform every step automatically">
          {autoplay ? <><Pause className="size-3.5" />Pause</> : <><Play className="size-3.5" />Autoplay</>}
        </Button>
        <div className="ml-auto flex items-center gap-1.5">
          {pending && step.action!.selfServe !== false && (
            <Button size="sm" variant="ghost" disabled={busy} title="You did this step yourself in the app"
              onClick={() => update((s) => ({ ...s, done: { ...s.done, [step.id]: true } }))}>I did it</Button>
          )}
          {pending ? (
            <Button size="sm" variant="primary" loading={busy} disabled={state.preparing || entering} onClick={runAction} data-testid="tour-do">
              {step.action!.button}
            </Button>
          ) : (
            <Button size="sm" variant="primary" disabled={busy || state.preparing || entering} onClick={next} data-testid="tour-next">
              {last ? "Finish" : "Next"} {!last && <ChevronRight className="size-3.5" />}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
