import { useQueryClient } from "@tanstack/react-query";
import {
  Activity, Boxes, Cpu, FastForward, FlaskConical, GitPullRequestArrow, LayoutDashboard, Network, Pause, Play, RefreshCw,
  ScrollText, ShieldAlert, Sparkles, Table2, UserRound,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { api, getPersona, PERSONA_EVENT, setPersona, useAction, useApi } from "../lib/api";
import { fmtTime } from "../lib/format";
import type { Me, Meta } from "../lib/types";
import { useTour } from "../demo/tour";
import { useMe } from "./domain";
import { cx } from "./ui";

const NAV = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/models", label: "Models", icon: Boxes },
  { to: "/engines", label: "Engines", icon: Cpu },
  { to: "/compatibility", label: "Compatibility", icon: Table2 },
  { to: "/fleet", label: "Fleet", icon: Network },
  { to: "/vulnerabilities", label: "Vulnerabilities", icon: ShieldAlert },
  { to: "/rollouts", label: "Rollouts", icon: GitPullRequestArrow },
  { to: "/audit", label: "Audit log", icon: ScrollText },
  { to: "/simulator", label: "Simulator", icon: FlaskConical },
];

export function Layout() {
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="flex items-center gap-2 px-4 py-4">
          <div className="grid size-8 place-items-center rounded-lg bg-indigo-600 text-white"><Activity className="size-4" /></div>
          <div>
            <div className="text-sm font-semibold leading-tight">FleetHub</div>
            <div className="text-[11px] leading-tight text-slate-500">Models · Engines · Fleet</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 px-2">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cx("flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm",
                  isActive ? "bg-indigo-50 font-medium text-indigo-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900")}
            >
              <n.icon className="size-4" />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-100 p-3 text-[11px] leading-snug text-slate-400">
          Prototype · all data synthetic. Deployments, inventory and scanners are simulated.
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white/90 px-4 py-2 backdrop-blur md:px-6">
          <MobileNav />
          <SimClock />
          <div className="ml-auto flex items-center gap-3"><DemoButton /><PersonaSwitcher /></div>
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 md:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function DemoButton() {
  const tour = useTour();
  if (tour.active) return null;
  return (
    <button
      onClick={tour.start}
      data-testid="start-demo"
      className="inline-flex h-7 items-center gap-1.5 rounded-md bg-indigo-600 px-2.5 text-xs font-medium text-white hover:bg-indigo-700"
    >
      <Sparkles className="size-3.5" /> Guided demo
    </button>
  );
}

function MobileNav() {
  return (
    <select
      className="rounded-md border border-slate-300 px-2 py-1 text-sm md:hidden"
      value=""
      onChange={(e) => e.target.value && window.location.assign(e.target.value)}
    >
      <option value="">Menu…</option>
      {NAV.map((n) => <option key={n.to} value={n.to}>{n.label}</option>)}
    </select>
  );
}

function PersonaSwitcher() {
  const { data } = useMe();
  const qc = useQueryClient();
  const [cur, setCur] = useState(getPersona());
  useEffect(() => {
    const h = (e: Event) => setCur((e as CustomEvent<string>).detail);
    window.addEventListener(PERSONA_EVENT, h);
    return () => window.removeEventListener(PERSONA_EVENT, h);
  }, []);
  if (!data) return null;
  return (
    <label className="flex items-center gap-2 text-sm" title={data.user.role_description}>
      <UserRound className="size-4 text-slate-400" />
      <span className="hidden text-xs text-slate-500 sm:inline">Acting as</span>
      <select
        aria-label="Persona"
        value={cur}
        onChange={(e) => {
          setPersona(e.target.value);
          qc.invalidateQueries();
        }}
        className="rounded-md border border-slate-300 bg-white py-1 pl-2 pr-7 text-sm"
      >
        {(data as Me).personas.map((p) => (
          <option key={p.id} value={p.id}>{p.name} — {p.role.replace("_", " ")}</option>
        ))}
      </select>
    </label>
  );
}

function SimClock() {
  const { data: meta } = useApi<Meta>("/meta");
  const qc = useQueryClient();
  const play = useAction<{ playing: boolean; speed?: number }>("POST");
  const adv = useAction<{ minutes: number }>("POST");
  const sync = useAction("POST");
  const busy = useRef(false);
  const playing = meta?.sim.playing ?? false;

  // Play mode: the browser drives simulated time (Workers have no background jobs).
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        await api("/sim/tick", { method: "POST", body: {} });
        await qc.invalidateQueries();
      } finally {
        busy.current = false;
      }
    }, 2000);
    return () => clearInterval(t);
  }, [playing, qc]);

  if (!meta) return null;
  const btn = "inline-flex h-7 items-center gap-1 rounded-md border border-slate-300 bg-white px-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50";
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="sim-clock">
      <span className="mr-1 rounded-md bg-slate-900 px-2 py-1 font-mono text-xs text-white" title="Simulated clock">
        {fmtTime(meta.sim.now)}
      </span>
      <button className={btn} onClick={() => play.mutate({ path: "/sim/play", body: { playing: !playing, speed: meta.sim.speed } })}>
        {playing ? <><Pause className="size-3" /> Pause</> : <><Play className="size-3" /> Play {meta.sim.speed}×</>}
      </button>
      {[5, 30, 120].map((m) => (
        <button key={m} className={btn} disabled={adv.isPending} onClick={() => adv.mutate({ path: "/sim/advance", body: { minutes: m } })}>
          <FastForward className="size-3" />{m < 60 ? `${m}m` : `${m / 60}h`}
        </button>
      ))}
      <button className={btn} title="Poll deployer, sync inventory and scanner now" disabled={sync.isPending} onClick={() => sync.mutate({ path: "/sim/sync" })}>
        <RefreshCw className={cx("size-3", sync.isPending && "animate-spin")} /> Sync
      </button>
    </div>
  );
}
