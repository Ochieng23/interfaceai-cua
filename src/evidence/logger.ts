/**
 * Single-process, synchronous JSONL evidence logger (SPEC §0.6, §11). No batching, no async
 * queue — every `log()` call redacts and appends one line immediately.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { redactDeep } from "../guardrails/redact";
import type { Policy } from "../guardrails/policy";

export class EvidenceLogger {
  private readonly filePath: string;
  private readonly policy: Policy;

  constructor(filePath: string, policy: Policy) {
    this.filePath = filePath;
    this.policy = policy;
    mkdirSync(dirname(filePath), { recursive: true });
  }

  /**
   * Redacts the ENTIRE entry (every string found anywhere in it, recursively) via
   * `redactDeep` before it is ever serialized — not just fields the caller happens to
   * remember are sensitive. Appends the JSON-stringified result plus a trailing newline.
   */
  log(entry: Record<string, unknown>): void {
    const redacted = redactDeep(entry, this.policy);
    appendFileSync(this.filePath, `${JSON.stringify(redacted)}\n`, "utf-8");
  }
}
