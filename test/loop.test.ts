import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

import { runDiscoveryLoop } from "../src/discovery/loop";
import { FakeSurface, type FakePageState } from "../src/surface/FakeSurface";
import type { Observation, Surface, SurfaceAction, Resolved, Extraction } from "../src/surface/Surface";
import { LocatorUnresolvedError } from "../src/surface/Surface";
import { ControlNotOwnedError, EscalationRequired } from "../src/surface/GuardedSurface";
import { PolicyViolation } from "../src/guardrails/policy";
import type { InputParamSpec, LocatorSpec } from "../src/schema/capability";

/**
 * `runDiscoveryLoop`'s state machine (stuck heuristics, malformed-tool-call retry, guard-error
 * mapping) is exercisable with NO browser and NO real API key — `options.anthropicClient` and
 * `options.captureLocator` are both injectable. This file is pure unit testing (zero API
 * cost), covering exactly the two bugs a real discovery run found and fixed (see loop.ts's own
 * comments on `bumpSameHashStreak`/`elementKey`) plus the general mechanics.
 */

const BOUND_PARAMS: InputParamSpec[] = [];
const GOAL = "test goal";

// ---------------------------------------------------------------------------------------
// A scripted, zero-cost stand-in for the Anthropic client. Only `messages.create` is ever
// called by loop.ts; everything else about the real SDK client is irrelevant here.
// ---------------------------------------------------------------------------------------

interface ScriptedResponse {
  content: Anthropic.ContentBlock[];
  usage: { input_tokens: number; output_tokens: number };
}

class ScriptedAnthropicClient {
  private index = 0;
  public readonly callCount = { n: 0 };
  constructor(private readonly responses: ScriptedResponse[]) {}
  messages = {
    create: async (): Promise<ScriptedResponse> => {
      this.callCount.n += 1;
      const response = this.responses[this.index];
      if (!response) {
        throw new Error(`ScriptedAnthropicClient: no scripted response left (call #${this.callCount.n})`);
      }
      this.index += 1;
      return response;
    },
  };
}

function fakeClient(responses: ScriptedResponse[]): Anthropic {
  return new ScriptedAnthropicClient(responses) as unknown as Anthropic;
}

const USAGE = { input_tokens: 100, output_tokens: 20 };

/** A minimal, spec-satisfying stand-in for the extra fields real ToolUseBlock/TextBlock
 * objects carry that loop.ts never reads (e.g. ToolUseBlock.caller) — test-only, cast past. */
function toolUseResponse(id: string, name: string, input: unknown): ScriptedResponse {
  return {
    content: [{ type: "tool_use", id, name, input } as unknown as Anthropic.ContentBlock],
    usage: USAGE,
  };
}

function textResponse(text: string): ScriptedResponse {
  return {
    content: [{ type: "text", text, citations: null } as unknown as Anthropic.ContentBlock],
    usage: USAGE,
  };
}

// ---------------------------------------------------------------------------------------
// FakeSurface page-state helpers
// ---------------------------------------------------------------------------------------

function snapshotLine(ref: string, role: string, name: string): string {
  return `${ref}: ${role} "${name}"`;
}

function page(url: string, elements: Array<{ ref: string; role: string; name: string }>, staticText = ""): FakePageState {
  const interactive = elements.map((e) => snapshotLine(e.ref, e.role, e.name)).join("\n");
  return {
    url,
    title: "test page",
    snapshotText: `URL: ${url}\nTITLE: test page\nINTERACTIVE ELEMENTS:\n${interactive}\n\nSTATIC TEXT:\n${staticText}`,
  };
}

// ---------------------------------------------------------------------------------------
// A minimal Surface stub whose act() always throws a given error — isolates loop.ts's OWN
// guard-error -> DiscoveryResult.status mapping from GuardedSurface's own (separately
// tested, in guardrails.test.ts/executor.test.ts) policy logic.
// ---------------------------------------------------------------------------------------

class ThrowingSurface implements Surface {
  constructor(
    private readonly observation: Observation,
    private readonly error: Error,
  ) {}
  async observe(): Promise<Observation> {
    return this.observation;
  }
  async act(_action: SurfaceAction): Promise<void> {
    throw this.error;
  }
  async resolve(_spec: LocatorSpec): Promise<Resolved | null> {
    return null;
  }
  async readText(_spec: LocatorSpec, _extraction?: Extraction): Promise<string | null> {
    return null;
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.from("");
  }
  currentUrl(): string {
    return this.observation.url;
  }
  async waitForSettle(): Promise<void> {
    /* no-op */
  }
}

const CLICKABLE_OBSERVATION: Observation = {
  url: "http://localhost:4173/",
  title: "test page",
  snapshotText: page("http://localhost:4173/", [{ ref: "e0", role: "button", name: "Go" }]).snapshotText,
};

describe("runDiscoveryLoop — guard-error to DiscoveryResult.status mapping", () => {
  it("maps PolicyViolation to status stuck", async () => {
    const surface = new ThrowingSurface(CLICKABLE_OBSERVATION, new PolicyViolation("off-allowlist"));
    const client = fakeClient([toolUseResponse("tu1", "click", { ref: "e0" })]);
    const result = await runDiscoveryLoop(surface, GOAL, BOUND_PARAMS, { anthropicClient: client, maxSteps: 5 });
    expect(result.status).toBe("stuck");
    expect(result.terminationReason).toMatch(/policy_violation/);
  });

  it("maps LocatorUnresolvedError to status stuck", async () => {
    const surface = new ThrowingSurface(CLICKABLE_OBSERVATION, new LocatorUnresolvedError("gone"));
    const client = fakeClient([toolUseResponse("tu1", "click", { ref: "e0" })]);
    const result = await runDiscoveryLoop(surface, GOAL, BOUND_PARAMS, { anthropicClient: client, maxSteps: 5 });
    expect(result.status).toBe("stuck");
    expect(result.terminationReason).toMatch(/locator_unresolved/);
  });

  it("maps EscalationRequired to status request_help", async () => {
    const surface = new ThrowingSurface(CLICKABLE_OBSERVATION, new EscalationRequired("needs a human"));
    const client = fakeClient([toolUseResponse("tu1", "click", { ref: "e0" })]);
    const result = await runDiscoveryLoop(surface, GOAL, BOUND_PARAMS, { anthropicClient: client, maxSteps: 5 });
    expect(result.status).toBe("request_help");
    expect(result.requestHelpReason).toMatch(/escalation required/);
  });

  it("maps ControlNotOwnedError to status request_help", async () => {
    const surface = new ThrowingSurface(CLICKABLE_OBSERVATION, new ControlNotOwnedError("human"));
    const client = fakeClient([toolUseResponse("tu1", "click", { ref: "e0" })]);
    const result = await runDiscoveryLoop(surface, GOAL, BOUND_PARAMS, { anthropicClient: client, maxSteps: 5 });
    expect(result.status).toBe("request_help");
    expect(result.requestHelpReason).toMatch(/control not owned/);
  });
});

describe("runDiscoveryLoop — malformed tool-call corrective retry", () => {
  it("re-prompts once on a text-only (zero tool_use) response, then proceeds on the retry", async () => {
    const state = page("http://localhost:4173/", [{ ref: "e0", role: "button", name: "Go" }]);
    const surface = new FakeSurface([state]);
    const client = fakeClient([
      textResponse("I'm thinking about what to do..."), // malformed: no tool_use
      toolUseResponse("tu1", "request_help", { reason: "needed a nudge" }), // the retry
    ]);
    const result = await runDiscoveryLoop(surface, GOAL, BOUND_PARAMS, { anthropicClient: client, maxSteps: 5 });
    expect(result.status).toBe("request_help");
    expect(result.requestHelpReason).toBe("needed a nudge");
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.retried).toBe(true);
    expect(result.turns[0]?.toolCall?.name).toBe("request_help");
    // Usage from BOTH calls (the malformed attempt and the retry) is summed onto the one turn.
    expect(result.turns[0]?.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
  });

  it("still ends gracefully (not crash) if the retry is ALSO malformed, folding into the stuck heuristic", async () => {
    const state = page("http://localhost:4173/", [{ ref: "e0", role: "button", name: "Go" }]);
    const surface = new FakeSurface([state]);
    // 3 turns x 2 calls each (initial + retry), all text-only — malformedStreak reaches 3.
    const responses: ScriptedResponse[] = [];
    for (let i = 0; i < 3; i += 1) {
      responses.push(textResponse("still thinking"), textResponse("still thinking"));
    }
    const client = fakeClient(responses);
    const result = await runDiscoveryLoop(surface, GOAL, BOUND_PARAMS, { anthropicClient: client, maxSteps: 10 });
    expect(result.status).toBe("stuck");
    expect(result.turns.every((t) => t.toolCall === null)).toBe(true);
  });
});

describe("runDiscoveryLoop — stuck heuristic 1 (progress-aware, not raw hash equality)", () => {
  it("does NOT false-trigger on a 2-field-login-style sequence (same page, different fields each turn)", async () => {
    // The exact real bug: filling username then password never changes the snapshot hash
    // (this project's snapshot format never reflects input values), but each turn targets a
    // genuinely different ref/element — this must NOT be treated as "stuck".
    const loginPage = page("http://localhost:4173/login", [
      { ref: "e0", role: "textbox", name: "Username" },
      { ref: "e1", role: "textbox", name: "Password" },
      { ref: "e2", role: "button", name: "Log in" },
    ]);
    const surface = new FakeSurface([loginPage]);
    const client = fakeClient([
      toolUseResponse("tu1", "type_text", { ref: "e0", text: "alice" }),
      toolUseResponse("tu2", "type_text", { ref: "e1", text: "hunter2" }),
      toolUseResponse("tu3", "click", { ref: "e2" }),
      toolUseResponse("tu4", "goal_complete", {
        checkpoint: { text: "Log in" },
        outputs: {},
        summary: "done",
      }),
    ]);
    const result = await runDiscoveryLoop(surface, GOAL, BOUND_PARAMS, { anthropicClient: client, maxSteps: 10 });
    expect(result.status).toBe("goal_complete");
    expect(result.turns).toHaveLength(4);
  });

  it("DOES trigger on genuine no-progress (repeated no-op snapshot calls)", async () => {
    const state = page("http://localhost:4173/", [{ ref: "e0", role: "button", name: "Go" }]);
    const surface = new FakeSurface([state]);
    // snapshot is a pure no-op every time; the hash never changes and no new element is ever
    // tried — this is exactly what heuristic 1 should catch.
    const client = fakeClient([
      toolUseResponse("tu1", "snapshot", {}),
      toolUseResponse("tu2", "snapshot", {}),
      toolUseResponse("tu3", "snapshot", {}),
      toolUseResponse("tu4", "snapshot", {}),
      toolUseResponse("tu5", "snapshot", {}), // extra, in case the loop needs one more turn
    ]);
    const result = await runDiscoveryLoop(surface, GOAL, BOUND_PARAMS, { anthropicClient: client, maxSteps: 10 });
    expect(result.status).toBe("stuck");
    expect(result.terminationReason).toMatch(/distinguishable progress/);
  });
});

describe("runDiscoveryLoop — stuck heuristic 2 (stable element identity, not the recycled ref string)", () => {
  it("does NOT false-trigger when the SAME ref number is reused for DIFFERENT elements across pages", async () => {
    // perception/snapshot.ts resets ref numbering to e0 on every observe() call — confirmed
    // directly from real evidence (turn 2's e2 was the login button, turn 5's e2 was an
    // unrelated result link). A naive `${kind}:${ref}` counter would wrongly treat 3 clicks on
    // "e0" across 3 DIFFERENT pages (a different real element each time) as the same repeated
    // action. Each state below reuses ref "e0" for a role+name that changes every time.
    const states: FakePageState[] = [
      page("http://localhost:4173/a", [{ ref: "e0", role: "link", name: "Home" }]),
      page("http://localhost:4173/b", [{ ref: "e0", role: "button", name: "Search" }]),
      page("http://localhost:4173/c", [{ ref: "e0", role: "link", name: "Details" }]),
    ];
    const surface = new FakeSurface(states);
    const client = fakeClient([
      toolUseResponse("tu1", "click", { ref: "e0" }), // state a: "Home"
      toolUseResponse("tu2", "navigate", { url: "http://localhost:4173/b" }), // advances FakeSurface
      toolUseResponse("tu3", "click", { ref: "e0" }), // state b: "Search"
      toolUseResponse("tu4", "navigate", { url: "http://localhost:4173/c" }), // advances FakeSurface
      toolUseResponse("tu5", "click", { ref: "e0" }), // state c: "Details"
      toolUseResponse("tu6", "goal_complete", {
        checkpoint: { text: "Details" },
        outputs: {},
        summary: "done",
      }),
    ]);
    const result = await runDiscoveryLoop(surface, GOAL, BOUND_PARAMS, { anthropicClient: client, maxSteps: 10 });
    expect(result.status).toBe("goal_complete");
  });

  it("DOES trigger when the SAME logical element is genuinely clicked repeatedly", async () => {
    const state = page("http://localhost:4173/", [{ ref: "e0", role: "button", name: "Retry" }]);
    const surface = new FakeSurface([state]);
    const client = fakeClient([
      toolUseResponse("tu1", "click", { ref: "e0" }),
      toolUseResponse("tu2", "click", { ref: "e0" }),
      toolUseResponse("tu3", "click", { ref: "e0" }),
      toolUseResponse("tu4", "click", { ref: "e0" }), // extra, in case an earlier turn doesn't trip it
    ]);
    const result = await runDiscoveryLoop(surface, GOAL, BOUND_PARAMS, { anthropicClient: client, maxSteps: 10 });
    expect(result.status).toBe("stuck");
    expect(result.terminationReason).toMatch(/\(element, action\)/);
  });
});
