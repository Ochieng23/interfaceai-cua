/**
 * `Surface` is THE seam (SPEC §5): the only interface through which anything in this
 * codebase — the discovery loop, the replay executor, the escalation/operator machinery —
 * touches a live application. No caller ever imports Playwright (or any other automation
 * engine) directly; they depend on this interface, and on `GuardedSurface` which wraps it.
 *
 * There is exactly one real implementation planned (`PlaywrightSurface`, a later task) and
 * one test implementation (`FakeSurface`, this task) — both satisfy this file unchanged.
 * Nothing in here may assume anything Node-specific-to-testing (e.g. that a "page" has an
 * `elements` array) — that's `FakePageState`'s business, not `Surface`'s.
 */

import type { LocatorSpec } from "../schema/capability";

/** What a caller sees after asking the surface to look at the current page. */
export interface Observation {
  url: string;
  title: string;
  /**
   * A numbered-ref textual snapshot, e.g. "e0: button 'Search'\ne1: textbox 'Member ID'\n...".
   * Full perception (building this from a real accessibility tree) is a later task; for now
   * this is just an opaque string field other code can read, log, and pass around.
   */
  snapshotText: string;
  /** Optional. `FakeSurface` may omit this or return an empty buffer. */
  screenshot?: Buffer;
}

export type SurfaceActionKind = "click" | "fill" | "select_option" | "navigate" | "wait_for" | "extract";

export interface SurfaceAction {
  kind: SurfaceActionKind;
  /** Discovery-time numbered ref (e.g. "e3") — set when acting on a live observation. */
  ref?: string;
  /** Replay-time strategy chain — set when acting deterministically from a recorded Capability. */
  target?: LocatorSpec;
  /**
   * Fill text / select_option value / navigate URL. May literally be the string
   * "{{secret:NAME}}" — `GuardedSurface` must substitute this before it reaches the real
   * surface (see GuardedSurface.ts). A bare `Surface` implementation (FakeSurface,
   * PlaywrightSurface) never interprets this pattern itself; substitution is exclusively
   * GuardedSurface's job.
   */
  value?: string;
  timeoutMs?: number;
  /**
   * Pre-classified risk of this action, when known (set by a caller — e.g. a replay
   * executor reading step.risk, or the discovery loop's own live classification).
   * Undefined defaults to "reversible" for guardrail purposes.
   */
  risk?: "safe" | "reversible" | "irreversible";
  /** For kind:"extract", a name to attach to the extracted value (candidate OutputSpec name). */
  extractName?: string;
}

/** Which tier of a `LocatorSpec.strategyChain` matched, and what kind it was. */
export interface Resolved {
  /** Index into `LocatorSpec.strategyChain` that matched. */
  tier: number;
  /** The `Locator.kind` at that tier (e.g. "role", "css"). */
  kind: string;
}

export type Extraction = "text" | "attribute" | "value";

/**
 * Thrown when `act()` is given an `action.target` (a LocatorSpec) whose strategy chain does
 * not resolve against the current page — at ANY tier. Implementations must throw this
 * specific type (never a generic Error) so a later replay executor can catch it and set
 * `ReplayResult.failureClass = "locator_unresolved"`.
 */
export class LocatorUnresolvedError extends Error {
  constructor(message = "no strategy in the locator chain resolved") {
    super(message);
    this.name = "LocatorUnresolvedError";
  }
}

export interface Surface {
  observe(): Promise<Observation>;

  /**
   * Perform a state-changing action. Behavioral contract: when `action.target` (a
   * LocatorSpec) is given, the implementation must internally resolve it (equivalent to
   * calling its own `resolve(action.target)`); if nothing resolves, it MUST throw
   * `LocatorUnresolvedError` rather than silently no-op or throw a generic Error.
   */
  act(action: SurfaceAction): Promise<void>;

  /** Walk `spec.strategyChain` and report the first tier that resolves, or null if none do. */
  resolve(spec: LocatorSpec): Promise<Resolved | null>;

  readText(spec: LocatorSpec, extraction?: Extraction, attributeName?: string): Promise<string | null>;

  /** `maskSpecs` identifies elements (e.g. pii outputs) that must be visually masked. */
  screenshot(opts: { maskSpecs: LocatorSpec[] }): Promise<Buffer>;

  currentUrl(): string;

  waitForSettle(timeoutMs: number): Promise<void>;
}
