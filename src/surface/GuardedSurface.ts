/**
 * GuardedSurface — the single enforcement point (SPEC §9): "There is exactly one place in
 * the codebase where 'is this action allowed right now' is decided." Every action, both
 * discovery and replay, must be routed through a `GuardedSurface` wrapping the real
 * `Surface` for this invariant to hold; nothing else in the codebase should re-implement
 * any of these checks.
 *
 * Only `act()` is guarded — `resolve`/`readText`/`screenshot`/`currentUrl`/`waitForSettle`
 * pass straight through to the wrapped surface, per spec ("guardrails apply to
 * `Surface.act()` — the state-changing operation — only").
 *
 * Check order inside `act()` (matters for correct error attribution to a caller trying to
 * diagnose *why* an action was refused):
 *   1. control ownership   → ControlNotOwnedError
 *   2. allowlist            → PolicyViolation
 *   3. risk / irreversibility → PolicyViolation | EscalationRequired
 *   4. secret substitution, then delegate to the wrapped surface
 */

import type { Surface, SurfaceAction } from "./Surface";
import { isActionAllowed, isUrlAllowed, PolicyViolation, type Policy } from "../guardrails/policy";

export type ControlOwner = "automation" | "human" | "none";

/**
 * Thrown when `getOwner()` reports anything other than "automation" at the moment `act()`
 * is called. This is a fail-fast safety-net check, NOT a scheduler: GuardedSurface does not
 * poll or wait for ownership to change — polling/waiting, if a caller wants it, is the
 * CALLER's responsibility before it ever calls `act()`.
 */
export class ControlNotOwnedError extends Error {
  constructor(owner: ControlOwner) {
    super(`control is not owned by automation (owner: "${owner}")`);
    this.name = "ControlNotOwnedError";
  }
}

/**
 * Thrown when an `irreversible`-risk action hits `irreversible_policy: "escalate"` on a
 * capability that isn't yet `status: "approved"`. A later task catches this and actually
 * pauses for a human; for this task, throwing it correctly is the whole job.
 */
export class EscalationRequired extends Error {
  constructor(message = "irreversible action requires human escalation") {
    super(message);
    this.name = "EscalationRequired";
  }
}

/** `{{secret:NAME}}` — the exact literal placeholder pattern substituted before delegation. */
export const SECRET_PLACEHOLDER_RE = /^\{\{secret:([A-Za-z0-9_]+)\}\}$/;

export type SecretProvider = (name: string) => string | undefined;

export interface GuardedSurfaceOptions {
  /** Default: always returns "automation" (real control.json wiring is a later task). */
  getOwner?: () => ControlOwner;
  /** Default: "draft". */
  capabilityStatus?: "draft" | "approved";
  /** Default: reads `process.env[name]`. */
  secretProvider?: SecretProvider;
}

export class GuardedSurface implements Surface {
  private readonly inner: Surface;
  private readonly policy: Policy;
  private readonly getOwner: () => ControlOwner;
  private readonly capabilityStatus: "draft" | "approved";
  private readonly secretProvider: SecretProvider;

  constructor(inner: Surface, policy: Policy, options: GuardedSurfaceOptions = {}) {
    this.inner = inner;
    this.policy = policy;
    this.getOwner = options.getOwner ?? (() => "automation");
    this.capabilityStatus = options.capabilityStatus ?? "draft";
    this.secretProvider = options.secretProvider ?? ((name: string) => process.env[name]);
  }

  async act(action: SurfaceAction): Promise<void> {
    // 1. control ownership
    const owner = this.getOwner();
    if (owner !== "automation") {
      throw new ControlNotOwnedError(owner);
    }

    // 2. allowlist (origin/route for navigate, action kind for everything)
    if (action.kind === "navigate" && action.value !== undefined) {
      if (!isUrlAllowed(action.value, this.policy)) {
        throw new PolicyViolation(`navigate target is not in the allowlist: ${action.value}`);
      }
    }
    if (!isActionAllowed(action.kind, this.policy)) {
      throw new PolicyViolation(`action kind is not in the allowlist: ${action.kind}`);
    }

    // 3. risk / irreversibility
    const risk = action.risk ?? "reversible";
    if (risk === "irreversible") {
      const irreversiblePolicy = this.policy.risk.irreversible_policy;
      if (irreversiblePolicy === "block") {
        throw new PolicyViolation("irreversible action blocked by policy");
      } else if (irreversiblePolicy === "escalate") {
        if (this.capabilityStatus !== "approved") {
          throw new EscalationRequired();
        }
        // approved: proceed normally
      } else if (irreversiblePolicy === "allow_if_approved") {
        if (this.capabilityStatus !== "approved") {
          throw new PolicyViolation("irreversible action requires an approved capability");
        }
        // approved: proceed normally
      }
    }

    // 4. secret substitution — build a NEW action, never mutate/return the original, never
    // let the resolved value escape into anything this class returns or throws.
    const outgoing = this.substituteSecret(action);
    await this.inner.act(outgoing);
  }

  private substituteSecret(action: SurfaceAction): SurfaceAction {
    if (action.value === undefined) {
      return action;
    }
    const match = SECRET_PLACEHOLDER_RE.exec(action.value);
    if (!match) {
      return action;
    }
    const name = match[1] as string;
    const resolved = this.secretProvider(name);
    if (resolved === undefined) {
      // Do not include the env var VALUE (there isn't one) — the NAME is fine to mention.
      throw new Error(`secret "${name}" is not available (checked env var ${name})`);
    }
    return { ...action, value: resolved };
  }

  // Unguarded pass-throughs — guardrails apply to act() only.
  observe(): ReturnType<Surface["observe"]> {
    return this.inner.observe();
  }

  resolve(...args: Parameters<Surface["resolve"]>): ReturnType<Surface["resolve"]> {
    return this.inner.resolve(...args);
  }

  readText(...args: Parameters<Surface["readText"]>): ReturnType<Surface["readText"]> {
    return this.inner.readText(...args);
  }

  screenshot(...args: Parameters<Surface["screenshot"]>): ReturnType<Surface["screenshot"]> {
    return this.inner.screenshot(...args);
  }

  currentUrl(): string {
    return this.inner.currentUrl();
  }

  waitForSettle(...args: Parameters<Surface["waitForSettle"]>): ReturnType<Surface["waitForSettle"]> {
    return this.inner.waitForSettle(...args);
  }
}
