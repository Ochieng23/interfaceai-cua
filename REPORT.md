# REPORT

## 1. Architecture

Two independent phases share one artifact format and one abstraction over the browser.

**Discovery** (`src/discovery/`): a loop (`loop.ts`) sends Claude (raw `@anthropic-ai/sdk`
Messages API, tool use — no agent framework) a numbered accessibility snapshot plus a
screenshot each turn; the model returns exactly one tool call (`click`, `type_text`,
`select_option`, `navigate`, `extract`, `request_help`, `goal_complete`); the loop guards it,
acts, logs, and repeats. `recorder.ts` turns the resulting trace into a `Capability` (Zod,
`src/schema/capability.ts`), merging in the seeded outcome catalog and computing an
`appFingerprint`. This is a real, non-fabricated run every time — see `evidence/discovery/`.

**Replay** (`src/replay/`): loads a `Capability`, resolves each step's `LocatorSpec` strategy
chain against the live page, acts, checks outcomes and checkpoints, and writes a
`ReplayResult`. `git grep "@anthropic-ai/sdk" src/replay` returns nothing — verified as part
of this task's own gate run — because the whole point of the split is that replay never
calls an LLM (SPEC §0.5).

**The seam**: everything — discovery, replay, escalation — touches the live app only through
`Surface` (`src/surface/Surface.ts`): `observe`, `act`, `resolve`, `readText`, `screenshot`,
`currentUrl`, `waitForSettle`. `PlaywrightSurface` is the only real implementation;
`FakeSurface` (scripted page states, no browser) is what all 121 unit tests run against.
`GuardedSurface` wraps whichever one is live and is the **single** place that decides "is
this action allowed right now" — `act()` checks, in this fixed order: (1) control ownership,
(2) allowlist, (3) risk/irreversibility, (4) `{{secret:NAME}}` substitution, then delegates.
Nothing else in the codebase reimplements any of these checks.

**Mock app** (`src/mockapp/`, "CU Console"): a real Express server, deliberately legacy —
server-rendered HTML, table layout, no ids/`data-testid`s, a same-origin iframe shell
(`GET /`), and one alt-less `<input type="image">` search-submit button. One empirically
interesting correction to SPEC §12's framing, documented in `snapshot.ts`'s header: that
image button is not actually nameless in the installed Chromium — it synthesizes a default
accessible name "Submit" — which is what caused a genuine `EscalationRequired` collision
with `policy.yaml`'s irreversible-action keyword list during a real discovery run
(`evidence/discovery/2026-09-19T17-34-38-577Z-cad836/`).

## 2. Artifact schema

`src/schema/capability.ts`/`result.ts`/`control.ts` are a Zod port of SPEC §4's abbreviated
shapes (`Locator` → `LocatorSpec` → `Step`/`Checkpoint`/`OutcomeSpec` → `Capability`,
`StepTrace` → `ReplayResult`, `ControlState`/`SessionControl`). SPEC §4 names `docs/artifact.py`
as the source of truth to port "faithfully"; that file does not exist anywhere in this repo
or its history. This is a real, documented gap (also flagged in `PlaywrightSurface.ts`'s
header comment) — SPEC §4's own abbreviated shapes were treated as authoritative instead,
since there was nothing else to port from.

A `LocatorSpec` is an ordered `strategyChain` (`role` → `css` → `xpath` → `text_anchor` →
`visual_anchor`, strongest to weakest) plus a human-readable `rationale` written at record
time. Frames are **not** part of the schema — `LocatorSpec` has no frame field. Frame
handling is entirely a `Surface`-level concern (`PlaywrightSurface` loops `page.frames()`
internally); the schema and the replay executor stay app-topology-agnostic, which is what
let the discovered artifact record a workflow that happened entirely inside an iframe
without any special-casing anywhere in `replay/` or `schema/`.

`OutcomeSpec.recoveryAction` is `dismiss | retry | wait_and_retry | none` with a
`maxRetries` counter — it has no "jump back to an earlier step" primitive. This is why
`session_expired` (`outcomes/cu-console.yaml`) is classified `hard_failure`, not
`recoverable`: there's no schema-level way to express "re-login and resume mid-run," so a
fresh replay invocation genuinely is the correct recovery, and the outcome says so in its
own `messageTemplate`.

## 3. Determinism & error handling

Locator resolution walks the strategy chain in order and records which tier matched
(`StepTrace.resolvedTier`); no coordinate-based clicking is used as a primary mechanism
(SPEC §16). Waits are Playwright's own auto-wait bounded by `step.timeoutMs`, plus explicit
checkpoints — no `sleep`. Outcome detection (`src/replay/outcomes.ts`) checks declared
`OutcomeSpec`s in artifact order first, then a generic detector
(`alert`/`alertdialog`/dialog/`/error|denied|not found|session (expired|timed out)|try
again/i`) that escalates rather than silently continuing on anything undeclared.

Two real bugs were found and fixed in this core loop during Task 5's code review:

- **Redaction prefix leak** (`src/guardrails/redact.ts`): exact-value scrubbing replaced
  registered secret/PII values in Set-insertion order; if a shorter registered value (e.g.
  `"pass1"`) was a prefix of a longer one registered later (`"pass12345"`), the shorter
  value's replace pass would fragment the longer value's occurrence and leave its suffix
  (`"2345"`) unredacted in the log. Fixed by sorting registered values longest-first before
  the replace loop (`redact.ts` lines 54-69) — verified present in the current file, with the
  fix's own rationale documented inline.
- **Irreversible-step double-invocation** (`src/replay/executor.ts`): an irreversible step's
  action could originally be re-invoked via the outcome-recovery `retry`/`wait_and_retry`
  path — a second, unguarded call site into `surface.act()` existed alongside the properly
  guarded one. A narrow patch was flagged by code review as non-centralized and refactored:
  the "never retry an irreversible step" invariant is now enforced structurally in one
  funnel, `performOneAct` (`executor.ts` ~line 278), via an `irreversibleStepsAttempted` set
  keyed by step id — every call site that might re-invoke a step's action, including the
  recovery retry path, is required to go back through `performOneAct`, so the guard can't be
  bypassed by a caller forgetting to re-check `step.risk`.

## 4. Heterogeneity & multi-tenant

The `Surface` interface is the heterogeneity story: nothing above it (replay executor,
guardrails, escalation) imports Playwright or knows it's talking to a browser at all. A
desktop/legacy-app variant would only need a new class implementing the same seven-method
`Surface` contract over a desktop accessibility API (e.g. UI Automation / AT-SPI), with
`visual_anchor` — currently unresolvable in `PlaywrightSurface` (documented in its header:
"no bounding-box-based click-at-coordinates primitive here... a real desktop/accessibility-
API Surface would be where that tier actually earns its keep") — as the universal fallback
tier for controls that expose no stable role/name/DOM path. This is **designed, not built**:
no desktop `Surface` implementation exists in this repo.

Multi-tenant support (`src/replay/tenantOverride.ts`) is a real, tested, deep-merge-by-step-id
patch applied to a `Capability`'s `tenantOverrides[tenant]` before replay, exercised live
against a genuinely separate tenant-B mock-app instance (`TENANT=b PORT=4174`, `/portal`
prefix, "Find member" label, "Member Portal — Second Federal CU" title —
`evidence/replay/2026-09-19T21-41-14-473Z-26f487/`). One real bug found live during Task 9:
tenant B's result-link `href`s are `/portal/member/<id>`, and `click_member_result_link`'s
css/xpath tiers matched on `href` *starting with* `/member/`, which doesn't match a
`/portal/`-prefixed href — fixed with a step-specific override in
`tenantOverrides.b`. This is **one override demo, not a tenant registry** — adding a third
tenant means hand-writing a third `tenantOverrides` entry, not registering a new tenant
config anywhere.

## 5. Escalation & handoff

`src/escalation/session.ts` shares one live browser between two independently started Node
processes over CDP: the replay process launches via `chromium.launchPersistentContext()`
with a fixed `--remote-debugging-port` (a plain `launchServer()`/`launch()` context isn't
reliably attachable to over CDP for this purpose); the `operator` CLI discovers the
`wsEndpoint` via `GET http://127.0.0.1:<port>/json/version` and attaches with
`chromium.connectOverCDP()`. `SessionControl`/`control.json` implements SPEC §4's control
state machine (`AUTOMATION_RUNNING → PAUSED_AWAITING_HUMAN → HUMAN_IN_CONTROL → RESUMING →
AUTOMATION_RUNNING`, any state `→ ABORTED`), tested for every legal transition in
`test/control.test.ts`.

Stuck detection (`src/escalation/stuck.ts`'s `classifyReplayStuckReason`) is a small, pure
classifier, not the trigger itself — the actual escalation fires from
`GuardedSurface`'s `EscalationRequired`/`ControlNotOwnedError`, the generic outcome
detector's `unknown_condition`, or a step whose locator never resolves
(`locator_unresolved`); this module only turns the "why" into a stable
`InterventionRequest.reason` string. `humanCapture.ts` installs a `page.addInitScript` that
captures `click`/`input`/`change`/`submit` at the DOM level via `page.exposeBinding` — it
re-attaches on every navigation, but, as documented in the module, it captures DOM-level
intent only: no OS-level events, and nothing inside a cross-origin iframe (the mock app's own
iframe is same-origin, so this doesn't bite here, but it's a real limitation of the
mechanism).

This handoff was independently reproduced live, multiple times: a replay run escalates on
`--inject stuck --tenant escalation-demo`, `npm run operator -- --run <id>` attaches over
real CDP, REPL commands (`snapshot`, `click <ref>`, `resume`) drive the live page as
`actor: "human"`, and the original replay process wakes and completes with
`recoveriesApplied` containing `"human_intervention:<stepId>"` — see
`evidence/replay/2026-09-19T19-09-43-547Z-8a3920/`, whose `log.jsonl` contains both the
operator's own REPL-command entries and genuine `human_action` DOM-capture entries. Three
real bugs were found and fixed producing this: a REPL command-ordering race; a pre-existing
gap where `DEMO_USER`/`DEMO_PASS` were never registered with `redact.ts`'s registry, so
human-capture logging of automation's own post-resume actions leaked them unredacted; and (a
code-review find) a readline `close`-handler race dropping queued commands on piped/
non-interactive stdin.

`--inject`'s failure-injection cookie is consumed by the capability's own entry-point
navigate before the step loop starts (a pre-existing Task 6 characteristic), which is why the
`stuck`/`dialog`/`error` demos above need `--tenant escalation-demo`: it's a workaround using
the executor's tenant-override fingerprint-mismatch escape hatch, not a real tenant, and is
documented as such in the artifact's own `tenantOverrides["escalation-demo"]._comment` and in
`evidence/README.md`.

**Discovery-side `request_help` does not get a live operator handoff** — it only ends the
discovery loop with `status: "request_help"` and a reason string (`src/discovery/loop.ts`);
the CDP-based shared-session handoff described above is replay-only.

## 6. Safety

`policy.yaml` is the single guardrail config: an allowlist (origins/routes/action kinds), a
risk classifier (`button_text_matches` + `method_is` → `irreversible`), and redaction
patterns (ssn/acct/email regexes). `GuardedSurface.act()` is the only place any of it is
enforced, in a fixed order (control ownership → allowlist → risk/irreversibility → secret
substitution) — every action from both discovery and replay goes through it; a policy
violation throws `PolicyViolation`/`EscalationRequired`, never silently no-ops.

Irreversible actions default to `irreversible_policy: "escalate"`: an irreversible step
pauses for a human to confirm unless the capability's own `status` is `"approved"` — the
justified choice for a banking context, where an automation should not get to perform an
irreversible action (open account, transfer, delete, close) on its own authority until a
capability has actually earned trust through review.

Redaction (`src/guardrails/redact.ts`) is a single choke point: every registered secret/PII
value is exact-match scrubbed (longest-first, per the bug fixed in §3) before pattern
scrubbing runs, and the JSONL logger, snapshots, and transcripts all pass through the same
`redact`/`redactDeep` functions — nothing writes to `evidence/` outside this path. Screenshot
masking uses Playwright's native `mask:` option, built from the `LocatorSpec`s of every
`pii`-flagged input/output. Credentials never reach the model: discovery types
`{{secret:password}}`, and `GuardedSurface` substitutes the real value only at the last
step before delegating to the real surface — verified by grepping every committed
`transcript.redacted.json` for the literal `DEMO_USER`/`DEMO_PASS` values (none found; see
`evidence/README.md`'s own note on this).

As part of this task's final gate: `npm run typecheck` is clean, all 121 tests pass, `.env`
is confirmed not tracked by git (`git ls-files | grep -x .env` returns nothing), and a
`git log --all -p` sweep for the literal `demo-pass` string found only the three expected,
harmless hits — the hard-coded *default* fallback value in `src/mockapp/server.ts`,
`.env.example`'s own line, and SPEC.md's own documentation of that default — never a real or
distinct secret.

## 7. Cuts

- **The operator console is a CLI, not co-browsing.** `src/cli/operator.ts` is a REPL
  (`snapshot`/`click <ref>`/`type <ref> <text>`/`note`/`resume`/`abort`) that drives the
  shared page programmatically; there is no shared visible-browser-window UI beyond the
  actual Chromium window `launchPersistentContext` opens (headed, not embedded in any tool).
- **The outcome catalog is seeded, not discovered.** `outcomes/cu-console.yaml`'s seven
  entries were all written ahead of any discovery run; discovery's recorder merges them into
  every new capability verbatim (`provenance: "seeded"`) rather than the model proposing new
  outcomes it actually encountered. `artifacts/lookup_member_balance_discovered.json`
  inherits all seven, including `session_expired`, whose `url_matches: "/login$"` detection
  false-positives against this specific capability's own login entry point — a known,
  accepted tradeoff of "merge verbatim, no curation" versus the hand-written artifact's
  manually curated 4-of-7 subset.
- **A desktop surface is designed but not built.** See §4: the `Surface` interface is
  implementation-agnostic by construction (seven methods, no Playwright type in the
  signature), and `visual_anchor` is explicitly reserved as the tier a desktop
  accessibility-API implementation would resolve — but no such implementation exists.
- **Multi-tenant support is one override demo, no registry.** `tenantOverrides.b` on the one
  shipped artifact; adding another tenant means hand-authoring another entry, not registering
  a tenant anywhere central.
- **"Assisted fallback" is not implemented.** There is no mode where the automation suggests
  an action for a human to approve inline mid-step; escalation is a full pause/handoff, not a
  suggest-and-confirm loop.
- **The capabilities CLI stretch goal was skipped for time.** `package.json` still lists the
  `capabilities` script (per SPEC §2/§3), but `src/cli/capabilities.ts` was never written —
  `npm run capabilities` fails with `ERR_MODULE_NOT_FOUND`, verified during this task. The
  tenant-B stretch goal was implemented instead, per SPEC §16's "do not implement more than
  the two stretch goals."
- **`OutcomeSpec` doesn't reject `maxRetries: 0` paired with a non-`"none"` recoveryAction.**
  That combination is always a no-op by construction (`attemptNumber > maxRetries` is already
  true on the first attempt), and it was found live in exactly this shape in Task 9 (see the
  "Notable finding" section of `evidence/README.md`). It was fixed in the hand-written
  artifact's own copy (`maxRetries: 1`, with `_maxRetriesNote` explaining why) but
  deliberately **not** fixed at the schema level, because doing so risked invalidating the
  already-committed, already-reviewed Task 7 discovered artifact and its evidence, which has
  this exact `maxRetries: 0` combination baked into its historical record.
- **Discovery-side `request_help` has no live operator handoff** — see §5; only replay
  escalation gets the real CDP shared-session mechanism.

**Next three things to build:**

1. **A real outcome-discovery path.** Let a discovery run propose a new `OutcomeSpec` when it
   hits an undeclared condition (rather than only ever merging the seed catalog verbatim),
   with a human reviewing/approving it before it's promoted from `provenance: "discovered"`
   into the seed catalog for future runs — this is the most direct fix for the
   `session_expired` false-positive noted above, and for the catalog's dependence on someone
   anticipating every failure mode up front.
2. **Schema-level rejection of a no-op recovery** (`maxRetries: 0` with a non-`"none"`
   `recoveryAction`), applied to the seed catalog and `outcomes/cu-console.yaml` in a
   follow-up pass that also regenerates/re-verifies the Task 7 discovered artifact against
   the corrected schema, rather than leaving the gap open indefinitely.
3. **A capabilities CLI** (`list`/`describe`/`invoke`, the stretch goal actually cut here) —
   the artifact and evidence layout already support it; it's the natural next entry point for
   anyone who wants to run a capability without remembering its exact `npm run replay --`
   invocation, and it's a small, contained piece of work given everything else it would sit
   on top of.
