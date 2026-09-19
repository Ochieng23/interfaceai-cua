/**
 * Task 9 / SPEC §12 ("Tenant B"): the deep-merge that turns a capability's base (tenant A)
 * steps into the tenant-specific variant declared under `capability.tenantOverrides[tenant]`,
 * BEFORE the capability is ever handed to `executeCapability()`. Per Task 5/6/8's own notes,
 * this merge was explicitly NOT implemented anywhere yet — `executor.ts`'s header comment for
 * `ExecutorOptions.tenant` says merging "happens in the CALLER... by the time we see
 * `capability`, its steps already reflect the merge." This file, plus the one call site in
 * `cli/replay.ts`, is that caller-side merge.
 *
 * Why the override touches MORE than just a step's `target` (a "relabeled locator"): reading
 * the actual CU Console markup (`src/mockapp/pages/*.ts`), tenant B changes exactly three
 * things — the `/portal` route prefix, the page `<title>`, and `searchButtonLabel` (plain
 * VISIBLE text next to the search button, never part of any accessible name or locator — see
 * `search.ts`'s own header comment: the alt-less `<input type="image">` search submit is
 * deliberately nameless under BOTH tenants, and `lookup_member_balance.json`'s
 * `click_search_submit` step deliberately never references a role/text tier for it at all,
 * only `css`/`xpath` tiers that are tenant-agnostic). So no step's `target.strategyChain`
 * actually needs to change for THIS capability/app pair — verified by reading every page
 * builder under `src/mockapp/pages/`, not assumed. What DOES genuinely need to change under
 * tenant B are the two places this capability hard-codes tenant-A's absolute origin+path:
 *   - `click_login_submit`'s checkpoint (`url_matches` against `http://localhost:4173/$`) —
 *     tenant B's shell lives at `<tenantOrigin>/portal/`.
 *   - `navigate_to_search`'s `valueLiteral` (`http://localhost:4173/members/search`).
 * This module's `TenantStepOverride` therefore covers `target`, `valueLiteral`, and
 * `checkpoint` — a strict superset of the "just `target`" shape the task brief sketched as a
 * starting point, extended because the real markup shows that's what this app's tenant-B
 * variant actually requires. `target` is included for forward-compatibility (a future
 * capability against an app that DOES relabel a locator would use it), even though this
 * capability's own override doesn't need it.
 */

import type { Capability, Checkpoint, LocatorSpec, Step } from "../schema/capability";

export interface TenantStepOverride {
  target?: LocatorSpec;
  valueLiteral?: string;
  checkpoint?: Checkpoint;
}

export interface TenantOverride {
  /** Replaces `capability.entryPoint` outright when present. */
  entryPoint?: string;
  /** Replaces `capability.appFingerprint` outright when present (optional — a tenant
   * override merely EXISTING already makes the executor proceed past a fingerprint
   * mismatch and log `fingerprint_mismatch_overridden`; supplying a real expected
   * fingerprint here is a nice-to-have, not required for that mechanism to work). */
  appFingerprint?: string;
  /** Keyed by `Step.id`. Each entry is shallow-merged onto the matching base step —
   * only the fields present in the override replace the base step's own; everything else
   * about the step (id, description, action, paramRef, risk, timeoutMs, ...) is untouched. */
  steps?: Record<string, TenantStepOverride>;
}

/**
 * Returns a NEW `Capability` with `override` deep-merged in by step id; never mutates
 * `capability`. Merges by step id, per SPEC §8's "deep-merge by step id" (§8 is the
 * general merge-semantics reference; the exact override shape is this task's call, per
 * SPEC §12's "the object's exact shape is up to you").
 *
 * A step id present in `override.steps` but absent from `capability.steps` is silently
 * ignored (a mismatched override is a capability-authoring mistake to catch by inspection /
 * a live run failing, not something this pure function should throw on — it has no logger
 * or run context to report through).
 */
export function applyTenantOverride(capability: Capability, override: TenantOverride | undefined): Capability {
  if (!override) {
    return capability;
  }

  const steps: Step[] = capability.steps.map((step) => {
    const stepOverride = override.steps?.[step.id];
    if (!stepOverride) {
      return step;
    }
    return { ...step, ...stepOverride };
  });

  return {
    ...capability,
    entryPoint: override.entryPoint ?? capability.entryPoint,
    appFingerprint: override.appFingerprint ?? capability.appFingerprint,
    steps,
  };
}
