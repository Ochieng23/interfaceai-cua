/**
 * `recordCapability` — SPEC §7's "trace → Capability" step. Turns a successful
 * `DiscoveryResult` (status `"goal_complete"`) into a `Capability` ready to be saved as an
 * artifact and, eventually, replayed deterministically.
 *
 * ---------------------------------------------------------------------------------------
 * DESIGN NOTE — why this file does NOT call `enrichLocator()` (Playwright) itself, despite
 * the task brief framing this as "the recorder's job."
 *
 * `enrichLocator()` needs a live, currently-resolvable Playwright `Locator`. By the time
 * `recordCapability()` runs, the discovery run is OVER — the browser has long since navigated
 * past most of the pages each step acted on, and this app's form POSTs cause full page
 * reloads that invalidate Playwright's own native `aria-ref=` resolution (see
 * `perception/snapshot.ts`'s finding #2 and `discovery/loop.ts`'s header comment for the full
 * argument). So enrichment happens LIVE, per-turn, inside `loop.ts` (via its
 * `options.captureLocator` hook), and the resulting `LocatorSpec`s are attached to each turn
 * as `DiscoveryTurn.capturedLocators`.
 *
 * This file's injectable dependency — `options.resolveLocator` — reflects that: it is a
 * SYNCHRONOUS, PURE lookup (`(turn, ref) => LocatorSpec`), not an async live-browser call. The
 * default implementation (`defaultLocatorResolver`) simply reads `turn.capturedLocators[ref]`
 * and throws a clear error if it's missing (a bug — either `captureLocator` wasn's wired into
 * the loop, or a ref was referenced that was never captured). Tests (`test/recorder.test.ts`)
 * inject a stub that returns a canned `LocatorSpec` regardless of the turn, sidestepping the
 * whole "was it captured" question entirely — exactly the clean, browser-free testability seam
 * the task asked for, just implemented one layer earlier than the literal suggestion.
 * ---------------------------------------------------------------------------------------
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";

import {
  Capability,
  OutcomeSpec,
  type Checkpoint,
  type InputParamSpec,
  type LocatorSpec,
  type OutputSpec,
  type Step,
} from "../schema/capability";
import { loadPolicy } from "../guardrails/policy";
import { classifyActionRisk } from "../guardrails/risk";
import { computeFingerprint } from "../perception/fingerprint";
import { findRefRoleName, type DiscoveryResult, type DiscoveryTurn } from "./loop";

export type LocatorResolver = (turn: DiscoveryTurn, ref: string) => LocatorSpec;

export const defaultLocatorResolver: LocatorResolver = (turn, ref) => {
  const spec = turn.capturedLocators?.[ref];
  if (!spec) {
    throw new Error(
      `recordCapability: no captured LocatorSpec for ref "${ref}" — was options.captureLocator ` +
        "wired into runDiscoveryLoop for this run? (recorder.ts cannot call enrichLocator() " +
        "itself after the fact — see this file's header comment.)",
    );
  }
  return spec;
};

export interface RecordCapabilityOptions {
  name: string;
  targetApp: string;
  runId: string;
  seededOutcomesPath?: string;
  resolveLocator?: LocatorResolver;
}

/** Only one seeded outcome catalog exists in this project (SPEC §12), so this is the default
 * rather than something meaningfully derived from `targetApp` (a URL origin like
 * "http://localhost:4173" has no natural "basename" that maps to a catalog filename) — a
 * documented convention, not an oversight. Callers targeting a different app family pass
 * `seededOutcomesPath` explicitly. */
const DEFAULT_SEEDED_OUTCOMES_PATH = "outcomes/cu-console.yaml";

function loadSeededOutcomes(path: string): OutcomeSpec[] {
  const raw = readFileSync(resolvePath(path), "utf-8");
  const parsed = parseYaml(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`seeded outcomes file ${path} did not parse to a YAML array`);
  }
  // Validated individually, and provenance is never overridden here — every entry in
  // outcomes/cu-console.yaml already declares `provenance: seeded` itself; this just
  // confirms each entry is well-formed against OutcomeSpec, it doesn't rewrite anything.
  return parsed.map((entry, i) => {
    try {
      return OutcomeSpec.parse(entry);
    } catch (err) {
      throw new Error(
        `seeded outcomes file ${path}, entry ${i} does not match OutcomeSpec: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  });
}

const ACTION_MAP: Record<string, Step["action"]> = {
  click: "click",
  type_text: "fill",
  select_option: "select_option",
  navigate: "navigate",
  extract: "extract",
};

function describeStep(toolName: string, input: Record<string, unknown>, roleName?: { name: string }): string {
  const label = roleName?.name && roleName.name.length > 0 ? `"${roleName.name}"` : String(input.ref ?? "");
  switch (toolName) {
    case "click":
      return `Click ${label}.`;
    case "type_text":
      return `Enter text into ${label}.`;
    case "select_option":
      return `Select an option in ${label}.`;
    case "navigate":
      return `Navigate to ${String(input.url)}.`;
    case "extract":
      return `Read the value of ${label} (candidate output "${String(input.name)}").`;
    default:
      return `${toolName} on ${label}.`;
  }
}

/**
 * Matches `value` against a bound param's literal run-time value: for a `secret`-typed param,
 * the exact `{{secret:NAME}}` placeholder convention; for any other type, `param.example` —
 * which is this project's convention for "the concrete value bound to this param for this
 * discovery run" (see `src/cli/discover.ts`: it sets `example` to the resolved `--param`
 * value for every non-secret param it builds). Returns the matching param's name, or
 * `undefined` if `value` doesn't exactly equal any bound param's value.
 */
function matchBoundParam(value: string, boundParams: InputParamSpec[]): string | undefined {
  for (const p of boundParams) {
    if (p.type === "secret" && value === `{{secret:${p.name}}}`) return p.name;
    if (p.type !== "secret" && p.example !== undefined && value === p.example) return p.name;
  }
  return undefined;
}

/**
 * Route canonicalization (SPEC §7): replaces any path segment of `url`'s pathname that
 * exactly equals a bound param's literal value with `:paramName` — e.g.
 * `/member/10001` → `/member/:member_id` when `member_id`'s bound value is `"10001"`. Applied
 * to every navigate step's target URL and to the set of visited paths that becomes
 * `allowlistScope`. Only non-secret params participate (a secret value never legitimately
 * appears literally in a URL path here, and matching against it would risk leaking its shape).
 */
function canonicalizePath(pathname: string, boundParams: InputParamSpec[]): string {
  const nonSecret = boundParams.filter((p) => p.type !== "secret" && p.example !== undefined);
  const segments = pathname.split("/").map((segment) => {
    if (segment.length === 0) return segment;
    const match = nonSecret.find((p) => p.example === segment);
    return match ? `:${match.name}` : segment;
  });
  return segments.join("/");
}

/**
 * Synthesizes a `LocatorSpec` for a `goal_complete` output the model reported WITHOUT a ref —
 * i.e. a value read from plain page text/a data-table cell, not an interactive element (see
 * `tools.ts`'s `GoalCompleteInput` doc comment for why `ref` is optional there; a real
 * discovery run's first attempt at this exact goal hit this precisely: the true "Savings
 * balance" value is static text with no ref of its own, and forcing a ref produced a WRONG
 * locator pointing at an unrelated interactive element — this function exists to fix that).
 *
 * Pure string synthesis — no live browser needed, unlike every OTHER locator this file
 * builds. This works because `perception/snapshot.ts`'s own static-text synthesis renders
 * every plain two-cell table row (the exact shape this app's data tables use for labeled
 * values — "Savings balance", "Checking balance", etc.) as a single `"<label>: <value>"` line
 * (see that file's `walk()`). Finding the line whose value matches what the model reported
 * recovers the LABEL, which is then turned into the same `text_anchor` + `xpath`
 * "value cell following a label cell" strategy the HAND-WRITTEN `artifacts/lookup_member_
 * balance.json` (Task 6) used for this exact kind of output — see that file's own
 * `savings_balance` output for the precedent; `PlaywrightSurface.buildCandidates`'s
 * `text_anchor` tier already knows how to resolve both pieces of this chain.
 *
 * Falls back to anchoring on the VALUE itself (weaker — `text_anchor`'s "following sibling
 * cell" xpath won't match without a preceding label cell, but `getByLabel` might, and a
 * reviewer can see exactly what happened via `rationale`) if no `"<label>: <value>"` line is
 * found verbatim — this is a real, if unlikely, possibility (e.g. the model paraphrased the
 * value rather than copying it exactly), and recorder.ts should degrade gracefully rather
 * than throw over one output's weaker-than-ideal locator when everything else in the run
 * genuinely succeeded.
 */
function buildStaticTextOutputLocator(snapshotText: string, value: string, outputName: string): LocatorSpec {
  for (const line of snapshotText.split("\n")) {
    const idx = line.indexOf(": ");
    if (idx === -1) continue;
    const label = line.slice(0, idx);
    const lineValue = line.slice(idx + 2);
    if (lineValue === value) {
      const escaped = label.replace(/"/g, "&quot;");
      return {
        strategyChain: [
          { kind: "text_anchor", text: label, nearbyText: label },
          {
            kind: "xpath",
            selector: `//td[normalize-space(text())="${escaped}"]/following-sibling::td[1] | //th[normalize-space(text())="${escaped}"]/following-sibling::td[1]`,
          },
        ],
        rationale:
          `output "${outputName}" has no ref (static page text, not an interactive element); ` +
          `synthesized from the snapshot's own "${label}: ${value}" static-text line — the same ` +
          `text_anchor+xpath "value cell following label cell" strategy the hand-written ` +
          `lookup_member_balance artifact uses for this exact shape (no live browser needed).`,
      };
    }
  }
  // Fallback: no matching "label: value" line found verbatim — anchor on the value itself.
  return {
    strategyChain: [{ kind: "text_anchor", text: value, nearbyText: value }],
    rationale:
      `output "${outputName}" has no ref and no "<label>: ${value}" static-text line was found ` +
      "verbatim in the final snapshot; falling back to anchoring on the value text itself " +
      "(weaker — review before relying on this in replay).",
  };
}

export function recordCapability(
  result: DiscoveryResult,
  goal: string,
  boundParams: InputParamSpec[],
  options: RecordCapabilityOptions,
): Capability {
  if (result.status !== "goal_complete" || !result.goalCompleteArgs) {
    throw new Error(`recordCapability: can only record a "goal_complete" result (got "${result.status}")`);
  }
  if (result.turns.length === 0) {
    throw new Error("recordCapability: result.turns is empty — nothing to record");
  }

  const resolveLocator = options.resolveLocator ?? defaultLocatorResolver;
  const policy = loadPolicy();
  const { checkpoint, outputs: rawOutputs, summary } = result.goalCompleteArgs;
  const finalTurn = result.turns[result.turns.length - 1] as DiscoveryTurn;
  const firstTurn = result.turns[0] as DiscoveryTurn;

  // ---- steps: every turn that genuinely performed an action --------------------------
  const actedTurns = result.turns.filter((t): t is DiscoveryTurn & { toolCall: NonNullable<DiscoveryTurn["toolCall"]> } =>
    Boolean(t.acted && t.toolCall),
  );

  const visitedPaths = new Set<string>();
  try {
    visitedPaths.add(new URL(firstTurn.observation.url).pathname);
  } catch {
    /* malformed URL — skip */
  }

  const steps: Step[] = actedTurns.map((turn, index) => {
    const toolCall = turn.toolCall;
    const input = toolCall.input as Record<string, unknown>;
    const ref = typeof input.ref === "string" ? input.ref : undefined;
    const roleName = ref ? findRefRoleName(turn.observation.snapshotText, ref) : undefined;
    const action = ACTION_MAP[toolCall.name];
    if (!action) {
      throw new Error(`recordCapability: turn ${index} has an unrecognized acted tool "${toolCall.name}"`);
    }

    const step: Step = {
      id: `s${index + 1}`,
      description: describeStep(toolCall.name, input, roleName),
      action,
      risk: classifyActionRisk({ buttonText: roleName?.name, accessibleName: roleName?.name }, policy),
      timeoutMs: 5000,
    };

    if (toolCall.name === "navigate") {
      const url = String(input.url);
      try {
        const parsed = new URL(url);
        visitedPaths.add(canonicalizePath(parsed.pathname, boundParams));
        step.valueLiteral = `${parsed.origin}${canonicalizePath(parsed.pathname, boundParams)}${parsed.search}`;
      } catch {
        step.valueLiteral = url;
      }
    } else if (ref) {
      step.target = resolveLocator(turn, ref);
      if (toolCall.name === "type_text") {
        const text = String(input.text ?? "");
        const paramName = matchBoundParam(text, boundParams);
        if (paramName) {
          step.paramRef = paramName;
        } else {
          step.valueLiteral = text;
        }
      } else if (toolCall.name === "select_option") {
        const value = String(input.value ?? "");
        const paramName = matchBoundParam(value, boundParams);
        if (paramName) {
          step.paramRef = paramName;
        } else {
          step.valueLiteral = value;
        }
      }
    }

    // Also track every visited page along the way (not just navigate targets) for
    // allowlistScope, since most of this app's page transitions are form POSTs/link clicks,
    // not explicit `navigate` tool calls.
    try {
      const pathname = new URL(turn.observation.url).pathname;
      visitedPaths.add(canonicalizePath(pathname, boundParams));
    } catch {
      /* malformed URL — skip */
    }

    return step;
  });

  // Include the final (goal_complete) turn's own URL too.
  try {
    visitedPaths.add(canonicalizePath(new URL(finalTurn.observation.url).pathname, boundParams));
  } catch {
    /* malformed URL — skip */
  }

  // ---- outputs: from goal_complete's declared outputs ---------------------------------
  const outputs: OutputSpec[] = Object.entries(rawOutputs).map(([name, { ref, value }]) => ({
    name,
    type: "string",
    description:
      ref !== undefined
        ? `Value read from ${ref} at goal completion (candidate output "${name}").`
        : `Value read from plain page text at goal completion (candidate output "${name}"), no interactive ref.`,
    source:
      ref !== undefined
        ? resolveLocator(finalTurn, ref)
        : buildStaticTextOutputLocator(finalTurn.observation.snapshotText, value, name),
    extraction: "text",
    pii: false,
  }));

  // ---- successCheckpoint: from goal_complete's checkpoint -------------------------------
  let successCheckpoint: Checkpoint;
  if (checkpoint.text !== undefined) {
    successCheckpoint = { kind: "text_matches", expectedText: checkpoint.text, description: summary };
  } else if (checkpoint.ref !== undefined) {
    successCheckpoint = {
      kind: "element_visible",
      target: resolveLocator(finalTurn, checkpoint.ref),
      description: summary,
    };
  } else {
    throw new Error("recordCapability: goal_complete checkpoint has neither ref nor text");
  }

  // ---- seeded outcomes -------------------------------------------------------------------
  const seededOutcomesPath = options.seededOutcomesPath ?? DEFAULT_SEEDED_OUTCOMES_PATH;
  const outcomes = loadSeededOutcomes(seededOutcomesPath);

  // ---- fingerprint: from the FIRST turn's observation ------------------------------------
  const appFingerprint = computeFingerprint(firstTurn.observation.snapshotText);

  const capability: Capability = {
    schemaVersion: "1.1",
    id: options.name,
    name: options.name,
    version: "1.0.0",
    status: "draft",
    description: `${goal} — discovered via a genuine LLM-driven discovery run. Outcome summary: ${summary}`,
    targetApp: options.targetApp,
    entryPoint: firstTurn.observation.url,
    allowlistScope: [...visitedPaths].sort(),
    appFingerprint,
    inputParams: boundParams,
    outputs,
    steps,
    outcomes,
    successCheckpoint,
    createdFromRunId: options.runId,
    createdAt: new Date().toISOString(),
    tenantOverrides: {},
  };

  // Fail loudly if the recorder itself produced something invalid — that's a recorder bug,
  // never something to silently paper over (per this task's explicit instruction).
  return Capability.parse(capability);
}
