# SPEC.md — Computer-Use Automation System (TypeScript)

This is the implementation spec for Claude Code. Read it fully before writing code. The
original brief is in `docs/brief.pdf`; this spec encodes the decisions already made against
it. Where this spec and the brief conflict, the brief wins — flag the conflict, don't
silently resolve it.

**What is being graded (in order):** system design → correctness of the core loop →
robustness & error handling → human-in-the-loop → generalization story → safety → code
quality → communication. Optimize for a **thin, real, end-to-end vertical slice**, not for
feature breadth. Every module below should exist and work at minimum depth before any
module is polished.

---

## 0. Non-negotiables

1. **The discovery run must be real.** At least one genuine LLM-driven run against the live
   mock app, with evidence saved under `/evidence/`. Never fabricate evidence.
2. **Exact deliverable paths:** `/README.md`, `/REPORT.md` (seven headings, verbatim, in
   order — see §11), `/evidence/`.
3. **No secrets in the repo.** `.env` is gitignored; `.env.example` documents every variable.
4. **No real PII, ever.** The mock app's data is synthetic and obviously fake.
5. **No LLM call anywhere in the replay path.** Grep-verifiable: `src/replay/**` must not
   import the Anthropic SDK.
6. **Don't build scaling infrastructure.** No queues, no services, no DB. Single process.
   Files on disk are the persistence layer.

---

## 1. Stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript, `strict: true`, Node ≥ 20 | Playwright is TS-native; end-to-end static types are a graded criterion |
| Browser automation | `playwright` (Chromium only) | Accessibility tree + CDP + native screenshot masking |
| LLM | `@anthropic-ai/sdk`, raw Messages API with tool use | The loop must be visible, first-class code — not hidden in an agent framework |
| Model | `claude-sonnet-4-6` (env-overridable via `MODEL`) | Cheap enough for iteration, capable enough for the task |
| Schema | `zod` + `zod-to-json-schema` | One source of truth: runtime validator, inferred TS type, and the JSON Schema handed to Claude for tool definitions |
| Mock app | `express`, server-rendered HTML strings (no template engine) | Deliberately legacy markup; trivially runnable |
| CLI | `commander` | — |
| Tests | `vitest` | — |
| Scripts | `tsx` | No build step needed to run |
| Package manager | `npm` | Reviewer friction is a criterion |

Do not add dependencies beyond these without a comment in `package.json` explaining why.

---

## 2. Repository layout

```
/
├── README.md
├── REPORT.md
├── SPEC.md                       (this file)
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── policy.yaml                   (guardrail allowlist config)
├── outcomes/
│   └── cu-console.yaml           (seeded outcome catalog for the mock app family)
├── artifacts/                    (saved Capability JSON files)
├── evidence/
│   ├── README.md                 (index of what's here and how it was produced)
│   ├── discovery/<run_id>/
│   └── replay/<run_id>/
├── docs/brief.pdf
├── src/
│   ├── schema/
│   │   ├── capability.ts         (Zod: Locator, Step, Capability, ...)
│   │   ├── result.ts             (Zod: ReplayResult, StepTrace)
│   │   ├── control.ts            (ControlState machine + SessionControl)
│   │   └── index.ts
│   ├── surface/
│   │   ├── Surface.ts            (interface — THE seam)
│   │   ├── PlaywrightSurface.ts
│   │   └── FakeSurface.ts        (for tests; scripted page states)
│   ├── perception/
│   │   ├── snapshot.ts           (aria tree → numbered refs)
│   │   ├── enrich.ts             (build LocatorSpec chain for an element at record time)
│   │   └── fingerprint.ts
│   ├── discovery/
│   │   ├── tools.ts              (tool definitions; JSON Schema derived from Zod)
│   │   ├── prompt.ts             (system prompt)
│   │   ├── loop.ts               (observe → decide → act)
│   │   └── recorder.ts           (trace → Capability)
│   ├── replay/
│   │   ├── executor.ts
│   │   ├── locate.ts             (strategy-chain resolution)
│   │   ├── checkpoint.ts
│   │   └── outcomes.ts           (declared + generic detection, recovery)
│   ├── guardrails/
│   │   ├── policy.ts             (load + evaluate policy.yaml)
│   │   ├── risk.ts
│   │   └── redact.ts             (log redaction + screenshot mask list)
│   ├── escalation/
│   │   ├── stuck.ts              (detectors)
│   │   ├── intervention.ts       (InterventionRequest + routing)
│   │   ├── session.ts            (shared browser over CDP, control file)
│   │   └── humanCapture.ts       (initScript + exposeBinding)
│   ├── evidence/
│   │   ├── logger.ts             (JSONL, single redaction choke point)
│   │   └── run.ts                (run folder layout, run_id)
│   ├── cli/
│   │   ├── discover.ts
│   │   ├── replay.ts
│   │   ├── operator.ts           (the mock operator console)
│   │   └── capabilities.ts       (stretch: list / describe / invoke)
│   └── mockapp/
│       ├── server.ts
│       ├── data.ts               (synthetic members)
│       ├── pages/*.ts            (HTML string builders)
│       └── inject.ts             (failure injection)
└── test/
    ├── schema.test.ts
    ├── executor.test.ts
    ├── locate.test.ts
    ├── outcomes.test.ts
    ├── guardrails.test.ts
    ├── control.test.ts
    └── recorder.test.ts
```

---

## 3. npm scripts (this is the README demo path — make these exact)

```json
{
  "mock-app":   "tsx src/mockapp/server.ts",
  "discover":   "tsx src/cli/discover.ts",
  "replay":     "tsx src/cli/replay.ts",
  "operator":   "tsx src/cli/operator.ts",
  "capabilities": "tsx src/cli/capabilities.ts",
  "test":       "vitest run",
  "typecheck":  "tsc --noEmit"
}
```

Canonical demo sequence:

```bash
npm install && npx playwright install chromium
cp .env.example .env            # add ANTHROPIC_API_KEY

npm run mock-app                # terminal 1, http://localhost:4173

# Discovery (needs API key)
npm run discover -- \
  --goal "Log in, look up member {member_id}, and read their current savings balance" \
  --param member_id=10001 \
  --target http://localhost:4173 \
  --name lookup_member_balance

# Deterministic replay (no API key needed)
npm run replay -- --capability artifacts/lookup_member_balance.json --param member_id=10001
npm run replay -- --capability artifacts/lookup_member_balance.json --param member_id=99999   # → business_outcome: member_not_found
npm run replay -- --capability artifacts/lookup_member_balance.json --param member_id=10001 --inject slow       # → recoverable, retried
npm run replay -- --capability artifacts/lookup_member_balance.json --param member_id=10001 --inject dialog     # → recoverable, dismissed
npm run replay -- --capability artifacts/lookup_member_balance.json --param member_id=10001 --inject error      # → hard failure with evidence
npm run replay -- --capability artifacts/lookup_member_balance.json --param member_id=10001 --inject stuck      # → escalated; then:
npm run operator -- --run <run_id>                                                                              #    take over, resume

# Tenant variant (stretch)
TENANT=b npm run mock-app
npm run replay -- --capability artifacts/lookup_member_balance.json --param member_id=10001 --tenant b
```

---

## 4. Schema (`src/schema/`)

Port `artifact.py` v1.1 (in `docs/artifact.py`) to Zod **faithfully**. Export both the Zod
schema and `z.infer` type for each. Key shapes, abbreviated:

```ts
// capability.ts
export const Locator = z.object({
  kind: z.enum(["role", "css", "xpath", "text_anchor", "visual_anchor"]),
  role: z.string().optional(),
  accessibleName: z.string().optional(),
  selector: z.string().optional(),
  text: z.string().optional(),
  bbox: BoundingBox.optional(),
  nearbyText: z.string().optional(),
});

export const LocatorSpec = z.object({
  strategyChain: z.array(Locator).min(1),      // ordered strongest → weakest
  rationale: z.string().optional(),            // written by recorder, read by reviewers
});

export const Checkpoint = z.object({
  kind: z.enum(["element_visible", "text_matches", "url_matches"]),
  target: LocatorSpec.optional(),
  expectedText: z.string().optional(),
  expectedUrlPattern: z.string().optional(),
  description: z.string().optional(),
});

export const Step = z.object({
  id: z.string(),
  description: z.string(),                     // "Enter member ID in the search box"
  action: z.enum(["click", "fill", "select_option", "navigate", "wait_for", "extract"]),
  target: LocatorSpec.optional(),
  valueLiteral: z.string().optional(),
  paramRef: z.string().optional(),
  risk: z.enum(["safe", "reversible", "irreversible"]).default("reversible"),
  timeoutMs: z.number().int().default(5000),
  checkpoint: Checkpoint.optional(),
}).refine(s => !(s.valueLiteral !== undefined && s.paramRef !== undefined),
  "set valueLiteral or paramRef, not both");

export const InputParamSpec = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean", "secret"]),   // secret: env-resolved, never persisted
  required: z.boolean().default(true),
  description: z.string(),
  pii: z.boolean().default(false),
  example: z.string().optional(),
});

export const OutputSpec = z.object({
  name: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string(),
  source: LocatorSpec,
  extraction: z.enum(["text", "attribute", "value"]).default("text"),
  attributeName: z.string().optional(),
  pii: z.boolean().default(false),             // drives screenshot masking + log redaction
});

export const OutcomeSpec = z.object({
  name: z.string(),
  classification: z.enum(["business_outcome", "recoverable", "hard_failure"]),
  detection: Checkpoint,
  recoveryAction: z.enum(["dismiss", "retry", "wait_and_retry", "none"]).default("none"),
  recoveryTarget: LocatorSpec.optional(),
  maxRetries: z.number().int().default(0),
  messageTemplate: z.string(),
  provenance: z.enum(["seeded", "discovered"]).default("seeded"),
});

export const Capability = z.object({
  schemaVersion: z.literal("1.1"),
  id: z.string(), name: z.string(), version: z.string(),
  status: z.enum(["draft", "approved"]).default("draft"),
  description: z.string(),
  targetApp: z.string(), entryPoint: z.string(),
  allowlistScope: z.array(z.string()),
  appFingerprint: z.string().optional(),
  inputParams: z.array(InputParamSpec),
  outputs: z.array(OutputSpec),
  steps: z.array(Step),
  outcomes: z.array(OutcomeSpec),
  successCheckpoint: Checkpoint,
  createdFromRunId: z.string(),
  createdAt: z.string().datetime(),
  tenantOverrides: z.record(z.string(), z.any()).default({}),
}).superRefine(/* every paramRef resolves to a declared inputParam */);
```

```ts
// result.ts
export const StepTrace = z.object({
  stepId: z.string(),
  resolvedTier: z.number().int().nullable(),   // index into strategyChain; null = unresolved
  resolvedKind: z.string().nullable(),
  durationMs: z.number().int(),
  checkpointPassed: z.boolean().nullable(),
});

export const ReplayResult = z.object({
  capabilityId: z.string(), capabilityVersion: z.string(), runId: z.string(),
  status: z.enum(["success", "business_outcome", "failure", "escalated"]),
  outputs: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  outcomeName: z.string().optional(), outcomeMessage: z.string().optional(),
  failedStepId: z.string().optional(), expected: z.string().optional(), observed: z.string().optional(),
  failureClass: z.enum(["unknown_condition","locator_unresolved","checkpoint_failed","timeout","policy_blocked"]).optional(),
  recoveriesApplied: z.array(z.string()).default([]),
  stepTraces: z.array(StepTrace).default([]),
  evidencePaths: z.array(z.string()).default([]),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
});
```

```ts
// control.ts — who is (or should be) in control of the live session
export type ControlState =
  | "AUTOMATION_RUNNING"
  | "PAUSED_AWAITING_HUMAN"
  | "HUMAN_IN_CONTROL"
  | "RESUMING"
  | "ABORTED";

export const SessionControl = z.object({
  runId: z.string(),
  state: ControlStateSchema,
  owner: z.enum(["automation", "human", "none"]),
  since: z.string().datetime(),
  reason: z.string().optional(),
  cdpEndpoint: z.string().optional(),          // ws:// so the operator CLI can attach
});

// Legal transitions — enforce in a pure function `transition(from, event)`; test it.
//   AUTOMATION_RUNNING  --escalate-->  PAUSED_AWAITING_HUMAN
//   PAUSED_AWAITING_HUMAN --operator_attach--> HUMAN_IN_CONTROL
//   HUMAN_IN_CONTROL    --resume-->    RESUMING
//   RESUMING            --resnapshot_ok--> AUTOMATION_RUNNING
//   any                 --abort-->     ABORTED
```

---

## 5. Surface (`src/surface/`) — the seam

```ts
export interface Surface {
  observe(): Promise<Observation>;                    // aria refs + screenshot + url + title
  act(action: SurfaceAction): Promise<void>;          // click/fill/select/navigate keyed by ref or LocatorSpec
  resolve(spec: LocatorSpec): Promise<Resolved | null>; // returns which tier matched
  readText(spec: LocatorSpec, extraction, attr?): Promise<string | null>;
  screenshot(opts: { maskSpecs: LocatorSpec[] }): Promise<Buffer>;
  currentUrl(): string;
  waitForSettle(timeoutMs: number): Promise<void>;
}
```

- `PlaywrightSurface` is the only real implementation. Everything in `replay/`, `guardrails/`,
  `escalation/` depends on `Surface`, never on Playwright directly.
- `FakeSurface` takes a scripted sequence of page states and records actions. All executor,
  outcome, and guardrail tests run against it — no browser in unit tests.
- **The guardrail and the control-state check wrap `Surface.act()`** via a single
  `GuardedSurface` decorator. There is exactly one place in the codebase where "is this
  action allowed right now" is decided.
- The REPORT's Section 4 (desktop / legacy extension) is about this interface: the same
  `Surface` contract implemented over a desktop accessibility API, with `visual_anchor` as
  the universal fallback.

---

## 6. Perception (`src/perception/`)

**Snapshot.** Use `page.locator('body').ariaSnapshot()` (or `page.accessibility.snapshot()`
if the former isn't available in the installed Playwright — check, pick one, note it).
Flatten to interactive elements only (`button`, `link`, `textbox`, `combobox`, `checkbox`,
`radio`, `menuitem`, `cell` that is clickable). Assign stable refs `e0..eN` for the current
turn only. Also include the page title, URL, and up to ~40 lines of visible static text (so
the model can read a balance without a tool call). Cap total snapshot at ~6k chars.

**Hybrid perception.** Every discovery turn sends the model both the numbered snapshot and a
current screenshot (PNG, scaled to ≤1280 wide). Screenshots in the *transcript* are
masked (see §9). The accessibility list is what gets recorded into locators; the screenshot
is what lets the model handle an unlabeled image button.

**Enrichment (`enrich.ts`).** When the model acts on ref `eN`, build its `LocatorSpec` chain
*at that moment*, while the live DOM is available:

1. `role` + `accessibleName` — include only if `getByRole(role, {name, exact:true}).count() === 1`
2. `css` — a generated path (shortest unique: prefer `[name=...]`, then structural `nth-of-type` path)
3. `xpath` — absolute path as last-resort structural fallback
4. `text_anchor` — nearest `<label>`, table header, or preceding cell text, if any
5. `visual_anchor` — `boundingBox()` + `nearbyText`

Drop tiers that can't be computed. Write a one-line `rationale`
(e.g. `"role+name unique on page; css added because name may be tenant-branded"`).

**Fingerprint.** `sha256` of the sorted `role|name` pairs of the entry page's snapshot.
Stored on the capability; compared at replay start (see §8).

---

## 7. Discovery (`src/discovery/`)

**Inputs:** `--goal` (may contain `{param}` placeholders), `--param k=v` (repeatable),
`--target`, `--name`, `--max-steps` (default 25), `--timeout` (default 300s).

**Tools exposed to the model** (JSON Schema generated from Zod in `tools.ts`):

| Tool | Input | Effect |
|---|---|---|
| `snapshot` | — | Re-observe (auto-called after every action anyway; exposed for explicit re-look) |
| `click` | `ref` | Click; records Step |
| `type_text` | `ref, text` | Fill; records Step; if `text` equals a bound param value, recorder emits `paramRef` |
| `select_option` | `ref, value` | Select; records Step |
| `navigate` | `url` | Only within allowlist; records Step |
| `extract` | `ref, name` | Reads text; declares a candidate OutputSpec |
| `request_help` | `reason` | Model-initiated escalation (see §10) |
| `goal_complete` | `checkpoint: {ref? , text?}, outputs: {name: {ref, value}}, summary` | Ends the loop; recorder builds `successCheckpoint` and `OutputSpec`s from refs |

**Loop:** observe → send `[snapshot text, screenshot]` → model returns exactly one tool call
→ guard → act → log → repeat. Stop on `goal_complete`, `request_help`, max steps, timeout,
or the stuck heuristic (§10).

**System prompt must say:** one action per turn; only use refs from the latest snapshot;
never type credentials except into fields the snapshot labels as login fields; call
`goal_complete` only when the checkpoint text is *visible in the snapshot*; call
`request_help` when unsure rather than guessing; treat "not found"/"denied" banners as
outcomes to report, not obstacles to route around.

**Credentials in discovery:** the goal says "log in"; the model is given `{username}` and
`{password}` as bound params of type `secret` whose *values* it types via `type_text`
with the literal placeholder `{{secret:password}}` — the surface substitutes the real
value from env. The model never sees the secret; the transcript never contains it.

**Recorder (`recorder.ts`):** trace → `Capability`. Sets `status: "draft"`, semver `1.0.0`,
`risk` per step via `guardrails/risk.ts`, merges seeded outcomes from
`outcomes/<targetApp>.yaml` (`provenance: seeded`), computes `appFingerprint`, canonicalizes
routes (`/member/10001` → `/member/:member_id` when a param value matches a path segment).
Saves to `artifacts/<name>.json` and copies into the evidence folder.

**Transcript evidence:** save the full model transcript (`transcript.redacted.json`) with
secrets/PII redacted and screenshots referenced by path, plus `usage` (tokens) and `model`
per call — this is what proves the run was real.

---

## 8. Replay (`src/replay/`)

**Inputs:** `--capability`, `--param k=v`, `--tenant`, `--inject` (dev only; sets a cookie
the mock app honors), `--approve-irreversible` (dev flag; production gate is `status`).

**Algorithm:**

```
load + validate capability; apply tenantOverrides[tenant] if given (deep-merge by step id)
resolve params: required check; secrets from env; refuse to log secret/pii values
open surface at entryPoint
fingerprint check:
   match            → proceed
   mismatch         → if tenant override exists: proceed with it, log "fingerprint_mismatch_overridden"
                      else → result.status=failure, failureClass=unknown_condition, expected/observed = fingerprints, EXIT
for each step:
   control check    → if owner !== automation: wait/poll (this is the HITL seam)
   guard check      → allowlist + risk → may set policy_blocked or escalate
   pre-detect       → run outcome detection (declared then generic) on current state
   resolve locator  → try chain in order; record tier; unresolved → attempt outcome detection once more → else failure(locator_unresolved)
   act              → with step.timeoutMs
   waitForSettle
   post-detect      → outcome detection
   checkpoint       → if step.checkpoint: evaluate; fail → failure(checkpoint_failed) unless an outcome matched
extract outputs; evaluate successCheckpoint
write ReplayResult + evidence
```

**Outcome detection order (`outcomes.ts`):**

1. Declared `OutcomeSpec`s, in artifact order. First match wins.
   - `business_outcome` → `status=business_outcome`, EXIT cleanly.
   - `recoverable` → apply `recoveryAction` (dismiss: click `recoveryTarget`; retry: redo
     step; wait_and_retry: `waitForSettle` then redo), up to `maxRetries`; append to
     `recoveriesApplied`; re-detect. Exhausted → `hard_failure`.
   - `hard_failure` → `status=failure`, `failureClass=unknown_condition` with the outcome's message.
2. **Generic detector** (only if nothing declared matched and the step failed): any
   `role=alert|alertdialog`, any native `dialog` event, or visible text matching
   `/error|denied|not found|session (expired|timed out)|try again/i` →
   `failureClass=unknown_condition`, and **escalate** rather than continue.
3. Nothing matched, step failed → `failure(locator_unresolved | checkpoint_failed | timeout)`.

Never proceed past a failed checkpoint. Never retry an `irreversible` step.

**Determinism rules:** no `sleep`; waits are Playwright auto-wait bounded by `timeoutMs`,
plus explicit `wait_for` steps with checkpoints. Locator resolution is exact-name
(`exact: true`) unless the tier says otherwise. Same artifact + same params + same app state
⇒ same `ReplayResult.status` and same `outputs`.

---

## 9. Guardrails (`src/guardrails/`)

`policy.yaml`:

```yaml
allowlist:
  origins: ["http://localhost:4173"]
  routes:  ["/", "/login", "/members/**", "/member/**", "/portal/**"]
  actions: ["click", "fill", "select_option", "navigate", "wait_for", "extract"]
risk:
  irreversible_when:
    button_text_matches: ["submit", "confirm", "open account", "transfer", "delete", "close"]
    method_is: ["POST"]           # a submit that leaves the confirm page
  irreversible_policy: "escalate" # block | escalate | allow_if_approved
redaction:
  patterns:
    - name: ssn        ; regex: "\\b\\d{3}-\\d{2}-\\d{4}\\b"
    - name: acct       ; regex: "\\b\\d{9,16}\\b"
    - name: email      ; regex: "[\\w.+-]+@[\\w-]+\\.[\\w.]+"
```

- **Enforcement point:** `GuardedSurface.act()` only. Every action, both discovery and
  replay. Violation → throw `PolicyViolation` → `failureClass=policy_blocked`. Never
  silently skip.
- **Risk:** the recorder tags steps using `risk.ts`. In replay, `irreversible` steps follow
  `irreversible_policy`: with `escalate` (the default and the justified choice), the run
  pauses with an intervention request asking a human to confirm; a capability with
  `status: approved` proceeds without asking. Justify in REPORT: irreversible actions in
  banking should default to a human confirming until a capability has earned approval.
- **Redaction (`redact.ts`) — one choke point:** the JSONL logger applies (a) pattern
  scrubbing, (b) exact-value scrubbing for every `pii` param/output value and every
  `secret` value in the run. Snapshots and transcripts pass through the same function.
- **Screenshot masking:** `PlaywrightSurface.screenshot({maskSpecs})` uses Playwright's
  native `mask:` option with the resolved locators of every `pii`-flagged output/input.
  Every saved screenshot goes through this.

---

## 10. Escalation & handoff (`src/escalation/`)

**Stuck detectors (`stuck.ts`)** — any one triggers an intervention:
- Discovery: `request_help` tool called; or 3 consecutive turns with identical snapshot
  hash and no `goal_complete`; or the same `(ref, action)` repeated 3×.
- Replay: any `failure` whose class is `unknown_condition`; an `irreversible` step under
  `irreversible_policy: escalate` on a `draft` capability; `--inject stuck` (dev).

**InterventionRequest** (written to `evidence/<kind>/<run_id>/intervention.json` and
printed):
```ts
{ runId, kind: "discovery"|"replay", capabilityId?, goal?, stepId?, stepDescription?,
  reason, currentUrl, screenshotPath /*masked*/, snapshotPath, cdpEndpoint, createdAt }
```

**Shared session (`session.ts`).** The browser is launched by the automation process via
`chromium.launchServer()` (or `launch` with `--remote-debugging-port`); its `wsEndpoint` is
written into `control.json`. On escalation the automation:
1. transitions `AUTOMATION_RUNNING → PAUSED_AWAITING_HUMAN`, writes `control.json`,
2. installs human-action capture (below),
3. **polls `control.json`** until state is `RESUMING` or `ABORTED`. It does not exit.

**Operator CLI (`cli/operator.ts`)** — the mock operator surface:
- `--run <id>` reads `control.json`, prints the intervention request, connects with
  `chromium.connect(wsEndpoint)` / `connectOverCDP`, attaches to the **existing** page,
  transitions to `HUMAN_IN_CONTROL`.
- REPL commands: `snapshot`, `click <ref>`, `type <ref> <text>`, `note <text>`, `resume`,
  `abort`. All commands go through the same `Surface` and are logged with `actor: "human"`.
- The human may also act directly in the visible browser window.

**Human-action capture (`humanCapture.ts`).** `page.addInitScript` installs document-level
listeners for `click`, `input`, `change`, `submit` that call
`window.__cuaHumanAction({type, role, name, text?, url})` — exposed via
`page.exposeBinding`. Because it's an init script it re-attaches after every navigation.
Every event is appended to the run log with `actor: "human"`. Input *values* are redacted
by the same choke point. Document the limitation: this captures DOM-level intent, not
OS-level events, and cannot see inside cross-origin iframes.

**Resume.** Operator types `resume` → `HUMAN_IN_CONTROL → RESUMING`. Automation wakes,
re-observes, evaluates the current step's precondition (checkpoint or outcome detection):
- if the human completed the step → mark it `resolved_by_human`, continue at next step;
- else continue at the same step.
Transition `RESUMING → AUTOMATION_RUNNING`. The `ReplayResult` records `status: "escalated"`
only if the run ended while paused/aborted; a resumed run reports its final status with
`recoveriesApplied` including `"human_intervention:<stepId>"`.

---

## 11. Evidence (`src/evidence/`)

Run folder: `evidence/<discovery|replay>/<run_id>/` containing
`log.jsonl` (every action, decision, guard check, detection, control transition — one JSON
object per line, redacted), `screenshots/NNN-<event>.png` (masked; always on failure,
also every N steps), `snapshot-<step>.txt` on failure, `capability.json` (discovery) or
`result.json` (replay), `transcript.redacted.json` (discovery), `intervention.json` and
`control.json` (if escalated). `evidence/README.md` indexes every run committed to the repo
and states which command produced it.

**Minimum committed evidence:** one discovery run; replay success; replay
`business_outcome` (99999); one recoverable (`slow` or `dialog`); one hard failure
(`error`); one escalated-and-resumed run with human actions in the log; the tenant-b replay
if the stretch is done.

---

## 12. Mock app (`src/mockapp/`) — "CU Console"

A deliberately legacy credit-union servicing console. **Markup requirements (this is the
point of building it ourselves):**
- Server-rendered HTML strings. Table-based layout. A `frameset`-style shell: a top nav
  frame and a main content **iframe** (same-origin) so the automation must handle frames.
- **No** `id`s, `data-testid`s, or semantic class names. Generic classes like `c1`, `r`.
- Exactly **one** critical control with **no accessible name**: the search submit is an
  `<input type="image" src="go.gif">` with no `alt` — forces a non-role locator tier and
  makes the discovery/replay evidence show fallback in action.
- Form POSTs with full page reloads. Inline `onclick` handlers on some table rows.

**Data (`data.ts`):** ~8 synthetic members with fake names, IDs `10001..10008`, savings and
checking balances. `10007` is *restricted* (permission denied page). Any other ID → "No
member found". Sub-account initial deposit must be ≥ 25.00 else validation error.

**Routes:**

| Route | Behavior |
|---|---|
| `GET /login`, `POST /login` | fake creds from env `DEMO_USER`/`DEMO_PASS` (defaults `teller`/`demo-pass`); sets session cookie |
| `GET /` | shell (nav + iframe → `/members/search`) |
| `GET /members/search`, `POST /members/search` | search form (image-button submit) → results table or "No member found" |
| `GET /member/:id` | detail: name, member since, **Savings balance**, Checking balance; "Open sub-account" link. `10007` → permission denied |
| `GET /member/:id/subaccount/new` → `POST .../confirm` → `POST .../submit` | multi-field form → confirmation screen → success with new account number (irreversible) |
| `GET /__inject?mode=slow\|error\|dialog\|stuck\|expire\|none` | sets a cookie; next matching request behaves accordingly (dev only, documented) |

**Injections:** `slow` delays the next response 6s (recoverable: wait_and_retry);
`dialog` injects a "Session notice" interstitial with an OK button (recoverable: dismiss);
`error` returns a 500 "Application error" page (hard failure); `expire` clears the session
(seeded as `recoverable → re-login`, or `hard_failure` if you cut re-login — say which);
`stuck` renders a page whose only path forward is a control with a random accessible
name (forces escalation).

**Tenant B (`TENANT=b`):** route prefix `/portal`, title "Member Portal — Second Federal CU",
search button labeled "Find member" instead of "Search", different colors. Everything else
identical. This is the stand-in for "same vendor product, different tenant." Ship a
`tenantOverrides.b` patch in the example artifact that overrides `entryPoint` and the
relabeled locator.

**Seeded outcomes (`outcomes/cu-console.yaml`):** `member_not_found` (business),
`permission_denied` (business), `validation_error_min_deposit` (business),
`session_notice_dialog` (recoverable/dismiss), `slow_load` (recoverable/wait_and_retry),
`application_error` (hard_failure), `session_expired` (per your cut decision).

---

## 13. Tests (`test/`) — "tested where it counts"

Required, all against `FakeSurface` (no browser):
- `schema`: valid artifact round-trips; `paramRef` to undeclared param rejected; literal+paramRef rejected.
- `locate`: tier 1 fails → tier 2 resolves → `StepTrace.resolvedTier === 1`; all fail → `locator_unresolved`.
- `executor`: success with outputs; business outcome exits cleanly; recoverable retries then succeeds; recoverable exhausts → failure; checkpoint failure stops; irreversible step on draft → escalation requested; irreversible never retried.
- `outcomes`: declared beats generic; generic alert text → `unknown_condition`.
- `guardrails`: off-allowlist navigate → `policy_blocked`; redaction scrubs pii param value and pattern hits from a log line; screenshot mask list built from pii outputs.
- `control`: every legal transition; illegal transition throws.
- `recorder`: literal equal to bound param becomes `paramRef`; route canonicalization.

Optional: one Playwright e2e that replays the committed artifact against the mock app
(skipped when `CI_NO_BROWSER` is set).

---

## 14. README.md and REPORT.md

**README.md:** what it is (3 sentences); setup incl. every env var; how to run *without* the
API key (mock app + replay + tests); the exact demo path from §3; where evidence lives;
what's mocked.

**REPORT.md** (~1–3 pages, these seven headings verbatim, this order):
1. Architecture
2. Artifact schema
3. Determinism & error handling
4. Heterogeneity & multi-tenant
5. Escalation & handoff
6. Safety
7. Cuts

`docs/REPORT_draft.md` already contains §1–2; extend it. Section 7 must name, at minimum:
the operator console is a CLI not co-browsing; outcome catalog is seeded not discovered;
desktop surface designed not built; multi-tenant is one override demo, no registry;
`assisted fallback` not implemented; and the next three things you'd build.

---

## 15. Build order (do not reorder)

1. Scaffold, `tsconfig`, scripts, `.env.example`, policy.yaml. `npm run typecheck` green.
2. Schema (§4) + `test/schema.test.ts`.
3. Mock app (§12) with all routes and injections. Manually verify in a browser.
4. `Surface`, `FakeSurface`, `GuardedSurface`; guardrails (§9) + tests.
5. Executor, locate, checkpoint, outcomes (§8) + tests against `FakeSurface`.
6. `PlaywrightSurface` + perception (§6). Hand-write one artifact JSON for
   `lookup_member_balance` and get replay green against the mock app. **Milestone: the
   production path works before the LLM is involved.**
7. Discovery loop + recorder (§7). Run it for real. Commit evidence. Diff the recorded
   artifact against the hand-written one — that diff is REPORT material.
8. Escalation, session sharing, operator CLI, human capture (§10). Produce the escalated
   run evidence.
9. Injection replays for evidence (§11). Tenant B (§12) if time.
10. README, REPORT, `evidence/README.md`. Final `npm test && npm run typecheck`.

**Definition of done:** every command in §3 runs as documented; `npm test` green; the
committed `evidence/` contains the minimum set from §11; REPORT has all seven headings;
`git grep "@anthropic-ai/sdk" src/replay` returns nothing.

---

## 16. Explicitly do not

- Do not use the Claude Agent SDK / Claude Code SDK for the agent loop.
- Do not use screenshot-coordinate clicking as the primary action mechanism.
- Do not add a database, queue, web dashboard, Docker, or multi-tenant registry.
- Do not put any string that looks like a real SSN, card number, or real person's name in
  the mock data.
- Do not "fix" a failing discovery run by editing the evidence. Re-run it.
- Do not implement more than the two stretch goals (tenant variant; capabilities CLI).
