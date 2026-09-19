/**
 * Run id + run folder layout (SPEC §11): `evidence/<discovery|replay>/<run_id>/`.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export type RunKind = "discovery" | "replay";

/** A sortable (ISO-timestamp-prefixed), collision-resistant run id. */
export function createRunId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = randomBytes(3).toString("hex");
  return `${timestamp}-${suffix}`;
}

/**
 * Absolute path to a run's evidence folder, resolved against `process.cwd()` — this
 * module assumes it is always invoked from the repo root (as every npm script in package.json
 * does), matching how `evidence/` is referenced elsewhere (e.g. `policy.yaml`'s default
 * load path in `src/guardrails/policy.ts`).
 */
export function runDir(kind: RunKind, runId: string): string {
  return resolve(process.cwd(), "evidence", kind, runId);
}

/** Like `runDir`, but also creates the directory (recursively) before returning it. */
export function ensureRunDir(kind: RunKind, runId: string): string {
  const dir = runDir(kind, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}
