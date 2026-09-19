/**
 * The Anthropic client used only by `src/discovery/**` (SPEC §7). This is the ONE place in
 * the codebase that constructs an `Anthropic` client — `src/replay/**` must never import
 * `@anthropic-ai/sdk` at all (SPEC §0.5, grep-verifiable), but discovery is a completely
 * separate module tree where a real LLM call is the whole point.
 *
 * Matches the proven Azure AI Foundry-compatible pattern already used elsewhere by this
 * developer: `baseURL` is optional (routes through a compatible proxy/gateway when set,
 * e.g. an Azure AI Foundry endpoint exposing the Anthropic Messages API — see .env.example),
 * falls back to the real Anthropic API when unset.
 */

import Anthropic from "@anthropic-ai/sdk";

/**
 * Throws at CALL time (never at module-load time — importing this file must never throw,
 * so e.g. `tsc`/tests that merely import discovery code don't require an API key) if
 * `ANTHROPIC_API_KEY` is unset. Names the env var only — never any value, per the task's
 * explicit instruction (there is no value to leak here anyway when it's unset, but the
 * principle holds for consistency with the rest of this codebase's secret-handling).
 */
export function createAnthropicClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Discovery requires a real Anthropic-compatible API key " +
        "(see .env.example) — copy .env.example to .env and fill it in.",
    );
  }
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
  });
}

export const MODEL = process.env.MODEL || "claude-sonnet-4-6";
