import { afterEach, describe, expect, it } from "vitest";

import { FakeSurface, type FakePageState } from "../src/surface/FakeSurface";
import { GuardedSurface } from "../src/surface/GuardedSurface";
import { loadPolicy, clearPolicyCache, type Policy } from "../src/guardrails/policy";
import { clearRegistry } from "../src/guardrails/redact";
import { Capability, type OutcomeSpec, type Step, type LocatorSpec } from "../src/schema/capability";
import type { StepTrace } from "../src/schema/result";
import type { Surface, SurfaceAction, Extraction, Observation } from "../src/surface/Surface";
import { executeCapability, type ExecutorHooks, type EscalationInfo, type EscalationOutcome } from "../src/replay/executor";

const POLICY_PATH = new URL("../policy.yaml", import.meta.url).pathname;

function loadTestPolicy(): Policy {
  clearPolicyCache();
  return loadPolicy(POLICY_PATH);
}

function baseCapability(overrides: Partial<Capability> = {}): Capability {
  return Capability.parse({
    schemaVersion: "1.1",
    id: "cap-1",
    name: "Test Capability",
    version: "1.0.0",
    status: "draft",
    description: "a capability used only in tests",
    targetApp: "cu-console",
    entryPoint: "http://localhost:4173/",
    allowlistScope: ["http://localhost:4173"],
    inputParams: [],
    outputs: [],
    steps: [],
    outcomes: [],
    // Permissive by default so tests that don't care about the final checkpoint don't fail
    // on it; tests that DO care override this.
    successCheckpoint: { kind: "url_matches", expectedUrlPattern: ".*" },
    createdFromRunId: "run-0",
    createdAt: new Date().toISOString(),
    ...overrides,
  });
}

/** Counts every `.act()` call made on the surface the executor was handed, regardless of
 * whether the call throws — used to pin the "irreversible step is never retried, even once"
 * invariant at the layer the executor itself calls (GuardedSurface throws BEFORE delegating
 * to the inner FakeSurface, so FakeSurface.recordedActions alone can't observe attempts that
 * were rejected by the guard). */
class CountingSurface implements Surface {
  actCallCount = 0;
  constructor(private readonly inner: Surface) {}
  observe() {
    return this.inner.observe();
  }
  act(action: SurfaceAction) {
    this.actCallCount += 1;
    return this.inner.act(action);
  }
  resolve(spec: LocatorSpec) {
    return this.inner.resolve(spec);
  }
  readText(spec: LocatorSpec, extraction?: Extraction, attributeName?: string) {
    return this.inner.readText(spec, extraction, attributeName);
  }
  screenshot(opts: { maskSpecs: LocatorSpec[] }) {
    return this.inner.screenshot(opts);
  }
  currentUrl() {
    return this.inner.currentUrl();
  }
  waitForSettle(timeoutMs: number) {
    return this.inner.waitForSettle(timeoutMs);
  }
}

const ENTRY_STUB: FakePageState = {
  url: "http://localhost:4173/entry-stub",
  title: "stub",
  snapshotText: "stub",
};

describe("executeCapability", () => {
  afterEach(() => {
    clearRegistry();
  });

  it("succeeds end to end and extracts a declared output", async () => {
    const memberState: FakePageState = {
      url: "http://localhost:4173/member/10001",
      title: "Member",
      snapshotText: "e0: button 'Extract'",
      resolves: () => true,
      texts: { balance: "1234.56" },
    };
    const fake = new FakeSurface([ENTRY_STUB, memberState]);

    const step: Step = {
      id: "s1",
      description: "Click extract",
      action: "click",
      target: {
        strategyChain: [{ kind: "role", role: "button", accessibleName: "Extract" }],
        rationale: "balance",
      },
      risk: "reversible",
      timeoutMs: 1000,
    };
    const capability = baseCapability({
      steps: [step],
      outputs: [
        {
          name: "balance",
          type: "number",
          description: "account balance",
          source: { strategyChain: [{ kind: "role", role: "text", accessibleName: "Balance" }], rationale: "balance" },
          extraction: "text",
          pii: false,
        },
      ],
    });

    const result = await executeCapability(capability, {}, fake, { runId: "run-success" });

    expect(result.status).toBe("success");
    expect(result.outputs.balance).toBe(1234.56);
    expect(result.stepTraces).toHaveLength(1);
    expect(result.stepTraces[0]?.stepId).toBe("s1");
  });

  it("records StepTrace.resolvedTier from locate() when tier 0 fails and tier 1 resolves", async () => {
    const memberState: FakePageState = {
      url: "http://localhost:4173/member/10001",
      title: "Member",
      snapshotText: "e0: button 'Search'",
      resolves: (_locator, tier) => tier === 1,
    };
    const fake = new FakeSurface([ENTRY_STUB, memberState]);
    const step: Step = {
      id: "s1",
      description: "Click search",
      action: "click",
      target: {
        strategyChain: [
          { kind: "role", role: "button", accessibleName: "Search" },
          { kind: "css", selector: ".c1" },
        ],
      },
      risk: "reversible",
      timeoutMs: 1000,
    };
    const capability = baseCapability({ steps: [step] });

    const result = await executeCapability(capability, {}, fake, { runId: "run-tier" });

    expect(result.status).toBe("success");
    expect(result.stepTraces[0]?.resolvedTier).toBe(1);
    expect(result.stepTraces[0]?.resolvedKind).toBe("css");
  });

  it("exits cleanly with status business_outcome when a declared business_outcome is detected", async () => {
    const closedState: FakePageState = {
      url: "http://localhost:4173/member/10001",
      title: "Member",
      snapshotText: "e0: alert 'Account already closed'",
    };
    const fake = new FakeSurface([ENTRY_STUB, closedState]);
    const outcome: OutcomeSpec = {
      name: "already_closed",
      classification: "business_outcome",
      detection: { kind: "text_matches", expectedText: "Account already closed" },
      recoveryAction: "none",
      maxRetries: 0,
      messageTemplate: "The account is already closed.",
      provenance: "seeded",
    };
    const step: Step = {
      id: "s1",
      description: "Click close",
      action: "click",
      risk: "reversible",
      timeoutMs: 1000,
    };
    const capability = baseCapability({ steps: [step], outcomes: [outcome] });

    const result = await executeCapability(capability, {}, fake, { runId: "run-business" });

    expect(result.status).toBe("business_outcome");
    expect(result.outcomeName).toBe("already_closed");
    expect(result.failureClass).toBeUndefined();
  });

  it("recoverable: applies recovery (retry) then succeeds once the condition clears", async () => {
    const clean: FakePageState = { url: "http://localhost:4173/before", title: "before", snapshotText: "e0: clean" };
    const errorState: FakePageState = {
      url: "http://localhost:4173/after",
      title: "after",
      snapshotText: "e0: text 'Temporary error, please retry'",
    };
    const success: FakePageState = { url: "http://localhost:4173/success", title: "success", snapshotText: "e0: 'Success page'" };
    const fake = new FakeSurface([ENTRY_STUB, clean, errorState, success]);

    const outcome: OutcomeSpec = {
      name: "transient_error",
      classification: "recoverable",
      detection: { kind: "text_matches", expectedText: "Temporary error" },
      recoveryAction: "retry",
      maxRetries: 2,
      messageTemplate: "a transient error occurred",
      provenance: "seeded",
    };
    const step: Step = {
      id: "s1",
      description: "Submit form",
      action: "navigate",
      valueLiteral: "http://localhost:4173/after",
      risk: "reversible",
      timeoutMs: 1000,
      checkpoint: { kind: "url_matches", expectedUrlPattern: "/success$" },
    };
    const capability = baseCapability({
      steps: [step],
      outcomes: [outcome],
      successCheckpoint: { kind: "url_matches", expectedUrlPattern: "/success$" },
    });

    const result = await executeCapability(capability, {}, fake, { runId: "run-recover" });

    expect(result.status).toBe("success");
    expect(result.recoveriesApplied.some((r) => r.startsWith("retry:transient_error:attempt"))).toBe(true);
  });

  it("recoverable: exhausts maxRetries and fails as a hard failure", async () => {
    const clean: FakePageState = { url: "http://localhost:4173/before", title: "before", snapshotText: "e0: clean" };
    const errorState1: FakePageState = {
      url: "http://localhost:4173/after1",
      title: "after1",
      snapshotText: "e0: text 'Temporary error, please retry'",
    };
    const errorState2: FakePageState = {
      url: "http://localhost:4173/after2",
      title: "after2",
      snapshotText: "e0: text 'Temporary error, please retry'",
    };
    const fake = new FakeSurface([ENTRY_STUB, clean, errorState1, errorState2]);

    const outcome: OutcomeSpec = {
      name: "transient_error",
      classification: "recoverable",
      detection: { kind: "text_matches", expectedText: "Temporary error" },
      recoveryAction: "retry",
      maxRetries: 1,
      messageTemplate: "a transient error occurred and could not be recovered",
      provenance: "seeded",
    };
    const step: Step = {
      id: "s1",
      description: "Submit form",
      action: "navigate",
      valueLiteral: "http://localhost:4173/after1",
      risk: "reversible",
      timeoutMs: 1000,
    };
    const capability = baseCapability({ steps: [step], outcomes: [outcome] });

    const result = await executeCapability(capability, {}, fake, { runId: "run-exhaust" });

    expect(result.status).toBe("failure");
    expect(result.failureClass).toBe("unknown_condition");
    expect(result.failedStepId).toBe("s1");
    expect(result.outcomeName).toBe("transient_error");
  });

  it("SAFETY: a recoverable outcome's retryAction never re-invokes an irreversible step's own action, even once", async () => {
    // Regression test for a coordinator-flagged Critical: `handleDetection`'s recoverable
    // branch → `applyRecovery` → `retryStepAction` is a SEPARATE call site from the
    // escalation-resume retry path, and it had no risk check at all — an irreversible
    // step's own action could be replayed up to `maxRetries` times via a declared
    // `recoverable` OutcomeSpec with `recoveryAction: "retry"`. This must never happen:
    // an irreversible action is confirmed exactly once, full stop.
    const clean: FakePageState = {
      url: "http://localhost:4173/confirm",
      title: "confirm",
      snapshotText: "e0: button 'Confirm Transfer'",
    };
    const errorState: FakePageState = {
      url: "http://localhost:4173/confirm-error",
      title: "confirm-error",
      snapshotText: "e0: text 'Temporary error, please retry'",
    };
    const fake = new FakeSurface([ENTRY_STUB, clean, errorState]);

    const outcome: OutcomeSpec = {
      name: "transient_error",
      classification: "recoverable",
      detection: { kind: "text_matches", expectedText: "Temporary error" },
      recoveryAction: "retry",
      maxRetries: 2,
      messageTemplate: "a transient error occurred confirming the transfer",
      provenance: "seeded",
    };
    const step: Step = {
      id: "s1",
      description: "Confirm transfer (irreversible)",
      action: "navigate", // FakeSurface only auto-advances on "navigate"; the risk check
      // in the executor is keyed on step.risk, not action kind, so this exercises the
      // same code path a "click"-based irreversible confirm step would hit.
      valueLiteral: "http://localhost:4173/confirm-error",
      risk: "irreversible",
      timeoutMs: 1000,
    };
    const capability = baseCapability({ steps: [step], outcomes: [outcome] });

    const result = await executeCapability(capability, {}, fake, { runId: "run-irreversible-recoverable" });

    const stepAttempts = fake.recordedActions.filter(
      (a) => a.kind === "navigate" && a.value === "http://localhost:4173/confirm-error",
    );
    expect(stepAttempts).toHaveLength(1); // the step's own action was attempted exactly once
    expect(result.status).toBe("failure");
    expect(result.failureClass).toBe("unknown_condition");
    expect(result.failedStepId).toBe("s1");
    expect(result.outcomeName).toBe("transient_error");
    // No "retry:transient_error:..." recovery was ever actually applied.
    expect(result.recoveriesApplied.some((r) => r.startsWith("retry:transient_error"))).toBe(false);
  });

  it("a recoverable outcome's `dismiss` recovery action stays allowed on an irreversible step (it clicks a different element, never the step's own action)", async () => {
    const bannerState: FakePageState = {
      url: "http://localhost:4173/confirm",
      title: "confirm",
      snapshotText: "e0: alertdialog 'Heads up banner' e1: button 'Dismiss'",
      resolves: () => true, // both the dismiss click and (if ever attempted) the step resolve
    };
    const fake = new FakeSurface([ENTRY_STUB, bannerState]);

    const dismissTarget: LocatorSpec = {
      strategyChain: [{ kind: "role", role: "button", accessibleName: "Dismiss" }],
    };
    const outcome: OutcomeSpec = {
      name: "banner",
      classification: "recoverable",
      detection: { kind: "text_matches", expectedText: "Heads up banner" },
      recoveryAction: "dismiss",
      recoveryTarget: dismissTarget,
      maxRetries: 1,
      messageTemplate: "a dismissible banner blocked the confirm page",
      provenance: "seeded",
    };
    const step: Step = {
      id: "s1",
      description: "Confirm transfer (irreversible)",
      action: "click",
      risk: "irreversible",
      timeoutMs: 1000,
    };
    const capability = baseCapability({ steps: [step], outcomes: [outcome] });

    const result = await executeCapability(capability, {}, fake, { runId: "run-dismiss-irreversible" });

    const dismissClicks = fake.recordedActions.filter(
      (a) => a.kind === "click" && a.target?.strategyChain[0]?.accessibleName === "Dismiss",
    );
    // Unlike "retry"/"wait_and_retry", "dismiss" never touches the step's own action, so it
    // is never refused by the irreversible-step guard — it actually fires (once per
    // attempt, exhausting at maxRetries since this fixture's banner never actually clears).
    expect(dismissClicks.length).toBeGreaterThanOrEqual(1);
    expect(result.status).toBe("failure");
    expect(result.outcomeName).toBe("banner");
  });

  it("checkpoint failure stops the run — never proceeds to the next step", async () => {
    const afterStep1: FakePageState = {
      url: "http://localhost:4173/wrong-place",
      title: "wrong",
      snapshotText: "e0: nothing interesting here",
    };
    const fake = new FakeSurface([ENTRY_STUB, afterStep1]);

    const step1: Step = {
      id: "s1",
      description: "Do the first thing",
      action: "click",
      risk: "reversible",
      timeoutMs: 1000,
      checkpoint: { kind: "url_matches", expectedUrlPattern: "/right-place$" },
    };
    const step2: Step = {
      id: "s2",
      description: "Do the second thing (must never run)",
      action: "navigate",
      valueLiteral: "http://localhost:4173/should-not-happen",
      risk: "reversible",
      timeoutMs: 1000,
    };
    const capability = baseCapability({ steps: [step1, step2] });

    const result = await executeCapability(capability, {}, fake, { runId: "run-checkpoint" });

    expect(result.status).toBe("failure");
    expect(result.failureClass).toBe("checkpoint_failed");
    expect(result.failedStepId).toBe("s1");
    expect(result.stepTraces).toHaveLength(0);
    // step2's navigate action must never have been recorded.
    expect(fake.recordedActions.some((a) => a.value === "http://localhost:4173/should-not-happen")).toBe(false);
  });

  describe("irreversible steps and escalation", () => {
    it("an irreversible step that requires escalation is escalated, not plainly retried, and aborts by default", async () => {
      const policy = loadTestPolicy();
      const fake = new FakeSurface([ENTRY_STUB, { url: "http://localhost:4173/confirm", title: "confirm", snapshotText: "e0: button 'Transfer'" }]);
      const guarded = new GuardedSurface(fake, policy, { capabilityStatus: "draft" });
      let escalationCalls = 0;
      const hooks: ExecutorHooks = {
        onEscalationNeeded: async (_info: EscalationInfo): Promise<EscalationOutcome> => {
          escalationCalls += 1;
          return "aborted";
        },
      };
      const step: Step = {
        id: "s1",
        description: "Confirm transfer",
        action: "click",
        risk: "irreversible",
        timeoutMs: 1000,
      };
      const capability = baseCapability({ steps: [step] });

      const result = await executeCapability(capability, {}, guarded, { runId: "run-escalate", hooks });

      expect(result.status).toBe("escalated");
      expect(result.failedStepId).toBe("s1");
      expect(escalationCalls).toBe(1);
      // GuardedSurface throws before ever delegating to the inner FakeSurface for the
      // irreversible/draft click, so the only action that ever reached the real surface is
      // the (allowed, non-irreversible) entry-point navigate — not the guarded step.
      expect(fake.recordedActions).toHaveLength(1);
      expect(fake.recordedActions[0]?.kind).toBe("navigate");
    });

    it("an irreversible step is never retried, even once, across multiple 'resumed' escalation rounds", async () => {
      const policy = loadTestPolicy();
      const fake = new FakeSurface([ENTRY_STUB, { url: "http://localhost:4173/confirm", title: "confirm", snapshotText: "e0: button 'Transfer'" }]);
      const guarded = new GuardedSurface(fake, policy, { capabilityStatus: "draft" });
      const counting = new CountingSurface(guarded);

      let hookCalls = 0;
      const hooks: ExecutorHooks = {
        onEscalationNeeded: async (): Promise<EscalationOutcome> => {
          hookCalls += 1;
          // "resumed" twice (but the step has no checkpoint, so its precondition is never
          // judged satisfied), then "aborted" to end the test deterministically.
          return hookCalls < 3 ? "resumed" : "aborted";
        },
      };
      const step: Step = {
        id: "s1",
        description: "Confirm transfer",
        action: "click",
        risk: "irreversible",
        timeoutMs: 1000,
      };
      const capability = baseCapability({ steps: [step] });

      const result = await executeCapability(capability, {}, counting, { runId: "run-never-retry", hooks });

      expect(result.status).toBe("escalated");
      expect(hookCalls).toBe(3);
      // The crux of the invariant: no matter how many times the hook says "resumed", the
      // executor calls `.act()` for this irreversible step exactly once (the entry
      // navigate also calls .act(), so we assert on the step's own attempt count via
      // recoveriesApplied instead of a bare count of 1).
      expect(counting.actCallCount).toBe(2); // 1 entry navigate + 1 single step attempt
      expect(result.recoveriesApplied.filter((r) => r === "human_intervention:s1")).toHaveLength(2);
    });

    it("a non-irreversible step gets exactly one same-step retry after a resumed-but-unsatisfied escalation, then succeeds", async () => {
      const policy = loadTestPolicy();
      const fake = new FakeSurface([ENTRY_STUB, { url: "http://localhost:4173/confirm", title: "confirm", snapshotText: "e0: button 'Save'" }]);
      // getOwner reports "automation" for the entry-point navigate (call 1), "human" for
      // the step's first attempt (call 2, forcing ControlNotOwnedError), then "automation"
      // thereafter so the single allowed retry succeeds.
      let ownerCalls = 0;
      const guarded = new GuardedSurface(fake, policy, {
        getOwner: () => {
          ownerCalls += 1;
          return ownerCalls === 2 ? "human" : "automation";
        },
      });
      let hookCalls = 0;
      const hooks: ExecutorHooks = {
        onEscalationNeeded: async (): Promise<EscalationOutcome> => {
          hookCalls += 1;
          return "resumed";
        },
      };
      const step: Step = {
        id: "s1",
        description: "Save (reversible)",
        action: "click",
        risk: "reversible",
        timeoutMs: 1000,
      };
      const capability = baseCapability({ steps: [step] });

      const result = await executeCapability(capability, {}, guarded, { runId: "run-retry-once", hooks });

      expect(result.status).toBe("success");
      expect(hookCalls).toBe(1);
      expect(fake.recordedActions).toHaveLength(2); // entry navigate + the retried click
    });
  });

  describe("locator_unresolved escalation (Task 8)", () => {
    it("REGRESSION: with the DEFAULT hook, a locator_unresolved scenario produces the IDENTICAL result as before this task's change", async () => {
      const stuckState: FakePageState = {
        url: "http://localhost:4173/stuck",
        title: "stuck",
        snapshotText: "e0: nothing here ever resolves",
        // no `resolves` -> every strategyChain tier is permanently unresolved
      };
      const fake = new FakeSurface([ENTRY_STUB, stuckState]);
      const step: Step = {
        id: "s1",
        description: "Click a control that never resolves",
        action: "click",
        target: { strategyChain: [{ kind: "role", role: "button", accessibleName: "Whatever" }] },
        risk: "reversible",
        timeoutMs: 1000,
      };
      const capability = baseCapability({ steps: [step] });

      // No `hooks` passed at all -> the executor's DEFAULT onEscalationNeeded, which resolves
      // "aborted" immediately. Every field below matches exactly what this function returned
      // for this scenario before the locator_unresolved escalation hook call was added.
      const result = await executeCapability(capability, {}, fake, { runId: "run-locator-default" });

      expect(result.status).toBe("failure");
      expect(result.failureClass).toBe("locator_unresolved");
      expect(result.failedStepId).toBe("s1");
      expect(result.observed).toBe(stuckState.snapshotText.slice(0, 200));
      expect(result.stepTraces).toHaveLength(0);
      expect(result.recoveriesApplied).toHaveLength(0);
    });

    it("a CUSTOM hook that resumes retries the step once and, if the retry now resolves, the run completes normally", async () => {
      const stuckState: FakePageState = {
        url: "http://localhost:4173/stuck",
        title: "stuck",
        snapshotText: "e0: nothing here resolves yet",
        resolves: () => false,
      };
      const recoveredState: FakePageState = {
        url: "http://localhost:4173/stuck",
        title: "stuck",
        snapshotText: "e0: button 'Continue'",
        resolves: () => true,
      };
      const fake = new FakeSurface([ENTRY_STUB, stuckState, recoveredState]);

      let hookCalls = 0;
      const hooks: ExecutorHooks = {
        onEscalationNeeded: async (): Promise<EscalationOutcome> => {
          hookCalls += 1;
          // Simulate a human fixing the live page (e.g. the stuck page's randomized control
          // is now the resolvable one) before typing "resume" in the operator CLI.
          fake.advance();
          return "resumed";
        },
      };

      const step: Step = {
        id: "s1",
        description: "Click the randomized-name continue control",
        action: "click",
        target: { strategyChain: [{ kind: "role", role: "button", accessibleName: "Continue" }] },
        risk: "reversible",
        timeoutMs: 1000,
      };
      const capability = baseCapability({ steps: [step] });

      const result = await executeCapability(capability, {}, fake, { runId: "run-locator-resumed", hooks });

      expect(result.status).toBe("success");
      expect(hookCalls).toBe(1);
      expect(result.recoveriesApplied).toContain("human_intervention:s1");
      expect(result.stepTraces).toHaveLength(1);
      expect(result.stepTraces[0]?.stepId).toBe("s1");
      expect(result.stepTraces[0]?.resolvedTier).toBe(0);
    });
  });

  it("fingerprint mismatch with no tenant override fails with failureClass unknown_condition", async () => {
    const fake = new FakeSurface([ENTRY_STUB]);
    const capability = baseCapability({ appFingerprint: "expected-fingerprint-value" });

    const result = await executeCapability(capability, {}, fake, { runId: "run-fp" });

    expect(result.status).toBe("failure");
    expect(result.failureClass).toBe("unknown_condition");
    expect(result.expected).toBe("expected-fingerprint-value");
    expect(result.observed).toBeDefined();
  });

  it("fingerprint mismatch WITH a tenant override present proceeds instead of failing", async () => {
    const fake = new FakeSurface([ENTRY_STUB]);
    const capability = baseCapability({
      appFingerprint: "expected-fingerprint-value",
      tenantOverrides: { acme: { steps: [] } },
    });

    const result = await executeCapability(capability, {}, fake, { runId: "run-fp-override", tenant: "acme" });

    expect(result.status).toBe("success");
    expect(result.recoveriesApplied).toContain("fingerprint_mismatch_overridden");
  });

  it("Task 9: onStepTrace fires once per successful step with the finalized StepTrace and the current Observation", async () => {
    const memberState: FakePageState = {
      url: "http://localhost:4173/member/10001",
      title: "Member",
      snapshotText: "e0: button 'Extract'",
      resolves: () => true,
    };
    const fake = new FakeSurface([ENTRY_STUB, memberState]);

    const step: Step = {
      id: "s1",
      description: "Click extract",
      action: "click",
      target: { strategyChain: [{ kind: "role", role: "button", accessibleName: "Extract" }] },
      risk: "reversible",
      timeoutMs: 1000,
    };
    const capability = baseCapability({ steps: [step] });

    const seen: Array<{ trace: StepTrace; observation: Observation }> = [];
    const result = await executeCapability(capability, {}, fake, {
      runId: "run-onsteptrace",
      onStepTrace: (trace, observation) => {
        seen.push({ trace, observation });
      },
    });

    expect(result.status).toBe("success");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.trace.stepId).toBe("s1");
    expect(seen[0]?.trace.checkpointPassed).toBeNull();
    expect(seen[0]?.observation.url).toBe(memberState.url);
    expect(seen[0]?.observation.snapshotText).toBe(memberState.snapshotText);
  });
});
