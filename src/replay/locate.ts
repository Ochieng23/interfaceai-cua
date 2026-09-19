/**
 * `locateStep` — the "resolve locator" phase of SPEC §8's replay algorithm, pulled out as
 * its own named, separately-testable step. `Surface.act()` also resolves `action.target`
 * internally (see `Surface.ts`), but the executor calls this FIRST, before ever attempting
 * `act()`, purely to learn *which tier* of the strategy chain matched — that's what feeds
 * `StepTrace.resolvedTier` / `StepTrace.resolvedKind` (SPEC §8, §13's locate test).
 */

import type { LocatorSpec } from "../schema/capability";
import type { Resolved, Surface } from "../surface/Surface";

/**
 * Thin wrapper around `surface.resolve(target)`. Returns whatever the surface returns:
 * a `Resolved` (`{ tier, kind }`) describing the first strategy-chain tier that matched, or
 * `null` if nothing in the chain resolved against the current page.
 */
export async function locateStep(surface: Surface, target: LocatorSpec): Promise<Resolved | null> {
  return surface.resolve(target);
}
