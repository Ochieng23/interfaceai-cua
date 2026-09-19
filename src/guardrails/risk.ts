/**
 * Pure risk classification (SPEC §9). Not wired into anything yet in this task — no
 * discovery loop or recorder exists — it exists now so `GuardedSurface`'s tests can
 * exercise `irreversible_policy` behavior meaningfully, and so a later task can import it
 * unchanged.
 */

import type { Policy } from "./policy";

export type RiskLevel = "safe" | "reversible" | "irreversible";

export interface RiskClassificationInput {
  buttonText?: string;
  accessibleName?: string;
  httpMethodHint?: string;
}

/**
 * Returns "irreversible" if `buttonText` or `accessibleName` case-insensitively contains
 * any of `policy.risk.irreversible_when.button_text_matches`, OR `httpMethodHint` is in
 * `policy.risk.irreversible_when.method_is`. Otherwise "reversible" — this function isn't
 * asked to produce "safe" yet (that's a later recorder-time nuance), it just returns a
 * type that allows for it.
 */
export function classifyActionRisk(input: RiskClassificationInput, policy: Policy): RiskLevel {
  const { button_text_matches, method_is } = policy.risk.irreversible_when;

  const haystacks = [input.buttonText, input.accessibleName]
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.toLowerCase());

  const textMatch = button_text_matches.some((phrase) =>
    haystacks.some((haystack) => haystack.includes(phrase.toLowerCase())),
  );
  if (textMatch) {
    return "irreversible";
  }

  if (input.httpMethodHint && method_is.includes(input.httpMethodHint)) {
    return "irreversible";
  }

  return "reversible";
}
