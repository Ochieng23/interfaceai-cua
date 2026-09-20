/**
 * `evaluateCheckpoint` — evaluates a single `Checkpoint` (SPEC §4) against a current
 * `Observation`. Used both for `Step.checkpoint` and `Capability.successCheckpoint`, and by
 * `outcomes.ts` (an `OutcomeSpec.detection` is itself a `Checkpoint`).
 *
 * A malformed checkpoint (missing the field its `kind` requires) must never crash a replay
 * run — it just fails to match. We `console.warn` once per call site so a capability author
 * notices the mistake without the run itself blowing up.
 */

import type { Checkpoint } from "../schema/capability";
import type { Observation, Surface } from "../surface/Surface";

export async function evaluateCheckpoint(
  checkpoint: Checkpoint,
  observation: Observation,
  surface: Surface,
): Promise<boolean> {
  switch (checkpoint.kind) {
    case "element_visible": {
      if (!checkpoint.target) {
        console.warn('evaluateCheckpoint: kind="element_visible" but no `target` was set');
        return false;
      }
      const resolved = await surface.resolve(checkpoint.target);
      return resolved !== null;
    }

    case "text_matches": {
      if (checkpoint.expectedText === undefined) {
        console.warn('evaluateCheckpoint: kind="text_matches" but no `expectedText` was set');
        return false;
      }
      // Case-sensitive substring check, deliberately: the business/outcome text the mock
      // app renders is exact (it's not user-generated copy with inconsistent casing), and a
      // case-sensitive match keeps detection unambiguous rather than risking a looser match
      // silently matching the wrong banner/state.
      return observation.snapshotText.includes(checkpoint.expectedText);
    }

    case "url_matches": {
      if (checkpoint.expectedUrlPattern === undefined) {
        console.warn('evaluateCheckpoint: kind="url_matches" but no `expectedUrlPattern` was set');
        return false;
      }
      return new RegExp(checkpoint.expectedUrlPattern).test(observation.url);
    }

    default: {
      // Exhaustiveness guard — Checkpoint.kind is a closed Zod enum, so this is unreachable
      // for schema-valid data, but a malformed/forward-incompatible checkpoint should still
      // fail closed rather than throw.
      console.warn(`evaluateCheckpoint: unknown checkpoint kind "${String((checkpoint).kind)}"`);
      return false;
    }
  }
}
