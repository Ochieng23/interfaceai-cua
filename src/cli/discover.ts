#!/usr/bin/env node
/**
 * `npm run discover -- --goal "..." --param k=v --target <url> --name <name>` — SPEC §3/§7's
 * discovery CLI. This is the ONLY command in this codebase that makes a real Anthropic API
 * call; everything under `src/replay/**` remains LLM-free (SPEC §0.5).
 *
 * Scope decisions made for this task (documented here, per the task brief's instruction to
 * document reasonable calls rather than silently making them):
 *  - This CLI always binds `username`/`password` as `type: "secret"` inputParams, resolved
 *    from the `DEMO_USER`/`DEMO_PASS` env vars, REGARDLESS of `--param` flags — SPEC's own
 *    demo goal always starts with "Log in", and a fully generic multi-goal discovery CLI
 *    (that infers which params are secret from arbitrary goal text) is out of scope here.
 *  - Browser launches with `headless: false` by default (overridable via `HEADLESS=true`) —
 *    unlike `cli/replay.ts` (headless:true by default), a human watching a live LLM-driven
 *    discovery run happen is exactly the point of this command.
 *  - `GuardedSurface` is constructed with fully permissive-but-safe defaults
 *    (`capabilityStatus: "draft"`, default `getOwner` → always "automation"): there is no
 *    pre-existing Capability to gate against yet — this run IS what produces one — so the
 *    same guardrails that would apply to a draft capability during replay (allowlist,
 *    irreversible-action escalation) apply here too, which is the conservative/safe default.
 *    (See `discovery/loop.ts`'s `findRefRoleName`-adjacent comment for a real false-positive
 *    this surfaced — the search page's browser-synthesized "Submit" name colliding with
 *    policy.yaml's irreversible keyword list — and the narrow, non-guardrail-weakening fix
 *    applied for it: recognizing that ONE specific, proven-meaningless synthesized string
 *    isn't a real label, not loosening what counts as "irreversible" in general.)
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve as resolvePath, join as joinPath } from "node:path";

import { Command } from "commander";
import { chromium } from "playwright";

import { createRunId, ensureRunDir } from "../evidence/run";
import { EvidenceLogger } from "../evidence/logger";
import { loadPolicy } from "../guardrails/policy";
import { redactDeep, registerSecretValue } from "../guardrails/redact";
import { enrichLocator } from "../perception/enrich";
import { GuardedSurface } from "../surface/GuardedSurface";
import { PlaywrightSurface } from "../surface/PlaywrightSurface";
import { runDiscoveryLoop, type DiscoveryTurn } from "../discovery/loop";
import { recordCapability } from "../discovery/recorder";
import type { InputParamSpec } from "../schema/capability";

// Best-effort .env load — same pattern as cli/replay.ts, except discovery genuinely needs
// ANTHROPIC_API_KEY (createAnthropicClient() throws a clear, named error at call time if
// it's missing; we don't duplicate that check here).
const envPath = resolvePath(process.cwd(), ".env");
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    /* malformed .env — proceed with whatever the shell environment already provides */
  }
}

interface CliOptions {
  goal: string;
  param: string[];
  target: string;
  name: string;
  maxSteps: string;
  timeout: string;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const program = new Command();
program
  .name("discover")
  .requiredOption("--goal <text>", "the task to discover, may reference {param} placeholders")
  .option("--param <key=value>", "a bound parameter, repeatable (e.g. --param member_id=10001)", collect, [] as string[])
  .requiredOption("--target <url>", "the app's base origin (e.g. http://localhost:4173)")
  .requiredOption("--name <name>", "capability name — used for the artifact filename")
  .option("--max-steps <n>", "maximum discovery turns", "25")
  .option("--timeout <ms>", "wall-clock timeout in milliseconds", "300000");

program.parse(process.argv);
const opts = program.opts<CliOptions>();

function parseCliParams(raw: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    if (eq === -1) {
      console.error(`invalid --param "${entry}"; expected key=value`);
      process.exit(1);
    }
    out[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return out;
}

/** Builds the bound `InputParamSpec[]`: always `username`/`password` (secret), plus one
 * string-typed param per `--param k=v` — `example` is set to the literal value given, which
 * is this project's convention (see `recorder.ts`'s `matchBoundParam`) for "the concrete
 * value this param was bound to for this run," letting the recorder later recognize when the
 * model typed that exact value back and should emit `paramRef` instead of `valueLiteral`. */
function buildBoundParams(cliParams: Record<string, string>): InputParamSpec[] {
  const params: InputParamSpec[] = [
    {
      name: "username",
      type: "secret",
      required: true,
      description: "CU Console login username, resolved from the DEMO_USER env var.",
      pii: false,
    },
    {
      name: "password",
      type: "secret",
      required: true,
      description: "CU Console login password, resolved from the DEMO_PASS env var.",
      pii: false,
    },
  ];
  for (const [name, value] of Object.entries(cliParams)) {
    params.push({
      name,
      type: "string",
      required: true,
      description: `Bound parameter "${name}" for this discovery run.`,
      pii: false,
      example: value,
    });
  }
  return params;
}

/** Mirrors `cli/replay.ts`'s `makeSecretProvider` exactly — the mock app's real credential
 * env vars are `DEMO_USER`/`DEMO_PASS`, not the capability-level param names `username`/
 * `password`; this is the mapping seam. */
function makeSecretProvider(): (name: string) => string | undefined {
  return (name: string) => {
    if (name === "username") return process.env.DEMO_USER;
    if (name === "password") return process.env.DEMO_PASS;
    return process.env[name];
  };
}

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

async function main(): Promise<void> {
  const maxSteps = Number.parseInt(opts.maxSteps, 10);
  const timeoutMs = Number.parseInt(opts.timeout, 10);
  const cliParams = parseCliParams(opts.param);
  const boundParams = buildBoundParams(cliParams);

  // Register secret VALUES for redaction before ANY logging happens (same pattern as
  // src/replay/executor.ts's pii registration, and the analogous requirement in SPEC §9).
  const demoUser = process.env.DEMO_USER;
  const demoPass = process.env.DEMO_PASS;
  if (demoUser) registerSecretValue(demoUser);
  if (demoPass) registerSecretValue(demoPass);

  const runId = createRunId();
  const evidenceDir = ensureRunDir("discovery", runId);
  const screenshotsDir = joinPath(evidenceDir, "screenshots");
  mkdirSync(screenshotsDir, { recursive: true });

  const policy = loadPolicy();
  const logger = new EvidenceLogger(joinPath(evidenceDir, "log.jsonl"), policy);

  const transcriptEntries: unknown[] = [];
  let turnCounter = 0;

  const headless = process.env.HEADLESS === "true";
  const browser = await chromium.launch({ headless });

  // No initializer: every path that reaches `process.exitCode = exitCode` below assigns it
  // exactly once first (the if/else branches inside the try); an exception instead propagates
  // straight out of the function to the outer `main().catch(...)`, never reading this variable.
  let exitCode: number;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const playwrightSurface = new PlaywrightSurface(page);
    const guardedSurface = new GuardedSurface(playwrightSurface, policy, {
      capabilityStatus: "draft",
      secretProvider: makeSecretProvider(),
    });

    logger.log({ event: "discovery_run_started", runId, goal: opts.goal, target: opts.target, name: opts.name });
    await page.goto(opts.target, { waitUntil: "domcontentloaded" });

    function onTurn(turn: DiscoveryTurn): void {
      turnCounter += 1;
      const eventLabel = turn.toolCall ? turn.toolCall.name : "malformed";

      // Screenshot: saved unmasked directly from what the model was shown. This capability's
      // bound params (username/password/member_id) are never `pii: true`, so a mask list
      // would be empty anyway — see this file's header comment for why we don't take a
      // second, separately-masked screenshot per turn.
      let screenshotPath: string | undefined;
      if (turn.observation.screenshot && turn.observation.screenshot.length > 0) {
        const fileName = `${pad3(turnCounter)}-${eventLabel}.png`;
        writeFileSync(joinPath(screenshotsDir, fileName), turn.observation.screenshot);
        screenshotPath = joinPath("screenshots", fileName);
      }

      logger.log({
        event: "discovery_turn",
        runId,
        turnIndex: turnCounter,
        url: turn.observation.url,
        toolCall: turn.toolCall ? { name: turn.toolCall.name, input: turn.toolCall.input } : null,
        usage: turn.usage,
        model: turn.model,
        retried: turn.retried ?? false,
        screenshotPath,
      });

      // Redacted immediately, at construction time — the same choke point discipline the
      // logger itself uses — so the in-memory transcript array never holds an unredacted
      // secret value beyond this single synchronous statement.
      const entry = redactDeep(
        {
          turnIndex: turnCounter,
          model: turn.model,
          usage: turn.usage,
          retried: turn.retried ?? false,
          url: turn.observation.url,
          title: turn.observation.title,
          snapshotText: turn.observation.snapshotText,
          screenshotPath,
          toolCall: turn.toolCall,
        },
        policy,
      );
      transcriptEntries.push(entry);
    }

    async function captureLocator(ref: string, roleNameHint?: { role: string; name: string }) {
      const resolved = await playwrightSurface.getLocatorForRef(ref);
      if (!resolved) return undefined;
      // roleNameHint MUST be forwarded — see perception/enrich.ts's doc comment on
      // enrichLocator: deriving role/name live via Locator.ariaSnapshot() permanently
      // invalidates this aria-ref-sourced locator's native ref, breaking the surface.act()
      // call this same turn still needs to make against the same ref.
      //
      // `resolved.root` (NOT always `page`) MUST be used as the uniqueness-check root: this
      // app's member-search flow happens inside a same-origin iframe, and `Page.getByRole`/
      // `Page.locator` don't search inside iframes — passing `page` unconditionally silently
      // dropped the role tier (and left the css tier's uniqueness unconfirmed) for every
      // iframe-scoped step on a real discovery run. `getLocatorForRef` derives the correct
      // `Page | Frame` root from the ref's own tracked `frameIndex`.
      return enrichLocator(resolved.locator, resolved.root, roleNameHint);
    }

    const result = await runDiscoveryLoop(guardedSurface, opts.goal, boundParams, {
      maxSteps,
      timeoutMs,
      onTurn,
      captureLocator,
    });

    logger.log({
      event: "discovery_run_finished",
      runId,
      status: result.status,
      terminationReason: result.terminationReason,
      requestHelpReason: result.requestHelpReason,
      turnCount: result.turns.length,
    });

    writeFileSync(
      joinPath(evidenceDir, "transcript.redacted.json"),
      JSON.stringify(
        {
          runId,
          goal: opts.goal,
          target: opts.target,
          name: opts.name,
          model: result.turns[0]?.model,
          status: result.status,
          terminationReason: result.terminationReason,
          requestHelpReason: result.requestHelpReason,
          turns: transcriptEntries,
        },
        null,
        2,
      ),
      "utf-8",
    );

    if (result.status === "goal_complete") {
      const capability = recordCapability(result, opts.goal, boundParams, {
        name: opts.name,
        targetApp: opts.target,
        runId,
      });
      const artifactPath = resolvePath(process.cwd(), "artifacts", `${opts.name}.json`);
      writeFileSync(artifactPath, JSON.stringify(capability, null, 2), "utf-8");
      writeFileSync(joinPath(evidenceDir, "capability.json"), JSON.stringify(capability, null, 2), "utf-8");

      console.log(`\ndiscovery: goal_complete after ${result.turns.length} turn(s).`);
      console.log(`  summary: ${result.goalCompleteArgs?.summary}`);
      console.log(`  capability saved to: ${artifactPath}`);
      console.log(`  evidence: ${evidenceDir}`);
      exitCode = 0;
    } else {
      console.log(`\ndiscovery: ended with status "${result.status}" after ${result.turns.length} turn(s).`);
      if (result.terminationReason) console.log(`  reason: ${result.terminationReason}`);
      if (result.requestHelpReason) console.log(`  request_help reason: ${result.requestHelpReason}`);
      console.log(`  evidence: ${evidenceDir}`);
      exitCode = 1;
    }
  } finally {
    await browser.close();
  }

  process.exitCode = exitCode;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
