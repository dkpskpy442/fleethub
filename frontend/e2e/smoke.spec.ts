import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Smoke tests for the primary user stories, run against the Workers runtime (pywrangler dev + local D1).
// Each run starts from the deterministic demo seed.

async function api(request: APIRequestContext, persona: string, method: "GET" | "POST", path: string, data?: unknown) {
  const res = await request.fetch(`/api${path}`, { method, headers: { "x-persona": persona }, data: data ?? {} });
  expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBeTruthy();
  return res.json();
}

async function as(page: Page, persona: string) {
  await page.addInitScript((p) => localStorage.setItem("fleethub.persona", p), persona);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  await api(request, "u_alex", "POST", "/sim/reset");
});

test("overview surfaces what needs attention", async ({ page }) => {
  await as(page, "u_jordan");
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("SIM-2026-0142: Unsafe deserialization")).toBeVisible();
  await expect(page.getByText(/Drift: atlas-chat @ prd-use-h100-2/)).toBeVisible();
  await expect(page.getByText(/Unmanaged deployment: sentinel-guard-shadow/)).toBeVisible();
  await expect(page.getByText(/unverifiable: Bare-metal node exporter/)).toBeVisible();
});

test("model version shows compatibility, lifecycle and deployed instances", async ({ page }) => {
  await as(page, "u_jordan");
  await page.goto("/model-versions/mv_atlas_2_1");
  await expect(page.getByRole("heading", { name: /Atlas Chat 2\.1/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Compatibility" })).toBeVisible();
  await expect(page.getByText(/Desired on \d+ deployments, observed running on \d+/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Plan rollout to this version/ })).toBeVisible();
});

test("fleet filters show unverifiable and unmanaged deployments explicitly", async ({ page }) => {
  await as(page, "u_jordan");
  await page.goto("/fleet?convergence=unverifiable");
  await expect(page.getByRole("link", { name: /atlas-chat\s*@\s*prd-apne-mi300-bm/ })).toBeVisible();
  await expect(page.getByText("never reported").first()).toBeVisible();
  await page.goto("/fleet?managed=false");
  await expect(page.getByRole("link", { name: /sentinel-guard-shadow\s*@\s*prd-use-l4-1/ })).toBeVisible();
});

test("vulnerability -> remediation rollout -> approval -> staged deploy", async ({ page, request }) => {
  await as(page, "u_jordan");
  const vulns = await api(request, "u_jordan", "GET", "/vulnerabilities");
  const vuln = vulns.find((v: { external_id: string }) => v.external_id === "SIM-2026-0142");
  await page.goto(`/vulnerabilities/${vuln.id}`);
  await expect(page.getByText("Remediation options")).toBeVisible();

  // The best option (vLLM 0.10.0) is ranked first.
  await page.getByRole("button", { name: /Plan remediation rollout/ }).first().click();
  await expect(page).toHaveURL(/\/rollouts\/new\?kind=engine&ev=ev_vllm_0_10_0/);
  await page.getByRole("button", { name: "Next: Targets & guardrails" }).click();

  const justifications = page.getByPlaceholder("Justification for accepting these warnings (required, audited)");
  await expect(justifications.first()).toBeVisible();
  for (const box of await justifications.all()) await box.fill("Accepted for P0 CVE remediation (e2e).");
  await page.getByRole("button", { name: "Next: Impact review" }).click();
  await expect(page.getByText(/Resolves SIM-2026-0142 on \d+ deployment/)).toBeVisible();
  await page.getByRole("button", { name: /Next: Waves/ }).click();
  await page.getByRole("button", { name: /Next: Submit/ }).click();
  await page.getByRole("button", { name: "Submit for execution" }).click();

  await expect(page).toHaveURL(/\/rollouts\/ro_/);
  const rolloutId = page.url().split("/").pop()!;
  await expect(page.getByText("approval pending").first()).toBeVisible();
  // Requesters can't approve their own rollout.
  await expect(page.getByRole("button", { name: "Approve prod waves" })).toBeDisabled();

  // Start: non-prod runs before approval.
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("in progress").first()).toBeVisible();
  await api(request, "u_jordan", "POST", "/sim/advance", { minutes: 60 });

  // A release approver approves the prod waves.
  await as(page, "u_taylor");
  await page.goto(`/rollouts/${rolloutId}`);
  await page.getByRole("button", { name: "Approve prod waves" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("approval approved").first()).toBeVisible();

  await api(request, "u_jordan", "POST", "/sim/advance", { minutes: 240 });
  const detail = await api(request, "u_jordan", "GET", `/rollouts/${rolloutId}`);
  // Stale eu-west inventory and the never-reporting bare-metal cluster can't be verified -> auto-pause.
  expect(detail.status).toBe("paused");
  expect(detail.pause_reason).toContain("unverifiable_stale_inventory");
  expect(detail.target_counts.succeeded).toBeGreaterThan(10);
  await page.reload();
  await expect(page.getByText("Rollout paused")).toBeVisible();
});

test("deployment page shows the reconciliation chain for a phantom success", async ({ page }) => {
  await as(page, "u_jordan");
  // By now the seeded Forge Coder rollout has reached us-west, where a phantom-success fault was armed.
  await page.goto("/fleet/deployments/dep_forge-coder_prd-usw-h100-1");
  await expect(page.getByText("Reconciliation chain")).toBeVisible();
  await expect(page.getByText("reported success").first()).toBeVisible();
  await expect(page.getByText("success not observed").first()).toBeVisible();
  await expect(page.getByText(/Desired state locked by rollout/)).toBeVisible();
});

test("guided demo plays end to end from the UI", async ({ page, request }) => {
  test.setTimeout(300_000);
  await as(page, "u_jordan");
  await page.goto("/");
  await page.getByTestId("start-demo").click();
  const panel = page.getByTestId("tour-panel");
  await expect(panel.getByRole("heading", { name: "The Overview" })).toBeVisible({ timeout: 30_000 });

  for (let i = 0; i < 40; i++) {
    const doIt = panel.getByTestId("tour-do");
    if (await doIt.isVisible()) {
      await doIt.click();
      await expect(panel.getByTestId("tour-next")).toBeVisible({ timeout: 90_000 });
    }
    await expect(panel.locator(".border-red-200")).toHaveCount(0);
    const next = panel.getByTestId("tour-next");
    await expect(next).toBeEnabled();
    const finish = (await next.textContent())?.includes("Finish");
    await next.click();
    if (finish) break;
  }
  await expect(panel).toBeHidden();

  const rollouts = await api(request, "u_jordan", "GET", "/rollouts");
  const remediation = rollouts.find((r: { title: string }) => r.title.startsWith("Remediate SIM-2026-0142"));
  expect(remediation.status).toBe("completed");
  expect(remediation.target_counts.succeeded).toBeGreaterThan(20);
});
