/**
 * `enrichLocator` — SPEC §6's "at record time, while the live DOM is available" locator-chain
 * builder. Given a LIVE, already-resolved Playwright `Locator` (e.g. one a discovery loop just
 * clicked, or one a throwaway script picked interactively), builds the 5-tier `LocatorSpec`
 * strategyChain, strongest first, dropping tiers that can't be computed.
 *
 * Deliberately decoupled from `PlaywrightSurface`: nothing here reads/writes
 * `PlaywrightSurface`'s ref map, and `PlaywrightSurface` never imports this file. This is a
 * standalone utility a LATER task (the discovery recorder, not built yet) will call at the
 * moment the model acts on a ref, to turn that live element into a recordable `LocatorSpec`.
 *
 * Tier 1 caveat (see snapshot.ts's header comment for the full empirical writeup): this
 * installed Chromium synthesizes a default accessible name ("Submit") for the mock app's
 * alt-less `<input type="image">` search-submit button, so the literal SPEC algorithm below
 * ("include only if `getByRole(role, {name, exact:true}).count() === 1`") technically
 * SUCCEEDS for that element — count is genuinely 1. We implement the literal spec'd algorithm
 * here (uniqueness-only, no "is this name meaningful" filter) rather than special-casing it,
 * since inventing an "ignore browser-default names" heuristic is itself guesswork this task's
 * Step 0 was supposed to replace with evidence, and a real discovery run should see and record
 * whatever the browser genuinely reports. The hand-written `artifacts/lookup_member_balance.json`
 * makes a different, explicit, human-authored choice for that specific step — see its
 * `rationale` string.
 *
 * Frame-scoping: the uniqueness checks in tiers 1-2 need to run against whichever frame
 * `locator` actually lives in (`Page.getByRole`/`Page.locator` do not search inside iframes —
 * only `Frame.getByRole`/`Frame.locator` or `Page.frameLocator()` do). The second parameter is
 * therefore typed `Page | Frame` rather than just `Page`: `Frame` exposes the exact same
 * `getByRole`/`locator` method shapes this function uses, so a caller enriching an element
 * inside the mock app's search iframe can pass that element's own `Frame` directly — no cast
 * needed. Not exercised by this task's own verification (the hand-written artifact doesn't
 * call this function at all).
 */

import type { Frame, Locator, Page } from "playwright";

import type { Locator as LocatorRecord, LocatorSpec } from "../schema/capability";

/** Whatever `locator` actually lives in — the top-level page's main frame, or a child frame
 * (e.g. the mock app's search iframe). Both expose the `getByRole`/`locator` methods the
 * tier-1/tier-2 uniqueness checks below use. */
type LocatorRoot = Page | Frame;

interface RoleAndName {
  role: string;
  name: string;
}

/**
 * Reads the live element's own computed role + accessible name via `Locator.ariaSnapshot()`
 * (default, non-"ai" mode — see snapshot.ts finding #1: this mode is accurate ground truth,
 * just refless). The first line of the returned YAML is always
 * `- <role>[ "<name>"][:]`; malformed/unparseable output (e.g. a detached element) yields
 * `null` rather than throwing, since a caller should treat "can't compute" the same as "this
 * tier can't be computed" instead of aborting the whole enrichment.
 */
async function getRoleAndName(locator: Locator): Promise<RoleAndName | null> {
  let snap: string;
  try {
    snap = await locator.ariaSnapshot({ timeout: 3000 });
  } catch {
    return null;
  }
  const firstLine = snap.split("\n")[0]?.trim() ?? "";
  const m = /^-\s+(\S+?):?\s*(?:"([^"]*)")?:?\s*$/.exec(firstLine);
  if (!m || !m[1]) return null;
  return { role: m[1], name: m[2] ?? "" };
}

/** Tier 1: role + accessibleName, included only if unique on the page (checked with
 * `exact: true`, matching SPEC §6 / §8's determinism rule).
 *
 * `knownRoleName`, when given, is used INSTEAD of calling `getRoleAndName` (which calls
 * `locator.ariaSnapshot()`) — see this file's "TASK 7 EMPIRICAL FINDING" comment on
 * `enrichLocator` below for why: that call permanently invalidates an `aria-ref=`-sourced
 * Locator's native ref. `discovery/loop.ts` already knows the acted-on ref's role/name (it
 * parses the same line out of the turn's own numbered snapshot text, for risk
 * classification) and passes it straight through here, skipping the destructive call
 * entirely for the one caller that actually hits this edge case. */
async function buildRoleTier(
  locator: Locator,
  root: LocatorRoot,
  rationale: string[],
  knownRoleName?: RoleAndName,
): Promise<LocatorRecord | null> {
  const info = knownRoleName ?? (await getRoleAndName(locator));
  if (!info) {
    rationale.push("role tier dropped (no computable role/accessible-name)");
    return null;
  }
  let count: number;
  try {
    count = await root
      .getByRole(info.role as Parameters<Page["getByRole"]>[0], { name: info.name, exact: true })
      .count();
  } catch {
    rationale.push(`role tier dropped ("${info.role}" is not a resolvable ARIA role)`);
    return null;
  }
  if (count !== 1) {
    rationale.push(`role tier dropped (role="${info.role}" name="${info.name}" matched ${count} elements, not 1)`);
    return null;
  }
  rationale.push(`role+name unique on page (role="${info.role}" name="${info.name}")`);
  return { kind: "role", role: info.role, accessibleName: info.name };
}

/** Tier 2: a generated css path. Prefers `tag[name="..."]` when the element has a `name`
 * attribute (form fields) and that alone is unique; otherwise climbs an `nth-of-type` path
 * from the element upward, keeping only the shortest SUFFIX of that path that's already
 * unique — cheaper to read than a full absolute path, still deterministic. */
async function buildCssTier(locator: Locator, root: LocatorRoot, rationale: string[]): Promise<LocatorRecord | null> {
  const handle = await locator.elementHandle().catch(() => null);
  if (!handle) {
    rationale.push("css tier dropped (element handle unavailable)");
    return null;
  }
  try {
    const nameAttr = await handle.evaluate((el) => (el as Element).getAttribute("name"));
    if (nameAttr) {
      const tag = await handle.evaluate((el) => (el as Element).tagName.toLowerCase());
      const candidate = `${tag}[name="${nameAttr}"]`;
      const count = await root.locator(candidate).count().catch(() => 0);
      if (count === 1) {
        rationale.push(`css added via [name="${nameAttr}"] (name may be tenant-branded elsewhere)`);
        return { kind: "css", selector: candidate };
      }
    }

    // IMPORTANT: this callback body must not declare any NAMED inner function or
    // const-assigned arrow function (e.g. `function segment(...) {}` or
    // `const segment = (...) => {}`). Under tsx/esbuild's transform, a named function nested
    // inside an evaluate() callback gets wrapped with an esbuild-injected `__name(...)` helper
    // call (its name-preservation transform) — but that helper only exists in the OUTER
    // Node-side module scope, not in the isolated browser context Playwright ships this
    // function's stringified source into. The result is a runtime
    // `ReferenceError: __name is not defined` INSIDE the browser, silently swallowed by this
    // function's own try/catch and misreported as "structural path computation failed" — a
    // real bug this task's own `test/enrich.test.ts` caught (every css/xpath tier was silently
    // dropping on every fixture). The fix is to keep this callback's logic fully inline/
    // anonymous, as below — an anonymous per-iteration computation, not a named helper.
    const fullPath: string = await handle.evaluate((el) => {
      const parts: string[] = [];
      let current: Element | null = el as Element;
      while (current && current.tagName.toLowerCase() !== "html") {
        let sel = current.tagName.toLowerCase();
        const parent: Element | null = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((c) => c.tagName === (current as Element).tagName);
          if (siblings.length > 1) {
            sel += `:nth-of-type(${siblings.indexOf(current) + 1})`;
          }
        }
        parts.unshift(sel);
        current = parent;
      }
      return parts.join(" > ");
    });

    const segments = fullPath.split(" > ");
    for (let start = segments.length - 1; start >= 0; start -= 1) {
      const candidate = segments.slice(start).join(" > ");
      const count = await root.locator(candidate).count().catch(() => 0);
      if (count === 1) {
        rationale.push("css added as a generated shortest-unique structural path");
        return { kind: "css", selector: candidate };
      }
    }
    rationale.push("css added as a full structural path (no shorter unique suffix found)");
    return { kind: "css", selector: fullPath };
  } catch {
    rationale.push("css tier dropped (structural path computation failed)");
    return null;
  }
}

/** Tier 3: absolute xpath — always computable for any attached element, so this tier is
 * effectively never dropped (SPEC §6: "last-resort structural fallback"). */
async function buildXPathTier(locator: Locator): Promise<LocatorRecord | null> {
  const handle = await locator.elementHandle().catch(() => null);
  if (!handle) return null;
  try {
    // See buildCssTier's comment above: no named inner function/const here either, for the
    // same esbuild/tsx `__name` reason.
    const xpath: string = await handle.evaluate((el) => {
      const parts: string[] = [];
      let current: Element | null = el as Element;
      while (current) {
        const parent: Element | null = current.parentElement;
        const tag = current.tagName.toLowerCase();
        let segStr = tag;
        if (parent) {
          const siblings = Array.from(parent.children).filter((c) => c.tagName === (current as Element).tagName);
          if (siblings.length > 1) {
            segStr = `${tag}[${siblings.indexOf(current) + 1}]`;
          }
        }
        parts.unshift(segStr);
        current = parent;
      }
      return `/${parts.join("/")}`;
    });
    return { kind: "xpath", selector: xpath };
  } catch {
    return null;
  }
}

/** Tier 4: nearest `<label>`, table header (`<th>`), or preceding table cell (`<td>`) text.
 * Interpretation (SPEC §6 leaves the exact walk to us): first try a wrapping/associated
 * `<label>` (form-field pattern); failing that, walk left through preceding sibling `<td>`s
 * in the same row, then fall back to the header cell in the same column (data-table pattern).
 */
async function buildTextAnchorTier(locator: Locator, rationale: string[]): Promise<LocatorRecord | null> {
  const handle = await locator.elementHandle().catch(() => null);
  if (!handle) return null;
  try {
    const anchor: string | null = await handle.evaluate((el) => {
      const element = el as HTMLElement;
      const label = element.closest("label");
      if (label) {
        const clone = label.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("input,select,textarea").forEach((n) => n.remove());
        const t = clone.textContent?.trim();
        if (t) return t;
      }
      const cell = element.closest("td,th");
      if (cell) {
        let prev = cell.previousElementSibling;
        while (prev) {
          const t = prev.textContent?.trim();
          if (t) return t;
          prev = prev.previousElementSibling;
        }
        const row = cell.closest("tr");
        const table = row?.closest("table");
        if (row && table) {
          const cells = Array.from(row.children);
          const colIndex = cells.indexOf(cell);
          const headerRow = table.querySelector("tr");
          if (headerRow && headerRow !== row) {
            const headerCell = headerRow.children[colIndex] as HTMLElement | undefined;
            const t = headerCell?.textContent?.trim();
            if (t) return t;
          }
        }
      }
      return null;
    });
    if (!anchor) {
      rationale.push("text_anchor dropped (no nearby label/header/cell text found)");
      return null;
    }
    rationale.push(`text_anchor from nearby label/cell text "${anchor}"`);
    return { kind: "text_anchor", text: anchor, nearbyText: anchor };
  } catch {
    rationale.push("text_anchor dropped (DOM walk failed)");
    return null;
  }
}

/** Tier 5: bounding box + nearby visible text — the universal, purely-visual fallback (also
 * the tier a future desktop/accessibility-API `Surface` implementation would lean on hardest,
 * per SPEC §5's REPORT note). */
async function buildVisualAnchorTier(locator: Locator, rationale: string[]): Promise<LocatorRecord | null> {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) {
    rationale.push("visual_anchor dropped (element has no bounding box — not visible/rendered)");
    return null;
  }
  const handle = await locator.elementHandle().catch(() => null);
  let nearbyText: string | undefined;
  if (handle) {
    nearbyText = await handle
      .evaluate((el) => {
        const parent = (el as HTMLElement).parentElement;
        const t = parent?.textContent?.replace(/\s+/g, " ").trim();
        return t ? t.slice(0, 80) : undefined;
      })
      .catch(() => undefined);
  }
  rationale.push("visual_anchor added as the last-resort bounding-box fallback");
  return { kind: "visual_anchor", bbox: box, nearbyText };
}

/**
 * `roleNameHint`, when given, is used for the role tier instead of calling
 * `Locator.ariaSnapshot()` to derive it live.
 *
 * ---------------------------------------------------------------------------------------
 * TASK 7 EMPIRICAL FINDING (why this parameter exists): when `locator` was itself resolved
 * via Playwright's `aria-ref=` selector engine — exactly what the discovery loop hands in,
 * via `PlaywrightSurface.getLocatorForRef` — calling `locator.ariaSnapshot()` (the DEFAULT,
 * non-"ai" mode; what the role tier's `getRoleAndName` used to always call) PERMANENTLY
 * invalidates that specific native ref token. Confirmed empirically against the live mock
 * app: immediately after `.ariaSnapshot()` resolves, a FRESH
 * `page.locator('aria-ref=<same token>').count()` call returns 0, not 1, even though nothing
 * else about the page changed. `elementHandle()` and `boundingBox()` (what
 * `buildCssTier`/`buildXPathTier`/`buildTextAnchorTier`/`buildVisualAnchorTier` use) do NOT
 * have this effect — also verified empirically. This is NOT a hypothetical: it broke the very
 * first real discovery turn end to end. The loop calls `captureLocator(ref)` (→ this
 * function) BEFORE `surface.act({ref})` (see `discovery/loop.ts`'s header comment for why
 * enrichment has to happen before the action, not after — form-POST navigations invalidate
 * refs too). Without a hint, the role tier's `ariaSnapshot()` call silently killed the ref
 * before `act()` ever got to resolve it, which then failed with "no longer resolves uniquely
 * (count=0)".
 *
 * The fix: `discovery/loop.ts` already knows the acted-on ref's role/name (it parses the same
 * line out of the turn's own numbered snapshot text, for risk classification) and passes it
 * straight through as `roleNameHint`, skipping `getRoleAndName`'s destructive
 * `ariaSnapshot()` call entirely for that call path. Every other caller (none currently exist
 * outside discovery, but a future one might) still gets the original live-derived behavior
 * by omitting the hint.
 * ---------------------------------------------------------------------------------------
 */
export async function enrichLocator(
  locator: Locator,
  page: LocatorRoot,
  roleNameHint?: { role: string; name: string },
): Promise<LocatorSpec> {
  const rationale: string[] = [];
  const chain: LocatorRecord[] = [];

  const role = await buildRoleTier(locator, page, rationale, roleNameHint);
  if (role) chain.push(role);

  const css = await buildCssTier(locator, page, rationale);
  if (css) chain.push(css);

  const xpath = await buildXPathTier(locator);
  if (xpath) {
    chain.push(xpath);
    rationale.push("xpath absolute path added as structural fallback");
  } else {
    rationale.push("xpath tier dropped (element handle unavailable)");
  }

  const textAnchor = await buildTextAnchorTier(locator, rationale);
  if (textAnchor) chain.push(textAnchor);

  const visualAnchor = await buildVisualAnchorTier(locator, rationale);
  if (visualAnchor) chain.push(visualAnchor);

  if (chain.length === 0) {
    // Every tier failed (e.g. a detached element) — xpath is the only tier that should ever
    // be able to fail this way in practice; fall back to a single unresolvable placeholder
    // rather than returning a `LocatorSpec` with zero tiers (the schema requires `min(1)`).
    chain.push({ kind: "xpath", selector: "/html" });
    rationale.push("all tiers failed to compute; falling back to an inert placeholder");
  }

  return { strategyChain: chain, rationale: rationale.join("; ") };
}
