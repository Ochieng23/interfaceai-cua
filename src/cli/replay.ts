#!/usr/bin/env node
/**
 * `npm run replay -- --capability <path> --param k=v ...` — SPEC §3/§8's deterministic replay
 * CLI. No LLM anywhere on this path (SPEC §0.5): this file, and everything it imports under
 * `src/replay/`, never touches `@anthropic-ai/sdk`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join as joinPath, resolve as resolvePath } from "node:path";

import { Command } from "commander";
import { ZodError } from "zod";

import { computeFingerprint } from "../perception/fingerprint";
import { executeCapability } from "../replay/executor";
import { applyTenantOverride, type TenantOverride } from "../replay/tenantOverride";
import { createRunId, ensureRunDir } from "../evidence/run";
import { EvidenceLogger } from "../evidence/logger";
import { loadPolicy } from "../guardrails/policy";
import { Capability, type LocatorSpec } from "../schema/capability";
import type { ReplayResult } from "../schema/result";
import { GuardedSurface } from "../surface/GuardedSurface";
import { PlaywrightSurface } from "../surface/PlaywrightSurface";
import { createEscalationHook, launchSharedSession, readControl } from "../escalation/session";
import { buildMaskSpecs, redactDeep, registerSecretValue } from "../guardrails/redact";

// Best-effort .env load. Every var this CLI itself reads (DEMO_USER/DEMO_PASS, HEADLESS) has
// a documented fallback or is optional, so a missing/malformed .env is never fatal here —
// unlike `discover.ts` (a later task), replay never needs ANTHROPIC_API_KEY.
const envPath = resolvePath(process.cwd(), ".env");
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // Malformed .env — proceed with whatever the shell environment already provides.
  }
}

interface CliOptions {
  capability: string;
  param: string[];
  tenant?: string;
  inject?: string;
  approveIrreversible: boolean;
}

function collectParam(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const program = new Command();
program
  .name("replay")
  .requiredOption("--capability <path>", "path to a Capability JSON file")
  .option("--param <key=value>", "input param, repeatable", collectParam, [] as string[])
  .option(
    "--tenant <name>",
    "tenant key to run under; when capability.tenantOverrides[name] exists, it is deep-merged " +
      "into a copy of the capability (entryPoint + per-step target/valueLiteral/checkpoint " +
      "overrides, matched by step id — see src/replay/tenantOverride.ts) before the run starts",
  )
  .option("--inject <mode>", "dev-only: sets a failure-injection cookie before the run (slow|error|dialog|stuck|expire|none)")
  .option(
    "--approve-irreversible",
    "dev flag: treat the capability as status=approved for this run regardless of its JSON " +
      "(real use should be rare/dev-only — the production gate is the capability's own status)",
    false,
  );

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

/**
 * Resolves `--param` entries against `capability.inputParams`. Secret-typed params are
 * deliberately skipped here — their VALUES never come from the CLI or from this function; they
 * are substituted by `GuardedSurface` at `act()`-time from the `{{secret:NAME}}` placeholder
 * the executor builds (see executor.ts's `buildAction`). This function must not require
 * `--param username=...`/`--param password=...` and must not read `process.env` itself.
 */
function resolveParams(
  capability: Capability,
  cliParams: Record<string, string>,
): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = {};
  for (const spec of capability.inputParams) {
    if (spec.type === "secret") {
      continue;
    }
    const provided = cliParams[spec.name];
    if (provided === undefined) {
      if (spec.required) {
        console.error(`missing required --param ${spec.name} (${spec.description})`);
        process.exit(1);
      }
      continue;
    }
    if (spec.type === "number") {
      params[spec.name] = Number(provided);
    } else if (spec.type === "boolean") {
      params[spec.name] = provided === "true";
    } else {
      params[spec.name] = provided;
    }
  }
  return params;
}

/**
 * Maps a secret-typed inputParam's NAME to the actual env var the mock app's credentials live
 * under. `GuardedSurface`'s default `secretProvider` does a literal `process.env[name]` lookup
 * — this capability declares its secret params as `username`/`password` (matching SPEC §7's
 * own discovery example: `{{secret:password}}`), which are NOT the literal env var names
 * (`DEMO_USER`/`DEMO_PASS` — see `.env.example`). This CLI-level mapping is the seam
 * `GuardedSurfaceOptions.secretProvider` exists for; falls through to a direct env lookup for
 * any other secret-typed param name a future capability might declare.
 */
function makeSecretProvider(): (name: string) => string | undefined {
  return (name: string) => {
    if (name === "username") return process.env.DEMO_USER;
    if (name === "password") return process.env.DEMO_PASS;
    return process.env[name];
  };
}

/**
 * Builds the `maskSpecs` list (SPEC §11: screenshots must be masked) `Surface.screenshot()`
 * needs, from whatever this capability itself already flags as PII: a step's `target` when
 * that step fills a `pii: true` inputParam, and a declared output's `source` when the output
 * itself is `pii: true`. This is the CLI-level "decide which locators need masking" step
 * `buildMaskSpecs` (src/guardrails/redact.ts) has always documented as a later task's job —
 * `buildMaskSpecs` itself stays a pure pass-through/validation seam.
 */
function buildRunMaskSpecs(capability: Capability): LocatorSpec[] {
  const piiParamNames = new Set(capability.inputParams.filter((p) => p.pii).map((p) => p.name));
  const specs: LocatorSpec[] = [];
  for (const step of capability.steps) {
    if (step.target && step.paramRef && piiParamNames.has(step.paramRef)) {
      specs.push(step.target);
    }
  }
  for (const output of capability.outputs) {
    if (output.pii) {
      specs.push(output.source);
    }
  }
  return buildMaskSpecs(specs);
}

/**
 * Reads, parses, and schema-validates a capability file, with a clean, specific diagnostic
 * for each failure mode — a missing file, malformed JSON, or JSON that doesn't match the
 * `Capability` schema each get their own message, consistent with `resolveParams`'s handling
 * of a missing `--param` (which names the param and its description rather than dumping a
 * raw exception). Without this, all three fell through to the generic top-level
 * `main().catch()`, which would print a raw `ENOENT` stack trace or an unformatted `ZodError`
 * object instead. Exits the process with code 1 on any failure; never throws.
 */
function loadCapability(path: string): Capability {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    console.error(
      code === "ENOENT"
        ? `capability file not found: ${path}`
        : `failed to read capability file ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    console.error(`invalid capability JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  try {
    return Capability.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n");
      console.error(`capability ${path} does not match the Capability schema:\n${issues}`);
    } else {
      console.error(`failed to validate capability ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const capabilityPath = resolvePath(opts.capability);
  const rawCapability = loadCapability(capabilityPath);

  // Tenant-override deep-merge (SPEC §12, implemented here — see src/replay/tenantOverride.ts
  // for the full rationale on exactly which fields a tenant override touches for this app).
  // `capability` from this point on is ALWAYS the (possibly merged) copy every other part of
  // this function uses — the pre-merge `rawCapability` is never referenced again, so a run
  // with `--tenant b` genuinely exercises the merged entryPoint/steps end to end, including
  // the `--inject` origin resolution below (a real gap in an earlier draft: injecting against
  // `rawCapability.entryPoint`'s tenant-A origin would silently no-op for a tenant-B run
  // pointed at a different port).
  let capability = rawCapability;
  if (opts.tenant) {
    const override = (rawCapability.tenantOverrides as Record<string, TenantOverride> | undefined)?.[opts.tenant];
    if (!override) {
      console.warn(
        `--tenant "${opts.tenant}" given but capability.tenantOverrides has no entry for it; ` +
          `proceeding without a merge.`,
      );
    } else {
      capability = applyTenantOverride(rawCapability, override);
      console.log(`[tenant] merged tenantOverrides.${opts.tenant}: entryPoint=${capability.entryPoint}`);
    }
  }

  const cliParams = parseCliParams(opts.param);
  const params = resolveParams(capability, cliParams);

  // Register secret VALUES for redaction before ANY logging happens (same discipline as
  // `src/replay/executor.ts`'s own pii registration, and `cli/discover.ts`'s identical
  // DEMO_USER/DEMO_PASS registration). This was a latent gap before Task 8: nothing under
  // `src/replay/**` ever logged a raw secret value (GuardedSurface resolves it only at the
  // moment it hands off to the real Surface, and never returns/logs it), so redaction was
  // never actually exercised for these values. Task 8's human-action capture changes that —
  // it observes raw DOM `input`/`change` events, which DOES include values the automation
  // itself fills in via GuardedSurface's secret substitution (e.g. while retrying a step
  // after a human resumes an escalated run) — so these must be registered here, unconditional
  // of whether this run ever actually escalates.
  const demoUser = process.env.DEMO_USER;
  const demoPass = process.env.DEMO_PASS;
  if (demoUser) registerSecretValue(demoUser);
  if (demoPass) registerSecretValue(demoPass);

  const runId = createRunId();
  const evidenceDir = ensureRunDir("replay", runId);
  const policy = loadPolicy();
  const logger = new EvidenceLogger(resolvePath(evidenceDir, "log.jsonl"), policy);

  // Task 8 (SPEC §10): launched via `launchPersistentContext` + a fixed CDP port, NOT a plain
  // `chromium.launch()` — this is what lets `cli/operator.ts`, running in a SEPARATE process,
  // attach to this exact browser/page via `chromium.connectOverCDP` when a human needs to take
  // over. See `src/escalation/session.ts`'s header comment for the full rationale.
  const { context, page, cdpEndpoint } = await launchSharedSession(runId);
  logger.log({ runId, event: "shared_session_launched", cdpEndpoint });

  try {
    if (opts.inject) {
      const entryOrigin = new URL(capability.entryPoint).origin;
      const injectUrl = `${entryOrigin}/__inject?mode=${encodeURIComponent(opts.inject)}`;
      // Bypasses GuardedSurface deliberately — __inject is a dev-only harness route, not part
      // of the capability's own allowlisted step sequence (see mockapp/inject.ts).
      await page.goto(injectUrl, { waitUntil: "domcontentloaded" });
    }

    const playwrightSurface = new PlaywrightSurface(page);
    const guardedSurface = new GuardedSurface(playwrightSurface, policy, {
      capabilityStatus: opts.approveIrreversible ? "approved" : capability.status,
      secretProvider: makeSecretProvider(),
      // Real ownership check (SPEC §9/§10): while `control.json` says a human has taken
      // control, automation must never be able to call `act()` — even though in practice the
      // executor is already blocked awaiting `onEscalationNeeded`'s promise during that
      // window, this makes the invariant hold at GuardedSurface's own enforcement point too,
      // not just "by construction" of the executor's call order.
      getOwner: () => readControl(runId)?.owner ?? "automation",
    });

    // Task 8's real `onEscalationNeeded` hook (src/escalation/session.ts), replacing the
    // executor's default "always abort" stub: writes intervention.json, transitions
    // control.json, installs human-action capture, and polls for the operator's resume/abort.
    const onEscalationNeeded = createEscalationHook(runId, page, capability, {
      cdpEndpoint,
      policy,
      logger,
      devInjected: opts.inject === "stuck",
    });

    // ---- Task 9 evidence capture (SPEC §11) -------------------------------------------
    // `evidencePaths` collects every file this CLI itself writes into evidenceDir, relative
    // to evidenceDir (same convention InterventionRequest.screenshotPath/snapshotPath already
    // use — see src/escalation/intervention.ts). log.jsonl is written incrementally by
    // `logger` throughout the run, so it's always present once a run starts.
    const evidencePaths: string[] = ["log.jsonl"];
    const runMaskSpecs = buildRunMaskSpecs(capability);
    const screenshotsDir = joinPath(evidenceDir, "screenshots");
    let stepCounter = 0;
    let failureCaptured = false;
    // Every Nth step also gets a screenshot, independent of pass/fail — chosen as a small,
    // fixed cadence that gives a reviewer a handful of visual checkpoints through a run
    // without flooding the evidence folder on a capability with many steps (this artifact
    // has 7 steps, so N=3 yields 2 periodic screenshots plus one on the final successful
    // step — see step_complete's own N-based capture below).
    const SCREENSHOT_EVERY_N_STEPS = 3;

    async function captureScreenshot(idx: number, event: string): Promise<void> {
      try {
        mkdirSync(screenshotsDir, { recursive: true });
        const png = await guardedSurface.screenshot({ maskSpecs: runMaskSpecs });
        const relPath = `screenshots/${String(idx).padStart(3, "0")}-${event}.png`;
        writeFileSync(joinPath(evidenceDir, relPath), png);
        evidencePaths.push(relPath);
      } catch {
        // Best-effort: a screenshot failing must never break the run itself.
      }
    }

    function captureSnapshot(stepId: string, snapshotText: string): void {
      try {
        const relPath = `snapshot-${stepId}.txt`;
        writeFileSync(joinPath(evidenceDir, relPath), snapshotText, "utf-8");
        evidencePaths.push(relPath);
      } catch {
        // Best-effort, same as captureScreenshot.
      }
    }

    const result = await executeCapability(capability, params, guardedSurface, {
      runId,
      fingerprintFn: (observation) => computeFingerprint(observation.snapshotText),
      tenant: opts.tenant,
      hooks: { onEscalationNeeded },
      logger,
      // Fires once per step (success or checkpoint-failure — see executor.ts's doc comment
      // on ExecutorOptions.onStepTrace for exactly which two call sites). Always-on-failure
      // and every-Nth-step screenshots both funnel through here for any step that actually
      // reaches this hook; failure paths that exit BEFORE a step ever produces a StepTrace
      // (business_outcome / hard_failure / locator_unresolved / escalated / a fingerprint
      // mismatch) are covered by the run-level fallback capture below instead.
      onStepTrace: async (trace, observation) => {
        stepCounter += 1;
        const isCheckpointFailure = trace.checkpointPassed === false;
        if (isCheckpointFailure) {
          failureCaptured = true;
          await captureScreenshot(stepCounter, "failure");
          captureSnapshot(trace.stepId, observation.snapshotText);
        } else if (stepCounter % SCREENSHOT_EVERY_N_STEPS === 0) {
          await captureScreenshot(stepCounter, trace.stepId);
        }
      },
    });

    // Run-level fallback: SPEC §11 requires a failure screenshot + snapshot-<step>.txt
    // regardless of which failure path produced `status: "failure"`, including the ones that
    // never reach `onStepTrace` at all (see the comment above). Uses the surface's live state
    // right after executeCapability returns — the browser/page is still open at this point.
    if (result.status === "failure" && !failureCaptured) {
      try {
        const obs = await guardedSurface.observe();
        stepCounter += 1;
        await captureScreenshot(stepCounter, "failure");
        captureSnapshot(result.failedStepId ?? "run", obs.snapshotText);
      } catch {
        // Best-effort.
      }
    }

    // control.json / intervention.json are written independently by createEscalationHook
    // (src/escalation/session.ts) whenever this run actually escalates — list them here too
    // if they exist, so `result.evidencePaths` reflects the FULL run folder, not just the
    // files this function itself wrote.
    for (const extra of ["control.json", "intervention.json"]) {
      if (existsSync(joinPath(evidenceDir, extra))) {
        evidencePaths.push(extra);
      }
    }
    evidencePaths.push("result.json");

    const finalResult: ReplayResult = { ...result, evidencePaths };
    // Redacted through the SAME choke point as everything else (src/guardrails/redact.ts) —
    // defensive: ReplayResult shouldn't normally carry a raw secret/pii value, but this keeps
    // the invariant "nothing reaches disk without going through redactDeep first" absolute
    // rather than resting on that being true by construction everywhere upstream.
    const redactedResult = redactDeep(finalResult, policy) as ReplayResult;
    writeFileSync(joinPath(evidenceDir, "result.json"), JSON.stringify(redactedResult, null, 2), "utf-8");

    console.log(JSON.stringify(finalResult, null, 2));
    process.exitCode = result.status === "success" || result.status === "business_outcome" ? 0 : 1;
  } finally {
    await context.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
