import { describe, expect, it } from "vitest";

import { classifyReplayStuckReason } from "../src/escalation/stuck";

describe("classifyReplayStuckReason", () => {
  it("returns a dev-injection reason when devInjected is set, regardless of other fields", () => {
    const reason = classifyReplayStuckReason({ devInjected: true, failureClass: "unknown_condition" });
    expect(reason).toMatch(/inject stuck/i);
  });

  it("returns an unknown_condition reason for the generic-detector failure class", () => {
    const reason = classifyReplayStuckReason({ failureClass: "unknown_condition" });
    expect(reason).toMatch(/generic outcome detector/i);
  });

  it("returns a locator_unresolved reason for that failure class", () => {
    const reason = classifyReplayStuckReason({ failureClass: "locator_unresolved" });
    expect(reason).toMatch(/locator/i);
  });

  it("returns an irreversible-approval reason when risk=irreversible, policy=escalate, status!=approved", () => {
    const reason = classifyReplayStuckReason({
      stepRisk: "irreversible",
      irreversiblePolicy: "escalate",
      capabilityStatus: "draft",
    });
    expect(reason).toMatch(/irreversible/i);
    expect(reason).toMatch(/approv/i);
  });

  it("returns null when nothing matches", () => {
    expect(classifyReplayStuckReason({})).toBeNull();
  });

  it("does NOT treat an irreversible step as needing escalation once the capability is approved", () => {
    const reason = classifyReplayStuckReason({
      stepRisk: "irreversible",
      irreversiblePolicy: "escalate",
      capabilityStatus: "approved",
    });
    expect(reason).toBeNull();
  });
});
