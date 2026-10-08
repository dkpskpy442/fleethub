import type { ReactNode } from "react";
import { fmtAgo, fmtTime, useNow } from "../../lib/format";
import type { DeploymentDetail } from "../../lib/types";
import { EvLink, ImageTag, MvLink } from "../domain";
import { HealthBadge, Pill } from "../status";
import { Card, Mono, cx } from "../ui";
import { SourcePill } from "./badges";

function Row({ label, children, mismatch }: { label: string; children: ReactNode; mismatch?: boolean }) {
  return (
    <div className={cx("grid grid-cols-[8rem_1fr] items-start gap-3 rounded px-1 py-1.5 text-sm", mismatch && "bg-orange-50 ring-1 ring-inset ring-orange-200")}>
      <span className="text-slate-500">{label}</span>
      <span className="min-w-0 overflow-hidden">{children}</span>
    </div>
  );
}

/** Desired (intent) and observed (evidence) side by side. Never fuses them into one "current version". */
export function DesiredObservedCards({ d }: { d: DeploymentDetail }) {
  const now = useNow();
  const diff = new Set(d.convergence.diff.map((x) => x.field));
  const des = d.desired;
  const obs = d.observed;
  const stale = d.freshness.state !== "fresh";
  const mm = (f: string) => !!des && !!obs?.present && diff.has(f);
  const replicasMismatch = !!des && !!obs?.present && obs.replicas_ready != null && obs.replicas_ready < des.replicas;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Desired state" subtitle="FleetHub's versioned intent - the source of truth for what should run.">
        {des ? (
          <div className="divide-y divide-slate-100">
            <Row label="Revision">
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">rev {des.rev_no}</span><SourcePill source={des.source} />
                <span className="text-xs text-slate-500" title={fmtTime(des.created_at)}>{fmtAgo(des.created_at, now)}</span>
              </span>
            </Row>
            <Row label="Model version"><MvLink mv={des.model_version} /></Row>
            <Row label="Engine version"><EvLink ev={des.engine_version} /></Row>
            <Row label="Image">
              <ImageTag img={des.image} />
              {des.image && <div className="truncate text-[11px] text-slate-400">{des.image.repo}</div>}
            </Row>
            <Row label="Replicas">{des.replicas} desired</Row>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-indigo-300 bg-indigo-50/40 p-4 text-sm text-indigo-900">
            No desired state. This workload was found by inventory but was not deployed through FleetHub, so there is no
            intent to compare against. Adopting it records the observed state as revision 1.
          </div>
        )}
      </Card>

      <Card
        title={<span className="flex items-center gap-2">Observed state {obs && stale && <Pill tone="unknown">last known</Pill>}</span>}
        subtitle={`Evidence from ${d.freshness.source_name}.`}
      >
        {!obs ? (
          <div className="hatched rounded-lg border border-slate-300 p-4 text-sm text-slate-700">
            Never reported by inventory. Nothing is known about what (if anything) is running here - versions and health are
            <strong> unverifiable</strong>, not healthy.
          </div>
        ) : (
          <>
            <div className={cx("mb-2 rounded-md px-2 py-1.5 text-xs", stale ? "hatched border border-slate-300 text-slate-700" : "bg-slate-50 text-slate-600")}>
              Observed {fmtAgo(obs.observed_at, now)} ({fmtTime(obs.observed_at)}) · source last synced{" "}
              {d.freshness.last_sync_at ? fmtAgo(d.freshness.last_sync_at, now) : "never"}.
              {stale && " Data is not fresh: these are last-known values and may no longer be true."}
            </div>
            {!obs.present ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">Inventory reports this workload as <strong>absent</strong>.</div>
            ) : (
              <div className={cx("divide-y divide-slate-100", stale && "opacity-70")}>
                <Row label="Model version" mismatch={mm("model_version")}>
                  {obs.model_version ? <MvLink mv={obs.model_version} /> : <span className="flex items-center gap-1.5"><Mono className="text-orange-700">{obs.model_raw ?? "—"}</Mono><Pill tone="orange">not in catalog</Pill></span>}
                </Row>
                <Row label="Engine version" mismatch={mm("engine_version")}>
                  {obs.engine_version ? <EvLink ev={obs.engine_version} /> : <span className="flex items-center gap-1.5"><Mono className="text-orange-700">{obs.engine_raw ?? "—"}</Mono><Pill tone="orange">not in catalog</Pill></span>}
                </Row>
                <Row label="Image" mismatch={mm("image")}>
                  <ImageTag img={obs.image} digest={obs.image_digest} />
                  {obs.image_digest && <Mono className="block truncate text-[11px] text-slate-400" title={obs.image_digest}>{obs.image_digest}</Mono>}
                </Row>
                <Row label="Replicas" mismatch={replicasMismatch}>
                  {obs.replicas_ready ?? "?"} ready / {obs.replicas_total ?? "?"} total
                  {des && <span className="text-xs text-slate-500"> (desired {des.replicas})</span>}
                </Row>
              </div>
            )}
          </>
        )}
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 text-xs">
          <div>
            <div className="mb-1 text-slate-500">Reported health (as of observation)</div>
            {obs?.reported_health ? <HealthBadge value={obs.reported_health} title="What the workload reported when last observed" /> : <span className="text-slate-400">—</span>}
          </div>
          <div>
            <div className="mb-1 text-slate-500">Effective health (now)</div>
            <HealthBadge value={d.health} />
            {d.health === "unknown" && obs?.reported_health && obs.reported_health !== "unknown" && (
              <div className="mt-1 text-[11px] text-slate-500">Reported value is not trusted without fresh data.</div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
