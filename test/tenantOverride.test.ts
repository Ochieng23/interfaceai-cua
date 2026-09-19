import { describe, expect, it } from "vitest";

import { Capability, type Step } from "../src/schema/capability";
import { applyTenantOverride, type TenantOverride } from "../src/replay/tenantOverride";

function baseCapability(steps: Step[]): Capability {
  return Capability.parse({
    schemaVersion: "1.1",
    id: "cap-1",
    name: "Test Capability",
    version: "1.0.0",
    status: "draft",
    description: "test",
    targetApp: "cu-console",
    entryPoint: "http://localhost:4173/login",
    allowlistScope: ["http://localhost:4173"],
    inputParams: [],
    outputs: [],
    steps,
    outcomes: [],
    successCheckpoint: { kind: "url_matches", expectedUrlPattern: ".*" },
    createdFromRunId: "run-0",
    createdAt: new Date().toISOString(),
  });
}

describe("applyTenantOverride", () => {
  it("returns the SAME capability object unchanged when override is undefined", () => {
    const capability = baseCapability([]);
    const result = applyTenantOverride(capability, undefined);
    expect(result).toBe(capability);
  });

  it("overrides entryPoint and leaves everything else untouched", () => {
    const step: Step = { id: "s1", description: "d", action: "navigate", risk: "safe", timeoutMs: 5000 };
    const capability = baseCapability([step]);
    const override: TenantOverride = { entryPoint: "http://localhost:4174/portal/login" };

    const result = applyTenantOverride(capability, override);

    expect(result.entryPoint).toBe("http://localhost:4174/portal/login");
    expect(result.steps).toEqual([step]);
    expect(result.id).toBe(capability.id);
  });

  it("shallow-merges a per-step override by step id, leaving other step fields intact", () => {
    const step: Step = {
      id: "click_login_submit",
      description: "click login",
      action: "click",
      risk: "reversible",
      timeoutMs: 5000,
      checkpoint: { kind: "url_matches", expectedUrlPattern: "^http://localhost:4173/$" },
    };
    const other: Step = { id: "unrelated", description: "d2", action: "navigate", risk: "safe", timeoutMs: 5000 };
    const capability = baseCapability([step, other]);

    const override: TenantOverride = {
      steps: {
        click_login_submit: {
          checkpoint: { kind: "url_matches", expectedUrlPattern: "^http://localhost:4174/portal/$" },
        },
      },
    };

    const result = applyTenantOverride(capability, override);

    const merged = result.steps.find((s) => s.id === "click_login_submit");
    expect(merged?.checkpoint?.expectedUrlPattern).toBe("^http://localhost:4174/portal/$");
    expect(merged?.description).toBe("click login"); // untouched
    expect(merged?.action).toBe("click"); // untouched
    // The other step is untouched (unrelated to Object.is identity — Capability.parse
    // itself produces fresh object instances, so we compare by value here).
    expect(result.steps.find((s) => s.id === "unrelated")).toEqual(other);
  });

  it("ignores a step-id override that doesn't match any real step, without throwing", () => {
    const step: Step = { id: "s1", description: "d", action: "navigate", risk: "safe", timeoutMs: 5000 };
    const capability = baseCapability([step]);
    const override: TenantOverride = { steps: { nonexistent: { valueLiteral: "http://x" } } };

    const result = applyTenantOverride(capability, override);

    expect(result.steps).toEqual([step]);
  });

  it("does not mutate the original capability object", () => {
    const step: Step = {
      id: "s1",
      description: "d",
      action: "navigate",
      valueLiteral: "http://localhost:4173/x",
      risk: "safe",
      timeoutMs: 5000,
    };
    const capability = baseCapability([step]);
    const snapshot = JSON.parse(JSON.stringify(capability));

    applyTenantOverride(capability, { steps: { s1: { valueLiteral: "http://localhost:4174/portal/x" } } });

    expect(JSON.parse(JSON.stringify(capability))).toEqual(snapshot);
  });
});
