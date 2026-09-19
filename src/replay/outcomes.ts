/**
 * Outcome detection (SPEC §8, "Outcome detection order") and recovery application.
 *
 * Detection order, first match wins:
 *   1. Declared `OutcomeSpec`s, walked in `capability.outcomes` array order.
 *   2. The generic detector (only reached if nothing declared matched) — an alert/error
 *      surfaced by the app that nobody bothered to declare as an `OutcomeSpec`.
 *   3. Nothing matched at all.
 *
 * Declared-beats-generic is the safety property under test in `test/outcomes.test.ts`: a
 * capability author's explicit classification of a known condition (e.g. "this 'not found'
 * banner is actually a business outcome, not a failure") must always win over the generic
 * fallback, even when the generic regex would also match the same page text.
 */

import type { Checkpoint, OutcomeSpec } from "../schema/capability";
import type { Observation, Surface } from "../surface/Surface";
import { evaluateCheckpoint } from "./checkpoint";

export type OutcomeDetectionResult =
  | { matched: false }
  | { matched: true; outcome: OutcomeSpec; source: "declared" }
  | { matched: true; source: "generic"; failureClass: "unknown_condition" };

/**
 * SPEC §8's generic-detector regex: visible text matching any of these signals an
 * error/denial/timeout condition nobody declared an `OutcomeSpec` for.
 */
const GENERIC_TEXT_RE = /error|denied|not found|session (expired|timed out)|try again/i;

/**
 * Convention pending a later perception task's structured snapshot format: an
 * alert/alertdialog role is represented in snapshotText as the literal substring
 * "role=alert" or "role=alertdialog". FakeSurface tests can construct snapshotText
 * containing this to exercise the generic detector's alert-role path.
 */
const ALERT_ROLE_MARKERS = ["role=alert", "role=alertdialog"];

function hasGenericSignal(snapshotText: string): boolean {
  if (GENERIC_TEXT_RE.test(snapshotText)) {
    return true;
  }
  return ALERT_ROLE_MARKERS.some((marker) => snapshotText.includes(marker));
}

export async function detectOutcome(
  observation: Observation,
  outcomes: OutcomeSpec[],
  surface: Surface,
): Promise<OutcomeDetectionResult> {
  // 1. Declared outcomes, in artifact order — first match wins.
  for (const outcome of outcomes) {
    const isMatch = await evaluateCheckpoint(outcome.detection as Checkpoint, observation, surface);
    if (isMatch) {
      return { matched: true, outcome, source: "declared" };
    }
  }

  // 2. Generic detector — only reached when no declared outcome matched.
  if (hasGenericSignal(observation.snapshotText)) {
    return { matched: true, source: "generic", failureClass: "unknown_condition" };
  }

  // 3. Nothing matched.
  return { matched: false };
}

export type RecoveryResult = "recovered" | "exhausted";

/**
 * Applies one recovery attempt for a `recoverable`-classified declared outcome match.
 *
 * Boundary semantics (the executor is responsible for incrementing `attemptNumber` across
 * calls and for re-running `detectOutcome` after each call to decide whether to call again):
 * `attemptNumber` is 1-based. A call is "exhausted" — and performs NO recovery action at
 * all — once `attemptNumber > outcome.maxRetries`. So `maxRetries: 2` permits exactly two
 * `applyRecovery` calls to actually run (`attemptNumber` 1 and 2); the third call
 * (`attemptNumber` 3) is the one that reports `"exhausted"`. `maxRetries: 0` means no
 * recovery attempt ever runs — the very first call (`attemptNumber` 1) is already exhausted.
 */
export async function applyRecovery(
  outcome: OutcomeSpec,
  surface: Surface,
  retryStepAction: () => Promise<void>,
  attemptNumber: number,
): Promise<RecoveryResult> {
  if (attemptNumber > outcome.maxRetries) {
    return "exhausted";
  }

  switch (outcome.recoveryAction) {
    case "dismiss": {
      if (outcome.recoveryTarget) {
        await surface.act({ kind: "click", target: outcome.recoveryTarget, risk: "reversible" });
      }
      break;
    }
    case "retry": {
      await retryStepAction();
      break;
    }
    case "wait_and_retry": {
      await surface.waitForSettle(outcome.maxRetries > 0 ? 1000 : 0);
      await retryStepAction();
      break;
    }
    case "none":
    default: {
      // Nothing to do — a declared outcome with no recovery action just gets re-detected
      // by the caller on the next loop iteration (which, since nothing changed, will
      // presumably match the same outcome again and exhaust on a later attempt).
      break;
    }
  }

  return "recovered";
}
