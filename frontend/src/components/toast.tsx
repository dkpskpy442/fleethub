import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { CheckCircle2, X, XCircle } from "lucide-react";

interface Toast { id: number; kind: "success" | "error"; message: string; details?: unknown }

const Ctx = createContext<{ push: (t: Omit<Toast, "id">) => void }>({ push: () => {} });

export function useToast() {
  return useContext(Ctx);
}

function detailLines(details: unknown): string[] {
  if (!details) return [];
  if (Array.isArray(details)) {
    return details.slice(0, 5).map((d) => {
      if (d && typeof d === "object" && "issue" in d) {
        const o = d as { deployment_id: string; issue: string; warnings?: string[] };
        return `${o.deployment_id}: ${o.issue}${o.warnings ? ` (${o.warnings.join(", ")})` : ""}`;
      }
      return typeof d === "string" ? d : JSON.stringify(d);
    });
  }
  if (typeof details === "object" && details && "checks" in details) {
    return (details as { checks: { level: string; message: string }[] }).checks
      .filter((c) => c.level === "block" || c.level === "warn")
      .map((c) => `${c.level}: ${c.message}`);
  }
  return [];
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { ...t, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), t.kind === "error" ? 9000 : 3500);
  }, []);
  return (
    <Ctx.Provider value={{ push }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`flex gap-2 rounded-lg border p-3 text-sm shadow-lg ${
              t.kind === "error" ? "border-red-200 bg-red-50 text-red-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"
            }`}
          >
            {t.kind === "error" ? <XCircle className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}
            <div className="min-w-0 flex-1">
              <div className="font-medium">{t.message}</div>
              {detailLines(t.details).map((l, i) => (
                <div key={i} className="mt-0.5 truncate text-xs opacity-80">{l}</div>
              ))}
            </div>
            <button className="opacity-60 hover:opacity-100" onClick={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))}>
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
