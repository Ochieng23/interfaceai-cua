/**
 * `InterventionRequest` (SPEC §10): the human-readable record of "why the run is paused and
 * what a human needs to know to take over," written to
 * `evidence/<kind>/<run_id>/intervention.json` and printed by the automation process and by
 * `cli/operator.ts`. Read/write are file-system operations only — no process coordination
 * lives here (that's `session.ts`'s job, via `control.json`).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";

import { ensureRunDir, runDir, type RunKind } from "../evidence/run";

export interface InterventionRequest {
  runId: string;
  kind: "discovery" | "replay";
  capabilityId?: string;
  goal?: string;
  stepId?: string;
  stepDescription?: string;
  reason: string;
  currentUrl: string;
  /** Path to a masked screenshot, relative to this run's evidence dir. */
  screenshotPath: string;
  /** Path to a snapshot-text file, relative to this run's evidence dir. */
  snapshotPath: string;
  cdpEndpoint: string;
  createdAt: string;
}

function interventionPath(kind: RunKind, runId: string): string {
  return joinPath(runDir(kind, runId), "intervention.json");
}

export function writeIntervention(kind: "discovery" | "replay", runId: string, req: InterventionRequest): void {
  ensureRunDir(kind, runId);
  writeFileSync(interventionPath(kind, runId), JSON.stringify(req, null, 2), "utf-8");
}

export function readIntervention(kind: "discovery" | "replay", runId: string): InterventionRequest {
  const raw = readFileSync(interventionPath(kind, runId), "utf-8");
  return JSON.parse(raw) as InterventionRequest;
}
