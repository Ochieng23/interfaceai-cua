/**
 * Loads and evaluates `policy.yaml` (SPEC §9). This module is the natural home for the
 * `PolicyViolation` error type since it's the "policy" concept's home file; `GuardedSurface`
 * imports it from here rather than redefining it.
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";

export interface Policy {
  allowlist: {
    origins: string[];
    routes: string[];
    actions: string[];
  };
  risk: {
    irreversible_when: {
      button_text_matches: string[];
      method_is: string[];
    };
    irreversible_policy: "block" | "escalate" | "allow_if_approved";
  };
  redaction: {
    patterns: Array<{ name: string; regex: string }>;
  };
}

/**
 * Thrown by `GuardedSurface` (and usable elsewhere) whenever an action is blocked by
 * policy — off-allowlist origin/route, a disallowed action kind, or an irreversible-risk
 * decision that resolves to "block". `failureClass` lets a caller (e.g. the later replay
 * executor) set `ReplayResult.failureClass` without string-matching the error message.
 */
export class PolicyViolation extends Error {
  readonly failureClass = "policy_blocked" as const;
  constructor(message: string) {
    super(message);
    this.name = "PolicyViolation";
  }
}

const DEFAULT_POLICY_PATH = resolvePath(process.cwd(), "policy.yaml");

// Module-level cache keyed by resolved path, so repeated `loadPolicy()` calls in the same
// process don't re-read/re-parse the file every time. Tests that need a fresh read of a
// possibly-mutated policy file for isolation should either pass an explicit path unique to
// that test, or call `clearPolicyCache()` between tests — do not rely on the default-path
// cache staying valid across a test file that also writes policy.yaml.
const cache = new Map<string, Policy>();

export function loadPolicy(path: string = DEFAULT_POLICY_PATH): Policy {
  const resolved = resolvePath(path);
  const cached = cache.get(resolved);
  if (cached) {
    return cached;
  }
  const raw = readFileSync(resolved, "utf-8");
  const parsed = parseYaml(raw) as Policy;
  cache.set(resolved, parsed);
  return parsed;
}

/** Test-only escape hatch: clears the module-level cache so a subsequent `loadPolicy()` re-reads. */
export function clearPolicyCache(): void {
  cache.clear();
}

/**
 * Converts a glob-style route pattern (`**` = "anything below this segment", `*` =
 * "anything within this segment") into a RegExp, by escaping regex metacharacters first and
 * then re-introducing `.*` / `[^/]*` for the glob wildcards. No new dependency: a small
 * hand-written matcher is sufficient for the patterns policy.yaml actually uses
 * (e.g. "/member/**" matches "/member/10001" and "/member/10001/subaccount/new").
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withWildcards = escaped.replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
  return new RegExp(`^${withWildcards}$`);
}

export function isUrlAllowed(url: string, policy: Policy): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const origin = `${parsed.protocol}//${parsed.host}`;
  if (!policy.allowlist.origins.includes(origin)) {
    return false;
  }
  return policy.allowlist.routes.some((pattern) => globToRegExp(pattern).test(parsed.pathname));
}

export function isActionAllowed(kind: string, policy: Policy): boolean {
  return policy.allowlist.actions.includes(kind);
}
