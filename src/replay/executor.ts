/**
 * The replay executor — SPEC §8's deterministic, LLM-free core loop that re-executes a
 * recorded `Capability` against a live `Surface`. Nothing in this file (or anywhere under
 * `src/replay/`) may import the Anthropic SDK package, directly or transitively (SPEC
 * §0.5): everything here operates purely on the `Surface` interface and the Zod-derived
 * schema types from `src/schema/`.
 *
 * Control-ownership and irreversible-action guarding are NOT reimplemented here — they
 * already live in `GuardedSurface.act()` (SPEC §9), which throws `ControlNotOwnedError`,
 * `EscalationRequired`, and `PolicyViolation`. Callers pass a `GuardedSurface` instance
 * typed as `Surface`; this file catches those specific error classes and translates them
 * into SPEC §8's "control check"/"guard check" outcomes:
 *   - `ControlNotOwnedError` | `EscalationRequired`  → needs human escalation (see
 *     `ExecutorHooks.onEscalationNeeded`).
 *   - `PolicyViolation`                               → `failureClass: "policy_blocked"`,
 *     hard failure, no retry.
 *   - `LocatorUnresolvedError`                         → one more outcome-detection attempt,
 *     then `failureClass: "locator_unresolved"` if still nothing.
 */

import { createHash } from "node:crypto";

import type { Capability, InputParamSpec, OutcomeSpec, Step } from "../schema/capability";
import type { ReplayResult, StepTrace } from "../schema/result";
import type { Observation, Surface, SurfaceAction } from "../surface/Surface";
import { LocatorUnresolvedError } from "../surface/Surface";
import { ControlNotOwnedError, EscalationRequired } from "../surface/GuardedSurface";
import { PolicyViolation } from "../guardrails/policy";
import { registerPiiValue } from "../guardrails/redact";
import type { EvidenceLogger } from "../evidence/logger";
import { locateStep } from "./locate";
import { evaluateCheckpoint } from "./checkpoint";
import { detectOutcome, applyRecovery, type OutcomeDetectionResult } from "./outcomes";

// ---------------------------------------------------------------------------------------
// Escalation hook (pluggable — SPEC §10's real control.json/operator machinery is a later
// task; this task only needs the seam to exist and behave correctly under a stub).
// ---------------------------------------------------------------------------------------

export type EscalationOutcome = "resumed" | "aborted";

export interface EscalationInfo {
  runId: string;
  stepId: string;
  stepDescription: string;
  reason: string;
  currentUrl: string;
}

export interface ExecutorHooks {
  /**
   * Called whenever the executor needs a human to intervene (an irreversible/ownership
   * escalation from `GuardedSurface`, or the generic outcome detector firing). Default
   * (when not provided): every escalation is immediately treated as `"aborted"` — a safe,
   * deterministic default for tests and for any caller that hasn't wired up real
   * human-in-the-loop handling yet. A later task passes a real hook that does actual
   * control.json polling / operator handoff and can return `"resumed"`.
   */
  onEscalationNeeded?: (info: EscalationInfo) => Promise<EscalationOutcome>;
}

const defaultOnEscalationNeeded: NonNullable<ExecutorHooks["onEscalationNeeded"]> = async () => "aborted";

// ---------------------------------------------------------------------------------------
// Fingerprint hook (pluggable — the real ARIA-based fingerprint, SPEC §6, is a later
// perception task; this task provides a sensible default so replay can run end to end).
// ---------------------------------------------------------------------------------------

export type FingerprintFn = (observation: Observation) => string;

/** Default: sha256 of `observation.snapshotText`. A later perception task formalizes the
 * real ARIA-based fingerprint (sha256 of sorted role|name pairs) into
 * `src/perception/fingerprint.ts` and passes it in via `ExecutorOptions.fingerprintFn`. */
export const defaultFingerprintFn: FingerprintFn = (observation) =>
  createHash("sha256").update(observation.snapshotText).digest("hex");

// ---------------------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------------------

export interface ExecutorOptions {
  runId: string;
  fingerprintFn?: FingerprintFn;
  hooks?: ExecutorHooks;
  logger?: EvidenceLogger;
  /**
   * Optional tenant id (mirrors the CLI's `--tenant` flag, SPEC §8). `tenantOverrides`
   * step/param merging happens in the CALLER (Task 9's `cli/replay.ts`) before the
   * capability ever reaches this function — by the time we see `capability`, its steps
   * already reflect the merge. This field is consulted ONLY for the fingerprint-mismatch
   * branch: "if tenant override exists: proceed with it, log fingerprint_mismatch_overridden"
   * — i.e. if the capability declares an override entry for this tenant at all, a
   * fingerprint mismatch is treated as an expected tenant-branding difference rather than a
   * failure.
   */
  tenant?: string;
  /**
   * Task 9 evidence hook (SPEC §11: screenshots "every N steps + always on failure",
   * `snapshot-<step>.txt` on failure). Added with the SAME discipline as Task 8's
   * `locator_unresolved` change: optional, defaults to a no-op, never alters control flow
   * or `ReplayResult`, and is invoked from exactly two places in the step loop below — once
   * per step's SUCCESS path (right after its `StepTrace` is pushed) and once on a
   * checkpoint-FAILURE exit (with a synthesized `StepTrace` carrying
   * `checkpointPassed: false`, built right before `finish()` returns). Both call sites reuse
   * an `Observation` already fetched earlier in the same iteration rather than calling
   * `surface.observe()` again. Errors thrown by the hook are swallowed (best-effort,
   * evidence-writing must never break a replay run) — same pattern as the screenshot/snapshot
   * writes in `src/escalation/session.ts`'s `createEscalationHook`.
   */
  onStepTrace?: (trace: StepTrace, observation: Observation) => Promise<void> | void;
}

export async function executeCapability(
  capability: Capability,
  params: Record<string, string | number | boolean>,
  surface: Surface,
  options: ExecutorOptions,
): Promise<ReplayResult> {
  const startedAt = new Date().toISOString();
  const fingerprintFn = options.fingerprintFn ?? defaultFingerprintFn;
  const onEscalationNeeded = options.hooks?.onEscalationNeeded ?? defaultOnEscalationNeeded;
  const logger = options.logger;

  const stepTraces: StepTrace[] = [];
  const recoveriesApplied: string[] = [];

  // The SOLE enforcement point for "never retry an irreversible step's own action"
  // (SPEC §8). `performOneAct` below is the only function in this file that ever calls
  // `surface.act()` for a step's own action — every call site (the initial attempt, the
  // escalation-resume retry, and the recoverable-outcome recovery retry) funnels through
  // it. Tracking "already attempted" here, keyed by step id, means the invariant holds by
  // construction for ANY caller, present or future, without each caller having to
  // remember to re-check `step.risk` itself — which is exactly the structural gap that
  // let the recoverable-outcome recovery path retry an irreversible step in the first
  // place (it was the one call site that forgot to check). Scoped to this run only (a
  // fresh Set per `executeCapability` call), not persisted across runs.
  const irreversibleStepsAttempted = new Set<string>();

  // ---- pii registration up front, before ANYTHING is logged (per architecture decision) ----
  for (const p of capability.inputParams) {
    if (p.pii && Object.prototype.hasOwnProperty.call(params, p.name)) {
      registerPiiValue(String(params[p.name]));
    }
  }

  function finish(partial: Partial<ReplayResult> & Pick<ReplayResult, "status">): ReplayResult {
    return {
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      runId: options.runId,
      outputs: {},
      recoveriesApplied,
      stepTraces,
      evidencePaths: [],
      startedAt,
      finishedAt: new Date().toISOString(),
      ...partial,
    };
  }

  function log(entry: Record<string, unknown>): void {
    logger?.log({ runId: options.runId, capabilityId: capability.id, ...entry });
  }

  /** Best-effort invocation of `options.onStepTrace` — see its doc comment on
   * `ExecutorOptions` for the backward-compatibility contract. Never throws. */
  async function emitStepTrace(trace: StepTrace, observation: Observation): Promise<void> {
    if (!options.onStepTrace) return;
    try {
      await options.onStepTrace(trace, observation);
    } catch {
      // Evidence capture must never break the run itself.
    }
  }

  function renderTemplate(template: string): string {
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
    );
  }

  function findParamSpec(name: string): InputParamSpec | undefined {
    return capability.inputParams.find((p) => p.name === name);
  }

  function buildAction(step: Step): SurfaceAction {
    const action: SurfaceAction = {
      kind: step.action,
      target: step.target,
      timeoutMs: step.timeoutMs,
      risk: step.risk,
    };
    if (step.valueLiteral !== undefined) {
      action.value = step.valueLiteral;
    } else if (step.paramRef !== undefined) {
      const spec = findParamSpec(step.paramRef);
      if (spec?.type === "secret") {
        // Literal placeholder — GuardedSurface substitutes the real value from process.env
        // right before it reaches the real surface. We never touch process.env ourselves,
        // and the real secret value never exists in this function's memory.
        action.value = `{{secret:${step.paramRef}}}`;
      } else {
        const raw = params[step.paramRef];
        action.value = raw === undefined ? undefined : String(raw);
      }
    }
    return action;
  }

  // ---- escalation plumbing --------------------------------------------------------------

  async function requestEscalation(step: Step, reason: string): Promise<EscalationOutcome> {
    const currentUrl = surface.currentUrl();
    log({ event: "escalation_requested", stepId: step.id, reason, currentUrl });
    const outcome = await onEscalationNeeded({
      runId: options.runId,
      stepId: step.id,
      stepDescription: step.description,
      reason,
      currentUrl,
    });
    log({ event: "escalation_resolved", stepId: step.id, outcome });
    return outcome;
  }

  /** Re-observe and decide whether the step's own precondition is now satisfied (e.g. a
   * human already completed it while in control). Conservative default when there's no
   * checkpoint to check against: not satisfied (so the caller falls back to a single retry
   * rather than silently skipping a step we have no positive signal was completed). */
  async function isStepPreconditionSatisfied(step: Step): Promise<boolean> {
    const obs = await surface.observe();
    if (step.checkpoint) {
      return evaluateCheckpoint(step.checkpoint, obs, surface);
    }
    return false;
  }

  // ---- single one-shot locate+act attempt (never loops, never retries by itself) --------

  type OneActResult =
    | { kind: "ok"; resolvedTier: number | null; resolvedKind: string | null }
    | { kind: "policy"; message: string }
    | { kind: "escalate"; message: string }
    | { kind: "locator_unresolved" }
    | { kind: "other"; message: string }
    | { kind: "refused" }; // structural guard fired — see irreversibleStepsAttempted above

  /**
   * The funnel: the only place `surface.act()` is ever called for a step's own action.
   * `step.risk === "irreversible"` steps get exactly one real attempt, ever, for this run
   * — enforced here via `irreversibleStepsAttempted`, not by trusting each caller to check
   * `step.risk` itself. A second call for the same irreversible step id short-circuits to
   * `{ kind: "refused" }` before doing anything else (no locate, no act, no side effects).
   */
  async function performOneAct(step: Step): Promise<OneActResult> {
    if (step.risk === "irreversible") {
      if (irreversibleStepsAttempted.has(step.id)) {
        return { kind: "refused" };
      }
      irreversibleStepsAttempted.add(step.id);
    }

    let resolvedTier: number | null = null;
    let resolvedKind: string | null = null;
    if (step.target) {
      const resolved = await locateStep(surface, step.target);
      resolvedTier = resolved?.tier ?? null;
      resolvedKind = resolved?.kind ?? null;
    }

    const action = buildAction(step);

    try {
      await surface.act(action);
      return { kind: "ok", resolvedTier, resolvedKind };
    } catch (err) {
      if (err instanceof PolicyViolation) {
        return { kind: "policy", message: err.message };
      }
      if (err instanceof ControlNotOwnedError || err instanceof EscalationRequired) {
        return { kind: "escalate", message: err.message };
      }
      if (err instanceof LocatorUnresolvedError) {
        return { kind: "locator_unresolved" };
      }
      // TODO(next task, PlaywrightSurface): a real timeout (Playwright's own auto-wait
      // exceeding step.timeoutMs) currently falls into this generic branch and gets
      // failureClass "unknown_condition" like everything else uncategorized. Once
      // PlaywrightSurface exists, have it throw/expose a distinguishable timeout error (or
      // map it here) so ReplayResult.failureClass can be "timeout" specifically — a human
      // debugging a stuck run needs to tell "genuinely unknown condition" apart from
      // "the element/action just never settled in time."
      return { kind: "other", message: err instanceof Error ? err.message : String(err) };
    }
  }

  type ActOutcome =
    | { kind: "ok"; resolvedTier: number | null; resolvedKind: string | null }
    | { kind: "exit"; result: ReplayResult }
    | { kind: "resolved_by_human" }
    | { kind: "locator_unresolved" };

  /**
   * Drives `performOneAct` to completion for `step`, handling escalation-shaped errors.
   *
   * This function does NOT itself decide whether a retry is allowed for an irreversible
   * step — it always asks `performOneAct` for the single allowed same-step retry after a
   * "resumed" escalation that didn't satisfy the step's precondition, and reacts to
   * whatever `performOneAct` reports. For an irreversible step whose one attempt already
   * happened, that means the retry call comes back `{ kind: "refused" }` (the structural
   * guard inside `performOneAct` — see `irreversibleStepsAttempted` above), which is
   * handled by falling back to "keep asking the escalation hook" rather than exiting or
   * looping forever. The net effect is unchanged from before: at most one extra
   * `performOneAct` call ever happens per step, and for an irreversible step it never
   * actually reaches `surface.act()` a second time — but that guarantee now lives in one
   * place (`performOneAct`) instead of being re-derived here from `step.risk`.
   */
  async function attemptStepAction(step: Step): Promise<ActOutcome> {
    let current = await performOneAct(step);
    let usedRetry = false;

    for (;;) {
      if (current.kind === "ok") {
        return { kind: "ok", resolvedTier: current.resolvedTier, resolvedKind: current.resolvedKind };
      }
      if (current.kind === "policy") {
        return {
          kind: "exit",
          result: finish({
            status: "failure",
            failureClass: "policy_blocked",
            failedStepId: step.id,
            observed: current.message,
          }),
        };
      }
      if (current.kind === "locator_unresolved") {
        return { kind: "locator_unresolved" };
      }
      if (current.kind === "other") {
        return {
          kind: "exit",
          result: finish({
            status: "failure",
            failureClass: "unknown_condition",
            failedStepId: step.id,
            observed: current.message,
          }),
        };
      }
      if (current.kind === "refused") {
        // The structural guard fired: no further real attempt is possible for this step.
        // React exactly as if no retry were allowed — keep asking the escalation hook
        // rather than calling `surface.act()` again (there is no way to reach this branch
        // without already having gone through the "escalate" branch at least once, so
        // falling back into it here is safe and keeps the human-in-the-loop UX unchanged).
        current = { kind: "escalate", message: "step action already attempted this run; refusing to retry" };
        continue;
      }

      // current.kind === "escalate"
      const escalationOutcome = await requestEscalation(step, current.message);
      if (escalationOutcome === "aborted") {
        return {
          kind: "exit",
          result: finish({ status: "escalated", failedStepId: step.id, observed: current.message }),
        };
      }

      recoveriesApplied.push(`human_intervention:${step.id}`);
      const satisfied = await isStepPreconditionSatisfied(step);
      if (satisfied) {
        return { kind: "resolved_by_human" };
      }

      if (!usedRetry) {
        usedRetry = true;
        current = await performOneAct(step); // the one allowed retry attempt; performOneAct
        // itself decides whether this is actually safe to perform (see "refused" above).
        continue;
      }

      // The one allowed retry has already been used: never call act() again. Keep looping
      // through the escalation hook only — bounded by whatever the hook does (the default
      // hook aborts on the very first ask, so this never spins in practice unless a caller
      // supplies a hook that keeps saying "resumed" forever).
      current = { kind: "escalate", message: current.message };
    }
  }

  /**
   * `retryStepAction` closure handed to `applyRecovery` for a `recoverable` outcome's
   * "retry"/"wait_and_retry" recovery action — re-does the step's own action once, via the
   * same `performOneAct` funnel that enforces the irreversible-step guard. The returned
   * `refusalFlag` lets the caller (`handleDetection`) find out, AFTER the fact, whether
   * `performOneAct` actually refused the attempt (irreversible step, already attempted) —
   * so it can treat that as an immediate exhaustion instead of logging a misleading
   * `recoveriesApplied` entry claiming a retry happened when it was silently refused.
   */
  function makeRetryStepAction(step: Step): {
    retryStepAction: () => Promise<void>;
    refusalFlag: { refused: boolean };
  } {
    const refusalFlag = { refused: false };
    const retryStepAction = async (): Promise<void> => {
      const result = await performOneAct(step);
      if (result.kind === "refused") {
        refusalFlag.refused = true;
      }
    };
    return { retryStepAction, refusalFlag };
  }

  // ---- outcome-detection handling (shared by pre-detect, post-detect, locator-unresolved
  // recheck, and checkpoint-failure recheck) ---------------------------------------------

  type DetectionHandling =
    | { kind: "none" } // nothing matched at all
    | { kind: "recovered" } // a recoverable/generic condition matched and was cleared
    | { kind: "exit"; result: ReplayResult };

  async function handleDetection(
    detection: OutcomeDetectionResult,
    step: Step,
  ): Promise<DetectionHandling> {
    if (!detection.matched) {
      return { kind: "none" };
    }

    if (detection.source === "generic") {
      // SPEC §8: generic detector → escalate rather than continue.
      const escalationOutcome = await requestEscalation(
        step,
        "generic outcome detector matched (alert/error/denied/not-found/session-expired text)",
      );
      if (escalationOutcome === "aborted") {
        return {
          kind: "exit",
          result: finish({
            status: "escalated",
            failedStepId: step.id,
            failureClass: "unknown_condition",
          }),
        };
      }
      recoveriesApplied.push(`human_intervention:${step.id}`);
      const satisfied = await isStepPreconditionSatisfied(step);
      return satisfied ? { kind: "recovered" } : { kind: "none" };
    }

    const outcome: OutcomeSpec = detection.outcome;

    if (outcome.classification === "business_outcome") {
      return {
        kind: "exit",
        result: finish({
          status: "business_outcome",
          outcomeName: outcome.name,
          outcomeMessage: renderTemplate(outcome.messageTemplate),
        }),
      };
    }

    if (outcome.classification === "hard_failure") {
      return {
        kind: "exit",
        result: finish({
          status: "failure",
          failureClass: "unknown_condition",
          failedStepId: step.id,
          outcomeName: outcome.name,
          outcomeMessage: renderTemplate(outcome.messageTemplate),
        }),
      };
    }

    // recoverable
    //
    // "retry" and "wait_and_retry" recovery actions re-invoke the STEP'S OWN action (via
    // retryStepAction → performOneAct → surface.act()) — exactly the thing SPEC §8 forbids
    // for an irreversible step ("Never retry an irreversible step"). We do NOT re-check
    // `step.risk` here: `performOneAct` (via `makeRetryStepAction`'s `refusalFlag`) is the
    // single place that decision is made, for every caller, including this one — see the
    // `irreversibleStepsAttempted` guard and its doc comment above. If the funnel refused
    // the attempt, we treat it as immediate exhaustion below rather than logging a
    // `recoveriesApplied` entry that would misleadingly claim a retry happened. "dismiss"
    // (clicks a *different* recoveryTarget, never the step's own action) and "none" never
    // touch `performOneAct` at all, so they're unaffected and remain safe on an
    // irreversible step.
    const { retryStepAction, refusalFlag } = makeRetryStepAction(step);
    let attempt = 1;
    for (;;) {
      const recoveryResult = await applyRecovery(outcome, surface, retryStepAction, attempt);
      if (recoveryResult === "exhausted" || refusalFlag.refused) {
        return {
          kind: "exit",
          result: finish({
            status: "failure",
            failureClass: "unknown_condition",
            failedStepId: step.id,
            outcomeName: outcome.name,
            outcomeMessage: renderTemplate(outcome.messageTemplate),
          }),
        };
      }
      recoveriesApplied.push(`${outcome.recoveryAction}:${outcome.name}:attempt${attempt}`);

      const obs = await surface.observe();
      const redetect = await detectOutcome(obs, capability.outcomes, surface);
      if (!redetect.matched) {
        return { kind: "recovered" };
      }
      if (redetect.source === "declared" && redetect.outcome.name !== outcome.name) {
        // A different outcome now matches — hand off to it rather than looping on the
        // original one.
        return handleDetection(redetect, step);
      }
      if (redetect.source === "generic") {
        return handleDetection(redetect, step);
      }
      // Same recoverable condition persists — loop to the next attempt.
      attempt += 1;
    }
  }

  // ---- fingerprint check --------------------------------------------------------------------

  const entryAction: SurfaceAction = { kind: "navigate", value: capability.entryPoint, risk: "safe" };
  try {
    await surface.act(entryAction);
  } catch (err) {
    if (err instanceof PolicyViolation) {
      return finish({ status: "failure", failureClass: "policy_blocked", observed: err.message });
    }
    if (err instanceof ControlNotOwnedError || err instanceof EscalationRequired) {
      const entryStep = { id: "__entry__", description: "navigate to entryPoint" } as Step;
      const escalationOutcome = await requestEscalation(entryStep, err.message);
      if (escalationOutcome === "aborted") {
        return finish({ status: "escalated", observed: err.message });
      }
      recoveriesApplied.push("human_intervention:__entry__");
      // fall through and try to observe/continue regardless of what the human left us with
    } else {
      return finish({
        status: "failure",
        failureClass: "unknown_condition",
        observed: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const entryObservation = await surface.observe();
  if (capability.appFingerprint) {
    const observedFingerprint = fingerprintFn(entryObservation);
    if (observedFingerprint !== capability.appFingerprint) {
      const tenantOverrideExists =
        options.tenant !== undefined &&
        Object.prototype.hasOwnProperty.call(capability.tenantOverrides ?? {}, options.tenant);
      if (tenantOverrideExists) {
        recoveriesApplied.push("fingerprint_mismatch_overridden");
        log({
          event: "fingerprint_mismatch_overridden",
          tenant: options.tenant,
          expected: capability.appFingerprint,
          observed: observedFingerprint,
        });
      } else {
        return finish({
          status: "failure",
          failureClass: "unknown_condition",
          expected: capability.appFingerprint,
          observed: observedFingerprint,
        });
      }
    }
  }

  // ---- step loop ------------------------------------------------------------------------

  for (const step of capability.steps) {
    const stepStart = Date.now();

    // PRE-DETECT
    const preObs = await surface.observe();
    const preDetection = await detectOutcome(preObs, capability.outcomes, surface);
    const preHandled = await handleDetection(preDetection, step);
    if (preHandled.kind === "exit") {
      return preHandled.result;
    }
    // "recovered" or "none" both fall through to attempting the step's own action.

    // LOCATE + ACT
    let actOutcome = await attemptStepAction(step);

    if (actOutcome.kind === "exit") {
      return actOutcome.result;
    }

    if (actOutcome.kind === "locator_unresolved") {
      // "unresolved → attempt outcome detection once more before giving up" (SPEC §8).
      const obs = await surface.observe();
      const detection = await detectOutcome(obs, capability.outcomes, surface);
      const handled = await handleDetection(detection, step);
      if (handled.kind === "exit") {
        return handled.result;
      }

      // Neither a declared nor generic outcome explains it. Before giving up, offer this to
      // a human via the SAME `onEscalationNeeded` hook every other stuck condition in this
      // file already uses (SPEC §10 lists `--inject stuck`'s randomized-per-render control —
      // a locator that can never stably resolve — as exactly this failure mode).
      //
      // CRITICAL backward-compat constraint: the DEFAULT hook (used by every caller that
      // hasn't wired up real human-in-the-loop handling, including every existing test in
      // `test/executor.test.ts`) resolves "aborted" on its very first call. In that case we
      // fall through to the EXACT SAME `failure(locator_unresolved)` this function always
      // returned here, unchanged — we do NOT map an aborted outcome to `status: "escalated"`
      // the way the OTHER escalation triggers (irreversible-step, generic-detector) do;
      // `status: "escalated"` stays reserved for those.
      const escalationOutcome = await requestEscalation(
        step,
        `locator_unresolved: no strategy in the locator chain resolved (${obs.snapshotText.slice(0, 200)})`,
      );

      let resolvedViaEscalation = false;
      if (escalationOutcome === "resumed") {
        recoveriesApplied.push(`human_intervention:${step.id}`);
        const satisfied = await isStepPreconditionSatisfied(step);
        if (satisfied) {
          actOutcome = { kind: "resolved_by_human" };
          resolvedViaEscalation = true;
        } else {
          // The one allowed same-step retry, via the SAME funnel every other retry in this
          // file uses (`performOneAct`) — which is also where the irreversible-step
          // "attempt exactly once" guard lives, so an irreversible step whose one real
          // attempt already ran (even if that very attempt is what produced this
          // locator_unresolved) correctly refuses a second real action here (returns
          // `{ kind: "refused" }`, which falls into the `!resolvedViaEscalation` branch
          // below exactly like any other unresolved retry) rather than silently retrying it.
          const retried = await performOneAct(step);
          if (retried.kind === "ok") {
            actOutcome = { kind: "ok", resolvedTier: retried.resolvedTier, resolvedKind: retried.resolvedKind };
            resolvedViaEscalation = true;
          }
        }
      }

      if (!resolvedViaEscalation) {
        // We never proceed past an unresolved locator.
        return finish({
          status: "failure",
          failureClass: "locator_unresolved",
          failedStepId: step.id,
          observed: obs.snapshotText.slice(0, 200),
        });
      }
      // Falls through to the normal post-action pipeline below (waitForSettle / POST-DETECT /
      // checkpoint), exactly as the "ok" / "resolved_by_human" branches always have.
    }

    let resolvedTier: number | null = null;
    let resolvedKind: string | null = null;
    let checkpointPassed: boolean | null = null;

    if (actOutcome.kind === "ok") {
      resolvedTier = actOutcome.resolvedTier;
      resolvedKind = actOutcome.resolvedKind;
    }
    // actOutcome.kind === "resolved_by_human": step considered complete without us ever
    // performing the action ourselves; resolvedTier/resolvedKind stay null.

    await surface.waitForSettle(step.timeoutMs);

    // POST-DETECT
    const postObs = await surface.observe();
    const postDetection = await detectOutcome(postObs, capability.outcomes, surface);
    const postHandled = await handleDetection(postDetection, step);
    if (postHandled.kind === "exit") {
      return postHandled.result;
    }

    // Tracks whichever Observation is freshest for this step, for `emitStepTrace` below to
    // reuse rather than calling `surface.observe()` again.
    let lastObs: Observation = postObs;

    // CHECKPOINT — never proceed past a failed checkpoint.
    if (step.checkpoint) {
      const finalObs = await surface.observe();
      lastObs = finalObs;
      const passed = await evaluateCheckpoint(step.checkpoint, finalObs, surface);
      checkpointPassed = passed;
      if (!passed) {
        const detection = await detectOutcome(finalObs, capability.outcomes, surface);
        const handled = await handleDetection(detection, step);
        if (handled.kind === "exit") {
          return handled.result;
        }
        // "recovered" or "none": no outcome explains the failed checkpoint — fail here and
        // do NOT proceed to the next step.
        const failTrace: StepTrace = {
          stepId: step.id,
          resolvedTier,
          resolvedKind,
          durationMs: Date.now() - stepStart,
          checkpointPassed: false,
        };
        await emitStepTrace(failTrace, finalObs);
        return finish({
          status: "failure",
          failureClass: "checkpoint_failed",
          failedStepId: step.id,
          expected: step.checkpoint.description ?? JSON.stringify(step.checkpoint),
          observed: finalObs.url,
        });
      }
    }

    const trace: StepTrace = {
      stepId: step.id,
      resolvedTier,
      resolvedKind,
      durationMs: Date.now() - stepStart,
      checkpointPassed,
    };
    stepTraces.push(trace);
    log({
      event: "step_complete",
      stepId: step.id,
      resolvedTier,
      resolvedKind,
      checkpointPassed,
      resolvedByHuman: actOutcome.kind === "resolved_by_human",
    });
    await emitStepTrace(trace, lastObs);
  }

  // ---- outputs + successCheckpoint --------------------------------------------------------

  const outputs: Record<string, string | number | boolean> = {};
  for (const output of capability.outputs) {
    const raw = await surface.readText(output.source, output.extraction, output.attributeName);
    if (output.pii && raw !== null) {
      registerPiiValue(raw);
    }
    if (raw !== null) {
      if (output.type === "number") {
        const num = Number(raw);
        outputs[output.name] = Number.isNaN(num) ? raw : num;
      } else if (output.type === "boolean") {
        outputs[output.name] = raw === "true";
      } else {
        outputs[output.name] = raw;
      }
    }
  }

  const finalObservation = await surface.observe();
  const successOk = await evaluateCheckpoint(capability.successCheckpoint, finalObservation, surface);
  if (!successOk) {
    return finish({
      status: "failure",
      failureClass: "checkpoint_failed",
      outputs,
      expected: capability.successCheckpoint.description ?? JSON.stringify(capability.successCheckpoint),
      observed: finalObservation.url,
    });
  }

  return finish({ status: "success", outputs });
}
