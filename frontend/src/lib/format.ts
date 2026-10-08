import { useApi } from "./api";
import type { Meta } from "./types";

/** Sim clock "now" (all timestamps in the app are simulated epoch seconds). */
export function useNow(): number {
  const { data } = useApi<Meta>("/meta");
  return data?.sim.now ?? Math.floor(Date.now() / 1000);
}

export function fmtAgo(ts: number | null | undefined, now: number): string {
  if (ts == null) return "never";
  const d = now - ts;
  const abs = Math.abs(d);
  const unit = abs < 60 ? `${abs}s` : abs < 3600 ? `${Math.floor(abs / 60)}m` : abs < 86400 ? `${Math.floor(abs / 3600)}h ${Math.floor((abs % 3600) / 60)}m` : `${Math.floor(abs / 86400)}d`;
  return d >= 0 ? `${unit} ago` : `in ${unit}`;
}

export function fmtDuration(s: number | null | undefined): string {
  if (s == null) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(s % 3600 ? 1 : 0)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function fmtTime(ts: number | null | undefined): string {
  if (ts == null) return "—";
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

export function shortDigest(d: string | null | undefined): string {
  if (!d) return "—";
  return d.replace("sha256:", "").slice(0, 12);
}

export function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
