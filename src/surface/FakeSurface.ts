/**
 * FakeSurface — the shared test substrate for THIS task (guardrails) and the NEXT task
 * (the replay engine: executor.ts, locate.ts, outcomes.ts). No test in this codebase drives
 * a real browser; every executor/outcome/guardrail test scripts a sequence of `FakePageState`s
 * and asserts against `recordedActions` / thrown errors instead.
 *
 * Because it is shared with a task this one doesn't implement, its API is intentionally a
 * little more general than THIS task alone needs — e.g. `advance()` for tests that want to
 * move between scripted states independently of what `act()` would do, and the tier-by-tier
 * `resolves` predicate exists mainly so the next task's `test/locate.test.ts` can script
 * "tier 0 fails, tier 1 resolves" scenarios precisely.
 */

import type {
  Extraction,
  Observation,
  Resolved,
  Surface,
  SurfaceAction,
} from "./Surface";
import { LocatorUnresolvedError } from "./Surface";
import type { Locator, LocatorSpec } from "../schema/capability";

export interface FakeElement {
  ref: string; // "e0", "e1", ...
  role: string;
  name?: string;
  text?: string;
}

export interface FakePageState {
  url: string;
  title: string;
  snapshotText: string;
  elements?: FakeElement[];
  /**
   * Programmable resolve behavior for this state: given one Locator from a strategyChain and
   * its index (tier) within that chain, return true if this fake page would resolve at that
   * tier. Tests use this to simulate "tier 0 fails, tier 1 resolves" scenarios precisely,
   * regardless of what the locator's actual role/selector/etc. content is. If a state omits
   * `resolves` entirely, every LocatorSpec against it resolves to null (nothing matches).
   */
  resolves?: (locator: Locator, tier: number) => boolean;
  /**
   * Optional map from a stable key to a text value `readText()` can return, for extraction
   * tests. Key convention (tests should follow this when authoring `texts`): the FIRST of
   * the following that is defined on the LocatorSpec being read, in order —
   *   1. `spec.rationale` (if the test set one, e.g. "balance-field")
   *   2. the first strategyChain locator's `accessibleName`
   *   3. the first strategyChain locator's `text`
   *   4. the first strategyChain locator's `selector`
   * `readText()` tries each candidate key in that order and returns the first that has an
   * entry in `texts`, or null if none do.
   */
  texts?: Record<string, string>;
}

/** Thrown by FakeSurface constructor/advance when there is no scripted state left. */
export class NoScriptedStateError extends Error {
  constructor(message = "FakeSurface has no scripted page state") {
    super(message);
    this.name = "NoScriptedStateError";
  }
}

export class FakeSurface implements Surface {
  /** Every act() call, in order, for test assertions. */
  public readonly recordedActions: SurfaceAction[] = [];

  private readonly states: FakePageState[];
  private index = 0;

  constructor(states: FakePageState[]) {
    if (states.length === 0) {
      throw new NoScriptedStateError("FakeSurface requires at least one FakePageState");
    }
    this.states = states;
  }

  private get current(): FakePageState {
    return this.states[this.index] as FakePageState;
  }

  /** Manually move to the next scripted state, for tests wanting fine control. */
  advance(): void {
    if (this.index < this.states.length - 1) {
      this.index += 1;
    }
  }

  async observe(): Promise<Observation> {
    const state = this.current;
    return { url: state.url, title: state.title, snapshotText: state.snapshotText };
  }

  async act(action: SurfaceAction): Promise<void> {
    if (action.target) {
      const resolved = await this.resolve(action.target);
      if (!resolved) {
        throw new LocatorUnresolvedError(
          `no strategy in the locator chain resolved for action.kind=${action.kind}`,
        );
      }
    }
    this.recordedActions.push(action);
    if (action.kind === "navigate") {
      this.advance();
    }
  }

  async resolve(spec: LocatorSpec): Promise<Resolved | null> {
    const state = this.current;
    if (!state.resolves) {
      return null;
    }
    for (let tier = 0; tier < spec.strategyChain.length; tier += 1) {
      const locator = spec.strategyChain[tier] as Locator;
      if (state.resolves(locator, tier)) {
        return { tier, kind: locator.kind };
      }
    }
    return null;
  }

  async readText(
    spec: LocatorSpec,
    _extraction?: Extraction,
    _attributeName?: string,
  ): Promise<string | null> {
    const state = this.current;
    if (!state.texts) {
      return null;
    }
    const first = spec.strategyChain[0];
    const candidateKeys = [
      spec.rationale,
      first?.accessibleName,
      first?.text,
      first?.selector,
    ].filter((k): k is string => typeof k === "string");
    for (const key of candidateKeys) {
      if (key in state.texts) {
        return state.texts[key] as string;
      }
    }
    return null;
  }

  async screenshot(_opts: { maskSpecs: LocatorSpec[] }): Promise<Buffer> {
    return Buffer.from("");
  }

  currentUrl(): string {
    return this.current.url;
  }

  async waitForSettle(_timeoutMs: number): Promise<void> {
    // no-op: fake time never needs to be waited out
  }
}
