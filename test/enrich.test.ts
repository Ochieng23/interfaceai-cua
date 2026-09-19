/**
 * `test/enrich.test.ts` — real-browser tests for `src/perception/enrich.ts`'s tier-selection
 * logic. Not required by SPEC §13 (that list is schema/locate/executor/outcomes/guardrails/
 * control/recorder), but cheap and valuable: `enrichLocator`'s decision logic is pure-ish over
 * a live `Locator` and needs no mock-app server, just a static HTML fixture per `it()` via
 * `page.setContent()`. One `chromium.launch()`/`browser.close()` pair is shared across this
 * file's tests via `beforeAll`/`afterAll` (no existing precedent for real-browser tests
 * elsewhere in this repo's `test/` — every other suite runs against `FakeSurface` — so this is
 * a minimal, self-contained setup scoped to this one file).
 *
 * Writing these tests caught a real, previously-invisible bug (fixed alongside this file, not
 * just documented): `buildCssTier`/`buildXPathTier` each declared a NAMED helper function
 * inside their `elementHandle.evaluate()` callback (e.g. `function segment(node) {...}`).
 * Under tsx/esbuild's transform, a named function nested inside an `evaluate()` callback gets
 * wrapped with an esbuild-injected `__name(...)` call (its name-preservation helper) — which
 * only exists in the outer Node-side module scope, not in the isolated browser context
 * Playwright ships the callback's stringified source into. The result was a runtime
 * `ReferenceError: __name is not defined` INSIDE the browser on every single invocation,
 * silently swallowed by `buildCssTier`/`buildXPathTier`'s own try/catch and misreported as
 * "structural path computation failed" / "element handle unavailable" — meaning the css and
 * xpath tiers were silently dropping on EVERY fixture, always falling through to
 * text_anchor/visual_anchor only. This was invisible until now because nothing in Task 6's own
 * milestone verification calls `enrichLocator` at all (the hand-written artifact's locators
 * were verified a different way — live, tier-by-tier, through `PlaywrightSurface.resolve()`
 * directly). Fixed by keeping both callbacks' logic fully inline/anonymous (see the comments
 * in enrich.ts itself).
 *
 * Also worth flagging: the "role tier dropped because the element has no accessible name"
 * scenario doesn't actually demonstrate what a naive reading of SPEC §12 would suggest for the
 * mock app's alt-less image-button submit — see the dedicated test below and Task 6's Step 0
 * findings (documented in both enrich.ts's and snapshot.ts's header comments) for why. The
 * genuine way tier 1 drops, verified here, is non-uniqueness (two elements sharing the same
 * role+accessibleName), not "no name" — an empty accessible name is still a valid, resolvable
 * `getByRole(..., {name:"", exact:true})` match as long as it's unique.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

import { enrichLocator } from "../src/perception/enrich";

describe("enrichLocator", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  }, 30000);

  afterAll(async () => {
    await browser.close();
  });

  it("includes a role tier as the strongest tier when role+accessibleName is unique on the page", async () => {
    await page.setContent(`<button>Log in</button>`);
    const spec = await enrichLocator(page.locator("button"), page);

    expect(spec.strategyChain[0]).toEqual({ kind: "role", role: "button", accessibleName: "Log in" });
  });

  it("drops the role tier when role+accessibleName matches more than one element (non-uniqueness, not absence)", async () => {
    await page.setContent(`<button>Submit</button><button>Submit</button>`);
    const spec = await enrichLocator(page.locator("button").nth(0), page);

    expect(spec.strategyChain.some((locator) => locator.kind === "role")).toBe(false);
    expect(spec.rationale).toMatch(/role tier dropped/);
    // css becomes the strongest SURVIVING tier once role is dropped.
    expect(spec.strategyChain[0]?.kind).toBe("css");
  });

  it("still computes css and xpath fallback tiers even when the role tier is dropped", async () => {
    await page.setContent(`<button>Submit</button><button>Submit</button>`);
    const spec = await enrichLocator(page.locator("button").nth(0), page);

    expect(spec.strategyChain.some((locator) => locator.kind === "css")).toBe(true);
    expect(spec.strategyChain.some((locator) => locator.kind === "xpath")).toBe(true);
  });

  it(
    "resolves a genuine role tier for the mock app's alt-less image-button pattern — " +
      "Chromium synthesizes a default accessible name here, contradicting a naive " +
      '"no alt => no accessible name => role tier dropped" expectation (see Task 6\'s Step 0 ' +
      "findings, documented in this file's header and in enrich.ts/snapshot.ts)",
    async () => {
      await page.setContent(`<form><input type="image" src="x.png"></form>`);
      const spec = await enrichLocator(page.locator('input[type="image"]'), page);

      expect(spec.strategyChain[0]).toEqual({ kind: "role", role: "button", accessibleName: "Submit" });
    },
  );

  it("always includes xpath as a fallback tier for an attached element", async () => {
    await page.setContent(`<button>Log in</button>`);
    const spec = await enrichLocator(page.locator("button"), page);

    const xpathTier = spec.strategyChain.find((locator) => locator.kind === "xpath");
    expect(xpathTier).toBeDefined();
    expect(xpathTier?.selector).toMatch(/^\//);
  });

  it("produces a non-empty one-line rationale string explaining the tier choices", async () => {
    await page.setContent(`<button>Log in</button>`);
    const spec = await enrichLocator(page.locator("button"), page);

    expect(typeof spec.rationale).toBe("string");
    expect((spec.rationale ?? "").length).toBeGreaterThan(0);
  });

  it("finds a text_anchor tier from a wrapping <label> for a labeled form field", async () => {
    await page.setContent(`<label>Username <input type="text" name="username"></label>`);
    const spec = await enrichLocator(page.locator('input[name="username"]'), page);

    const anchorTier = spec.strategyChain.find((locator) => locator.kind === "text_anchor");
    expect(anchorTier?.text).toBe("Username");
  });
});
