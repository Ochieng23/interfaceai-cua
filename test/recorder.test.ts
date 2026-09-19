import { describe, expect, it } from "vitest";

import { recordCapability, type LocatorResolver } from "../src/discovery/recorder";
import type { DiscoveryResult, DiscoveryTurn } from "../src/discovery/loop";
import type { InputParamSpec, LocatorSpec } from "../src/schema/capability";

const SEEDED_OUTCOMES_PATH = new URL("../outcomes/cu-console.yaml", import.meta.url).pathname;

const CANNED_LOCATOR: LocatorSpec = {
  strategyChain: [{ kind: "css", selector: "#stub" }],
  rationale: "stubbed for test — no live browser involved",
};

/** Injectable dependency (per this file's requirement): never touches a real browser, always
 * returns the same canned LocatorSpec regardless of which turn/ref is asked for. */
const stubResolveLocator: LocatorResolver = () => CANNED_LOCATOR;

const BOUND_PARAMS: InputParamSpec[] = [
  { name: "username", type: "secret", required: true, description: "login username", pii: false },
  { name: "password", type: "secret", required: true, description: "login password", pii: false },
  {
    name: "member_id",
    type: "string",
    required: true,
    description: "the member id to look up",
    pii: false,
    example: "10001",
  },
];

function turn(partial: Partial<DiscoveryTurn> & { observation: DiscoveryTurn["observation"] }): DiscoveryTurn {
  return { toolCall: null, model: "test-model", ...partial };
}

/** A synthetic, hand-built DiscoveryResult mimicking what a real successful discovery run
 * against the mock app would produce — a login (secret placeholders), a navigate whose URL
 * contains the bound member_id value as a path segment (route canonicalization target), a
 * fill whose text is exactly the member_id's bound value (paramRef target), and a
 * goal_complete declaring the savings balance output. No browser, no LLM call involved. */
function syntheticDiscoveryResult(): DiscoveryResult {
  const loginObs = {
    url: "http://localhost:4173/login",
    title: "CU Console — Login",
    snapshotText: 'URL: http://localhost:4173/login\nTITLE: CU Console — Login\nINTERACTIVE ELEMENTS:\ne0: textbox "Username"\ne1: textbox "Password"\ne2: button "Log in"\n\nSTATIC TEXT:\n(none)',
  };
  const searchObs = {
    url: "http://localhost:4173/member/10001",
    title: "CU Console — Member detail",
    snapshotText: 'URL: http://localhost:4173/member/10001\nTITLE: CU Console — Member detail\nINTERACTIVE ELEMENTS:\ne3: textbox "Member ID or name"\n\nSTATIC TEXT:\n(none)',
  };
  const detailObs = {
    url: "http://localhost:4173/member/10001",
    title: "CU Console — Member detail",
    snapshotText:
      'URL: http://localhost:4173/member/10001\nTITLE: CU Console — Member detail\nINTERACTIVE ELEMENTS:\ne5: link "Jane Doe"\n\nSTATIC TEXT:\nSavings balance: 4,200.00',
  };

  const turns: DiscoveryTurn[] = [
    turn({
      observation: loginObs,
      toolCall: { name: "type_text", input: { ref: "e0", text: "{{secret:username}}" }, id: "tu_1" },
      acted: true,
    }),
    turn({
      observation: loginObs,
      toolCall: { name: "type_text", input: { ref: "e1", text: "{{secret:password}}" }, id: "tu_2" },
      acted: true,
    }),
    turn({
      observation: loginObs,
      toolCall: { name: "click", input: { ref: "e2" }, id: "tu_3" },
      acted: true,
    }),
    turn({
      // A navigate step whose URL embeds the bound member_id value ("10001") as a path
      // segment — this is exactly SPEC §7's route-canonicalization example.
      observation: searchObs,
      toolCall: { name: "navigate", input: { url: "http://localhost:4173/member/10001" }, id: "tu_4" },
      acted: true,
    }),
    turn({
      // A fill whose typed text is EXACTLY the member_id bound param's literal value.
      observation: searchObs,
      toolCall: { name: "type_text", input: { ref: "e3", text: "10001" }, id: "tu_5" },
      acted: true,
    }),
    turn({
      observation: detailObs,
      toolCall: {
        name: "goal_complete",
        input: {
          checkpoint: { text: "Savings balance" },
          // No `ref` — the real value is plain page text (a data-table cell), not an
          // interactive element, exactly the shape a real discovery run against this app
          // produces for "Savings balance: 4,200.00" (see recorder.ts's
          // buildStaticTextOutputLocator doc comment for why `ref` is optional here).
          outputs: { savings_balance: { value: "4,200.00" } },
          summary: "Logged in, looked up member 10001, and read their savings balance.",
        },
        id: "tu_6",
      },
      // goal_complete never sets acted:true — it doesn't produce a Step.
    }),
  ];

  return {
    status: "goal_complete",
    turns,
    goalCompleteArgs: {
      checkpoint: { text: "Savings balance" },
      outputs: { savings_balance: { value: "4,200.00" } },
      summary: "Logged in, looked up member 10001, and read their savings balance.",
    },
  };
}

describe("recordCapability", () => {
  it("records a valid Capability from a synthetic goal_complete DiscoveryResult", () => {
    const cap = recordCapability(
      syntheticDiscoveryResult(),
      "Log in, look up member {member_id}, and read their current savings balance",
      BOUND_PARAMS,
      {
        name: "lookup_member_balance_test",
        targetApp: "http://localhost:4173",
        runId: "test-run-1",
        seededOutcomesPath: SEEDED_OUTCOMES_PATH,
        resolveLocator: stubResolveLocator,
      },
    );

    expect(cap.status).toBe("draft");
    expect(cap.version).toBe("1.0.0");
    expect(cap.createdFromRunId).toBe("test-run-1");
    expect(cap.entryPoint).toBe("http://localhost:4173/login");
    // 5 acted turns (2 type_text, 1 click, 1 navigate, 1 type_text) → 5 steps; goal_complete
    // itself never becomes a step.
    expect(cap.steps).toHaveLength(5);
    // Seeded outcomes were merged in verbatim, with provenance untouched.
    expect(cap.outcomes.length).toBeGreaterThan(0);
    expect(cap.outcomes.every((o) => o.provenance === "seeded")).toBe(true);
    // Output built from goal_complete's outputs. This output has no ref (see fixture), so its
    // source is synthesized from the snapshot's static text, NOT the stubbed resolveLocator —
    // covered in detail by the next test.
    expect(cap.outputs).toHaveLength(1);
    expect(cap.outputs[0]?.name).toBe("savings_balance");
  });

  it("synthesizes a text_anchor source locator for a ref-less output from the snapshot's own \"label: value\" static-text line", () => {
    const cap = recordCapability(
      syntheticDiscoveryResult(),
      "Log in, look up member {member_id}, and read their current savings balance",
      BOUND_PARAMS,
      {
        name: "lookup_member_balance_test",
        targetApp: "http://localhost:4173",
        runId: "test-run-1",
        seededOutcomesPath: SEEDED_OUTCOMES_PATH,
        resolveLocator: stubResolveLocator,
      },
    );

    const output = cap.outputs[0];
    expect(output?.source).not.toEqual(CANNED_LOCATOR);
    expect(output?.source.strategyChain[0]).toEqual({
      kind: "text_anchor",
      text: "Savings balance",
      nearbyText: "Savings balance",
    });
    expect(output?.source.strategyChain.some((l) => l.kind === "xpath" && l.selector?.includes("Savings balance"))).toBe(
      true,
    );
  });

  it("emits paramRef (not valueLiteral) when typed text exactly equals a bound param's literal value", () => {
    const cap = recordCapability(
      syntheticDiscoveryResult(),
      "Log in, look up member {member_id}, and read their current savings balance",
      BOUND_PARAMS,
      {
        name: "lookup_member_balance_test",
        targetApp: "http://localhost:4173",
        runId: "test-run-1",
        seededOutcomesPath: SEEDED_OUTCOMES_PATH,
        resolveLocator: stubResolveLocator,
      },
    );

    // The two secret-typed logins ("{{secret:username}}" / "{{secret:password}}") also match
    // this rule (secret params compare against the literal placeholder) — assert all three
    // fill-type steps that should resolve to a paramRef actually do.
    const fillSteps = cap.steps.filter((s) => s.action === "fill");
    expect(fillSteps).toHaveLength(3);

    const usernameStep = fillSteps.find((s) => s.paramRef === "username");
    expect(usernameStep).toBeDefined();
    expect(usernameStep?.valueLiteral).toBeUndefined();

    const passwordStep = fillSteps.find((s) => s.paramRef === "password");
    expect(passwordStep).toBeDefined();
    expect(passwordStep?.valueLiteral).toBeUndefined();

    // The member_id fill: typed text "10001" exactly equals member_id's bound example "10001".
    const memberIdStep = fillSteps.find((s) => s.paramRef === "member_id");
    expect(memberIdStep).toBeDefined();
    expect(memberIdStep?.valueLiteral).toBeUndefined();

    // Sanity: a fill step whose text does NOT match any bound param would keep valueLiteral —
    // covered implicitly here since every fill step in this fixture DOES match; the schema's
    // own refine (valueLiteral XOR paramRef) plus Capability.parse() succeeding is further
    // proof no step ended up with both set.
  });

  it("canonicalizes a navigate step's URL path segment that matches a bound param's value", () => {
    const cap = recordCapability(
      syntheticDiscoveryResult(),
      "Log in, look up member {member_id}, and read their current savings balance",
      BOUND_PARAMS,
      {
        name: "lookup_member_balance_test",
        targetApp: "http://localhost:4173",
        runId: "test-run-1",
        seededOutcomesPath: SEEDED_OUTCOMES_PATH,
        resolveLocator: stubResolveLocator,
      },
    );

    const navigateStep = cap.steps.find((s) => s.action === "navigate");
    expect(navigateStep).toBeDefined();
    // "/member/10001" → "/member/:member_id" — the literal path segment "10001" equals the
    // member_id bound param's value, so it is replaced by ":member_id".
    expect(navigateStep?.valueLiteral).toBe("http://localhost:4173/member/:member_id");

    // allowlistScope (built from every visited path, canonicalized the same way) reflects the
    // canonical route, not the literal member id.
    expect(cap.allowlistScope).toContain("/member/:member_id");
    expect(cap.allowlistScope).not.toContain("/member/10001");
  });

  it("throws when the result status is not goal_complete", () => {
    expect(() =>
      recordCapability(
        { status: "stuck", turns: [] },
        "goal",
        BOUND_PARAMS,
        {
          name: "x",
          targetApp: "http://localhost:4173",
          runId: "run",
          seededOutcomesPath: SEEDED_OUTCOMES_PATH,
          resolveLocator: stubResolveLocator,
        },
      ),
    ).toThrow(/goal_complete/);
  });

  it("throws a clear error (rather than silently proceeding) when resolveLocator can't find a captured spec", () => {
    // Exercises the DEFAULT resolver (no stub) against a turn that never captured anything —
    // this is the "recorder fails loudly on its own bug" contract, not a silent fallback.
    const result = syntheticDiscoveryResult();
    expect(() =>
      recordCapability(result, "goal", BOUND_PARAMS, {
        name: "x",
        targetApp: "http://localhost:4173",
        runId: "run",
        seededOutcomesPath: SEEDED_OUTCOMES_PATH,
        // no resolveLocator override — falls back to defaultLocatorResolver, which reads
        // turn.capturedLocators (unset on every turn in this fixture).
      }),
    ).toThrow(/no captured LocatorSpec/);
  });
});
