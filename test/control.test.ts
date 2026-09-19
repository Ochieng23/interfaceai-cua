import { describe, expect, it } from "vitest";
import {
  SessionControl,
  transition,
  type ControlEvent,
  type ControlState,
} from "../src/schema/control";

const ALL_STATES: ControlState[] = [
  "AUTOMATION_RUNNING",
  "PAUSED_AWAITING_HUMAN",
  "HUMAN_IN_CONTROL",
  "RESUMING",
  "ABORTED",
];

const LEGAL_TRANSITIONS: Array<{ from: ControlState; event: ControlEvent; to: ControlState }> = [
  { from: "AUTOMATION_RUNNING", event: "escalate", to: "PAUSED_AWAITING_HUMAN" },
  { from: "PAUSED_AWAITING_HUMAN", event: "operator_attach", to: "HUMAN_IN_CONTROL" },
  { from: "HUMAN_IN_CONTROL", event: "resume", to: "RESUMING" },
  { from: "RESUMING", event: "resnapshot_ok", to: "AUTOMATION_RUNNING" },
];

describe("transition", () => {
  it.each(LEGAL_TRANSITIONS)(
    "$from --$event--> $to",
    ({ from, event, to }) => {
      expect(transition(from, event)).toBe(to);
    },
  );

  it("throws on an event that is not legal from the given state", () => {
    expect(() => transition("AUTOMATION_RUNNING", "resume")).toThrow();
  });

  it("throws on a completely unknown event", () => {
    // Cast past the (now-tightened) ControlEvent union to simulate a value that
    // arrived at runtime from outside the type system (e.g. deserialized JSON)
    // rather than from a typo a compiler would already have caught.
    const bogusEvent = "not_a_real_event" as unknown as ControlEvent;
    expect(() => transition("AUTOMATION_RUNNING", bogusEvent)).toThrow();
  });

  it.each(ALL_STATES.filter((s) => s !== "ABORTED"))(
    "abort is legal from %s and yields ABORTED",
    (state) => {
      expect(transition(state, "abort")).toBe("ABORTED");
    },
  );

  it("ABORTED is a dead end: abort from ABORTED throws (no legal outgoing transitions)", () => {
    expect(() => transition("ABORTED", "abort")).toThrow();
  });

  it("ABORTED has no legal outgoing transitions for any known event", () => {
    const events: ControlEvent[] = [
      "escalate",
      "operator_attach",
      "resume",
      "resnapshot_ok",
      "abort",
    ];
    for (const event of events) {
      expect(() => transition("ABORTED", event)).toThrow();
    }
  });
});

describe("SessionControl schema", () => {
  it("parses a valid session control object", () => {
    const parsed = SessionControl.parse({
      runId: "run-1",
      state: "AUTOMATION_RUNNING",
      owner: "automation",
      since: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.runId).toBe("run-1");
    expect(parsed.state).toBe("AUTOMATION_RUNNING");
    expect(parsed.owner).toBe("automation");
    expect(parsed.reason).toBeUndefined();
    expect(parsed.cdpEndpoint).toBeUndefined();
  });

  it("parses a session control object with optional fields set", () => {
    const parsed = SessionControl.parse({
      runId: "run-2",
      state: "PAUSED_AWAITING_HUMAN",
      owner: "human",
      since: "2026-01-01T00:00:00.000Z",
      reason: "irreversible step requires approval",
      cdpEndpoint: "ws://localhost:9222/devtools/browser/abc",
    });
    expect(parsed.reason).toBe("irreversible step requires approval");
    expect(parsed.cdpEndpoint).toBe("ws://localhost:9222/devtools/browser/abc");
  });

  it("rejects a session control object with an invalid state", () => {
    const result = SessionControl.safeParse({
      runId: "run-3",
      state: "NOT_A_REAL_STATE",
      owner: "automation",
      since: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});
