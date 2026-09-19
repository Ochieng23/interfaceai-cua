/**
 * `PlaywrightSurface` — the only real `Surface` implementation (SPEC §5). Wraps an
 * already-open Playwright `Page`; it does NOT launch the browser itself. Browser launching is
 * the CALLER's responsibility — `src/cli/replay.ts` does a plain `chromium.launch()` +
 * `newPage()` for this task; a later task's escalation/shared-session code launches
 * differently (a persistent context, a fixed CDP port for operator handoff) and hands the
 * resulting `Page` to this SAME class unchanged. This keeps `PlaywrightSurface` decoupled from
 * session-sharing concerns it doesn't need yet.
 *
 * Frame-aware throughout (this project's D2 decision — see `perception/snapshot.ts`'s header
 * comment for the empirical basis): `observe()` delegates to `buildSnapshot()`, which loops
 * every frame; `resolve()`/`act({target})`/`readText()`/`screenshot()` all walk
 * `LocatorSpec.strategyChain` tiers OUTER loop, frames INNER loop (main frame first —
 * `page.frames()[0]` is always the main frame), so a tier is tried against every frame before
 * falling through to the next, weaker tier.
 *
 * `act({ref})` (the discovery-style path — not exercised by this task's hand-written artifact,
 * since there's no discovery loop yet, but implemented per `Surface`'s contract) resolves a
 * ref via the map `observe()` most recently built, then hands off to Playwright's own
 * `aria-ref=` selector engine (see snapshot.ts finding #2) — no manual frame bookkeeping
 * needed, since those native refs resolve globally from `this.page` regardless of which frame
 * they actually live in.
 *
 * `resolve()`'s `text_anchor` interpretation (SPEC §6 leaves this to us): tries, in order, (a)
 * `Frame.getByLabel(text, {exact:true})` for the "nearest <label>" form-field case, then (b) an
 * xpath matching a `<td>`/`<th>` whose own text equals the anchor text, returning its
 * immediately-following sibling `<td>` — the "value next to a known label cell" pattern this
 * app's data tables actually use (member detail's "Savings balance" / value pair, etc.).
 * `visual_anchor` is treated as unresolvable via a Playwright locator (no bounding-box-based
 * "click at coordinates" primitive here, per SPEC §16's "do not use screenshot-coordinate
 * clicking as the primary action mechanism") — a real desktop/accessibility-API `Surface`
 * (SPEC §5's REPORT §4) would be where that tier actually earns its keep.
 *
 * Screenshot sizing: rather than a `clip`/resize option on every `screenshot()` call, the
 * CALLER sets the browser viewport to 1280 wide at page-creation time (`cli/replay.ts`), so
 * every screenshot this class takes is naturally ≤1280 wide already — simpler than
 * recomputing a clip region per call, and the SPEC's "≤1280 wide" requirement is about what
 * the model/reviewer sees, not a hard per-call invariant this class must itself enforce.
 */

import type { Frame, Locator as PWLocator, Page } from "playwright";

import type { Locator as LocatorRecord, LocatorSpec } from "../schema/capability";
import { buildSnapshot, type SnapshotRef } from "../perception/snapshot";
import {
  LocatorUnresolvedError,
  type Extraction,
  type Observation,
  type Resolved,
  type Surface,
  type SurfaceAction,
} from "./Surface";

const DEFAULT_TIMEOUT_MS = 5000;

interface ResolvedTarget {
  locator: PWLocator;
  tier: number;
  kind: string;
}

export class PlaywrightSurface implements Surface {
  private readonly page: Page;
  /** Ref map from the MOST RECENT `observe()` call — `act({ref})` resolves against this and
   * only this; refs are turn-scoped by construction (see snapshot.ts finding #2: Playwright's
   * own native refs are invalidated by a navigation/reload, so an `act({ref})` call using a
   * ref from before the last `observe()` will correctly fail to resolve). */
  private lastRefs: Map<string, SnapshotRef> | null = null;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * (Task 7 addition — discovery/recorder threading.) Resolves ref `ref` from the MOST
   * RECENT `observe()` call to its live Playwright `Locator`, or `undefined` if it isn't
   * present or no longer resolves uniquely. Exists so a caller (the discovery loop) can hand
   * this live element to `enrichLocator()` (`src/perception/enrich.ts`) at the exact moment
   * the model acts on it — critically, BEFORE any subsequent navigation, since this app's
   * form POSTs cause full page reloads that invalidate Playwright's own native `aria-ref=`
   * resolution (see snapshot.ts's finding #2). Waiting until after a whole discovery run
   * completes to enrich locators would silently fail for every step before the run's last
   * navigation — so this method is called live, per-turn, not once at the end. See
   * `src/discovery/loop.ts`'s `captureLocators` for the call site.
   */
  async getLocatorForRef(ref: string): Promise<PWLocator | undefined> {
    const info = this.lastRefs?.get(ref);
    if (!info) return undefined;
    const locator = this.page.locator(`aria-ref=${info.nativeRef}`);
    const count = await locator.count().catch(() => 0);
    return count === 1 ? locator : undefined;
  }

  async observe(): Promise<Observation> {
    const snap = await buildSnapshot(this.page);
    this.lastRefs = snap.refs;
    const screenshot = await this.page
      .screenshot({ type: "png", timeout: DEFAULT_TIMEOUT_MS })
      .catch(() => undefined);
    const title = await this.page.title().catch(() => "");
    return {
      url: this.page.url(),
      title,
      snapshotText: snap.snapshotText,
      screenshot,
    };
  }

  async act(action: SurfaceAction): Promise<void> {
    const timeout = action.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (action.kind === "navigate") {
      if (action.value === undefined) {
        throw new Error('act({kind:"navigate"}) requires action.value (a URL)');
      }
      await this.page.goto(action.value, { waitUntil: "domcontentloaded", timeout });
      return;
    }

    if (action.kind === "wait_for") {
      // "wait for this checkpoint before continuing": if a target/ref was given, wait for it
      // to become resolvable (bounded by timeout) — an unresolved target here is a genuine
      // failure (same contract as click/fill). With neither, just settle.
      if (action.target !== undefined || action.ref !== undefined) {
        await this.resolveActingLocator(action);
      }
      await this.waitForSettle(timeout);
      return;
    }

    if (action.kind === "extract") {
      // Reasonable minimal implementation for this task (SPEC: "must not throw for common
      // cases" — the rich discovery-tool version is a later task): confirm the target/ref
      // resolves, no-op beyond that. `readText()` is the real extraction path (used by the
      // executor for `OutputSpec`s), called separately.
      if (action.target !== undefined || action.ref !== undefined) {
        await this.resolveActingLocator(action);
      }
      return;
    }

    // click / fill / select_option
    const locator = await this.resolveActingLocator(action);
    switch (action.kind) {
      case "click":
        await locator.click({ timeout });
        return;
      case "fill":
        if (action.value === undefined) {
          throw new Error('act({kind:"fill"}) requires action.value');
        }
        await locator.fill(action.value, { timeout });
        return;
      case "select_option":
        if (action.value === undefined) {
          throw new Error('act({kind:"select_option"}) requires action.value');
        }
        await locator.selectOption(action.value, { timeout });
        return;
      default:
        throw new Error(`unsupported action.kind: ${String(action.kind)}`);
    }
  }

  /** Resolves the Playwright `Locator` an `act()` call should operate on: `action.ref`
   * (discovery-style, via the last observation's ref map + Playwright's native `aria-ref=`
   * selector) if set, else `action.target` (replay-style, via `resolveTarget`). Throws
   * `LocatorUnresolvedError` — never a generic `Error` — when neither resolves, per the
   * `Surface.act()` contract established in Task 4/5. */
  private async resolveActingLocator(action: SurfaceAction): Promise<PWLocator> {
    if (action.ref !== undefined) {
      const info = this.lastRefs?.get(action.ref);
      if (!info) {
        throw new LocatorUnresolvedError(
          `ref "${action.ref}" is not present in the most recent observation (call observe() first, or it may be stale)`,
        );
      }
      const locator = this.page.locator(`aria-ref=${info.nativeRef}`);
      let count: number;
      try {
        count = await locator.count();
      } catch (err) {
        throw new LocatorUnresolvedError(
          `ref "${action.ref}" (native ${info.nativeRef}) failed to resolve: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (count !== 1) {
        throw new LocatorUnresolvedError(`ref "${action.ref}" no longer resolves uniquely (count=${count})`);
      }
      return locator;
    }

    if (action.target !== undefined) {
      const found = await this.resolveTarget(action.target);
      if (!found) {
        throw new LocatorUnresolvedError();
      }
      return found.locator;
    }

    throw new LocatorUnresolvedError(`act({kind:"${action.kind}"}) requires either action.ref or action.target`);
  }

  async resolve(spec: LocatorSpec): Promise<Resolved | null> {
    const found = await this.resolveTarget(spec);
    return found ? { tier: found.tier, kind: found.kind } : null;
  }

  /** Walks `spec.strategyChain` tiers outer, frames inner (main frame first), returning the
   * first `{locator, tier, kind}` where the candidate resolves to EXACTLY one element. A tier
   * can offer more than one candidate locator (currently only `text_anchor` does — see class
   * doc); each candidate is tried in turn before moving to the next frame.
   *
   * Resolution itself is a bounded, single `count()` pass per candidate — Playwright's
   * `Locator.count()` has no timeout/retry option (it's an immediate check), so there's no
   * `{timeout}` to thread through here. The CALLER's subsequent action (click/fill/etc.) is
   * what carries the real bound, via Playwright's own auto-waiting on that action. */
  private async resolveTarget(spec: LocatorSpec): Promise<ResolvedTarget | null> {
    const frames: Frame[] = this.page.frames();
    for (let tier = 0; tier < spec.strategyChain.length; tier += 1) {
      const loc = spec.strategyChain[tier] as LocatorRecord;
      for (const frame of frames) {
        const candidates = this.buildCandidates(frame, loc);
        for (const candidate of candidates) {
          let count: number;
          try {
            count = await candidate.count();
          } catch {
            continue;
          }
          if (count === 1) {
            return { locator: candidate, tier, kind: loc.kind };
          }
        }
      }
    }
    return null;
  }

  private buildCandidates(frame: Frame, loc: LocatorRecord): PWLocator[] {
    switch (loc.kind) {
      case "role": {
        if (!loc.role) return [];
        try {
          const opts = loc.accessibleName !== undefined ? { name: loc.accessibleName, exact: true } : undefined;
          return [frame.getByRole(loc.role as Parameters<Frame["getByRole"]>[0], opts)];
        } catch {
          return [];
        }
      }
      case "css":
        return loc.selector ? [frame.locator(loc.selector)] : [];
      case "xpath":
        return loc.selector ? [frame.locator(`xpath=${loc.selector}`)] : [];
      case "text_anchor": {
        const text = loc.nearbyText ?? loc.text;
        if (!text) return [];
        const candidates: PWLocator[] = [];
        try {
          candidates.push(frame.getByLabel(text, { exact: true }));
        } catch {
          /* not every anchor text is usable as a getByLabel query (e.g. contains characters
           * that make it an invalid selector fragment internally) — fall through to xpath */
        }
        const escaped = text.replace(/"/g, "&quot;");
        candidates.push(
          frame.locator(
            `xpath=//td[normalize-space(text())="${escaped}"]/following-sibling::td[1] | //th[normalize-space(text())="${escaped}"]/following-sibling::td[1]`,
          ),
        );
        return candidates;
      }
      case "visual_anchor":
        // Not resolvable via a Playwright locator — see class doc comment.
        return [];
      default:
        return [];
    }
  }

  async readText(spec: LocatorSpec, extraction: Extraction = "text", attributeName?: string): Promise<string | null> {
    const found = await this.resolveTarget(spec);
    if (!found) return null;
    try {
      if (extraction === "attribute") {
        if (!attributeName) return null;
        return await found.locator.getAttribute(attributeName, { timeout: DEFAULT_TIMEOUT_MS });
      }
      if (extraction === "value") {
        return await found.locator.inputValue({ timeout: DEFAULT_TIMEOUT_MS });
      }
      return await found.locator.textContent({ timeout: DEFAULT_TIMEOUT_MS });
    } catch {
      return null;
    }
  }

  async screenshot(opts: { maskSpecs: LocatorSpec[] }): Promise<Buffer> {
    const maskLocators: PWLocator[] = [];
    for (const spec of opts.maskSpecs) {
      const found = await this.resolveTarget(spec).catch(() => null);
      if (found) maskLocators.push(found.locator);
    }
    return this.page.screenshot({
      type: "png",
      mask: maskLocators.length > 0 ? maskLocators : undefined,
      timeout: DEFAULT_TIMEOUT_MS,
    });
  }

  currentUrl(): string {
    return this.page.url();
  }

  async waitForSettle(timeoutMs: number): Promise<void> {
    // Bounded wait that gives up rather than throws — SPEC §8's determinism rule is "bounded",
    // not "must never time out" (a real network hang must not hang the run forever, but it
    // also shouldn't be treated as an error at this layer; the caller's own checkpoint/outcome
    // detection is what decides whether the page actually ended up somewhere useful).
    await this.page.waitForLoadState("networkidle", { timeout: timeoutMs }).catch(() => undefined);
  }
}
