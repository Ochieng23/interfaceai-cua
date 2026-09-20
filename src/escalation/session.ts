/**
 * The core of Task 8 (SPEC §10): launching a browser session that can be handed off to a
 * human, the `control.json` state file that coordinates the automation process and the
 * operator CLI across TWO SEPARATE PROCESSES, and `createEscalationHook` — the real
 * `ExecutorHooks.onEscalationNeeded` implementation `src/cli/replay.ts` wires into
 * `executeCapability()` in place of the executor's safe "always abort" default.
 *
 * Launch mechanism (architecture decision, not SPEC's literal wording): `chromium.launch()` /
 * `launchServer()` are NOT used. We use `chromium.launchPersistentContext()` with a fixed
 * `--remote-debugging-port`, because Playwright's `connectOverCDP` reliably exposes contexts
 * and pages created this way to a SEPARATE process (`cli/operator.ts`) — which is the whole
 * point of a "shared session." `launchPersistentContext` returns a `BrowserContext`, not a
 * `Browser`/server object, so it has no `wsEndpoint()` of its own; we discover the real CDP
 * websocket endpoint via the standard CDP HTTP discovery route,
 * `GET http://127.0.0.1:<port>/json/version`, which returns JSON with a
 * `webSocketDebuggerUrl` field. The profile directory lives under `.pw-profile/<run_id>/`
 * (already gitignored — see `.gitignore`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join as joinPath, resolve as resolvePath } from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright";

import type { Capability } from "../schema/capability";
import {
  SessionControl,
  transition,
  type ControlEvent,
  type ControlState,
  type SessionControl as SessionControlType,
} from "../schema/control";
import { ensureRunDir, runDir } from "../evidence/run";
import type { EvidenceLogger } from "../evidence/logger";
import type { Policy } from "../guardrails/policy";
import { redact } from "../guardrails/redact";
import type { EscalationInfo, EscalationOutcome, ExecutorHooks } from "../replay/executor";
import type { Surface } from "../surface/Surface";
import { PlaywrightSurface } from "../surface/PlaywrightSurface";
import { classifyReplayStuckReason } from "./stuck";
import { writeIntervention, type InterventionRequest } from "./intervention";
import { installHumanCapture, setHumanCaptureActive, type HumanActionEvent } from "./humanCapture";

// Re-exported so `cli/operator.ts` (and any other consumer) can build/consume control records
// without importing `schema/control` directly — "a thin CLI over this module's real logic."
export { SessionControl, transition };
export type { ControlEvent, ControlState };
// `SessionControlType` (below) is the same `z.infer<typeof SessionControl>` type re-exported
// under the value's own name `SessionControl` — the value import two lines up already carries
// its type-position meaning too (the same value+type name merge `schema/control.ts` itself
// uses), so `import { SessionControl } from "./session"` works as both a value and a type for
// any consumer (e.g. `cli/operator.ts`), exactly like importing straight from `schema/control`.

// ---------------------------------------------------------------------------------------
// Shared session launch
// ---------------------------------------------------------------------------------------

export interface SharedSession {
  context: BrowserContext;
  page: Page;
  cdpEndpoint: string;
}

export interface LaunchSharedSessionOptions {
  headless?: boolean;
  cdpPort?: number;
}

/**
 * Polls `GET http://127.0.0.1:<port>/json/version` until it returns a `webSocketDebuggerUrl`
 * (standard CDP discovery) or `timeoutMs` elapses. The endpoint isn't guaranteed to be up the
 * instant `launchPersistentContext` resolves, so this is a real (bounded) retry loop, not a
 * single fetch.
 */
async function discoverCdpEndpoint(port: number, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const json = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (json.webSocketDebuggerUrl) {
          return json.webSocketDebuggerUrl;
        }
      }
    } catch (err) {
      lastError = err;
    }
    await sleep(200);
  }
  throw new Error(
    `could not discover a CDP endpoint on 127.0.0.1:${port} within ${timeoutMs}ms` +
      (lastError instanceof Error ? `: ${lastError.message}` : ""),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveFn) => setTimeout(resolveFn, ms));
}

/**
 * Launches a browser session that CAN be handed off to a human in a separate process
 * (`cli/operator.ts`), via `launchPersistentContext` + a fixed remote-debugging port. Returns
 * the context/page/real-CDP-endpoint. Callers are responsible for eventually closing
 * `context` (persistent contexts have no separate `Browser` to close).
 */
export async function launchSharedSession(
  runId: string,
  opts: LaunchSharedSessionOptions = {},
): Promise<SharedSession> {
  const headless = opts.headless ?? process.env.HEADLESS !== "false";
  const cdpPort = opts.cdpPort ?? Number(process.env.CDP_PORT ?? 9222);

  const profileDir = resolvePath(process.cwd(), ".pw-profile", runId);
  mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless,
    viewport: { width: 1280, height: 900 },
    args: [`--remote-debugging-port=${cdpPort}`],
  });

  const cdpEndpoint = await discoverCdpEndpoint(cdpPort);
  const page = context.pages()[0] ?? (await context.newPage());

  return { context, page, cdpEndpoint };
}

// ---------------------------------------------------------------------------------------
// control.json — read/write/transition
// ---------------------------------------------------------------------------------------

function controlPath(runId: string): string {
  return joinPath(runDir("replay", runId), "control.json");
}

export function readControl(runId: string): SessionControlType | null {
  const p = controlPath(runId);
  if (!existsSync(p)) return null;
  const raw: unknown = JSON.parse(readFileSync(p, "utf-8"));
  return SessionControl.parse(raw);
}

/** Raw writer — `control` must already be a fully-formed, validated record. Prefer
 * `transitionControl` for any actual state CHANGE (it's the one place `transition()` from
 * `schema/control.ts` is invoked, per this task's "don't hand-roll transition logic" rule). */
export function writeControl(runId: string, control: SessionControlType): void {
  ensureRunDir("replay", runId);
  writeFileSync(controlPath(runId), JSON.stringify(control, null, 2), "utf-8");
}

/** Derives `SessionControl.owner` from a `ControlState` — kept as one small pure mapping
 * rather than letting callers pass `owner` independently of `state` and risk the two
 * disagreeing. */
function ownerForState(state: ControlState): SessionControlType["owner"] {
  switch (state) {
    case "AUTOMATION_RUNNING":
      return "automation";
    case "HUMAN_IN_CONTROL":
    case "RESUMING": // human just typed resume; automation hasn't reclaimed ownership yet
      return "human";
    case "PAUSED_AWAITING_HUMAN":
    case "ABORTED":
      return "none";
  }
}

/**
 * The ONLY place a `control.json` state actually changes: reads the current record (or
 * synthesizes a fresh `AUTOMATION_RUNNING` one if none exists yet — the very first
 * "escalate" call for a run), applies `event` via `schema/control.ts`'s pure `transition()`
 * (throws on an illegal transition, exactly like every other caller of that function), merges
 * in `extra`, and persists + returns the result.
 */
export function transitionControl(
  runId: string,
  event: ControlEvent,
  extra: Partial<SessionControlType> = {},
): SessionControlType {
  const current =
    readControl(runId) ??
    ({
      runId,
      state: "AUTOMATION_RUNNING",
      owner: "automation",
      since: new Date().toISOString(),
    } satisfies SessionControlType);

  const nextState = transition(current.state, event);
  const next = SessionControl.parse({
    ...current,
    ...extra,
    runId,
    state: nextState,
    owner: ownerForState(nextState),
    since: new Date().toISOString(),
  });
  writeControl(runId, next);
  return next;
}

// ---------------------------------------------------------------------------------------
// createEscalationHook — the real ExecutorHooks.onEscalationNeeded implementation
// ---------------------------------------------------------------------------------------

export interface EscalationHookDeps {
  /** The real CDP endpoint from `launchSharedSession`, written into control.json /
   * intervention.json so the operator CLI can attach. */
  cdpEndpoint: string;
  policy: Policy;
  logger?: EvidenceLogger;
  /** Set by `cli/replay.ts` when this run was started with `--inject stuck`, so
   * `classifyReplayStuckReason` can label the reason precisely rather than guessing from the
   * executor's raw error-message text. */
  devInjected?: boolean;
  /** How often to poll `control.json` while paused (SPEC §10: "polls control.json ... does
   * not exit"). Default 750ms. */
  pollIntervalMs?: number;
  /** Bound on how long we wait for a human before giving up and treating the run as aborted.
   * Default 10 minutes — generous for a real human to notice and attach, but finite so a
   * truly abandoned run doesn't poll forever. */
  timeoutMs?: number;
}

/**
 * Builds the real `ExecutorHooks.onEscalationNeeded` function (see `src/replay/executor.ts`'s
 * exact signature: `(info: EscalationInfo) => Promise<EscalationOutcome>`) for run `runId`,
 * operating on the shared `page`. On each call it:
 *   1. Writes an `InterventionRequest` (masked screenshot + snapshot text captured live from
 *      `page` via a `PlaywrightSurface`, reason text from `stuck.ts`).
 *   2. Transitions `control.json` `AUTOMATION_RUNNING -> PAUSED_AWAITING_HUMAN` (via
 *      `transitionControl`), recording the real `cdpEndpoint`.
 *   3. Installs human-action capture on `page` (once per run, even across multiple
 *      escalations in the same run — `page.exposeBinding` throws if called twice with the
 *      same binding name).
 *   4. Polls `control.json` until `RESUMING`/`ABORTED`/timeout. THIS POLLING LOOP IS A REAL
 *      `setTimeout`-based sleep loop, not a fake-timer/deterministic wait — and that is
 *      correct, not a violation of SPEC §8's "bounded, deterministic waits" rule: that rule
 *      governs AUTOMATION waiting on PAGE STATE (network idle, a locator appearing), which
 *      must never depend on wall-clock human response time. This loop is waiting on a real
 *      human's real-world action (they might be away from their desk for two minutes), which
 *      is a fundamentally different kind of wait and is explicitly out of that rule's scope.
 *   5. On `RESUMING`: transitions to `AUTOMATION_RUNNING`, resolves `"resumed"`. On `ABORTED`
 *      or timeout: resolves `"aborted"` (timeout also force-transitions control.json to
 *      `ABORTED` first, so a later stray operator attach doesn't find a stale
 *      `PAUSED_AWAITING_HUMAN`).
 */
export function createEscalationHook(
  runId: string,
  page: Page,
  capability: Pick<Capability, "id" | "status" | "steps">,
  deps: EscalationHookDeps,
): NonNullable<ExecutorHooks["onEscalationNeeded"]> {
  const surface: Surface = new PlaywrightSurface(page);
  let humanCaptureInstalled = false;

  return async (info: EscalationInfo): Promise<EscalationOutcome> => {
    const step = capability.steps.find((s) => s.id === info.stepId);
    // Best-effort classification of `info.reason`'s raw text into a `failureClass` guess —
    // `classifyReplayStuckReason` checks `devInjected` FIRST regardless of this, so an
    // imprecise guess here only affects the non-dev-injected, non-irreversible fallback
    // wording, never which branch a real `--inject stuck` run takes.
    const reasonMsg = info.reason.toLowerCase();
    let failureClass: string | undefined;
    if (reasonMsg.includes("generic outcome detector")) {
      failureClass = "unknown_condition";
    } else if (reasonMsg.includes("locator")) {
      failureClass = "locator_unresolved";
    }

    const reason =
      classifyReplayStuckReason({
        failureClass,
        stepRisk: step?.risk,
        irreversiblePolicy: deps.policy.risk.irreversible_policy,
        capabilityStatus: capability.status,
        devInjected: deps.devInjected === true,
      }) ?? info.reason;

    deps.logger?.log({ runId, event: "escalation_intervention_prepared", stepId: info.stepId, reason });

    // --- masked screenshot + snapshot text, saved into this run's evidence dir -------------
    const evidenceDir = ensureRunDir("replay", runId);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const screenshotFile = `intervention-${timestamp}.png`;
    const snapshotFile = `intervention-${timestamp}.txt`;

    let observation: Awaited<ReturnType<Surface["observe"]>> | undefined;
    try {
      observation = await surface.observe();
    } catch {
      observation = undefined;
    }
    try {
      // No PII-typed output locators are generically known at this seam (the capability's
      // own `OutputSpec.pii` flags are consulted by the executor, not by this hook); an empty
      // mask list is the honest, documented default — screenshot masking beyond the redaction
      // choke point (which already covers all logged TEXT) is out of scope for this task.
      const screenshot = await surface.screenshot({ maskSpecs: [] });
      writeFileSync(joinPath(evidenceDir, screenshotFile), screenshot);
    } catch {
      // Best-effort: a screenshot failing must never block the escalation itself.
    }
    if (observation) {
      writeFileSync(joinPath(evidenceDir, snapshotFile), observation.snapshotText, "utf-8");
    }

    const req: InterventionRequest = {
      runId,
      kind: "replay",
      capabilityId: capability.id,
      stepId: info.stepId,
      stepDescription: info.stepDescription,
      reason,
      currentUrl: info.currentUrl,
      screenshotPath: screenshotFile,
      snapshotPath: snapshotFile,
      cdpEndpoint: deps.cdpEndpoint,
      createdAt: new Date().toISOString(),
    };
    writeIntervention("replay", runId, req);

    // --- control.json: AUTOMATION_RUNNING -> PAUSED_AWAITING_HUMAN -------------------------
    transitionControl(runId, "escalate", { reason, cdpEndpoint: deps.cdpEndpoint });
    deps.logger?.log({ runId, event: "control_paused_awaiting_human", stepId: info.stepId });
    console.log(`\n[escalation] run ${runId} paused — human intervention needed.`);
    console.log(`[escalation] reason: ${reason}`);
    console.log(`[escalation] intervention written to evidence/replay/${runId}/intervention.json`);
    console.log(`[escalation] attach with: npm run operator -- --run ${runId}\n`);

    // --- human-action capture (once per run, even across repeated escalations) -------------
    if (!humanCaptureInstalled) {
      humanCaptureInstalled = true;
      await installHumanCapture(page, (event: HumanActionEvent) => {
        // `text` values are scrubbed by the SAME redaction choke point everything else in
        // this codebase goes through: `EvidenceLogger.log()` calls `redactDeep()` on the
        // WHOLE entry before writing, so a raw `event.text` here is safe to pass straight
        // through — it is never written unredacted.
        deps.logger?.log({ runId, actor: "human", event: "human_action", ...event });
      }).catch((err: unknown) => {
        deps.logger?.log({
          runId,
          event: "human_capture_install_failed",
          error: err instanceof Error ? err.message : String(err),
        });
      });

      // `humanCapture.ts`'s init script defaults every FRESH document to INACTIVE (see its
      // header comment) — necessary because it re-runs on every navigation, including ones
      // the AUTOMATION itself causes after resuming. To keep capture working for a human who
      // navigates the page WHILE still paused/in-control (their own click on the stuck page's
      // real control, for instance), re-activate it on every page "load" for as long as
      // control.json still says a human has (or is being asked to take) control — checked at
      // call time, not baked in once, so this single listener (installed only once, for the
      // page's whole lifetime) correctly does nothing once automation reclaims control.
      page.on("load", () => {
        const state = readControl(runId)?.state;
        if (state === "PAUSED_AWAITING_HUMAN" || state === "HUMAN_IN_CONTROL" || state === "RESUMING") {
          void setHumanCaptureActive(page, true);
        }
      });
    }
    // Explicitly (re-)activate for the CURRENT document right now — covers both the very
    // first escalation (the "load" listener above was just attached and won't fire again for
    // an already-loaded document) and any later escalation in the same run.
    await setHumanCaptureActive(page, true);

    // --- poll control.json until RESUMING / ABORTED / timeout ------------------------------
    const pollIntervalMs = deps.pollIntervalMs ?? 750;
    const timeoutMs = deps.timeoutMs ?? 10 * 60 * 1000;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const control = readControl(runId);
      if (control?.state === "RESUMING") {
        transitionControl(runId, "resnapshot_ok");
        // Deactivate BEFORE returning to the executor: the very next thing it does is retry
        // the step's own action (or continue to the next step), which must never be
        // misattributed as a human action (see humanCapture.ts's header comment on this
        // exact race).
        await setHumanCaptureActive(page, false);
        deps.logger?.log({ runId, event: "control_resumed", stepId: info.stepId });
        console.log(`[escalation] run ${runId} resumed by operator — automation continuing.`);
        return "resumed";
      }
      if (control?.state === "ABORTED") {
        deps.logger?.log({ runId, event: "control_aborted", stepId: info.stepId });
        return "aborted";
      }
      if (Date.now() > deadline) {
        try {
          transitionControl(runId, "abort", { reason: "escalation poll timed out waiting for a human" });
        } catch {
          // Already ABORTED (or otherwise not in a state "abort" is legal from) — fine, we're
          // reporting "aborted" either way.
        }
        deps.logger?.log({ runId, event: "control_timed_out", stepId: info.stepId, timeoutMs });
        console.log(`[escalation] run ${runId} timed out after ${timeoutMs}ms waiting for a human — aborting.`);
        return "aborted";
      }
      await sleep(pollIntervalMs);
    }
  };
}

// Re-exported for callers (cli/operator.ts, cli/replay.ts) that want to print a snapshot
// through the same redaction choke point the rest of the codebase uses.
export { redact };
