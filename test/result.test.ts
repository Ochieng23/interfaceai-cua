import { describe, expect, it } from "vitest";
import { ReplayResult, StepTrace } from "../src/schema/result";

function minimalReplayResult() {
  return {
    capabilityId: "cap-1",
    capabilityVersion: "1.0.0",
    runId: "run-1",
    status: "success" as const,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:05.000Z",
  };
}

describe("ReplayResult schema", () => {
  it("parses a minimal ReplayResult and applies the documented defaults", () => {
    const parsed = ReplayResult.parse(minimalReplayResult());
    expect(parsed.outputs).toEqual({});
    expect(parsed.recoveriesApplied).toEqual([]);
    expect(parsed.stepTraces).toEqual([]);
    expect(parsed.evidencePaths).toEqual([]);
  });

  it("rejects an outputs value that is not a string, number, or boolean", () => {
    const bad = {
      ...minimalReplayResult(),
      outputs: { memberStatus: { nested: "object" } },
    };
    expect(ReplayResult.safeParse(bad).success).toBe(false);
  });

  it("rejects an outputs value that is an array", () => {
    const bad = {
      ...minimalReplayResult(),
      outputs: { memberStatus: ["array", "value"] },
    };
    expect(ReplayResult.safeParse(bad).success).toBe(false);
  });

  it("accepts string/number/boolean outputs values", () => {
    const good = {
      ...minimalReplayResult(),
      outputs: { name: "Jane", age: 42, active: true },
    };
    expect(ReplayResult.safeParse(good).success).toBe(true);
  });
});

describe("StepTrace schema", () => {
  it("accepts null for resolvedTier, resolvedKind, and checkpointPassed", () => {
    const parsed = StepTrace.parse({
      stepId: "step-1",
      resolvedTier: null,
      resolvedKind: null,
      durationMs: 120,
      checkpointPassed: null,
    });
    expect(parsed.resolvedTier).toBeNull();
    expect(parsed.resolvedKind).toBeNull();
    expect(parsed.checkpointPassed).toBeNull();
  });

  it("accepts non-null values for resolvedTier, resolvedKind, and checkpointPassed", () => {
    const parsed = StepTrace.parse({
      stepId: "step-1",
      resolvedTier: 1,
      resolvedKind: "css",
      durationMs: 120,
      checkpointPassed: true,
    });
    expect(parsed.resolvedTier).toBe(1);
    expect(parsed.resolvedKind).toBe("css");
    expect(parsed.checkpointPassed).toBe(true);
  });
});
