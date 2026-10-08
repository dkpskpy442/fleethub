/**
 * Helpers that let the guided demo operate the real UI the way a person would: find an element by
 * its visible text, spotlight it briefly, then click it / fill it.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Find by visible text prefix (buttons, links, headings, then any text), or "css:<selector>". */
export function findTarget(spec: string, root: ParentNode = document): HTMLElement | null {
  if (spec.startsWith("css:")) return root.querySelector<HTMLElement>(spec.slice(4));
  const want = spec.toLowerCase();
  const scope = root === document ? "main " : "";
  // Priority: section headings, then buttons/links, then table headers (document order within each).
  const groups = [
    [`${scope}h1`, `${scope}h2`, `${scope}h3`],
    [`${scope}button`, `${scope}a`, ...(root === document ? ["header button"] : [])],
    [`${scope}th`],
  ];
  for (const g of groups) {
    for (const n of root.querySelectorAll<HTMLElement>(g.join(", "))) {
      if ((n.textContent ?? "").trim().toLowerCase().startsWith(want)) {
        return /^H[1-3]$/.test(n.tagName) ? ((n.closest("section") as HTMLElement | null) ?? n) : n;
      }
    }
  }
  const base = root === document ? document.querySelector("main") : (root as Element);
  if (!base) return null;
  const walker = document.createTreeWalker(base, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if ((t.textContent ?? "").trim().toLowerCase().startsWith(want)) {
      const el = t.parentElement;
      return (el?.closest("section, [role=alert], .rounded-lg, .rounded-xl, tr, li") as HTMLElement | null) ?? el;
    }
  }
  return null;
}

export async function waitFor(spec: string, { timeout = 10_000, root }: { timeout?: number; root?: () => ParentNode | null } = {}) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const r = root ? root() : document;
    const el = r ? findTarget(spec, r) : null;
    if (el) return el;
    await sleep(150);
  }
  throw new Error(`Couldn't find “${spec.replace(/^css:/, "")}” on this page.`);
}

function clickable(el: HTMLElement): HTMLElement {
  if (el.matches("a, button")) return el;
  return el.querySelector<HTMLElement>("a, button") ?? (el.closest("a, button") as HTMLElement | null) ?? el;
}

/** Spotlight an element for a moment, then click it. */
export async function click(spec: string, { pause = 900, root }: { pause?: number; root?: () => ParentNode | null } = {}) {
  let el = clickable(await waitFor(spec, { root }));
  // Permissions reload after a persona switch: give a disabled button a moment to enable.
  for (let i = 0; i < 40 && (el as HTMLButtonElement).disabled; i++) {
    await sleep(250);
    el = clickable(await waitFor(spec, { root }));
  }
  if ((el as HTMLButtonElement).disabled) throw new Error(`“${spec.replace(/^css:/, "")}” is disabled for the current persona.`);
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("tour-press");
  await sleep(pause);
  el.classList.remove("tour-press");
  el.click();
  await sleep(300);
}

/** Set a React-controlled input/textarea value. */
function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export async function fillAll(selector: string, value: string) {
  const els = Array.from(document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(selector));
  for (const el of els) {
    if (el.value.trim()) continue;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setValue(el, value);
    await sleep(120);
  }
  return els.length;
}

const dialog = () => document.querySelector<HTMLElement>("[aria-modal=true]");

/** Fill the open confirmation dialog's text field (if any) and confirm it. */
export async function confirmDialog(text?: string) {
  const end = Date.now() + 5000;
  while (!dialog() && Date.now() < end) await sleep(100);
  const d = dialog();
  if (!d) throw new Error("The confirmation dialog didn't open.");
  const field = d.querySelector<HTMLTextAreaElement | HTMLInputElement>("textarea, input[type=text]");
  if (field && text) {
    await sleep(500);
    setValue(field, text);
  }
  await sleep(700);
  await click("Confirm", { root: dialog, pause: 600 });
  const gone = Date.now() + 8000;
  while (dialog() && Date.now() < gone) await sleep(150);
  if (dialog()) throw new Error("The action was rejected — see the message on screen.");
}

export { sleep };
