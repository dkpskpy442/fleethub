import { Activity } from "lucide-react";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Field, Input } from "../components/ui";
import { api, ApiError } from "../lib/api";

export function LoginPage() {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const [params] = useSearchParams();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api("/auth/login", { method: "POST", body: { password: pw } });
      nav(params.get("next") || "/");
    } catch (x) {
      setErr(x instanceof ApiError ? x.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <div className="grid size-9 place-items-center rounded-lg bg-indigo-600 text-white"><Activity className="size-5" /></div>
          <div>
            <div className="font-semibold">FleetHub demo</div>
            <div className="text-xs text-slate-500">Synthetic data · simulated infrastructure</div>
          </div>
        </div>
        <Field label="Demo password">
          <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        </Field>
        {err && <div className="text-sm text-red-600">{err}</div>}
        <Button variant="primary" className="w-full" loading={busy} type="submit">Sign in</Button>
        <p className="text-xs text-slate-500">After signing in, pick a persona in the header to act as a different role.</p>
      </form>
    </div>
  );
}
