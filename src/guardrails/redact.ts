/**
 * The single redaction choke point (SPEC §9): the JSONL logger, snapshots, and transcripts
 * all pass through `redact` / `redactDeep` before anything is written to disk.
 */

import type { Policy } from "./policy";

export const REDACTED_MARKER = "[REDACTED]";

// Module-level registries of literal values that must never appear in logs. Populated by
// the discovery/replay code (a later task) as it resolves secrets and pii param/output
// values; read by `redact`/`redactDeep` here.
const secretValues = new Set<string>();
const piiValues = new Set<string>();

export function registerSecretValue(value: string): void {
  if (value.length > 0) {
    secretValues.add(value);
  }
}

export function registerPiiValue(value: string): void {
  if (value.length > 0) {
    piiValues.add(value);
  }
}

/** Test-only escape hatch: clears both registries so tests don't leak values into each other. */
export function clearRegistry(): void {
  secretValues.clear();
  piiValues.clear();
}

/**
 * Escapes a literal string for safe embedding inside a RegExp (so we can do a global
 * replace of an exact registered value without treating it as a pattern).
 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Scrubs `input`: (a) every registered secret/pii value, replaced by `REDACTED_MARKER`,
 * THEN (b) every regex in `policy.redaction.patterns`, likewise replaced.
 *
 * Order: exact-value scrubbing first, then pattern scrubbing. This is safer than the
 * reverse: a registered secret value might otherwise partially survive a pattern replace
 * (e.g. a pattern regex that only matches part of the secret's shape) and be left exposed
 * in the "leftover" fragment, or a pattern's replacement could itself reintroduce
 * characters that coincidentally match another registered value. Scrubbing exact known
 * values FIRST guarantees they're gone before any pattern-driven rewriting touches the
 * string at all.
 *
 * Within step (a), registered values are sorted longest-first before replacing. Doing one
 * `.replace()` pass per value in arbitrary (Set insertion) order is unsafe when one
 * registered value is a prefix of another registered later: replacing the shorter value
 * first partially consumes the longer value's occurrence (turning it into
 * `REDACTED_MARKER` + the longer value's unmatched suffix), and the longer value's own pass
 * then finds nothing left to match, so its suffix survives unredacted. E.g. registering
 * "pass1" then "pass12345" and scrubbing "...password pass12345..." must not leak "2345".
 * Longest-first ensures the longer (more specific) value is always matched whole before a
 * shorter value that happens to be one of its prefixes gets a chance to fragment it.
 */
export function redact(input: string, policy: Policy): string {
  let result = input;

  const exactValues = [...secretValues, ...piiValues].sort((a, b) => b.length - a.length);
  for (const value of exactValues) {
    const re = new RegExp(escapeRegExp(value), "g");
    result = result.replace(re, REDACTED_MARKER);
  }

  for (const pattern of policy.redaction.patterns) {
    const re = new RegExp(pattern.regex, "g");
    result = result.replace(re, REDACTED_MARKER);
  }

  return result;
}

/**
 * Recursively walks a plain object/array/string, applying `redact()` to every string found.
 * Numbers/booleans/null pass through untouched. Returns a new structure; never mutates
 * `value`. This is what `EvidenceLogger` uses on whole log entries.
 */
export function redactDeep(value: unknown, policy: Policy): unknown {
  if (typeof value === "string") {
    return redact(value, policy);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, policy));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = redactDeep(val, policy);
    }
    return out;
  }
  // number, boolean, null, undefined — untouched
  return value;
}

/**
 * Currently a pass-through seam, NOT dead code: it exists so `Surface.screenshot()`
 * implementations (a later task's `PlaywrightSurface`) have a single, stable call site to
 * build a screenshot mask list from. The actual "which outputs/inputs are pii" filtering
 * happens in a later recorder/executor task BEFORE calling this — by the time a caller has
 * a `LocatorSpec[]` to hand in here, it has already decided those are the specs that need
 * masking. This function's job, once that filtering exists, may grow to deduplicate or
 * validate the list; for now it simply returns what it's given.
 */
export function buildMaskSpecs(
  specs: import("../schema/capability").LocatorSpec[],
): import("../schema/capability").LocatorSpec[] {
  return specs;
}
