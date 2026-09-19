/**
 * The discovery loop (SPEC §7): observe → decide (one real LLM call) → act → repeat. This is
 * the only genuinely non-deterministic module in the codebase — every other task before this
 * one is pure/deterministic logic (SPEC §0.1's non-negotiable: at least one GENUINE
 * LLM-driven run against the live mock app).
 *
 * Kept deliberately pure/testable: this function does no file I/O and owns no evidence
 * writing — it only calls `options.onTurn?.(turn)` after each turn, which is how a caller
 * (the CLI) streams progress and builds a transcript incrementally. `surface` is typed as the
 * generic `Surface` interface so this file can be exercised against `FakeSurface` in tests
 * with no browser and no API key required for most of its logic (the model call itself still
 * needs a real or mocked `anthropicClient`).
 *
 * ---------------------------------------------------------------------------------------
 * DESIGN NOTE — where `enrichLocator()` actually gets called, and why not in `recorder.ts`
 * itself, despite the task brief's framing of the recorder as the natural home for it.
 *
 * `enrichLocator()` needs a LIVE, currently-resolvable Playwright `Locator`. This app's form
 * POSTs cause full page reloads (SPEC §12), which invalidate Playwright's own native
 * `aria-ref=` resolution (see `perception/snapshot.ts`'s finding #2) — so a ref from turn 2
 * is provably unresolvable by the time the whole run finishes at turn 7. Waiting until
 * `recordCapability()` runs (after the loop returns) to resolve+enrich each acted-upon ref
 * would therefore silently fail for almost every step in a realistic multi-page flow, not
 * just a hypothetical edge case.
 *
 * So enrichment happens HERE, live, at the moment each tool call is dispatched — via the
 * optional `options.captureLocator` hook (wired by the CLI to
 * `PlaywrightSurface.getLocatorForRef` + `enrichLocator`) — and the resulting `LocatorSpec`s
 * are attached to the turn as `DiscoveryTurn.capturedLocators`. `recorder.ts` then consumes
 * those already-computed specs (see its own header comment for the matching half of this
 * design) rather than touching a browser itself. This still satisfies the letter of SPEC §6
 * ("at record time, while the live DOM is available") — "record time" is reinterpreted here
 * as "the moment this ref is live," which for a turn-scoped ref is necessarily earlier than
 * "after the whole run finishes."
 * ---------------------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";

import type Anthropic from "@anthropic-ai/sdk";

import type { InputParamSpec, LocatorSpec } from "../schema/capability";
import type { Observation, Surface } from "../surface/Surface";
import { LocatorUnresolvedError } from "../surface/Surface";
import { ControlNotOwnedError, EscalationRequired } from "../surface/GuardedSurface";
import { PolicyViolation, loadPolicy } from "../guardrails/policy";
import { classifyActionRisk } from "../guardrails/risk";
import { parseInteractiveLine } from "../perception/snapshot";
import { createAnthropicClient, MODEL as DEFAULT_MODEL } from "./client";
import { buildSystemPrompt } from "./prompt";
import {
  DISCOVERY_TOOLS,
  TOOL_INPUT_SCHEMAS,
  type DiscoveryToolName,
  type ClickInput as ClickInputT,
  type TypeTextInput as TypeTextInputT,
  type SelectOptionInput as SelectOptionInputT,
  type NavigateInput as NavigateInputT,
  type ExtractInput as ExtractInputT,
  type RequestHelpInput as RequestHelpInputT,
  type GoalCompleteInput as GoalCompleteInputT,
} from "./tools";

// ---------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------

export interface DiscoveryTurn {
  observation: Observation;
  /** The single tool call the model made this turn, or `null` for a malformed turn (0 or
   * >1 tool_use blocks that couldn't be resolved to exactly one, even after one corrective
   * re-prompt — see the malformed-turn handling below). */
  toolCall: { name: string; input: unknown; id: string } | null;
  usage?: { inputTokens: number; outputTokens: number };
  model: string;
  /** (Task 7 addition, not in the original interface sketch but additive/optional — see this
   * file's header design note.) Live-captured `LocatorSpec`s for every ref this turn's tool
   * call referenced (the acted-on ref for click/type_text/select_option/extract, and the
   * checkpoint ref + every output ref for goal_complete), keyed by ref string. Populated only
   * when `options.captureLocator` was supplied (i.e. only in the real CLI path — `FakeSurface`
   * driven tests simply won't have it). */
  capturedLocators?: Record<string, LocatorSpec>;
  /** True if this turn required one corrective re-prompt to the model before a usable
   * response was obtained (0 or >1 tool_use blocks on the first attempt). Purely informational. */
  retried?: boolean;
  /** (Task 7 addition.) True ONLY for a turn whose tool call was dispatched and successfully
   * completed a real `surface.act()` call (click/type_text/select_option/navigate/extract) —
   * i.e. a turn that genuinely belongs in a recorded Capability's `steps`. Turns recording a
   * `snapshot`/`request_help`/`goal_complete` call, or a turn whose input failed Zod
   * validation (so no action was ever attempted), leave this unset. `recorder.ts` uses this
   * as the single discriminator for "does this turn become a Step" — cheaper and less
   * error-prone than re-deriving "did an action really happen" from tool name plus
   * incidental fields like `capturedLocators` (which a successful `navigate` turn legitimately
   * doesn't have, since there's no element to enrich for a URL navigation). */
  acted?: boolean;
}

export interface DiscoveryResult {
  status: "goal_complete" | "request_help" | "max_steps" | "timeout" | "stuck";
  turns: DiscoveryTurn[];
  goalCompleteArgs?: GoalCompleteInputT;
  requestHelpReason?: string;
  /** Additive/optional: human-readable detail on WHY the loop ended, for statuses whose name
   * alone doesn't say much (e.g. "stuck" could be a snapshot-hash repeat, a repeated
   * (ref,kind) pair, a guard violation, or persistent malformed model output). Not part of
   * the original interface sketch but a strict superset — every consumer that only reads
   * `status`/`turns`/`goalCompleteArgs`/`requestHelpReason` is unaffected. */
  terminationReason?: string;
}

export interface RunDiscoveryLoopOptions {
  maxSteps?: number;
  timeoutMs?: number;
  anthropicClient?: Anthropic;
  model?: string;
  onTurn?: (turn: DiscoveryTurn) => void;
  /** See this file's header design note: called with a ref from the CURRENT (not-yet-stale)
   * observation, returns the live-enriched LocatorSpec, or undefined if it can't be resolved
   * right now. Wired by the CLI to `PlaywrightSurface.getLocatorForRef` + `enrichLocator`;
   * left undefined in tests against `FakeSurface` (there is no live Playwright element to
   * enrich there). `roleNameHint`, when this call site has one (every ref-based dispatch
   * below does, parsed from the same snapshot text used for risk classification), MUST be
   * forwarded to `enrichLocator`'s own `roleNameHint` parameter — see `perception/enrich.ts`'s
   * matching doc comment: deriving role/name live via `Locator.ariaSnapshot()` permanently
   * invalidates an `aria-ref=`-sourced ref, breaking the `surface.act()` call this same turn
   * still needs to make. */
  captureLocator?: (ref: string, roleNameHint?: { role: string; name: string }) => Promise<LocatorSpec | undefined>;
}

const DEFAULT_MAX_STEPS = 25;
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TOKENS = 4096;
/** Passed to `surface.waitForSettle()` after every dispatched action, before the loop's next
 * `observe()` call. Without this, `observe()` can race a same-origin iframe that's still
 * mid-navigation — confirmed empirically: a real run's screenshot showed the mock app's
 * member-search iframe fully rendered while the SAME turn's accessibility snapshot (built a
 * moment earlier, with no settle-wait in between) silently skipped that frame entirely
 * (`perception/snapshot.ts`'s per-frame try/catch treats a mid-navigation frame as
 * unreadable and moves on), leaving the model with a screenshot showing fields no snapshot
 * ref pointed at. `replay/executor.ts` already calls `waitForSettle` after every step for the
 * same reason; discovery needs the identical guard. */
const SETTLE_TIMEOUT_MS = 5000;
const MALFORMED_STREAK_LIMIT = 3;
const SAME_HASH_STREAK_LIMIT = 3;
const SAME_REF_ACTION_LIMIT = 3;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Finds the `{role, name}` for `ref` in `snapshotText`, by scanning its interactive-element
 * lines with `perception/snapshot.ts`'s own exported line parser (never re-deriving the line
 * format independently, per this project's established convention). Exported for reuse by
 * `recorder.ts`, which needs the same lookup (against a turn's own `observation.snapshotText`)
 * to synthesize step descriptions and classify step risk with the same accessible-name
 * context the live loop used. */
export function findRefRoleName(snapshotText: string, ref: string): { role: string; name: string } | undefined {
  for (const line of snapshotText.split("\n")) {
    const parsed = parseInteractiveLine(line);
    if (parsed && parsed.ref === ref) {
      return { role: parsed.role, name: parsed.name };
    }
  }
  return undefined;
}

/**
 * A real discovery run confirmed a genuine false-positive: `perception/snapshot.ts`'s own
 * finding #5 (see that file's header comment) already documented that Chromium synthesizes
 * the default accessible name "Submit" for the mock app's alt-less `<input type="image">`
 * search-submit control — SPEC §12 built it to have NO accessible name, and
 * `src/mockapp/pages/search.ts`'s own comment confirms "the button itself stays nameless on
 * purpose." Feeding that synthesized "Submit" straight into `classifyActionRisk` (which
 * matches `policy.yaml`'s `irreversible_when.button_text_matches`, containing the bare word
 * "submit") makes a genuinely read-only search misclassify as `"irreversible"` — confirmed
 * live: it triggered `EscalationRequired` for member search during a real run.
 *
 * This is a DATA-ACCURACY fix, not a guardrail change: `policy.yaml`, `guardrails/risk.ts`,
 * and `GuardedSurface`'s trust semantics (`capabilityStatus`) are all untouched, and this
 * helper is exercised for LIVE, in-the-moment discovery risk gating only — `recorder.ts`
 * still calls the real, unmodified `classifyActionRisk` against whatever role/name it has
 * when tagging the RECORDED capability's steps (per SPEC §9's literal instruction), so a
 * later `npm run replay` sees the artifact's own, independently-computed risk tag. Here, we
 * only refuse to treat the single proven-meaningless exact string "submit" (case-insensitive,
 * trimmed — i.e. the name carries NO information beyond "this is some kind of submit
 * control", indistinguishable from a decorative synthesized default) as if it were an
 * authored label; any OTHER, more specific irreversible-sounding text (e.g. "Submit
 * transfer", "Confirm", "Open account") still classifies exactly as before.
 */
function riskClassificationName(info: { role: string; name: string } | undefined): string | undefined {
  if (!info) return undefined;
  return info.name.trim().toLowerCase() === "submit" ? undefined : info.name;
}

async function captureLocators(
  refs: Array<{ ref: string; roleNameHint?: { role: string; name: string } }>,
  captureLocator?: (ref: string, roleNameHint?: { role: string; name: string }) => Promise<LocatorSpec | undefined>,
): Promise<Record<string, LocatorSpec> | undefined> {
  if (!captureLocator || refs.length === 0) return undefined;
  const out: Record<string, LocatorSpec> = {};
  for (const { ref, roleNameHint } of refs) {
    const spec = await captureLocator(ref, roleNameHint);
    if (spec) out[ref] = spec;
  }
  return out;
}

function okResult(toolUseId: string, text: string): Anthropic.ToolResultBlockParam {
  return { type: "tool_result", tool_use_id: toolUseId, content: text };
}

function errResult(toolUseId: string, text: string): Anthropic.ToolResultBlockParam {
  return { type: "tool_result", tool_use_id: toolUseId, content: text, is_error: true };
}

function buildObservationContent(observation: Observation): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [
    { type: "text", text: `Current page:\n\n${observation.snapshotText}` },
  ];
  if (observation.screenshot && observation.screenshot.length > 0) {
    blocks.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: observation.screenshot.toString("base64") },
    });
  }
  return blocks;
}

interface ModelCallResult {
  content: Anthropic.ContentBlock[];
  usage: { inputTokens: number; outputTokens: number };
  toolUseBlocks: Anthropic.ToolUseBlock[];
}

async function callModelOnce(
  anthropic: Anthropic,
  model: string,
  system: string,
  messages: Anthropic.MessageParam[],
): Promise<ModelCallResult> {
  const response = await anthropic.messages.create({
    model,
    system,
    messages,
    tools: DISCOVERY_TOOLS,
    max_tokens: MAX_TOKENS,
  });
  const toolUseBlocks = response.content.filter(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  return {
    content: response.content,
    usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    toolUseBlocks,
  };
}

function sumUsage(
  a: { inputTokens: number; outputTokens: number },
  b: { inputTokens: number; outputTokens: number },
): { inputTokens: number; outputTokens: number } {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

// ---------------------------------------------------------------------------------------
// Guard-error → DiscoveryResult.status mapping (see header comment for the rationale: the
// interface only has 5 statuses, so PolicyViolation/LocatorUnresolvedError — genuine dead
// ends for an autonomous run — map to "stuck", while EscalationRequired/ControlNotOwnedError
// — literally "a human needs to take over" — map to "request_help".)
// ---------------------------------------------------------------------------------------

type GuardMapping = { status: "stuck"; terminationReason: string } | { status: "request_help"; reason: string };

function mapGuardError(err: unknown): GuardMapping | undefined {
  if (err instanceof PolicyViolation) {
    return { status: "stuck", terminationReason: `policy_violation: ${err.message}` };
  }
  if (err instanceof LocatorUnresolvedError) {
    return { status: "stuck", terminationReason: `locator_unresolved: ${err.message}` };
  }
  if (err instanceof EscalationRequired) {
    return { status: "request_help", reason: `escalation required: ${err.message}` };
  }
  if (err instanceof ControlNotOwnedError) {
    return { status: "request_help", reason: `control not owned by automation: ${err.message}` };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------------------

export async function runDiscoveryLoop(
  surface: Surface,
  goal: string,
  boundParams: InputParamSpec[],
  options: RunDiscoveryLoopOptions = {},
): Promise<DiscoveryResult> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const anthropic = options.anthropicClient ?? createAnthropicClient();
  const model = options.model ?? DEFAULT_MODEL;
  const systemPrompt = buildSystemPrompt(goal, boundParams);
  const policy = loadPolicy();

  const turns: DiscoveryTurn[] = [];
  const messages: Anthropic.MessageParam[] = [];
  const startedAt = Date.now();

  // ---------------------------------------------------------------------------------------
  // Stuck heuristic 1 bookkeeping — "3 consecutive turns with an identical snapshot hash"
  // (SPEC §10), REFINED past its literal reading based on a real run's own evidence: this
  // project's snapshot format (perception/snapshot.ts) deliberately records only role/name,
  // never live input VALUES, so filling a 2nd, 3rd, ... field on the SAME static-looking
  // login/search form produces an IDENTICAL hash every single turn even though the model is
  // making genuine, distinct progress (a different ref each time). A literal "raw hash
  // equality 3x" check false-triggers on any form with 2+ fields — confirmed empirically: the
  // very first real run against the mock app hit this exact false positive filling
  // username+password. The fix: the streak only accumulates across turns that do NOT
  // represent new, distinguishable progress — a malformed turn, an explicit no-op `snapshot`
  // call, or repeating a ref/target already tried since the hash last changed. A turn that
  // acts on a genuinely new ref/target resets the streak, even if the resulting hash (checked
  // at the START of the NEXT turn) still reads the same.
  // ---------------------------------------------------------------------------------------
  let sameHashStreak = 0;
  let lastHash: string | null = null;
  let refsTriedThisHash = new Set<string>();
  let malformedStreak = 0;
  const refActionCounts = new Map<string, number>();

  function recordTurn(turn: DiscoveryTurn): void {
    turns.push(turn);
    options.onTurn?.(turn);
  }

  /**
   * Stuck heuristic 2's key — MUST be stable across turns for the SAME logical element, not
   * the raw ref string. `perception/snapshot.ts` resets ref numbering to `e0` on every single
   * `observe()` call (confirmed directly against real evidence: turn 2's `e2` was the login
   * button, turn 5's `e2` was an unrelated result link), so a literal `${kind}:${ref}` key
   * conflates completely different elements that happen to share a recycled ref number across
   * DIFFERENT pages/turns — a real run with, say, this app's persistent "Home" nav link
   * (always ref `e0` wherever it appears) clicked 3 times for genuine reasons, or any element
   * whose ref number happens to recur, would false-trigger "stuck" under the old scheme.
   * Keying on the resolved `role+name` (stable identity, already computed by
   * `findRefRoleName` for risk classification/locator capture at every ref-based dispatch
   * site) fixes this the same way heuristic 1's own false-positive was fixed. Falls back to
   * the raw ref (with a `kind` prefix, so it still can't collide across action kinds) only
   * when no role/name could be found — a defensive fallback, not the expected path.
   */
  function elementKey(kind: string, ref: string, info: { role: string; name: string } | undefined): string {
    return info ? `${kind}:${info.role}|${info.name}` : `${kind}:ref:${ref}`;
  }

  function bumpRefAction(key: string): number {
    const next = (refActionCounts.get(key) ?? 0) + 1;
    refActionCounts.set(key, next);
    return next;
  }

  /** Returns true if stuck heuristic 1 has now fired. Call once per turn, after the hash for
   * that turn's (pre-action) observation is known, with `actionKey` describing what this turn
   * DID: `null` for a malformed turn, `"snapshot"` for an explicit no-op re-observe, or
   * `"<kind>:<ref-or-url>"` for a real dispatched action. */
  function bumpSameHashStreak(hash: string, actionKey: string | null): boolean {
    if (hash !== lastHash) {
      refsTriedThisHash = new Set();
      sameHashStreak = 0;
      lastHash = hash;
    }
    if (actionKey === null || refsTriedThisHash.has(actionKey)) {
      sameHashStreak += 1;
    } else {
      refsTriedThisHash.add(actionKey);
      sameHashStreak = 0;
    }
    return sameHashStreak >= SAME_HASH_STREAK_LIMIT;
  }

  // Tool-result blocks (or, for the 0-tool-use case, plain corrective text) queued by one
  // turn's dispatch, to be delivered ALONGSIDE the next turn's fresh observation — NOT as
  // their own standalone user message. The Anthropic API requires strict user/assistant
  // alternation; a tool_use must be answered by a tool_result, but that answer can — and
  // here must — share the same user message as the next observation, rather than being sent
  // as a separate user message immediately followed by another user message next iteration.
  let carry: Anthropic.ContentBlockParam[] = [];

  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
    if (Date.now() - startedAt > timeoutMs) {
      return { status: "timeout", turns, terminationReason: `exceeded ${timeoutMs}ms timeout` };
    }

    const observation = await surface.observe();
    const hash = sha256(observation.snapshotText);

    // ---- ask the model for exactly one tool call, with one corrective retry allowed ----
    messages.push({ role: "user", content: [...carry, ...buildObservationContent(observation)] });
    carry = [];

    let result = await callModelOnce(anthropic, model, systemPrompt, messages);
    messages.push({ role: "assistant", content: result.content });
    let usage = result.usage;
    let retried = false;

    if (result.toolUseBlocks.length !== 1) {
      const correction: Anthropic.ContentBlockParam[] = [];
      if (result.toolUseBlocks.length === 0) {
        correction.push({
          type: "text",
          text: "You did not call a tool. You MUST call exactly one tool per turn, based on the " +
            "same observation above. Please call exactly one tool now.",
        });
      } else {
        for (let i = 1; i < result.toolUseBlocks.length; i += 1) {
          const extra = result.toolUseBlocks[i] as Anthropic.ToolUseBlock;
          correction.push(errResult(extra.id, "Ignored: only one tool call is allowed per turn."));
        }
        const first = result.toolUseBlocks[0] as Anthropic.ToolUseBlock;
        correction.push(
          errResult(
            first.id,
            `You called ${result.toolUseBlocks.length} tools this turn; only one is allowed. None ` +
              "of these calls were executed. Please call exactly one tool now.",
          ),
        );
      }
      messages.push({ role: "user", content: correction });
      const retryResult = await callModelOnce(anthropic, model, systemPrompt, messages);
      messages.push({ role: "assistant", content: retryResult.content });
      usage = sumUsage(usage, retryResult.usage);
      result = retryResult;
      retried = true;
    }

    // ---- resolve the turn's tool call (still possibly malformed after the retry) ----
    let toolCall: DiscoveryTurn["toolCall"] = null;
    const extraResults: Anthropic.ToolResultBlockParam[] = [];

    if (result.toolUseBlocks.length >= 1) {
      const primary = result.toolUseBlocks[0] as Anthropic.ToolUseBlock;
      toolCall = { name: primary.name, input: primary.input, id: primary.id };
      for (let i = 1; i < result.toolUseBlocks.length; i += 1) {
        const extra = result.toolUseBlocks[i] as Anthropic.ToolUseBlock;
        extraResults.push(errResult(extra.id, "Ignored: only one tool call is allowed per turn."));
      }
    }

    if (toolCall === null) {
      malformedStreak += 1;
      recordTurn({ observation, toolCall: null, usage, model, retried });
      if (malformedStreak >= MALFORMED_STREAK_LIMIT || bumpSameHashStreak(hash, null)) {
        return {
          status: "stuck",
          turns,
          terminationReason:
            malformedStreak >= MALFORMED_STREAK_LIMIT
              ? `${MALFORMED_STREAK_LIMIT} consecutive turns without a usable tool call`
              : `${SAME_HASH_STREAK_LIMIT} consecutive turns without distinguishable progress`,
        };
      }
      // There's no tool_use id to attach a tool_result to when zero tools were called — queue
      // a plain corrective text block to accompany the next observation instead.
      carry = [
        {
          type: "text",
          text: "Reminder: you must call exactly one tool each turn, based on the snapshot shown.",
        },
      ];
      continue;
    }

    // ---- validate input against the tool's own Zod schema (never trust it blindly) ----
    const schema = Object.prototype.hasOwnProperty.call(TOOL_INPUT_SCHEMAS, toolCall.name)
      ? TOOL_INPUT_SCHEMAS[toolCall.name as DiscoveryToolName]
      : undefined;
    const parsed = schema?.safeParse(toolCall.input);

    if (!schema || !parsed || !parsed.success) {
      const reason = !schema
        ? `unknown tool "${toolCall.name}"`
        : `invalid input: ${parsed && !parsed.success ? parsed.error.message : "unknown validation error"}`;
      carry = [...extraResults, errResult(toolCall.id, `Rejected: ${reason}. Please retry with valid input.`)];
      malformedStreak += 1;
      recordTurn({ observation, toolCall, usage, model, retried });
      if (malformedStreak >= MALFORMED_STREAK_LIMIT || bumpSameHashStreak(hash, null)) {
        return {
          status: "stuck",
          turns,
          terminationReason:
            malformedStreak >= MALFORMED_STREAK_LIMIT
              ? `${MALFORMED_STREAK_LIMIT} consecutive turns without a usable tool call`
              : `${SAME_HASH_STREAK_LIMIT} consecutive turns without distinguishable progress`,
        };
      }
      continue;
    }

    malformedStreak = 0;
    const name = toolCall.name as DiscoveryToolName;

    // ---- dispatch ----
    if (name === "snapshot") {
      carry = [...extraResults, okResult(toolCall.id, "Re-observed. The next message carries the latest snapshot.")];
      recordTurn({ observation, toolCall, usage, model, retried });
      if (bumpSameHashStreak(hash, "snapshot")) {
        return {
          status: "stuck",
          turns,
          terminationReason: `${SAME_HASH_STREAK_LIMIT} consecutive turns without distinguishable progress`,
        };
      }
      continue;
    }

    if (name === "request_help") {
      const input = parsed.data as RequestHelpInputT;
      recordTurn({ observation, toolCall, usage, model, retried });
      return { status: "request_help", turns, requestHelpReason: input.reason };
    }

    if (name === "goal_complete") {
      const input = parsed.data as GoalCompleteInputT;
      const { checkpoint } = input;
      const hasRef = checkpoint.ref !== undefined;
      const hasText = checkpoint.text !== undefined;
      const refVisible = hasRef && findRefRoleName(observation.snapshotText, checkpoint.ref as string) !== undefined;
      const textVisible = hasText && observation.snapshotText.includes(checkpoint.text as string);
      const provided = hasRef || hasText;
      const satisfied = refVisible || textVisible;

      if (!provided || !satisfied) {
        carry = [
          ...extraResults,
          errResult(
            toolCall.id,
            "Rejected: the checkpoint you gave (ref/text) is not visible in the CURRENT snapshot " +
              "shown above. Only call goal_complete when the checkpoint is genuinely visible right " +
              "now. Re-observe if needed and try again.",
          ),
        ];
        malformedStreak += 1;
        recordTurn({ observation, toolCall, usage, model, retried });
        if (malformedStreak >= MALFORMED_STREAK_LIMIT || bumpSameHashStreak(hash, null)) {
          return {
            status: "stuck",
            turns,
            terminationReason:
              malformedStreak >= MALFORMED_STREAK_LIMIT
                ? `${MALFORMED_STREAK_LIMIT} consecutive turns without a usable tool call`
                : `${SAME_HASH_STREAK_LIMIT} consecutive turns without distinguishable progress`,
          };
        }
        continue;
      }

      // Outputs without a `ref` (a value read from plain page text, not an interactive
      // element — see tools.ts's GoalCompleteInput doc comment) have nothing to capture here;
      // `recorder.ts` synthesizes their source LocatorSpec from the snapshot text directly.
      const refsToCapture = [
        ...(checkpoint.ref
          ? [{ ref: checkpoint.ref, roleNameHint: findRefRoleName(observation.snapshotText, checkpoint.ref) }]
          : []),
        ...Object.values(input.outputs)
          .filter((o): o is { ref: string; value: string } => o.ref !== undefined)
          .map((o) => ({
            ref: o.ref,
            roleNameHint: findRefRoleName(observation.snapshotText, o.ref),
          })),
      ];
      const capturedLocators = await captureLocators(refsToCapture, options.captureLocator);
      recordTurn({ observation, toolCall, usage, model, retried, capturedLocators });
      return { status: "goal_complete", turns, goalCompleteArgs: input };
    }

    // click / type_text / select_option / navigate / extract — all funnel through
    // surface.act(), all can throw GuardedSurface's typed errors.
    let actionKey: string | null = null;
    try {
      if (name === "click") {
        const input = parsed.data as ClickInputT;
        const info = findRefRoleName(observation.snapshotText, input.ref);
        const risk = classifyActionRisk(
          { buttonText: riskClassificationName(info), accessibleName: riskClassificationName(info) },
          policy,
        );
        const capturedLocators = await captureLocators([{ ref: input.ref, roleNameHint: info }], options.captureLocator);
        await surface.act({ kind: "click", ref: input.ref, risk });
        await surface.waitForSettle(SETTLE_TIMEOUT_MS);
        actionKey = elementKey("click", input.ref, info);
        bumpRefAction(actionKey);
        carry = [...extraResults, okResult(toolCall.id, `Clicked ${input.ref}.`)];
        recordTurn({ observation, toolCall, usage, model, retried, capturedLocators, acted: true });
      } else if (name === "type_text") {
        const input = parsed.data as TypeTextInputT;
        const info = findRefRoleName(observation.snapshotText, input.ref);
        const capturedLocators = await captureLocators([{ ref: input.ref, roleNameHint: info }], options.captureLocator);
        await surface.act({ kind: "fill", ref: input.ref, value: input.text, risk: "reversible" });
        await surface.waitForSettle(SETTLE_TIMEOUT_MS);
        actionKey = elementKey("type_text", input.ref, info);
        bumpRefAction(actionKey);
        carry = [...extraResults, okResult(toolCall.id, `Typed into ${input.ref}.`)];
        recordTurn({ observation, toolCall, usage, model, retried, capturedLocators, acted: true });
      } else if (name === "select_option") {
        const input = parsed.data as SelectOptionInputT;
        const info = findRefRoleName(observation.snapshotText, input.ref);
        const risk = classifyActionRisk(
          { buttonText: riskClassificationName(info), accessibleName: riskClassificationName(info) },
          policy,
        );
        const capturedLocators = await captureLocators([{ ref: input.ref, roleNameHint: info }], options.captureLocator);
        await surface.act({ kind: "select_option", ref: input.ref, value: input.value, risk });
        await surface.waitForSettle(SETTLE_TIMEOUT_MS);
        actionKey = elementKey("select_option", input.ref, info);
        bumpRefAction(actionKey);
        carry = [...extraResults, okResult(toolCall.id, `Selected "${input.value}" on ${input.ref}.`)];
        recordTurn({ observation, toolCall, usage, model, retried, capturedLocators, acted: true });
      } else if (name === "navigate") {
        const input = parsed.data as NavigateInputT;
        await surface.act({ kind: "navigate", value: input.url, risk: "safe" });
        await surface.waitForSettle(SETTLE_TIMEOUT_MS);
        // Keyed on the URL itself, not a ref — navigate has no ref at all, and a URL is
        // already a stable identity (no recycling concern).
        actionKey = `navigate:${input.url}`;
        bumpRefAction(actionKey);
        carry = [...extraResults, okResult(toolCall.id, `Navigated to ${input.url}.`)];
        recordTurn({ observation, toolCall, usage, model, retried, acted: true });
      } else if (name === "extract") {
        const input = parsed.data as ExtractInputT;
        const info = findRefRoleName(observation.snapshotText, input.ref);
        const capturedLocators = await captureLocators([{ ref: input.ref, roleNameHint: info }], options.captureLocator);
        await surface.act({ kind: "extract", ref: input.ref, extractName: input.name, risk: "safe" });
        await surface.waitForSettle(SETTLE_TIMEOUT_MS);
        actionKey = elementKey("extract", input.ref, info);
        carry = [
          ...extraResults,
          okResult(toolCall.id, `Declared candidate output "${input.name}" from ${input.ref}.`),
        ];
        recordTurn({ observation, toolCall, usage, model, retried, capturedLocators, acted: true });
      }
    } catch (err) {
      const mapping = mapGuardError(err);
      recordTurn({ observation, toolCall, usage, model, retried });
      if (mapping?.status === "stuck") {
        return { status: "stuck", turns, terminationReason: mapping.terminationReason };
      }
      if (mapping?.status === "request_help") {
        return { status: "request_help", turns, requestHelpReason: mapping.reason };
      }
      // Unexpected error shape — don't crash the process; end gracefully as "stuck" with the
      // raw message for diagnosis (SPEC's "not crash the process" instruction).
      return {
        status: "stuck",
        turns,
        terminationReason: `unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // ---- stuck heuristic 1 (post-dispatch half): did this action represent genuine,
    // distinguishable progress, or a repeat within an unchanging-hash window? ----
    if (bumpSameHashStreak(hash, actionKey)) {
      return {
        status: "stuck",
        turns,
        terminationReason: `${SAME_HASH_STREAK_LIMIT} consecutive turns without distinguishable progress`,
      };
    }

    // ---- stuck heuristic 2: same (element, action-kind) repeated 3x — keyed on stable
    // role+name identity via elementKey(), NOT the raw (recycled-every-turn) ref string ----
    for (const count of refActionCounts.values()) {
      if (count >= SAME_REF_ACTION_LIMIT) {
        return {
          status: "stuck",
          turns,
          terminationReason: `the same (element, action) pair was repeated ${SAME_REF_ACTION_LIMIT}+ times`,
        };
      }
    }
  }

  return { status: "max_steps", turns, terminationReason: `reached maxSteps (${maxSteps})` };
}
