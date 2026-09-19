import { describe, expect, it } from "vitest";

import { FakeSurface, type FakePageState } from "../src/surface/FakeSurface";
import { detectOutcome, applyRecovery } from "../src/replay/outcomes";
import type { OutcomeSpec } from "../src/schema/capability";

const BASE_STATE: FakePageState = {
  url: "http://localhost:4173/member/10001",
  title: "CU Console",
  snapshotText: "e0: link 'Home'",
};

function notFoundOutcome(overrides: Partial<OutcomeSpec> = {}): OutcomeSpec {
  return {
    name: "member_not_found",
    classification: "business_outcome",
    detection: { kind: "text_matches", expectedText: "Member not found" },
    recoveryAction: "none",
    maxRetries: 0,
    messageTemplate: "The member could not be found.",
    provenance: "seeded",
    ...overrides,
  };
}

describe("detectOutcome", () => {
  it("declared beats generic: a declared outcome wins even when the same text would also match the generic regex", async () => {
    // "Member not found" both satisfies a declared business_outcome checkpoint AND the
    // generic detector's /not found/i regex. Declared must win (first-match-wins over
    // capability.outcomes, checked before the generic detector runs at all).
    const state: FakePageState = { ...BASE_STATE, snapshotText: "e0: alert 'Member not found'" };
    const fake = new FakeSurface([state]);
    const outcomes = [notFoundOutcome()];

    const result = await detectOutcome(await fake.observe(), outcomes, fake);

    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.source).toBe("declared");
      if (result.source === "declared") {
        expect(result.outcome.name).toBe("member_not_found");
      }
    }
  });

  it("BREAK/RESTORE CHECK (documented inline, not a real toggle): walking outcomes in array order means an earlier declared entry wins over a later one even if both match", async () => {
    const state: FakePageState = { ...BASE_STATE, snapshotText: "e0: text 'Member not found, try again'" };
    const fake = new FakeSurface([state]);
    const first = notFoundOutcome({ name: "first_match" });
    const second: OutcomeSpec = {
      ...notFoundOutcome({ name: "second_match" }),
      detection: { kind: "text_matches", expectedText: "try again" },
    };

    const result = await detectOutcome(await fake.observe(), [first, second], fake);

    expect(result.matched).toBe(true);
    if (result.matched && result.source === "declared") {
      expect(result.outcome.name).toBe("first_match");
    }
  });

  it("falls back to the generic detector (unknown_condition) when no declared outcome matches but error-ish text is visible", async () => {
    const state: FakePageState = { ...BASE_STATE, snapshotText: "e0: alert 'Session expired, please log in again'" };
    const fake = new FakeSurface([state]);

    const result = await detectOutcome(await fake.observe(), [], fake);

    expect(result.matched).toBe(true);
    if (result.matched && result.source === "generic") {
      expect(result.failureClass).toBe("unknown_condition");
    } else {
      throw new Error("expected a generic match");
    }
  });

  it("generic detector also matches the documented role=alert / role=alertdialog textual convention", async () => {
    const state: FakePageState = { ...BASE_STATE, snapshotText: "e2: [role=alertdialog] 'Something unexpected happened'" };
    const fake = new FakeSurface([state]);

    const result = await detectOutcome(await fake.observe(), [], fake);

    expect(result.matched).toBe(true);
    if (result.matched && result.source === "generic") {
      expect(result.failureClass).toBe("unknown_condition");
    } else {
      throw new Error("expected a generic match via the role=alertdialog convention");
    }
  });

  it("returns matched:false when nothing declared matches and no generic signal is present", async () => {
    const fake = new FakeSurface([BASE_STATE]);

    const result = await detectOutcome(await fake.observe(), [], fake);

    expect(result).toEqual({ matched: false });
  });
});

describe("applyRecovery", () => {
  it("dismiss: clicks recoveryTarget and reports recovered when within the retry budget", async () => {
    const fake = new FakeSurface([{ ...BASE_STATE, resolves: () => true }]);
    const outcome: OutcomeSpec = {
      name: "banner",
      classification: "recoverable",
      detection: { kind: "text_matches", expectedText: "banner" },
      recoveryAction: "dismiss",
      recoveryTarget: { strategyChain: [{ kind: "role", role: "button", accessibleName: "Dismiss" }] },
      maxRetries: 2,
      messageTemplate: "a dismissible banner appeared",
      provenance: "seeded",
    };
    const retryStepAction = async () => {
      throw new Error("dismiss must not call retryStepAction");
    };

    const result = await applyRecovery(outcome, fake, retryStepAction, 1);

    expect(result).toBe("recovered");
    expect(fake.recordedActions).toHaveLength(1);
    expect(fake.recordedActions[0]?.kind).toBe("click");
  });

  it("retry: calls retryStepAction and reports recovered when within budget", async () => {
    const fake = new FakeSurface([BASE_STATE]);
    const outcome: OutcomeSpec = {
      name: "transient",
      classification: "recoverable",
      detection: { kind: "text_matches", expectedText: "transient" },
      recoveryAction: "retry",
      maxRetries: 1,
      messageTemplate: "transient error",
      provenance: "seeded",
    };
    let retried = 0;
    const retryStepAction = async () => {
      retried += 1;
    };

    const result = await applyRecovery(outcome, fake, retryStepAction, 1);

    expect(result).toBe("recovered");
    expect(retried).toBe(1);
  });

  it("exhausted boundary: attemptNumber > maxRetries performs NO recovery action and reports exhausted", async () => {
    const fake = new FakeSurface([BASE_STATE]);
    const outcome: OutcomeSpec = {
      name: "transient",
      classification: "recoverable",
      detection: { kind: "text_matches", expectedText: "transient" },
      recoveryAction: "retry",
      maxRetries: 1,
      messageTemplate: "transient error",
      provenance: "seeded",
    };
    let retried = 0;
    const retryStepAction = async () => {
      retried += 1;
    };

    // attempt 1 is within budget (1 <= maxRetries 1)
    expect(await applyRecovery(outcome, fake, retryStepAction, 1)).toBe("recovered");
    // attempt 2 exceeds budget (2 > maxRetries 1) — exhausted, no further retry performed
    expect(await applyRecovery(outcome, fake, retryStepAction, 2)).toBe("exhausted");
    expect(retried).toBe(1);
  });

  it("maxRetries: 0 means the very first attempt (attemptNumber 1) is already exhausted", async () => {
    const fake = new FakeSurface([BASE_STATE]);
    const outcome: OutcomeSpec = {
      name: "no_retry",
      classification: "recoverable",
      detection: { kind: "text_matches", expectedText: "x" },
      recoveryAction: "retry",
      maxRetries: 0,
      messageTemplate: "no retry allowed",
      provenance: "seeded",
    };
    let retried = 0;
    const retryStepAction = async () => {
      retried += 1;
    };

    expect(await applyRecovery(outcome, fake, retryStepAction, 1)).toBe("exhausted");
    expect(retried).toBe(0);
  });
});
