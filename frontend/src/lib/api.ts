import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "../components/toast";

const PERSONA_KEY = "fleethub.persona";
export const DEFAULT_PERSONA = "u_jordan";

export function getPersona(): string {
  try {
    return localStorage.getItem(PERSONA_KEY) || DEFAULT_PERSONA;
  } catch {
    return DEFAULT_PERSONA;
  }
}

export function setPersona(id: string) {
  try {
    localStorage.setItem(PERSONA_KEY, id);
  } catch {
    /* storage unavailable: persona falls back to default */
  }
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details: unknown) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", "x-persona": getPersona() },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
  });
  if (res.status === 401 && !path.startsWith("/auth")) {
    if (!location.pathname.startsWith("/login")) location.assign(`/login?next=${encodeURIComponent(location.pathname)}`);
    throw new ApiError(401, "unauthorized", "Sign in required", null);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = data?.error ?? { code: "http_error", message: `${res.status} ${res.statusText}`, details: data?.detail };
    throw new ApiError(res.status, err.code, err.message, err.details);
  }
  return data as T;
}

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 2_000, refetchOnWindowFocus: false, retry: 1 } },
});

export function useApi<T>(path: string | null, opts: { refetchInterval?: number } = {}) {
  return useQuery<T, ApiError>({
    queryKey: [path],
    queryFn: () => api<T>(path!),
    enabled: path !== null,
    refetchInterval: opts.refetchInterval,
  });
}

/** POST/PUT an action; on success everything is refetched (the backend may have advanced the world). */
export function useAction<TBody = unknown, TRes = unknown>(
  method: "POST" | "PUT" | "DELETE" = "POST",
  opts: { success?: string; onSuccess?: (r: TRes) => void } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<TRes, ApiError, { path: string; body?: TBody }>({
    mutationFn: ({ path, body }) => api<TRes>(path, { method, body: body ?? {} }),
    onSuccess: (r) => {
      qc.invalidateQueries();
      if (opts.success) toast.push({ kind: "success", message: opts.success });
      opts.onSuccess?.(r);
    },
    onError: (e) => toast.push({ kind: "error", message: e.message, details: e.details }),
  });
}
