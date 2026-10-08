import { request, type FullConfig } from "@playwright/test";

// Signs in once with the shared demo password and saves the session cookie for all tests.
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0].use.baseURL!;
  const ctx = await request.newContext({ baseURL });
  const res = await ctx.post("/api/auth/login", { data: { password: process.env.E2E_PASSWORD ?? "fleethub-local" } });
  if (!res.ok()) throw new Error(`login failed: ${res.status()} ${await res.text()}`);
  await ctx.storageState({ path: "e2e/.auth.json" });
  await ctx.dispose();
}
