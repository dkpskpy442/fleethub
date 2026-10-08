import { ArrowRight, Lock } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAction, useApi } from "../lib/api";
import { fmtAgo, fmtTime, shortDigest, useNow } from "../lib/format";
import type { AuditEntry, Check, DeploymentRow, EvRef, ImgRef, Me, MvRef, Severity } from "../lib/types";
import {
  CheckLevelIcon, ConvergenceBadge, EngineLifecycleBadge, FreshnessBadge, HealthBadge, ModelLifecycleBadge, Pill, SeverityBadge,
} from "./status";
import { Button, Empty, Field, Modal, Mono, Table, Td, Textarea, Th, cx } from "./ui";

// ------------------------------------------------------------------ permissions
export function useMe() {
  return useApi<Me>("/me");
}

export function useCan(perm: string): boolean {
  const { data } = useMe();
  return !!data?.user.permissions.includes(perm);
}

// ------------------------------------------------------------------ links
const linkCls = "text-indigo-700 hover:text-indigo-900 hover:underline";

export function MvLink({ mv, lifecycle = true }: { mv: MvRef | null | undefined; lifecycle?: boolean }) {
  if (!mv) return <span className="text-slate-400">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Link to={`/model-versions/${mv.id}`} className={linkCls}>{mv.label}</Link>
      {lifecycle && mv.lifecycle !== "production" && <ModelLifecycleBadge value={mv.lifecycle} />}
    </span>
  );
}

export function EvLink({ ev, lifecycle = true }: { ev: EvRef | null | undefined; lifecycle?: boolean }) {
  if (!ev) return <span className="text-slate-400">—</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Link to={`/engine-versions/${ev.id}`} className={linkCls}>{ev.label}</Link>
      {lifecycle && ev.lifecycle !== "supported" && <EngineLifecycleBadge value={ev.lifecycle} />}
    </span>
  );
}

export function DepLink({ d }: { d: Pick<DeploymentRow, "id" | "service_name" | "target"> }) {
  return (
    <Link to={`/fleet/deployments/${d.id}`} className={linkCls}>
      {d.service_name}<span className="text-slate-400"> @ </span>{d.target.name}
    </Link>
  );
}

export function TargetLink({ id, name }: { id: string; name: string }) {
  return <Link to={`/fleet/targets/${id}`} className={linkCls}>{name}</Link>;
}

export function RolloutLink({ r }: { r: { id: string; title: string } | null | undefined }) {
  if (!r) return null;
  return <Link to={`/rollouts/${r.id}`} className={linkCls}>{r.title}</Link>;
}

export function VulnLink({ v }: { v: { id: string; external_id: string; severity?: Severity } }) {
  return (
    <span className="inline-flex items-center gap-1">
      {v.severity && <SeverityBadge value={v.severity} />}
      <Link to={`/vulnerabilities/${v.id}`} className={linkCls}>{v.external_id}</Link>
    </span>
  );
}

export function ImageTag({ img, digest }: { img: ImgRef | null | undefined; digest?: string | null }) {
  if (img) return <Mono title={img.digest}>{img.tag} · {shortDigest(img.digest)}</Mono>;
  if (digest) return <Pill tone="orange" title={`Not in catalog: ${digest}`}><Mono>unregistered {shortDigest(digest)}</Mono></Pill>;
  return <span className="text-slate-400">—</span>;
}

// ------------------------------------------------------------------ desired vs observed
export function EnvTag({ tier, name }: { tier: string; name: string }) {
  return <Pill tone={tier === "prod" ? "red" : tier === "staging" ? "amber" : "gray"}>{name}</Pill>;
}

export function Freshness({ d }: { d: DeploymentRow }) {
  const now = useNow();
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <FreshnessBadge value={d.freshness.state} title={`${d.freshness.source_name}: last sync ${fmtAgo(d.freshness.last_sync_at, now)}`} />
      <span className="text-[11px] text-slate-500">{d.freshness.last_sync_at ? fmtAgo(d.freshness.last_sync_at, now) : "never reported"}</span>
    </span>
  );
}

/** The two halves of a deployment's state side by side; mismatched fields are highlighted. */
export function DesiredObserved({ d, compact }: { d: DeploymentRow; compact?: boolean }) {
  const diff = new Set(d.convergence.diff.map((x) => x.field));
  const stale = d.freshness.state !== "fresh";
  const hl = (f: string) => diff.has(f) && d.desired && d.observed?.present;
  return (
    <div className={cx("grid gap-x-3 gap-y-0.5 text-xs", compact ? "grid-cols-[3.5rem_1fr]" : "grid-cols-[4.5rem_1fr]")}>
      <span className="text-slate-400">desired</span>
      <span>
        {d.desired ? (
          <span className="flex flex-wrap items-center gap-x-1.5">
            <MvLink mv={d.desired.model_version} />
            <span className="text-slate-300">/</span>
            <EvLink ev={d.desired.engine_version} />
            {!compact && <ImageTag img={d.desired.image} />}
          </span>
        ) : <span className="italic text-slate-400">none (not managed)</span>}
      </span>
      <span className="text-slate-400">observed</span>
      <span className={cx(stale && "opacity-60")}>
        {!d.observed ? <span className="italic text-slate-400">never reported</span>
          : !d.observed.present ? <span className="font-medium text-red-600">absent</span>
          : (
            <span className="flex flex-wrap items-center gap-x-1.5">
              <span className={cx(hl("model_version") && "rounded bg-orange-100 px-0.5")}>
                {d.observed.model_version ? <MvLink mv={d.observed.model_version} lifecycle={false} /> : <Mono className="text-orange-700">{d.observed.model_raw}</Mono>}
              </span>
              <span className="text-slate-300">/</span>
              <span className={cx(hl("engine_version") && "rounded bg-orange-100 px-0.5")}>
                {d.observed.engine_version ? <EvLink ev={d.observed.engine_version} lifecycle={false} /> : <Mono className="text-orange-700">{d.observed.engine_raw}</Mono>}
              </span>
              {(!compact || hl("image")) && (
                <span className={cx(hl("image") && "rounded bg-orange-100 px-0.5")}><ImageTag img={d.observed.image} digest={d.observed.image_digest} /></span>
              )}
              {stale && <span className="text-[11px] text-slate-500">(last known)</span>}
            </span>
          )}
      </span>
    </div>
  );
}

export function DeploymentTable({ rows, empty = "No deployments.", extra }: {
  rows: DeploymentRow[]; empty?: ReactNode; extra?: { header: ReactNode; cell: (d: DeploymentRow) => ReactNode };
}) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <Table>
      <thead>
        <tr>
          <Th>Deployment</Th><Th>Env / region / hw</Th><Th>Desired vs observed</Th><Th>Convergence</Th><Th>Health</Th><Th>Data</Th>
          {extra && <Th>{extra.header}</Th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => (
          <tr key={d.id} className="hover:bg-slate-50/60">
            <Td>
              <div className="flex items-center gap-1"><DepLink d={d} />{d.lock && <span title={`Locked by rollout: ${d.lock.rollout.title}`}><Lock className="size-3 text-slate-400" /></span>}</div>
              {!d.managed && <div className="mt-0.5"><ConvergenceBadge value="unmanaged" /></div>}
            </Td>
            <Td>
              <div className="flex flex-wrap gap-1"><EnvTag tier={d.target.environment.tier} name={d.target.environment.name} /></div>
              <div className="mt-0.5 text-xs text-slate-500">{d.target.region.name} · {d.target.hardware.name}</div>
            </Td>
            <Td className="min-w-[22rem]"><DesiredObserved d={d} compact /></Td>
            <Td>{d.managed && <ConvergenceBadge value={d.convergence.state} title={d.convergence.detail} />}</Td>
            <Td><HealthBadge value={d.health} /></Td>
            <Td><Freshness d={d} /></Td>
            {extra && <Td>{extra.cell(d)}</Td>}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

// ------------------------------------------------------------------ guardrails
export function GuardrailChecklist({ checks, onlyIssues }: { checks: Check[]; onlyIssues?: boolean }) {
  const list = onlyIssues ? checks.filter((c) => c.level === "block" || c.level === "warn" || c.level === "info") : checks;
  if (!list.length) return <span className="text-xs text-emerald-700">All checks passed</span>;
  return (
    <ul className="space-y-1">
      {list.map((c) => (
        <li key={c.code} className="flex items-start gap-1.5 text-xs">
          <CheckLevelIcon level={c.level} />
          <span className={cx(c.level === "block" && "text-red-700", c.level === "warn" && "text-amber-800")}>{c.message}</span>
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ audit
export function AuditList({ entries, empty = "No audit entries yet." }: { entries: AuditEntry[]; empty?: string }) {
  const now = useNow();
  if (!entries.length) return <Empty>{empty}</Empty>;
  return (
    <ol className="space-y-3">
      {entries.map((a) => (
        <li key={a.id} className="flex gap-3 text-sm">
          <div className="mt-1.5 size-2 shrink-0 rounded-full bg-slate-300" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{a.actor.name}</span>
              <span className="text-xs text-slate-400">{a.actor_role}</span>
              <Mono className="text-slate-500">{a.action}</Mono>
              <span className="ml-auto text-xs text-slate-400" title={fmtTime(a.at)}>{fmtAgo(a.at, now)}</span>
            </div>
            <div className="text-slate-700">{a.summary}</div>
            {a.reason && <div className="mt-0.5 rounded bg-slate-50 px-2 py-1 text-xs text-slate-600">“{a.reason}”</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------------ action dialogs
/** A button that opens a dialog asking for a reason / justification and then calls an API action. */
export function ActionButton({
  label, title, path, perm, variant = "secondary", size = "sm", reasonLabel = "Reason", requireReason = true,
  description, success, field = "reason", disabled, disabledReason, extraBody, icon,
}: {
  label: ReactNode; title?: ReactNode; path: string; perm?: string; variant?: "primary" | "secondary" | "danger" | "warning" | "ghost";
  size?: "sm" | "md"; reasonLabel?: string; requireReason?: boolean; description?: ReactNode; success?: string;
  field?: "reason" | "comment"; disabled?: boolean; disabledReason?: string; extraBody?: Record<string, unknown>; icon?: ReactNode;
}) {
  const allowed = useCan(perm ?? "");
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const act = useAction("POST", { success, onSuccess: () => { setOpen(false); setText(""); } });
  const blocked = (perm && !allowed) || disabled;
  const why = perm && !allowed ? `Your role lacks permission: ${perm}` : disabledReason;
  return (
    <>
      <Button variant={variant} size={size} disabled={!!blocked} title={blocked ? why : undefined} onClick={() => setOpen(true)}>
        {icon}{label}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title ?? label}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant={variant === "ghost" ? "primary" : variant}
              loading={act.isPending}
              disabled={requireReason && !text.trim()}
              onClick={() => act.mutate({ path, body: { [field]: text, ...extraBody } })}
            >
              Confirm
            </Button>
          </>
        }
      >
        {description && <div className="text-slate-600">{description}</div>}
        <Field label={reasonLabel} hint="Recorded in the audit log.">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </Field>
      </Modal>
    </>
  );
}

export function NoPermission({ perm }: { perm: string }) {
  const { data } = useMe();
  return (
    <span className="text-xs text-slate-500">
      {data?.user.name} ({data?.user.role}) can't <Mono>{perm}</Mono>. Switch persona to try it.
    </span>
  );
}

export function Arrow() {
  return <ArrowRight className="inline size-3.5 text-slate-400" />;
}

export function SourceLine({ name, lastSync, freshness }: { name: string; lastSync: number | null; freshness: "fresh" | "stale" | "unknown" }) {
  const now = useNow();
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-600">
      <FreshnessBadge value={freshness} /> {name} · {lastSync ? `synced ${fmtAgo(lastSync, now)}` : "never reported"}
    </span>
  );
}
