/**
 * `classifyReplayStuckReason` — a small, documented, and independently testable
 * classification module (SPEC §10). It does NOT decide whether to escalate, and it does not
 * reimplement any control flow that already lives in `src/replay/executor.ts` /
 * `src/surface/GuardedSurface.ts` — the actual TRIGGERING of an escalation already happens
 * there (see `executor.ts`'s `requestEscalation` call sites: `ControlNotOwnedError` /
 * `EscalationRequired` from `GuardedSurface`, the generic outcome detector's
 * `unknown_condition` match, and Task 8's new `locator_unresolved` call site). This module's
 * only job is to turn whatever context is available about WHY an escalation fired into a
 * stable, human-readable reason string for `InterventionRequest.reason` — centralized here so
 * it isn't duplicated/reworded ad hoc at each call site, and so it's testable on its own
 * without spinning up a browser or an executor run.
 *
 * SPEC §10's three replay stuck conditions, in the order this function checks them:
 *   1. `--inject stuck` (dev-only failure injection) — signaled via `ctx.devInjected`.
 *   2. Any `failure` whose class is `unknown_condition` OR `locator_unresolved` — the generic
 *      outcome detector firing, or a step's own locator never resolving even after a final
 *      outcome-detection recheck.
 *   3. An `irreversible` step under `irreversible_policy: "escalate"` on a capability that
 *      isn't yet `status: "approved"`.
 * Returns `null` when none of these match (a caller passing an empty/unrecognized `ctx`).
 */

export interface ReplayStuckContext {
  failureClass?: string;
  stepRisk?: string;
  irreversiblePolicy?: string;
  capabilityStatus?: string;
  devInjected?: boolean;
}

export function classifyReplayStuckReason(ctx: ReplayStuckContext): string | null {
  if (ctx.devInjected) {
    return (
      "dev-only failure injection (--inject stuck): the app rendered an interstitial whose " +
      "forward control has a randomized-per-render accessible name that can never stably " +
      "resolve — this is deliberately unrecoverable by automation and requires a human to " +
      "act on the live page."
    );
  }

  if (ctx.failureClass === "unknown_condition") {
    return (
      "the generic outcome detector matched an undeclared alert/error/denied/not-found/" +
      "session-expired condition (or an unexplained checkpoint/fingerprint mismatch) that no " +
      "declared OutcomeSpec accounts for — requires human judgment to classify or unblock."
    );
  }

  if (ctx.failureClass === "locator_unresolved") {
    return (
      "the step's own locator strategy chain did not resolve against the live page, even " +
      "after a final outcome-detection recheck found no declared or generic condition to " +
      "explain it — this may be a randomized/dynamic element or a genuine app change; a " +
      "human needs to look at the live page."
    );
  }

  if (ctx.stepRisk === "irreversible" && ctx.irreversiblePolicy === "escalate" && ctx.capabilityStatus !== "approved") {
    return (
      "an irreversible step requires human approval before proceeding: this capability is " +
      "not yet status \"approved\" and policy.yaml's risk.irreversible_policy is \"escalate\"."
    );
  }

  return null;
}
