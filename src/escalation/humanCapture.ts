/**
 * Human-action capture (SPEC §10). While a run is `PAUSED_AWAITING_HUMAN` / `HUMAN_IN_CONTROL`,
 * a human may act directly in the visible/connected browser window, not just through the
 * operator CLI's REPL. This module makes those direct actions observable to the rest of the
 * system: `page.addInitScript()` installs document-level capture listeners for `click`,
 * `input`, `change`, and `submit` that call `window.__cuaHumanAction({type, role, name, text?,
 * url})`; `page.exposeBinding()` wires that function to `onEvent`, which the caller (
 * `session.ts`) uses to append each event to the run's `EvidenceLogger` with `actor: "human"`.
 *
 * Because this is an init script, Playwright re-runs it at the start of every new document
 * (SPEC §10, and Playwright's own documented `addInitScript` guarantee) — so capture survives
 * whatever navigations the human's own actions cause. HOWEVER, an init script only runs for
 * documents created AFTER it is registered; it does NOT retroactively attach to whatever
 * document is already loaded at the moment this function is called (which, for an escalation
 * mid-replay, is exactly the page a human needs to act on right now). We compensate by also
 * running the identical script once via `page.evaluate()` immediately, so the CURRENTLY loaded
 * document gets listeners too, not just future ones.
 *
 * LIMITATIONS (documented per SPEC's own wording — real, not hypothetical, constraints):
 *   - DOM-level intent only, not OS-level input events: a human moving the mouse, using a
 *     screen reader, or interacting via assistive tech in ways that never fire a `click`/
 *     `input`/`change`/`submit` DOM event is invisible to this module.
 *   - Cannot see inside CROSS-ORIGIN iframes: `addInitScript`/`page.evaluate()` here target the
 *     top-level document only, and a cross-origin iframe's own document is a separate
 *     browsing context this code never touches. The mock app's own iframe (see
 *     `src/mockapp/pages/shell.ts`) is SAME-origin, so this limitation does not block this
 *     project's demo — but it is a real constraint for any other target app.
 *   - CANNOT actually distinguish a real human's click/keystroke from Playwright's own
 *     SYNTHETIC dispatch of the identical DOM event (e.g. `locator.fill()`/`locator.click()`
 *     both fire genuine `input`/`change`/`click` events) — both are indistinguishable
 *     `Event` objects by the time a document-level listener sees them. Confirmed empirically
 *     during this task's live two-process verification: once installed, capture kept firing
 *     for the AUTOMATION's own post-resume actions (retrying/continuing the capability's
 *     remaining steps), which would otherwise be misattributed as `actor: "human"` events.
 *     `setHumanCaptureActive()` (below) is this module's mitigation: `session.ts` disables
 *     capture the instant control.json transitions back to `AUTOMATION_RUNNING` (before the
 *     executor performs another `act()`), and re-enables it only at the START of each new
 *     escalation. This narrows the misattribution window to "a human acts on the page in the
 *     brief instant between the automation resuming and this toggle call landing" — not
 *     eliminated in principle (a JS-level toggle can't out-race a same-tick synthetic event),
 *     but reduced to effectively the whole window this module SHOULD be active for.
 */

import type { Page } from "playwright";

export interface HumanActionEvent {
  type: string;
  role?: string;
  name?: string;
  text?: string;
  url: string;
}

const CAPTURE_SCRIPT = `
(() => {
  // \`__cuaHumanCaptureActive\` is the runtime on/off switch (see setHumanCaptureActive()).
  // Defaults to INACTIVE for any fresh document: this script re-runs on EVERY navigation (via
  // addInitScript), including navigations the AUTOMATION itself causes while resuming/
  // continuing after a human hands control back — defaulting to active there would mis-
  // capture (and mis-attribute as \`actor: "human"\`) the automation's own subsequent DOM
  // events. \`session.ts\` explicitly activates this on each real escalation and on every
  // navigation that happens while control.json still says a human has (or is being asked to
  // take) control, and explicitly deactivates it the instant control returns to automation.
  if (window.__cuaHumanCaptureActive === undefined) {
    window.__cuaHumanCaptureActive = false;
  }
  if (window.__cuaHumanCaptureInstalled) return;
  window.__cuaHumanCaptureInstalled = true;

  function describe(el) {
    if (!el || typeof el.getAttribute !== "function") return { role: undefined, name: undefined };
    const role = el.getAttribute("role") || (el.tagName ? el.tagName.toLowerCase() : undefined);
    const name =
      el.getAttribute("aria-label") ||
      el.getAttribute("name") ||
      el.getAttribute("placeholder") ||
      (el.innerText ? String(el.innerText).slice(0, 80) : undefined) ||
      undefined;
    return { role, name };
  }

  function report(type, el, extra) {
    if (!window.__cuaHumanCaptureActive) return;
    if (typeof window.__cuaHumanAction !== "function") return;
    const { role, name } = describe(el);
    const payload = Object.assign({ type: type, role: role, name: name, url: window.location.href }, extra || {});
    try {
      window.__cuaHumanAction(payload).catch(function () {});
    } catch (e) {
      /* binding not ready yet — best effort, never throw from a capture listener */
    }
  }

  document.addEventListener(
    "click",
    function (e) {
      report("click", e.target);
    },
    true,
  );
  document.addEventListener(
    "input",
    function (e) {
      const el = e.target;
      const text = el && "value" in el ? String(el.value) : undefined;
      report("input", el, { text: text });
    },
    true,
  );
  document.addEventListener(
    "change",
    function (e) {
      const el = e.target;
      const text = el && "value" in el ? String(el.value) : undefined;
      report("change", el, { text: text });
    },
    true,
  );
  document.addEventListener(
    "submit",
    function (e) {
      report("submit", e.target);
    },
    true,
  );
})();
`;

/**
 * Installs human-action capture on `page`. Safe to call more than once on the same `page`
 * (e.g. if an executor run escalates more than once) — `page.exposeBinding` throws if the same
 * binding name is registered twice on the same page, so callers should guard repeat calls
 * themselves (see `session.ts`'s `createEscalationHook`, which installs this exactly once per
 * run via a closure flag); this function itself does not track that.
 */
export async function installHumanCapture(
  page: Page,
  onEvent: (event: HumanActionEvent) => void,
): Promise<void> {
  await page.exposeBinding("__cuaHumanAction", (_source, event: HumanActionEvent) => {
    onEvent(event);
  });
  // Future navigations/documents.
  await page.addInitScript(CAPTURE_SCRIPT);
  // The document that is ALREADY loaded right now (see header comment for why this is needed
  // in addition to addInitScript). Best-effort: a page mid-navigation or otherwise unable to
  // run script must not crash the escalation flow over this.
  await page.evaluate(CAPTURE_SCRIPT).catch(() => undefined);
}

/**
 * Toggles the runtime on/off switch installed by `installHumanCapture` (see this file's
 * header comment on why this exists — DOM-level capture cannot itself distinguish a real
 * human's action from Playwright's own synthetic dispatch of the same event, so `session.ts`
 * uses this to narrow the window during which capture reports anything at all to "while a
 * human plausibly has the page"). Safe to call even if `installHumanCapture` was never called
 * (best-effort `page.evaluate`, swallows the error) or the page has since navigated away/
 * closed.
 */
export async function setHumanCaptureActive(page: Page, active: boolean): Promise<void> {
  await page.evaluate((value: boolean) => {
    (window as unknown as { __cuaHumanCaptureActive?: boolean }).__cuaHumanCaptureActive = value;
  }, active).catch(() => undefined);
}
