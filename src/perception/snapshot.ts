/**
 * Turn-scoped accessibility snapshot (SPEC §6). Builds a flattened, numbered-ref textual
 * representation of a live page — across ALL frames, main frame first — for both the
 * discovery loop (a later task, not built yet) and `PlaywrightSurface.observe()` (this task).
 *
 * ---------------------------------------------------------------------------------------
 * STEP 0 EMPIRICAL FINDINGS (installed `playwright`/`playwright-core` 1.63.0) — what was
 * actually checked against the live mock app before writing any of this file, and why the
 * design below follows from it. See the task's Step 0 instructions; this is the "check, pick
 * one, note it" SPEC §6 asks for.
 *
 * 1. `Locator.ariaSnapshot()` (no options — "default" mode) returns a YAML-ish string of
 *    role/name/hierarchy with NO per-element identifiers at all, e.g.:
 *        - table:
 *            - rowgroup:
 *                - row "Username Password Log in":
 *                    - cell "Username":
 *                        - text: Username
 *                        - textbox "Username"
 *    Good as accessibility-tree ground truth (used by `enrich.ts` to read an element's
 *    computed role/name), useless on its own for building actionable refs — nothing to
 *    resolve back to a live element.
 *
 * 2. `Locator.ariaSnapshot({ mode: "ai" })` / `Locator.ariaSnapshotJSON({ mode: "ai" })` (and
 *    the equivalent `Page.ariaSnapshot(...)` / `Page.ariaSnapshotJSON(...)`) return the
 *    "AI-optimized" variant: every element gets a `ref` like `f2e17` — `f<N>` identifies the
 *    underlying frame (stable across repeated snapshot calls against that same live frame,
 *    confirmed by snapshotting the same iframe both from `page.locator('body')` — where it
 *    shows up nested under an `iframe` node — and directly from `frame.locator('body')`; both
 *    produced identical `f2e*` refs), `e<M>` is a per-call element index.
 *
 *    Critically, this native ref is resolvable via Playwright's `aria-ref=` selector engine
 *    from the TOP-LEVEL `page` object, regardless of which frame's locator produced the
 *    snapshot that discovered it — confirmed by filling an iframe's textbox purely via
 *    `page.locator('aria-ref=f2e17').fill(...)` called on `page`, not the frame. So resolving
 *    one of our own `e0..eN` refs later needs nothing more than remembering the native
 *    `f<N>e<M>` string; no manual frame bookkeeping or DOM-path computation required. This is
 *    exactly the "lean on Playwright's own aria-ref= selector" path the task flagged as
 *    likely-better, and it's what `PlaywrightSurface.act({ref})` uses (see PlaywrightSurface.ts).
 *
 *    These native refs are turn-scoped in practice, not just by our own convention: resolving
 *    a ref captured before a full page reload/navigation throws
 *    `Error: locator.count: Invalid frame in aria-ref selector "aria-ref=f2e17"` afterward —
 *    confirmed empirically. Our own `e0..eN` labels inherit that same one-observation lifetime
 *    for free.
 *
 * 3. `ariaSnapshotJSON({ mode: "ai" })` gives the same tree as structured JSON (an array of
 *    root nodes; each node has `role`, optionally `name`/`text`/`children`/`ref`/`cursor`/
 *    etc.) — used here instead of regex-parsing the YAML string, since walking a real tree is
 *    far more reliable than scraping indentation. A `cell` with no interactive children
 *    reports its full text directly as `name` (e.g. `{role:"cell", name:"Savings balance",
 *    ref:"f4e19"}`), which is what lets us synthesize readable "Label: value" static-text
 *    lines out of two-cell table rows (see `walk()` below) — exactly the
 *    "Savings balance: 4,200.00" example SPEC §6 gives for the static-text budget.
 *
 * 4. Frame-aware, per the project's D2 decision: we loop `page.frames()` ourselves and
 *    snapshot each frame's own `body` locator individually (main frame first — `frames()[0]`
 *    is always the main frame in Playwright), rather than relying on `mode:"ai"`'s automatic
 *    same-origin-iframe recursion from an ancestor frame. Both approaches surface the same
 *    content, but doing it frame-by-frame lets us (a) attribute a `frameIndex` per element for
 *    debugging, and (b) avoid double-counting: when walking the MAIN frame's tree we
 *    explicitly stop descending at `role: "iframe"` nodes (the mock app's `GET /` shell has
 *    exactly one same-origin `<iframe src="/members/search">`), because that iframe's content
 *    gets its own, independent walk when we reach it as its own entry in `page.frames()`.
 *
 * 5. THE key surprising finding, directly relevant to `enrich.ts` and the hand-written
 *    `artifacts/lookup_member_balance.json`: the mock app's alt-less
 *    `<input type="image" src="go.gif">` search-submit button is NOT nameless in Chromium's
 *    actual computed accessibility tree. Chromium synthesizes a default accessible name of
 *    `"Submit"` for an unlabeled image-type form input (mirroring the browser-default label a
 *    valueless `<input type="submit">` gets). Confirmed two ways: (a) default-mode
 *    `ariaSnapshot()` ground truth on the search page shows `button "Submit"`; (b)
 *    `page.getByRole('button', { name: "Submit", exact: true }).count()` is genuinely `1`, and
 *    clicking through that exact locator genuinely submits the search form. This contradicts
 *    SPEC §12's framing of this control as having "no accessible name" — in this installed
 *    Chromium, it does, just not a meaningful, authored, or portable one (a browser/locale
 *    default, not anything the page itself declared). `enrich.ts` documents this same finding
 *    at its own tier-1 check; the hand-written artifact deliberately does not use a role tier
 *    for that specific step so it still demonstrates genuine fallback-tier resolution — see
 *    that file's `rationale` string for the full reasoning.
 * ---------------------------------------------------------------------------------------
 */

import type { Frame, Page } from "playwright";

/** Roles flattened into the numbered interactive-elements list (SPEC §6). A `cell` is only
 * included when Chromium/Playwright reports it as clickable (`cursor: "pointer"` in ai-mode
 * JSON) — the SPEC's "any clickable `cell`" carve-out; a plain data cell is static text. */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "link",
  "textbox",
  "combobox",
  "checkbox",
  "radio",
  "menuitem",
]);

const MAX_SNAPSHOT_CHARS = 6000;
const MAX_STATIC_LINES = 40;

/** What we remember, per our own `e0..eN` label, in order to act on it later. `nativeRef` is
 * the actual resolution key (Playwright's own `f<N>e<M>` string, usable directly as
 * `aria-ref=<nativeRef>` from the top-level `page`); `frameIndex`/`frameUrl` are informational
 * (debugging/logging) only — see finding #2 above for why resolution doesn't need them. */
export interface SnapshotRef {
  frameIndex: number;
  frameUrl: string;
  nativeRef: string;
  role: string;
  name: string;
}

export interface SnapshotResult {
  snapshotText: string;
  refs: Map<string, SnapshotRef>;
}

/**
 * The ONE line format `snapshotText` uses for interactive elements — documented here because
 * `fingerprint.ts` parses this exact format back out and must never re-derive/guess it
 * independently (per the task's explicit instruction). Convention:
 *   `e<N>: <role> "<accessibleName>"`
 * e.g. `e3: button "Log in"` or `e7: textbox ""` (empty accessible name is valid — quotes
 * still present, just empty between them).
 */
export const INTERACTIVE_LINE_RE = /^(e\d+):\s+(\S+)\s+"([^"]*)"$/;

export interface ParsedInteractiveLine {
  ref: string;
  role: string;
  name: string;
}

/** Parses one `snapshotText` line against `INTERACTIVE_LINE_RE`; returns `null` for any line
 * that isn't an interactive-element line (headers, static text, blank lines, etc.) — callers
 * (e.g. `fingerprint.ts`) run this over every line and skip the `null`s. */
export function parseInteractiveLine(line: string): ParsedInteractiveLine | null {
  const m = INTERACTIVE_LINE_RE.exec(line);
  if (!m) return null;
  const ref = m[1] as string;
  const role = m[2] as string;
  const name = m[3] as string;
  return { ref, role, name };
}

// ---------------------------------------------------------------------------------------
// ariaSnapshotJSON's node shape is not exported by playwright's types (the method's return
// type is `Promise<any>`) — this is our own minimal structural type for the fields we read.
// ---------------------------------------------------------------------------------------
interface AriaNode {
  role?: string;
  name?: string;
  text?: string;
  ref?: string;
  cursor?: string;
  children?: AriaNode[];
}

interface WalkContext {
  frameIndex: number;
  frameUrl: string;
  refs: Map<string, SnapshotRef>;
  interactiveLines: string[];
  staticLines: string[];
  nextRefIndex: { n: number };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function walk(node: AriaNode | undefined, ctx: WalkContext): void {
  if (!node || typeof node !== "object") return;
  const role = node.role;
  if (!role) return;

  // Each real frame gets its own independent walk (see finding #4) — never descend into a
  // nested <iframe>'s content while walking an ANCESTOR frame's tree.
  if (role === "iframe" || role === "frame") return;

  const isClickableCell = role === "cell" && node.cursor === "pointer";
  if (INTERACTIVE_ROLES.has(role) || isClickableCell) {
    if (node.ref) {
      const ref = `e${ctx.nextRefIndex.n}`;
      ctx.nextRefIndex.n += 1;
      const name = typeof node.name === "string" ? node.name : "";
      ctx.refs.set(ref, {
        frameIndex: ctx.frameIndex,
        frameUrl: ctx.frameUrl,
        nativeRef: node.ref,
        role,
        name,
      });
      ctx.interactiveLines.push(`${ref}: ${role} "${name}"`);
    }
    // Don't descend into an interactive element's internals — its accessible `name` already
    // captures what we need; recursing further would risk pulling inner fragments out as
    // separate (misleading) static-text lines.
    return;
  }

  const children = Array.isArray(node.children) ? node.children : [];

  // "Label: value" static-text synthesis for exactly-two-cell, non-interactive table rows —
  // the pattern this app's data tables (member detail, login errors, etc.) actually use, and
  // exactly the "Savings balance: 4,200.00" shape SPEC §6 asks for.
  if (
    role === "row" &&
    children.length === 2 &&
    children.every(
      (c) => c?.role === "cell" && c.cursor !== "pointer" && !(Array.isArray(c.children) && c.children.length > 0),
    )
  ) {
    const label = ownText(children[0]) ?? "";
    const value = ownText(children[1]) ?? "";
    if (label) ctx.staticLines.push(value ? `${label}: ${value}` : label);
    return;
  }

  // A leaf (no children) carrying its own content — a heading, a standalone cell, a column
  // header, a <p>, a bare static-text fragment (role "text"), etc. — becomes one static-text
  // line. IMPORTANT: content shows up under EITHER `.name` (e.g. table cells, headings, links)
  // OR `.text` (e.g. a <p> whose only content is text — confirmed empirically: the mock app's
  // "No member found." paragraph reports `{role:"paragraph", text:"No member found."}` with NO
  // `name` field and no `children` array at all) — per ariaSnapshotJSON's own doc comment,
  // `text` is "Text content of the element when it is the only child, or the content of a
  // static text fragment". Checking `.name` alone silently drops this content — a real bug
  // caught by running this against the mock app's actual "member not found" page during Task 6
  // milestone verification, not a hypothetical.
  if (children.length === 0) {
    const content = ownText(node);
    if (content) {
      ctx.staticLines.push(content);
      return;
    }
  }

  for (const child of children) walk(child, ctx);
}

/** Returns a node's own text content, preferring `.name` (the ARIA-computed accessible name —
 * what table cells, headings, and links carry) and falling back to `.text` (what a leaf
 * static-text fragment, e.g. a plain `<p>`, carries instead — see the comment above `walk()`
 * for why both fields matter). Returns `undefined` if neither is a non-empty string. */
function ownText(node: AriaNode | undefined): string | undefined {
  if (!node) return undefined;
  if (isNonEmptyString(node.name)) return node.name.trim();
  if (isNonEmptyString(node.text)) return node.text.trim();
  return undefined;
}

/**
 * Assembles the final `snapshotText`, capped at `MAX_SNAPSHOT_CHARS`.
 *
 * Truncation priority (documented per the task's instruction): interactive elements are the
 * part a replay/discovery step actually acts on, so they are kept in full whenever possible.
 * Static text is truncated FIRST — first by line count (`MAX_STATIC_LINES`), then, if still
 * over budget, line-by-line from the end. Only if the interactive-elements list ALONE would
 * still exceed the budget (pathological — a huge page) do we fall back to truncating that
 * list too, keeping the earliest (document-order) elements and noting how many were dropped.
 */
function assemble(header: string, interactiveLines: string[], staticLinesFull: string[]): string {
  const staticCapped = staticLinesFull.slice(0, MAX_STATIC_LINES);
  const staticTruncatedByCount = staticLinesFull.length > MAX_STATIC_LINES;

  function render(interactive: string[], statics: string[], staticTruncated: boolean, interactiveTruncated: boolean): string {
    const parts = [header, "INTERACTIVE ELEMENTS:", interactive.length ? interactive.join("\n") : "(none)"];
    if (interactiveTruncated) {
      parts.push(`... [truncated: ${interactiveLines.length - interactive.length} more interactive element(s) omitted]`);
    }
    parts.push("", "STATIC TEXT:", statics.length ? statics.join("\n") : "(none)");
    if (staticTruncated) {
      parts.push("... [truncated: additional static text omitted]");
    }
    return parts.join("\n");
  }

  let text = render(interactiveLines, staticCapped, staticTruncatedByCount, false);
  if (text.length <= MAX_SNAPSHOT_CHARS) return text;

  // Still too long: drop static lines from the end until it fits (or none are left).
  let statics = staticCapped;
  while (statics.length > 0 && render(interactiveLines, statics, true, false).length > MAX_SNAPSHOT_CHARS) {
    statics = statics.slice(0, -1);
  }
  text = render(interactiveLines, statics, true, false);
  if (text.length <= MAX_SNAPSHOT_CHARS) return text;

  // Last resort (pathological): trim the interactive list too, keeping earliest elements.
  let interactive = interactiveLines;
  while (interactive.length > 0 && render(interactive, [], true, true).length > MAX_SNAPSHOT_CHARS) {
    interactive = interactive.slice(0, -1);
  }
  text = render(interactive, [], true, true);
  return text.length > MAX_SNAPSHOT_CHARS ? text.slice(0, MAX_SNAPSHOT_CHARS) : text;
}

/**
 * Builds a turn-scoped snapshot of `page`: every frame's `body`, flattened to interactive
 * elements (numbered `e0..eN`, globally unique across all frames — main frame first) plus up
 * to `MAX_STATIC_LINES` lines of visible static text, capped at `MAX_SNAPSHOT_CHARS` total.
 */
export async function buildSnapshot(page: Page): Promise<SnapshotResult> {
  const frames: Frame[] = page.frames(); // frames()[0] is always the main frame (Playwright guarantee)
  const refs = new Map<string, SnapshotRef>();
  const interactiveLines: string[] = [];
  const staticLines: string[] = [];
  const nextRefIndex = { n: 0 };

  for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
    const frame = frames[frameIndex] as Frame;
    let json: unknown;
    try {
      json = await frame.locator("body").ariaSnapshotJSON({ mode: "ai", timeout: 5000 });
    } catch {
      // A detached, cross-origin, or mid-navigation frame — skip it gracefully rather than
      // failing the whole observation over one frame we can't currently read.
      continue;
    }
    const roots: AriaNode[] = Array.isArray(json) ? (json as AriaNode[]) : [json as AriaNode];
    const ctx: WalkContext = { frameIndex, frameUrl: frame.url(), refs, interactiveLines, staticLines, nextRefIndex };
    for (const root of roots) walk(root, ctx);
  }

  const url = page.url();
  const title = await page.title().catch(() => "");
  const header = `URL: ${url}\nTITLE: ${title}`;
  const snapshotText = assemble(header, interactiveLines, staticLines);

  return { snapshotText, refs };
}
