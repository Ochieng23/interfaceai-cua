#!/usr/bin/env node
/**
 * `npm run operator -- --run <run_id>` — SPEC §10/§3's operator CLI: the mock human-operator
 * surface for a paused replay run. Thin over `src/escalation/session.ts`'s real logic — this
 * file reads `control.json`/`intervention.json`, attaches to the ALREADY-RUNNING shared
 * browser session via `chromium.connectOverCDP`, transitions control state, and drives a small
 * REPL. It does not reimplement any control-flow/state-machine logic itself.
 *
 * Every browser-acting command goes through a plain `PlaywrightSurface` wrapping the SAME
 * connected page — deliberately NOT wrapped in `GuardedSurface`. `GuardedSurface`'s
 * control-ownership check exists specifically to block AUTOMATION while a human has control;
 * wrapping the human operator's own actions in that same check would be nonsensical (it would
 * block the human from doing the very thing they were asked to attach and do). Every command
 * is still logged through `EvidenceLogger` with `actor: "human"`, and any `snapshot` output
 * printed to the terminal goes through the same `redact()` choke point everything else in this
 * codebase uses.
 */

import { existsSync } from "node:fs";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";

import { Command } from "commander";
import { chromium } from "playwright";

import { readControl, transitionControl } from "../escalation/session";
import { readIntervention } from "../escalation/intervention";
import { EvidenceLogger } from "../evidence/logger";
import { runDir } from "../evidence/run";
import { loadPolicy } from "../guardrails/policy";
import { redact } from "../guardrails/redact";
import { PlaywrightSurface } from "../surface/PlaywrightSurface";

const envPath = resolvePath(process.cwd(), ".env");
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // Malformed .env — proceed with whatever the shell environment already provides.
  }
}

interface CliOptions {
  run: string;
}

const program = new Command();
program.name("operator").requiredOption("--run <run_id>", "the replay run id to attach to");
program.parse(process.argv);
const opts = program.opts<CliOptions>();

function printIntervention(runId: string): { currentUrl?: string } {
  try {
    const req = readIntervention("replay", runId);
    console.log("=== Intervention request ===");
    console.log(`  reason:      ${req.reason}`);
    console.log(`  stepId:      ${req.stepId ?? "(entry)"}`);
    console.log(`  stepDesc:    ${req.stepDescription ?? "(n/a)"}`);
    console.log(`  currentUrl:  ${req.currentUrl}`);
    console.log(`  screenshot:  evidence/replay/${runId}/${req.screenshotPath}`);
    console.log(`  snapshot:    evidence/replay/${runId}/${req.snapshotPath}`);
    console.log(`  cdpEndpoint: ${req.cdpEndpoint}`);
    console.log(`  createdAt:   ${req.createdAt}`);
    console.log("=============================\n");
    return { currentUrl: req.currentUrl };
  } catch {
    console.warn(`(no intervention.json found for run ${runId} — proceeding without it)\n`);
    return {};
  }
}

async function main(): Promise<void> {
  const runId = opts.run;

  const control = readControl(runId);
  if (!control) {
    console.error(
      `no control.json found for run ${runId} (looked in evidence/replay/${runId}/control.json) — ` +
        `is the replay process running and currently escalated?`,
    );
    process.exitCode = 1;
    return;
  }

  const { currentUrl } = printIntervention(runId);

  const cdpEndpoint = control.cdpEndpoint;
  if (!cdpEndpoint) {
    console.error("control.json has no cdpEndpoint recorded; cannot attach.");
    process.exitCode = 1;
    return;
  }

  console.log(`connecting to ${cdpEndpoint} ...`);
  const browser = await chromium.connectOverCDP(cdpEndpoint);
  const context = browser.contexts()[0];
  if (!context) {
    console.error("connected, but no browser context was found at that CDP endpoint.");
    process.exitCode = 1;
    return;
  }

  // Page selection: prefer the page whose URL matches the intervention request's currentUrl
  // (the page the automation process was actually stuck on); fall back to the most recently
  // created page (last in `context.pages()`), since that's the one most likely to be the live
  // one a persistent context with exactly one open tab will have; fall back to whatever's
  // there.
  const pages = context.pages();
  const page =
    (currentUrl ? pages.find((p) => p.url() === currentUrl) : undefined) ?? pages[pages.length - 1] ?? pages[0];
  if (!page) {
    console.error("connected, but the context has no open pages.");
    process.exitCode = 1;
    return;
  }
  console.log(`attached to page: ${page.url()}`);

  // Idempotent attach: "operator_attach" is only a LEGAL transition() from
  // PAUSED_AWAITING_HUMAN. If a previous operator CLI invocation already attached (e.g. it
  // was killed/disconnected before typing "resume"/"abort"), control.json is already
  // HUMAN_IN_CONTROL — reattaching should just continue, not crash on an illegal-transition
  // error.
  if (control.state === "PAUSED_AWAITING_HUMAN") {
    transitionControl(runId, "operator_attach");
    console.log(`control.json: PAUSED_AWAITING_HUMAN -> HUMAN_IN_CONTROL\n`);
  } else if (control.state === "HUMAN_IN_CONTROL") {
    console.log(`control.json is already HUMAN_IN_CONTROL (reattaching to an existing session).\n`);
  } else {
    console.error(`control.json is in state "${control.state}", not PAUSED_AWAITING_HUMAN or HUMAN_IN_CONTROL — nothing to attach to.`);
    process.exitCode = 1;
    return;
  }

  const policy = loadPolicy();
  const logger = new EvidenceLogger(joinPath(runDir("replay", runId), "log.jsonl"), policy);
  logger.log({ runId, actor: "human", event: "operator_attached", cdpEndpoint });

  const surface = new PlaywrightSurface(page);

  console.log("Commands: snapshot | click <ref> | type <ref> <text> | note <text> | resume | abort");
  console.log("(run `snapshot` first to see numbered refs before `click`/`type`)\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "operator> " });
  rl.prompt();

  // Commands MUST run strictly one at a time, in the order typed. Node's `readline` fires
  // "line" for every newline already sitting in its input buffer essentially back-to-back
  // (this matters most for piped/scripted input, e.g. this task's own live verification) —
  // a naive `rl.on("line", (l) => { void handle(l); })` starts a NEW concurrent async handler
  // per line without waiting for the previous one, so e.g. a `click`, immediately followed by
  // `resume`, can race: `resume` (whose own body has no `await` before it) can finish and
  // transition control.json to RESUMING before the `click`'s `surface.act()` promise has even
  // resolved. Observed exactly this race empirically during this task's live verification.
  // Chaining every command onto a single `Promise` queue serializes them regardless of how
  // bunched-up the "line" events arrive.
  let queue: Promise<void> = Promise.resolve();
  rl.on("line", (lineRaw: string) => {
    queue = queue.then(() => handleLine(lineRaw));
  });

  async function handleLine(lineRaw: string): Promise<void> {
    const line = lineRaw.trim();
    if (!line) {
      rl.prompt();
      return;
    }
    const [cmd, ...rest] = line.split(/\s+/);

    try {
      switch (cmd) {
        case "snapshot": {
          const obs = await surface.observe();
          logger.log({ runId, actor: "human", event: "operator_snapshot", url: obs.url });
          console.log(redact(obs.snapshotText, policy));
          break;
        }
        case "click": {
          const ref = rest[0];
          if (!ref) {
            console.log("usage: click <ref>");
            break;
          }
          await surface.act({ kind: "click", ref, risk: "reversible" });
          logger.log({ runId, actor: "human", event: "operator_click", ref });
          console.log(`clicked ${ref}`);
          break;
        }
        case "type": {
          const ref = rest[0];
          const text = rest.slice(1).join(" ");
          if (!ref || !text) {
            console.log("usage: type <ref> <text>");
            break;
          }
          await surface.act({ kind: "fill", ref, value: text, risk: "reversible" });
          // `text` is redacted by EvidenceLogger's own redactDeep() pass before it's ever
          // written — never logged raw beyond this in-memory call.
          logger.log({ runId, actor: "human", event: "operator_type", ref, text });
          console.log(`typed into ${ref}`);
          break;
        }
        case "note": {
          const text = rest.join(" ");
          logger.log({ runId, actor: "human", event: "operator_note", text });
          console.log("noted.");
          break;
        }
        case "resume": {
          transitionControl(runId, "resume");
          logger.log({ runId, actor: "human", event: "operator_resume" });
          console.log("control.json: HUMAN_IN_CONTROL -> RESUMING. The paused replay process should wake up shortly.");
          rl.close();
          return;
        }
        case "abort": {
          transitionControl(runId, "abort");
          logger.log({ runId, actor: "human", event: "operator_abort" });
          console.log("control.json: -> ABORTED.");
          rl.close();
          return;
        }
        default:
          console.log(
            `unknown command: "${cmd}". Commands: snapshot | click <ref> | type <ref> <text> | note <text> | resume | abort`,
          );
      }
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
    rl.prompt();
  }

  await new Promise<void>((resolveFn) => {
    rl.on("close", async () => {
      // Deliberately do NOT call browser.close() here: this `browser` object came from
      // `connectOverCDP`, and the automation process still owns the actual browser/page —
      // closing it out from under a still-running (or about-to-resume) replay process would
      // be exactly the wrong thing. We only want to drop THIS CLI's own CDP connection.
      //
      // However, Playwright's CDP connection keeps an open WebSocket that keeps Node's event
      // loop alive on its own (observed empirically: without a forced exit, this process
      // hangs indefinitely after the REPL closes, even though nothing is left for it to do).
      // `process.exit()` right after resolving is the deliberate, documented way this CLI
      // terminates itself without touching the remote browser's lifecycle.
      //
      // IMPORTANT: `close` can fire before the last queued command (from the serial `queue`
      // above) has actually finished — readline emits it right after the final buffered
      // "line" event, which for piped/non-interactive stdin can race ahead of an in-flight
      // async handler (e.g. a `resume`/`abort` still awaiting `surface.act()`). Await the
      // queue here so a scripted invocation can't silently lose its last command. An
      // interactive human typing at a real terminal is unaffected either way, since
      // `resume`/`abort` already close `rl` themselves only after their own handler resolves.
      await queue;
      resolveFn();
    });
  });
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
