/**
 * App fingerprint (SPEC §6, §8): sha256 of the SORTED `role|name` pairs of a page's
 * interactive elements. Stored on a `Capability` (`appFingerprint`); compared at replay start
 * so a run fails fast with a clear diagnostic when it's pointed at a page that structurally
 * isn't the one it was recorded against, instead of failing confusingly deep into the step
 * loop. This is the real implementation `src/replay/executor.ts`'s `defaultFingerprintFn`
 * placeholder (sha256 of raw `snapshotText`) was always meant to be replaced by — wired in via
 * `ExecutorOptions.fingerprintFn` from `src/cli/replay.ts`.
 *
 * Parses `role|name` pairs OUT of `snapshotText` using `snapshot.ts`'s own exported
 * `parseInteractiveLine`/`INTERACTIVE_LINE_RE` — never re-deriving or re-guessing that line
 * format here, per the task's explicit instruction (this is exactly the kind of
 * format-drifts-silently bug a shared-format-string convention avoids).
 */

import { createHash } from "node:crypto";

import { parseInteractiveLine } from "./snapshot";

export function computeFingerprint(snapshotText: string): string {
  const pairs: string[] = [];
  for (const line of snapshotText.split("\n")) {
    const parsed = parseInteractiveLine(line);
    if (parsed) {
      pairs.push(`${parsed.role}|${parsed.name}`);
    }
  }
  pairs.sort();
  return createHash("sha256").update(pairs.join("\n")).digest("hex");
}
