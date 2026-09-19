import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EvidenceLogger } from "../src/evidence/logger";
import { createRunId } from "../src/evidence/run";
import { clearPolicyCache, loadPolicy, type Policy } from "../src/guardrails/policy";
import { clearRegistry, registerSecretValue } from "../src/guardrails/redact";

const POLICY_PATH = new URL("../policy.yaml", import.meta.url).pathname;

function loadTestPolicy(): Policy {
  clearPolicyCache();
  return loadPolicy(POLICY_PATH);
}

// All logger tests write under a fresh OS-tmpdir directory per test, never under the
// committed evidence/ folder — so nothing here pollutes real evidence.
let scratchDir: string;

afterEach(() => {
  clearRegistry();
  if (scratchDir && existsSync(scratchDir)) {
    rmSync(scratchDir, { recursive: true, force: true });
  }
  vi.useRealTimers();
});

describe("EvidenceLogger", () => {
  it("creates the file and the full parent directory tree from scratch", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "interfaceai-evidence-test-"));
    const nestedLogPath = join(scratchDir, "discovery", "run-abc", "log.jsonl");
    expect(existsSync(nestedLogPath)).toBe(false);

    const policy = loadTestPolicy();
    const logger = new EvidenceLogger(nestedLogPath, policy);
    logger.log({ event: "started" });

    expect(existsSync(nestedLogPath)).toBe(true);
    const contents = readFileSync(nestedLogPath, "utf-8");
    expect(contents.trim().length).toBeGreaterThan(0);
    expect(JSON.parse(contents.trim().split("\n")[0] as string)).toEqual({ event: "started" });
  });

  it("appends one JSON line per log() call", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "interfaceai-evidence-test-"));
    const logPath = join(scratchDir, "log.jsonl");
    const policy = loadTestPolicy();
    const logger = new EvidenceLogger(logPath, policy);

    logger.log({ event: "first" });
    logger.log({ event: "second" });

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toEqual({ event: "first" });
    expect(JSON.parse(lines[1] as string)).toEqual({ event: "second" });
  });

  it("redacts a registered secret via the redactDeep choke point before writing", () => {
    scratchDir = mkdtempSync(join(tmpdir(), "interfaceai-evidence-test-"));
    const logPath = join(scratchDir, "log.jsonl");
    const policy = loadTestPolicy();
    registerSecretValue("the-real-secret-value");
    const logger = new EvidenceLogger(logPath, policy);

    logger.log({ event: "fill", value: "the-real-secret-value", nested: { note: "pw=the-real-secret-value" } });

    const contents = readFileSync(logPath, "utf-8");
    expect(contents).not.toContain("the-real-secret-value");
    expect(contents).toContain("[REDACTED]");
  });
});

describe("createRunId", () => {
  it("produces unique ids across many calls made at distinct instants, and sorts (lexicographically) in creation order", () => {
    // The realistic case: one run id per invocation of the CLI, each at a distinct moment.
    // Deterministic (no flakiness): distinct millisecond timestamps alone guarantee distinct
    // ids, independent of the random suffix, and the ISO-timestamp prefix guarantees
    // lexicographic sort matches chronological/creation order.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const generationOrder: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      generationOrder.push(createRunId());
      vi.setSystemTime(new Date(Date.now() + 1));
    }

    expect(new Set(generationOrder).size).toBe(generationOrder.length);
    const lexicographicOrder = [...generationOrder].sort();
    expect(lexicographicOrder).toEqual(generationOrder);
  });

  it("random suffix distinguishes ids generated within the very same millisecond", () => {
    // Collision-resistance sanity check for the part of the id that ISN'T the timestamp: 3
    // random bytes (~16.7M values) means a modest sample size at a frozen instant should
    // come back all-unique with overwhelming probability (~1 in ~13,700 chance of any
    // collision at n=50, per the birthday bound) without making the test suite flaky.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const ids = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      ids.add(createRunId());
    }

    expect(ids.size).toBe(50);
  });
});
