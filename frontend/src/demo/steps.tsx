import type { ReactNode } from "react";
import { api } from "../lib/api";
import type { RolloutSummary, VulnDetail, VulnSummary } from "../lib/types";
import { click, confirmDialog, fillAll, findTarget, sleep, waitFor } from "./ui";

export interface TourVars {
  vulnId?: string;
  rolloutId?: string;
}

export interface ActionCtx {
  vars: TourVars;
  setVars: (v: Partial<TourVars>) => void;
  /** Narrate progress in the panel while a longer action runs. */
  say: (msg: string) => void;
}

export interface Step {
  id: string;
  chapter: string;
  title: string;
  body: ReactNode;
  /** Plain-text version of the body, used to pace autoplay. */
  narration: string;
  persona?: string;
  /** Where this step happens. Only used if the previous step didn't already land there (e.g. after a reload). */
  route?: string | ((vars: TourVars) => Promise<string> | string);
  /** Visible text prefix to spotlight, or "css:<selector>". */
  highlight?: string;
  /** What to spotlight once the step's action has run (its outcome). */
  highlightDone?: string;
  action?: {
    /** Label of the primary button, e.g. "Open the finding". */
    button: string;
    /** What the user would do by hand. */
    hint: string;
    /** Whether the user may do it by hand and tell the tour ("I did it"). Default true. */
    selfServe?: boolean;
    /** The action moves the UI on to the next step's screen, so the tour advances with it. */
    advances?: boolean;
    run: (ctx: ActionCtx) => Promise<void>;
  };
}

export const PERSONA_NAMES: Record<string, string> = {
  u_jordan: "Jordan Kim · platform engineer",
  u_taylor: "Taylor Brooks · release approver",
  u_alex: "Alex Morgan · admin",
};

const VULN = "SIM-2026-0142";
const FIX_EV = "ev_vllm_0_10_0";

// ------------------------------------------------------------------ fallbacks (used only when resuming mid-tour)
const get = <T,>(path: string) => api<T>(path, { persona: "u_jordan" });
const post = (path: string, body: unknown = {}) => api(path, { method: "POST", body, persona: "u_jordan" });

async function vulnId(vars: TourVars): Promise<string> {
  if (vars.vulnId) return vars.vulnId;
  const v = (await get<VulnSummary[]>("/vulnerabilities")).find((x) => x.external_id === VULN);
  if (!v) throw new Error(`${VULN} not found — restart the guided demo.`);
  return v.id;
}

async function rolloutId(vars: TourVars): Promise<string> {
  if (vars.rolloutId) return vars.rolloutId;
  const r = (await get<RolloutSummary[]>("/rollouts"))
    .filter((x) => x.linked_vulnerability?.external_id === VULN && x.status !== "cancelled")
    .sort((a, b) => b.created_at - a.created_at)[0];
  if (!r) throw new Error("The remediation rollout hasn't been created yet.");
  return r.id;
}

async function wizardUrl(vars: TourVars): Promise<string> {
  const vid = await vulnId(vars);
  const v = await get<VulnDetail>(`/vulnerabilities/${vid}`);
  const ids = v.remediation_options.find((o) => o.engine_version_id === FIX_EV)?.deployments
    .filter((d) => d.outcome === "ok" || d.outcome === "warn").map((d) => d.deployment_id) ?? [];
  return `/rollouts/new?kind=engine&ev=${FIX_EV}&vuln=${vid}&deployments=${ids.join(",")}`;
}

const rolloutRoute = async (vars: TourVars) => `/rollouts/${await rolloutId(vars)}`;
const currentRolloutId = () => location.pathname.match(/^\/rollouts\/(ro_[^/]+)/)?.[1];

/** Click every enabled button with this exact label (e.g. per-target "Retry"), confirming each dialog.
 *  Waits for at least one to become enabled (permissions reload after a persona switch). */
async function clickEach(label: string, text?: string, onEach?: (n: number, total: number) => void) {
  const find = () => Array.from(document.querySelectorAll<HTMLButtonElement>("main button"))
    .find((b) => b.textContent?.trim() === label && !b.disabled);
  const deadline = Date.now() + 10_000;
  let clicked = 0;
  const count = () => Array.from(document.querySelectorAll<HTMLButtonElement>("main button"))
    .filter((b) => b.textContent?.trim() === label && !b.disabled).length;
  let total = 0;
  while (clicked < 8) {
    const btn = find();
    if (!btn) {
      if (clicked > 0 || Date.now() > deadline) break;
      await sleep(250);
      continue;
    }
    total = Math.max(total, clicked + count());
    onEach?.(clicked + 1, total);
    btn.setAttribute("data-tour-now", "1");
    await click("css:[data-tour-now='1']", { pause: clicked ? 500 : 800 });
    btn.removeAttribute("data-tour-now");
    await confirmDialog(text);
    clicked++;
    await sleep(500);
  }
  if (!clicked) throw new Error(`No enabled “${label}” button on this page.`);
}

const JUSTIFY = "textarea[placeholder^='Justification for accepting']";
const JUSTIFICATION = "P0 CVE remediation; risk reviewed with the model owners.";

/** Bring the wizard to the screen whose own "Next: …" button is `marker`
 *  (the wizard restarts at its first screen after a page reload). */
async function wizardTo(marker: string) {
  await waitFor("css:main h1");
  for (let i = 0; i < 6; i++) {
    if (findTarget(marker)) return;
    if (document.querySelector(JUSTIFY)) await fillAll(JUSTIFY, JUSTIFICATION);
    const next = Array.from(document.querySelectorAll<HTMLButtonElement>("main button"))
      .find((b) => b.textContent?.trim().startsWith("Next:") && !b.disabled);
    if (!next) break;
    next.click();
    await sleep(1200);
  }
  await waitFor(marker);
}

const advance = (minutes: number) => post("/sim/advance", { minutes });
const CLOCK = "css:[data-testid='sim-clock']";
const STORY = "Remediate a security finding";

// ------------------------------------------------------------------ the tour
export const STEPS: Step[] = [
  // ---------------------------------------------------------------- orientation
  {
    id: "overview",
    chapter: "Quick tour",
    title: "The Overview",
    persona: "u_jordan",
    route: "/",
    highlight: "Needs attention",
    narration: "FleetHub answers what models and engines we run, where, whether that matches what we intended, and what needs attention. The Needs attention queue ranks everything that needs a human.",
    body: <>
      <p>FleetHub answers four questions: <b>what</b> models and engines we have, <b>where</b> they run, whether that <b>matches what we intended</b>, and <b>what needs attention</b>.</p>
      <p>The <b>Needs attention</b> queue ranks everything that needs a human, from security findings to drift to stale data. We'll come back to the top item shortly.</p>
    </>,
  },
  {
    id: "model",
    chapter: "Quick tour",
    title: "A model version",
    persona: "u_jordan",
    route: "/model-versions/mv_atlas_2_1",
    highlight: "Compatibility",
    narration: "Each model version has a lifecycle, owner and artifact. Compatibility is recorded per engine version and hardware, and untested is never treated as compatible. Further down, every deployment shows desired versus observed.",
    body: <>
      <p><b>Atlas Chat 2.1</b>: lifecycle, owning team and the immutable artifact it ships.</p>
      <p>Compatibility is recorded per <b>engine version × hardware</b>. <i>Untested</i> is never treated as compatible, and <i>no image</i> means the engine can't run there at all. Further down, every deployment shows <b>desired</b> (intent) next to <b>observed</b> (inventory).</p>
    </>,
  },
  {
    id: "engine",
    chapter: "Quick tour",
    title: "An engine version",
    persona: "u_jordan",
    route: "/engine-versions/ev_vllm_0_9_1",
    highlight: "Container images",
    narration: "Engine versions ship container images per accelerator, identified by digest. Scanners report vulnerabilities against those digests. vLLM 0.9.1 carries a critical finding, and that is what the Overview flagged.",
    body: <>
      <p><b>vLLM 0.9.1</b> ships one container image per accelerator, each identified by its <b>digest</b>. Scanners report vulnerabilities against those digests, so a rebuilt image is never mistaken for the old one.</p>
      <p>This version carries a <b>critical</b> finding and runs across most of the fleet. That's the top item on the Overview, so let's go fix it.</p>
    </>,
  },

  // ---------------------------------------------------------------- the story
  {
    id: "flagged",
    chapter: STORY,
    title: "Start from what's flagged",
    persona: "u_jordan",
    route: "/",
    highlight: VULN,
    narration: "Jordan, a platform engineer, starts where anyone would: the top item in Needs attention, a critical CVE running on production deployments, some of which can't even be verified.",
    body: <p>You're <b>Jordan</b>, a platform engineer. The top item in <b>Needs attention</b> is a <b>critical CVE</b> running on production deployments, and a few of them can't even be verified because their inventory data is stale.</p>,
    action: {
      advances: true,
      button: "Open the finding",
      hint: "Click the SIM-2026-0142 item.",
      run: async ({ setVars }) => {
        await click(VULN);
        await waitFor("Affected deployments");
        setVars({ vulnId: location.pathname.split("/").pop() });
      },
    },
  },
  {
    id: "exposure",
    chapter: STORY,
    title: "Who is affected, really?",
    persona: "u_jordan",
    route: async (v) => `/vulnerabilities/${await vulnId(v)}`,
    highlight: "Affected deployments",
    narration: "Exposure is shown two ways: running, according to inventory, and intended, according to desired state. Deployments with stale data are counted as potentially exposed, never as safe. Two are unmanaged and must be adopted before a rollout can touch them.",
    body: <>
      <p>Exposure is shown two ways: <b>running</b> (inventory says so) and <b>intended</b> (it's in the desired state). They differ when there's drift or a rollout in flight.</p>
      <p>Deployments with stale inventory are counted as <i>potentially</i> exposed, never as safe. Two are <b>unmanaged</b> (deployed by hand) and can't be fixed by a rollout until they're adopted.</p>
    </>,
  },
  {
    id: "options",
    chapter: STORY,
    title: "Pick a fix, checked against every deployment",
    persona: "u_jordan",
    route: async (v) => `/vulnerabilities/${await vulnId(v)}`,
    highlight: "Remediation options",
    narration: "Every engine version without this vulnerability is guardrail-checked against every exposed deployment. vLLM 0.10.0 ranks first: most pass, some need a written justification, and one is blocked as incompatible.",
    body: <>
      <p>Every engine version without the vulnerability is <b>guardrail-checked against every exposed deployment</b>.</p>
      <p><b>vLLM 0.10.0</b> ranks first: most deployments pass, some need a written justification, and Sentinel Guard on L4 is <b>blocked</b> (recorded as incompatible). vLLM 0.9.2 ranks last because it carries its own high CVE.</p>
    </>,
    action: {
      advances: true,
      button: "Plan with vLLM 0.10.0",
      hint: "Click “Plan remediation rollout” on vLLM 0.10.0.",
      run: async ({ say }) => {
        say("Opening the rollout planner for vLLM 0.10.0…");
        await click("Plan remediation rollout");
        await waitFor("Next: Targets");
        say("The change is prefilled from the finding. Checking every target…");
        await sleep(900);
        await click("Next: Targets");
        await waitFor("Targets & guardrails");
      },
    },
  },
  {
    id: "targets",
    chapter: STORY,
    title: "Guardrails, per deployment",
    persona: "u_jordan",
    route: wizardUrl,
    highlight: "Targets & guardrails",
    narration: "Each candidate deployment shows its guardrail checks. Blocked ones are excluded with the reason. Warnings, such as untested on MI300X or stale inventory, can only be accepted with a written justification, which is audited.",
    body: <>
      <p>Each candidate shows its guardrail checks. <b>Blocked</b> deployments are excluded, with the reason shown.</p>
      <p><b>Warnings</b> (untested on MI300X, known issues on A100, a deprecated model, stale inventory) can only be accepted with a written justification, which goes in the audit log.</p>
    </>,
    action: {
      advances: true,
      button: "Justify & continue",
      hint: "Write a justification for each warned deployment, then click “Next: Impact review”.",
      run: async ({ say }) => {
        await wizardTo("Next: Impact review");
        say("Writing a justification for each warned deployment…");
        await fillAll(JUSTIFY, JUSTIFICATION);
        await sleep(600);
        await click("Next: Impact review");
        await waitFor("Vulnerabilities resolved");
      },
    },
  },
  {
    id: "impact",
    chapter: STORY,
    title: "Impact, before anything changes",
    persona: "u_jordan",
    route: wizardUrl,
    highlight: "Vulnerabilities resolved",
    narration: "Before anything changes: how many deployments and replicas, how many in production, which regions, and confirmation that the change actually resolves this CVE everywhere it's applied.",
    body: <p>Before anything changes: how many deployments and replicas, how many in prod, which regions, and confirmation that the change actually <b>resolves the CVE</b> everywhere it's applied.</p>,
    action: {
      advances: true,
      button: "Continue to waves",
      hint: "Click “Next: Waves”.",
      run: async () => {
        await wizardTo("Next: Waves");
        await click("Next: Waves");
        await waitFor("Waves run top to bottom");
      },
    },
  },
  {
    id: "waves",
    chapter: STORY,
    title: "Staged in waves",
    persona: "u_jordan",
    route: wizardUrl,
    highlight: "Waves run top to bottom",
    narration: "FleetHub proposes waves: non-prod first, then a single production canary, then production region by region. A target only counts once inventory confirms the new version and it stays healthy through the bake time. Any failure pauses everything.",
    body: <>
      <p>Suggested waves: <b>non-prod → one prod canary → prod region by region</b>, all editable.</p>
      <p>A target only counts as done when <b>inventory confirms</b> the new image and it stays healthy through the wave's bake time. Any failure pauses the whole rollout.</p>
    </>,
    action: {
      advances: true,
      button: "Review & submit",
      hint: "Click “Next: Submit”, then “Submit for execution”.",
      run: async ({ setVars, say }) => {
        await wizardTo("Next: Submit");
        await click("Next: Submit");
        await waitFor("Submit for execution");
        say("Submitting for execution…");
        await sleep(1000);
        await click("Submit for execution");
        await waitFor("Approve prod waves", { timeout: 15_000 });
        const id = currentRolloutId();
        if (id) setVars({ rolloutId: id });
      },
    },
  },
  {
    id: "submitted",
    chapter: STORY,
    title: "Submitted: locked, awaiting approval",
    persona: "u_jordan",
    route: rolloutRoute,
    highlight: "Approve prod waves",
    highlightDone: "Wave 1",
    narration: "Submitting locked each target's desired state so nothing else can change it mid-rollout. Production needs a release approver who isn't the requester, so Approve is disabled for Jordan. Non-production can start now.",
    body: <>
      <p>Submitting <b>locked</b> every target, so no other change can touch them mid-rollout.</p>
      <p>Prod waves need a <b>release approver who isn't the requester</b>, so <i>Approve</i> is disabled for Jordan. Non-prod can start right away.</p>
    </>,
    action: {
      button: "Start the rollout",
      hint: "Click Start, then Confirm.",
      run: async () => {
        await click("Start");
        await confirmDialog();
      },
    },
  },
  {
    id: "nonprod",
    chapter: STORY,
    title: "Non-prod, verified by inventory",
    persona: "u_jordan",
    route: rolloutRoute,
    highlight: CLOCK,
    highlightDone: "Wave 1",
    narration: "Time is simulated. Over the next hour the deployer applies non-production, inventory confirms the new image digest, and each target bakes healthy. Production waves wait for approval.",
    body: <p>Time is simulated. Over the next hour the deployer applies non-prod, inventory <b>confirms the new image digest</b>, and each target bakes healthy. Prod waves wait for approval.</p>,
    action: { button: "Let an hour pass", hint: "Press +30m twice in the header.", run: async ({ say }) => { say("An hour passes on the simulated clock…"); await advance(60); await sleep(1500); } },
  },
  {
    id: "approve",
    chapter: STORY,
    title: "Hand-off: the release approver",
    persona: "u_taylor",
    route: rolloutRoute,
    highlight: "Approve prod waves",
    highlightDone: "Prod approval",
    narration: "Now we're Taylor, the release approver. Non-production is verified, so Taylor approves the production waves. The decision and comment are recorded.",
    body: <p>Now you're <b>Taylor</b>, the release approver. Non-prod is verified, so Taylor approves the prod waves. The decision and comment are recorded.</p>,
    action: {
      button: "Approve as Taylor",
      hint: "Click “Approve prod waves”, then Confirm.",
      run: async () => {
        await click("Approve prod waves");
        await confirmDialog("Non-prod verified by inventory; go for prod.");
      },
    },
  },
  {
    id: "prod",
    chapter: STORY,
    title: "Prod rolls out… and pauses itself",
    persona: "u_jordan",
    route: rolloutRoute,
    highlight: CLOCK,
    highlightDone: "Rollout paused",
    narration: "Back as Jordan. The canary and US regions roll out and verify. In eu-west the deployer reports success, but that region's inventory exporter is down, so there is no evidence. Those targets fail as unverifiable and the rollout pauses itself.",
    body: <>
      <p>Back as Jordan. The canary and US regions roll out and verify.</p>
      <p>In <b>eu-west</b> the deployer reports success, but that region's inventory exporter is down, so there's <b>no evidence</b>. A claim without evidence never counts: those targets fail and the rollout <b>pauses itself</b>.</p>
    </>,
    action: { button: "Let 4 hours pass", hint: "Press +2h twice in the header.", run: async ({ say }) => { say("Four hours pass while prod waves roll out…"); await advance(240); await sleep(1500); } },
  },
  {
    id: "recover",
    chapter: STORY,
    title: "Restore visibility, retry, resume",
    persona: "u_jordan",
    route: rolloutRoute,
    highlight: "Rollout paused",
    highlightDone: "Rollout paused",
    narration: "The exporter is restored. Retrying re-sends the same desired revision, and inventory now confirms eu-west, so the rollout resumes. It pauses once more at a bare-metal pool whose exporter has never reported.",
    body: <>
      <p>The platform team restores the eu-west exporter. <b>Retry</b> re-sends the same desired revision, inventory now confirms eu-west, and the rollout <b>resumes</b>.</p>
      <p>It pauses once more, at a bare-metal pool whose exporter has <b>never</b> reported.</p>
    </>,
    action: {
      button: "Restore, retry & resume",
      hint: "Bring the eu-west exporter online (Simulator), click Retry on each failed target, then Resume.",
      run: async ({ say }) => {
        say("Restoring the eu-west inventory exporter…");
        await post("/sim/source", { source_id: "src_inv_euw", offline: false });
        await clickEach("Retry", undefined, (n, total) => say(`Retrying failed target ${n} of ${total}…`));
        say("Resuming the rollout…");
        await click("Resume");
        await confirmDialog();
        say("Two hours pass while the remaining waves run…");
        await advance(120);
        await sleep(1500);
      },
    },
  },
  {
    id: "signoff",
    chapter: STORY,
    title: "An admin signs off, visibly",
    persona: "u_alex",
    route: rolloutRoute,
    highlight: "Manually verify",
    highlightDone: "css:main h1",
    narration: "An engineer checked the bare-metal pool by hand. Only an admin can mark a target verified without inventory evidence, a justification is required, and the target stays flagged as manually verified.",
    body: <p>An engineer checked the bare-metal pool by hand. Only an <b>admin</b> can mark a target verified without inventory evidence; it needs a justification and stays flagged <i>manually verified</i>, so it never looks like observed success.</p>,
    action: {
      button: "Verify & resume",
      hint: "As Alex: click “Manually verify”, give a justification, Confirm, then Resume.",
      run: async ({ say }) => {
        say("Recording the manual verification with a justification…");
        await clickEach("Manually verify", "Checked the bare-metal pool by hand: vLLM 0.10.0 ROCm image running and healthy.");
        say("Resuming the rollout…");
        await click("Resume");
        await confirmDialog();
        await sleep(1500);
      },
    },
  },
  {
    id: "outcome",
    chapter: STORY,
    title: "Back to the finding",
    persona: "u_jordan",
    route: rolloutRoute,
    highlight: VULN,
    highlightDone: "Affected images",
    narration: "The rollout is complete. On the vulnerability, findings on images that no longer run anywhere were marked remediated automatically. What remains is exactly what needs follow-up: Sentinel Guard on L4, which needs vLLM 0.10.1, and the two hand-deployed workloads.",
    body: <>
      <p>The rollout is complete. On the finding, images that no longer run anywhere were marked <b>remediated</b> automatically.</p>
      <p>What's left is exactly what needs follow-up: Sentinel Guard on L4 (needs vLLM 0.10.1) and the two hand-deployed workloads.</p>
    </>,
    action: {
      button: "Open the finding",
      hint: "Click the SIM-2026-0142 link on the rollout.",
      run: async () => {
        await click(VULN);
        await waitFor("Affected images");
      },
    },
  },
  {
    id: "done",
    chapter: STORY,
    title: "Done, and fully audited",
    persona: "u_jordan",
    route: "/",
    highlight: "Needs attention",
    narration: "The critical item now covers only the remaining follow-ups. Every decision along the way, from justifications and the approval to the manual sign-off and automatic remediation, is in the audit log.",
    body: <>
      <p>The critical item on the Overview now covers only the remaining follow-ups.</p>
      <p>Every decision along the way (justifications, the approval, the admin sign-off, the automatic remediation) is in the <b>Audit log</b>. Explore freely from here: switch personas, or arm faults in the <b>Simulator</b>.</p>
    </>,
  },
];
