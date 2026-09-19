import { z } from "zod";

export const BoundingBox = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type BoundingBox = z.infer<typeof BoundingBox>;

export const Locator = z.object({
  kind: z.enum(["role", "css", "xpath", "text_anchor", "visual_anchor"]),
  role: z.string().optional(),
  accessibleName: z.string().optional(),
  selector: z.string().optional(),
  text: z.string().optional(),
  bbox: BoundingBox.optional(),
  nearbyText: z.string().optional(),
});
export type Locator = z.infer<typeof Locator>;

export const LocatorSpec = z.object({
  strategyChain: z.array(Locator).min(1), // ordered strongest → weakest
  rationale: z.string().optional(), // written by recorder, read by reviewers
});
export type LocatorSpec = z.infer<typeof LocatorSpec>;

export const Checkpoint = z.object({
  kind: z.enum(["element_visible", "text_matches", "url_matches"]),
  target: LocatorSpec.optional(),
  expectedText: z.string().optional(),
  expectedUrlPattern: z.string().optional(),
  description: z.string().optional(),
});
export type Checkpoint = z.infer<typeof Checkpoint>;

export const Step = z
  .object({
    id: z.string(),
    description: z.string(), // "Enter member ID in the search box"
    action: z.enum(["click", "fill", "select_option", "navigate", "wait_for", "extract"]),
    target: LocatorSpec.optional(),
    valueLiteral: z.string().optional(),
    paramRef: z.string().optional(),
    // "safe": read-only, freely retried. "reversible" (default): mutates state but can be
    // undone/redone, may be retried by the replay executor. "irreversible": cannot be safely
    // retried (e.g. submits a payment) — never retried, and by default forces an escalation
    // to a human before the step is taken (see SPEC §8-9).
    risk: z.enum(["safe", "reversible", "irreversible"]).default("reversible"),
    timeoutMs: z.number().int().default(5000),
    checkpoint: Checkpoint.optional(),
  })
  .superRefine((s, ctx) => {
    if (s.valueLiteral !== undefined && s.paramRef !== undefined) {
      const message = "set valueLiteral or paramRef, not both";
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ["valueLiteral"] });
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: ["paramRef"] });
    }
  });
export type Step = z.infer<typeof Step>;

export const InputParamSpec = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean", "secret"]), // secret: env-resolved, never persisted
  required: z.boolean().default(true),
  description: z.string(),
  pii: z.boolean().default(false),
  example: z.string().optional(),
});
export type InputParamSpec = z.infer<typeof InputParamSpec>;

export const OutputSpec = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string(),
  source: LocatorSpec,
  extraction: z.enum(["text", "attribute", "value"]).default("text"),
  attributeName: z.string().optional(),
  pii: z.boolean().default(false), // drives screenshot masking + log redaction
});
export type OutputSpec = z.infer<typeof OutputSpec>;

export const OutcomeSpec = z.object({
  name: z.string(),
  classification: z.enum(["business_outcome", "recoverable", "hard_failure"]),
  detection: Checkpoint,
  recoveryAction: z.enum(["dismiss", "retry", "wait_and_retry", "none"]).default("none"),
  recoveryTarget: LocatorSpec.optional(),
  maxRetries: z.number().int().default(0),
  messageTemplate: z.string(),
  // "seeded" (default): merged in from the static outcome catalog (YAML) before discovery
  // runs. "discovered": found live by the recorder during a discovery session and was not
  // in the catalog beforehand (see SPEC §7, §9).
  provenance: z.enum(["seeded", "discovered"]).default("seeded"),
});
export type OutcomeSpec = z.infer<typeof OutcomeSpec>;

export const Capability = z
  .object({
    schemaVersion: z.literal("1.1"),
    id: z.string(),
    name: z.string(),
    version: z.string(),
    status: z.enum(["draft", "approved"]).default("draft"),
    description: z.string(),
    targetApp: z.string(),
    entryPoint: z.string(),
    allowlistScope: z.array(z.string()),
    appFingerprint: z.string().optional(),
    inputParams: z.array(InputParamSpec),
    outputs: z.array(OutputSpec),
    steps: z.array(Step),
    outcomes: z.array(OutcomeSpec),
    successCheckpoint: Checkpoint,
    createdFromRunId: z.string(),
    createdAt: z.string().datetime(),
    tenantOverrides: z.record(z.string(), z.any()).default({}),
  })
  .superRefine((cap, ctx) => {
    const declaredParamNames = new Set(cap.inputParams.map((p) => p.name));
    cap.steps.forEach((step, stepIndex) => {
      if (step.paramRef !== undefined && !declaredParamNames.has(step.paramRef)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `paramRef "${step.paramRef}" does not match any declared inputParam`,
          path: ["steps", stepIndex, "paramRef"],
        });
      }
    });
  });
export type Capability = z.infer<typeof Capability>;
