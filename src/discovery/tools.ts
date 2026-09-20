/**
 * The 8 discovery tools (SPEC §7's table). Each tool's input is a Zod schema — the single
 * source of truth, per SPEC §1: `zodToJsonSchema` derives the `input_schema` handed to
 * Claude's native tool-use API, and the SAME Zod schema is used at runtime to validate
 * whatever input the model actually returns (SPEC §7: "Anthropic can return malformed tool
 * input, don't trust it blindly").
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type Anthropic from "@anthropic-ai/sdk";

export const SnapshotInput = z.object({});
export type SnapshotInput = z.infer<typeof SnapshotInput>;

export const ClickInput = z.object({
  ref: z.string().min(1).describe("The numbered ref (e.g. \"e3\") from the LATEST snapshot to click."),
});
export type ClickInput = z.infer<typeof ClickInput>;

export const TypeTextInput = z.object({
  ref: z.string().min(1).describe("The numbered ref (e.g. \"e3\") from the LATEST snapshot to type into."),
  text: z
    .string()
    .describe(
      "The text to type. For a bound secret param (e.g. username/password), type the LITERAL " +
        'placeholder string "{{secret:PARAM_NAME}}" — never a guessed or real credential.',
    ),
});
export type TypeTextInput = z.infer<typeof TypeTextInput>;

export const SelectOptionInput = z.object({
  ref: z.string().min(1).describe("The numbered ref (e.g. \"e3\") from the LATEST snapshot to select an option on."),
  value: z.string().describe("The option value (or visible label) to select."),
});
export type SelectOptionInput = z.infer<typeof SelectOptionInput>;

export const NavigateInput = z.object({
  url: z.string().min(1).describe("An absolute URL within the allowed origin/route allowlist to navigate to."),
});
export type NavigateInput = z.infer<typeof NavigateInput>;

export const ExtractInput = z.object({
  ref: z.string().min(1).describe("The numbered ref (e.g. \"e3\") from the LATEST snapshot whose text is a candidate output."),
  name: z.string().min(1).describe("A short snake_case name for this candidate output (e.g. \"savings_balance\")."),
});
export type ExtractInput = z.infer<typeof ExtractInput>;

export const RequestHelpInput = z.object({
  reason: z.string().min(1).describe("Why you are stuck and need a human — be specific."),
});
export type RequestHelpInput = z.infer<typeof RequestHelpInput>;

export const GoalCompleteInput = z.object({
  checkpoint: z
    .object({
      ref: z.string().optional().describe("A ref from the LATEST snapshot that proves the goal is done."),
      text: z.string().optional().describe("Literal text visible in the LATEST snapshot that proves the goal is done."),
    })
    .describe("At least one of ref/text must be given, and it must be visible in the CURRENT (latest) snapshot."),
  outputs: z
    .record(
      z.string(),
      z.object({
        ref: z
          .string()
          .optional()
          .describe(
            "The ref (from the LATEST snapshot) the value was read from, ONLY if it came from an " +
              "interactive element (e.g. an input's current value). OMIT this for a value read from " +
              "plain page text/a data table cell that has no ref of its own — those are common and " +
              "expected; just give value in that case.",
          ),
        value: z.string().describe("The value as read from the page right now."),
      }),
    )
    .describe("Any values the goal asked you to read, keyed by a short snake_case output name."),
  summary: z.string().min(1).describe("A one- or two-sentence human-readable summary of what happened."),
});
export type GoalCompleteInput = z.infer<typeof GoalCompleteInput>;

export const DISCOVERY_TOOL_NAMES = [
  "snapshot",
  "click",
  "type_text",
  "select_option",
  "navigate",
  "extract",
  "request_help",
  "goal_complete",
] as const;
export type DiscoveryToolName = (typeof DISCOVERY_TOOL_NAMES)[number];

/** Zod schema per tool name — the runtime validator for whatever the model actually sends. */
export const TOOL_INPUT_SCHEMAS: Record<DiscoveryToolName, z.ZodTypeAny> = {
  snapshot: SnapshotInput,
  click: ClickInput,
  type_text: TypeTextInput,
  select_option: SelectOptionInput,
  navigate: NavigateInput,
  extract: ExtractInput,
  request_help: RequestHelpInput,
  goal_complete: GoalCompleteInput,
};

const TOOL_DESCRIPTIONS: Record<DiscoveryToolName, string> = {
  snapshot:
    "Re-observe the current page right now (a fresh accessibility snapshot + screenshot is sent " +
    "back to you). You are already re-observed after every action automatically — use this only " +
    "when you want an explicit re-look without taking any action (e.g. after a slow page load).",
  click: "Click the element identified by `ref`. `ref` MUST come from the snapshot you were just shown.",
  type_text:
    'Type `text` into the field identified by `ref`. For a bound param of type "secret" ' +
    '(e.g. username/password), type the literal placeholder string "{{secret:PARAM_NAME}}" — ' +
    "the system substitutes the real value before it ever reaches the browser; you never see or " +
    "need to know the actual credential.",
  select_option: "Select `value` (an option value or visible label) in the `<select>` identified by `ref`.",
  navigate: "Navigate the browser directly to `url`. Only URLs within the allowed origin/routes will succeed.",
  extract:
    "Declare that the text currently shown at `ref` is a candidate output named `name` " +
    "(e.g. name=\"savings_balance\"). This does not change the page; it just records intent — " +
    "you still report the actual value you read via `goal_complete`'s `outputs`.",
  request_help:
    "Stop and ask a human for help because you are genuinely unsure what to do next — use this " +
    "instead of guessing or repeatedly retrying the same thing.",
  goal_complete:
    "Declare the goal complete. `checkpoint` must point at something ACTUALLY VISIBLE in the " +
    "snapshot you were just shown (not from memory of an earlier turn) — either a `ref` or literal " +
    "`text`. `outputs` carries any values the goal asked you to read (ref + the value as currently " +
    "displayed). `summary` is a short human-readable description of the outcome, including an " +
    'outcome the goal did not "succeed" at in the usual sense (e.g. "member not found", ' +
    '"permission denied") — reporting a clear negative outcome via goal_complete is correct; do ' +
    "not try to creatively route around it.",
};

function buildTool(name: DiscoveryToolName): Anthropic.Tool {
  const schema = TOOL_INPUT_SCHEMAS[name];
  // `z.ZodTypeAny` (this project's zod import) and `zod-to-json-schema`'s own declared
  // parameter type are both intentionally "any Zod schema" top-types built on generic `any`
  // parameters — that's the whole point of accepting an arbitrary schema generically, not a
  // real loss of type safety at this specific interop boundary between the two packages.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const jsonSchema = zodToJsonSchema(schema) as Record<string, unknown>;
  // Drop the `$schema` draft-version key — Anthropic's Tool.InputSchema doesn't want/need it,
  // and everything else zodToJsonSchema produces for a plain z.object(...) (type, properties,
  // required, additionalProperties) is exactly the shape Anthropic's native tool-use format
  // expects.
  const { $schema: _drop, ...rest } = jsonSchema;
  return {
    name,
    description: TOOL_DESCRIPTIONS[name],
    input_schema: { type: "object", ...rest },
  };
}

export const DISCOVERY_TOOLS: Anthropic.Tool[] = DISCOVERY_TOOL_NAMES.map(buildTool);
