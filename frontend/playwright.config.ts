import { defineConfig, devices } from "@playwright/test";

// Runs against the real Workers runtime (pywrangler dev + local D1) serving the built SPA and API on one origin.
// Requires `npm run build` first (CI downloads the build artifact).
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:8787",
    storageState: "e2e/.auth.json",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    // Local secrets come from backend/.dev.vars (created from the example if missing).
    command:
      "cd ../backend && ([ -f .dev.vars ] || cp .dev.vars.example .dev.vars) && " +
      "npx -y wrangler@4 d1 migrations apply fleethub --local && uv run pywrangler dev --port 8787",
    url: "http://localhost:8787/api/health",
    timeout: 240_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
  },
});
