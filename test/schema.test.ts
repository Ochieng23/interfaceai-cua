import { describe, expect, it } from "vitest";
import { Capability, Step } from "../src/schema/capability";

function minimalCapability() {
  return {
    schemaVersion: "1.1" as const,
    id: "cap-1",
    name: "Look up member",
    version: "1.0.0",
    description: "Looks up a member by ID and returns their status",
    targetApp: "https://cu-console.example.com",
    entryPoint: "https://cu-console.example.com/search",
    allowlistScope: ["https://cu-console.example.com/*"],
    inputParams: [
      {
        name: "memberId",
        type: "string" as const,
        description: "The member ID to search for",
      },
    ],
    outputs: [
      {
        name: "memberStatus",
        type: "string" as const,
        description: "The status of the member",
        source: {
          strategyChain: [{ kind: "css" as const, selector: "#status" }],
        },
      },
    ],
    steps: [
      {
        id: "step-1",
        description: "Fill in the member ID search box",
        action: "fill" as const,
        target: {
          strategyChain: [{ kind: "css" as const, selector: "#member-id" }],
        },
        paramRef: "memberId",
      },
    ],
    outcomes: [
      {
        name: "member_found",
        classification: "business_outcome" as const,
        detection: {
          kind: "element_visible" as const,
          description: "Member status element is visible",
        },
        messageTemplate: "Member {{memberId}} found",
      },
    ],
    successCheckpoint: {
      kind: "element_visible" as const,
      description: "Status panel is visible",
    },
    createdFromRunId: "run-1",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("Capability schema", () => {
  it("parses a minimal-but-valid capability", () => {
    const cap = minimalCapability();
    const parsed = Capability.parse(cap);
    expect(parsed.id).toBe("cap-1");
    expect(parsed.steps).toHaveLength(1);
    // defaults applied
    expect(parsed.status).toBe("draft");
    expect(parsed.steps[0].risk).toBe("reversible");
    expect(parsed.steps[0].timeoutMs).toBe(5000);
  });

  it("rejects a step whose paramRef does not match any declared inputParam", () => {
    const cap = minimalCapability();
    cap.steps[0].paramRef = "doesNotExist";

    const result = Capability.safeParse(cap);
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.path.join(".") === "steps.0.paramRef"
      );
      expect(issue).toBeDefined();
    }
  });

  it("round-trips through JSON without losing validity", () => {
    const cap = minimalCapability();
    const parsed = Capability.parse(cap);
    const roundTripped = JSON.parse(JSON.stringify(parsed));
    expect(() => Capability.parse(roundTripped)).not.toThrow();
    expect(roundTripped).toEqual(parsed);
  });
});

describe("Step schema", () => {
  const baseStep = {
    id: "step-1",
    description: "Click the submit button",
    action: "click" as const,
    target: {
      strategyChain: [{ kind: "css" as const, selector: "#submit" }],
    },
  };

  it("accepts a step with only valueLiteral set", () => {
    expect(() => Step.parse({ ...baseStep, valueLiteral: "hello" })).not.toThrow();
  });

  it("accepts a step with only paramRef set", () => {
    expect(() => Step.parse({ ...baseStep, paramRef: "someParam" })).not.toThrow();
  });

  it("rejects a step with BOTH valueLiteral and paramRef set", () => {
    const result = Step.safeParse({
      ...baseStep,
      valueLiteral: "hello",
      paramRef: "someParam",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("valueLiteral");
      expect(paths).toContain("paramRef");
    }
  });
});
