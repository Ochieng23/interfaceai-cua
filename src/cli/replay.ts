#!/usr/bin/env node
/**
 * `npm run replay -- --capability <path> --param k=v ...` — SPEC §3/§8's deterministic replay
 * CLI. No LLM anywhere on this path (SPEC §0.5): this file, and everything it imports under
 * `src/replay/`, never touches `@anthropic-ai/sdk`.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { Command } from "commander";
import { chromium } from "playwright";
import { ZodError } from "zod";

import { computeFingerprint } from "../perception/fingerprint";
import { executeCapability } from "../replay/executor";
import { createRunId } from "../evidence/run";
import { loadPolicy } from "../guardrails/policy";
import { Capability } from "../schema/capability";
import { GuardedSurface } from "../surface/GuardedSurface";
import { PlaywrightSurface } from "../surface/PlaywrightSurface";

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
    "tenant key to run under; tenantOverrides deep-merge is a later task — for now this only " +
      "affects the fingerprint-mismatch-override check and is otherwise informational",
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
  const capability = loadCapability(capabilityPath);

  if (opts.tenant && !Object.prototype.hasOwnProperty.call(capability.tenantOverrides ?? {}, opts.tenant)) {
    console.warn(
      `--tenant "${opts.tenant}" given but capability.tenantOverrides has no entry for it; ` +
        `proceeding without a merge (tenantOverrides deep-merge is a later task's job).`,
    );
  }

  const cliParams = parseCliParams(opts.param);
  const params = resolveParams(capability, cliParams);

  // Default headless=true (CI-friendly, matches SPEC's demo path); set HEADLESS=false while
  // debugging this task manually to watch the browser drive the real mock app.
  const headless = process.env.HEADLESS !== "false";
  const browser = await chromium.launch({ headless });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    if (opts.inject) {
      const entryOrigin = new URL(capability.entryPoint).origin;
      const injectUrl = `${entryOrigin}/__inject?mode=${encodeURIComponent(opts.inject)}`;
      // Bypasses GuardedSurface deliberately — __inject is a dev-only harness route, not part
      // of the capability's own allowlisted step sequence (see mockapp/inject.ts).
      await page.goto(injectUrl, { waitUntil: "domcontentloaded" });
    }

    const playwrightSurface = new PlaywrightSurface(page);
    const policy = loadPolicy();
    const guardedSurface = new GuardedSurface(playwrightSurface, policy, {
      capabilityStatus: opts.approveIrreversible ? "approved" : capability.status,
      secretProvider: makeSecretProvider(),
    });

    const result = await executeCapability(capability, params, guardedSurface, {
      runId: createRunId(),
      fingerprintFn: (observation) => computeFingerprint(observation.snapshotText),
      tenant: opts.tenant,
    });

    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "success" || result.status === "business_outcome" ? 0 : 1;
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
