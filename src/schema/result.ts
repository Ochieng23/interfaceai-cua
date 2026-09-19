import { z } from "zod";

export const StepTrace = z.object({
  stepId: z.string(),
  resolvedTier: z.number().int().nullable(), // index into strategyChain; null = unresolved
  resolvedKind: z.string().nullable(),
  durationMs: z.number().int(),
  checkpointPassed: z.boolean().nullable(),
});
export type StepTrace = z.infer<typeof StepTrace>;

export const ReplayResult = z.object({
  capabilityId: z.string(),
  capabilityVersion: z.string(),
  runId: z.string(),
  status: z.enum(["success", "business_outcome", "failure", "escalated"]),
  outputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  outcomeName: z.string().optional(),
  outcomeMessage: z.string().optional(),
  failedStepId: z.string().optional(),
  expected: z.string().optional(),
  observed: z.string().optional(),
  failureClass: z
    .enum(["unknown_condition", "locator_unresolved", "checkpoint_failed", "timeout", "policy_blocked"])
    .optional(),
  recoveriesApplied: z.array(z.string()).default([]),
  stepTraces: z.array(StepTrace).default([]),
  evidencePaths: z.array(z.string()).default([]),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
});
export type ReplayResult = z.infer<typeof ReplayResult>;
