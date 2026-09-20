# interfaceai — computer-use browser automation (discover once, replay deterministically)

A system for automating a legacy web app in two phases: an LLM (Claude, via the raw
Anthropic Messages API) **discovers** a workflow once by actually driving a real Chromium
browser against a deliberately old-fashioned mock banking console, and records what it did
as a validated, schema-checked **Capability** artifact (JSON). A separate, **LLM-free**
deterministic **replay** engine then re-executes that Capability against the live app —
resolving elements through a tiered locator strategy, detecting known business/recoverable/
hard-failure outcomes, enforcing an allowlist + risk policy on every action, and pausing for
a real human operator (over a shared browser session) when something it doesn't recognize
happens. The mock app (`src/mockapp`, "CU Console") is intentionally legacy — no ids, no
`data-testid`s, one alt-less image-button submit control, a same-origin iframe shell — so
both the discovery and replay paths have to deal with the same kind of markup a real
internal banking tool would have.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env   # then fill in ANTHROPIC_API_KEY if you want to run discovery
```

Every environment variable, all documented in `.env.example`:

| Var | Required for | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | `npm run discover` only | Replay, the mock app, and tests never read it. |
| `ANTHROPIC_BASE_URL` | optional | Routes Anthropic API calls through a compatible proxy/gateway (e.g. an Azure AI Foundry endpoint exposing the Anthropic Messages API). Blank = call Anthropic directly. |
| `MODEL` | optional | Anthropic model id used for discovery. Defaults to `claude-sonnet-4-6`. |
| `DEMO_USER` | mock app + discovery + replay | Fake login username the mock app accepts. Default `teller`. Never a real credential. |
| `DEMO_PASS` | mock app + discovery + replay | Fake login password. Default `demo-pass`. |
| `TENANT` | optional | Set to `b` to run the mock app's second-tenant variant (`/portal` route prefix, different branding). |
| `PORT` | optional | Port the mock app listens on. Default `4173`. |
| `CDP_PORT` | escalation/operator only | Chrome DevTools Protocol remote-debugging port used to share one live browser session between the replay process and the separate `operator` CLI process during human escalation. Default `9222`. |

`.env` is loaded with Node's built-in `process.loadEnvFile()` (no `dotenv` dependency) by
each CLI entry point (`src/cli/discover.ts`, `src/cli/replay.ts`, `src/cli/operator.ts`); a
missing or malformed `.env` is never fatal — the process falls back to whatever the shell
environment already provides. `.env` is gitignored; only `.env.example` is committed.

## Running without an API key

Everything except `npm run discover` works with no `ANTHROPIC_API_KEY` set — verified live
for this README:

```bash
npm run mock-app                 # terminal 1 — http://localhost:4173
npm test                         # 13 test files / 121 tests, all against FakeSurface, no browser
npm run typecheck                # tsc --noEmit, zero errors
npm run lint                     # eslint . — added post-review at explicit user request, zero errors
npm run replay -- --capability artifacts/lookup_member_balance.json --param member_id=10001
```

The replay engine (`src/replay/**`) has zero imports of `@anthropic-ai/sdk` — this is a
hard requirement (SPEC §0.5), grep-verifiable:

```bash
git grep "@anthropic-ai/sdk" src/replay   # must return nothing
```

## Demo path

This follows SPEC §3, with one documented correction: two of the `--inject` demos need an
extra `--tenant escalation-demo` flag that SPEC §3's literal text omits. Without it, the
injected page becomes the capability's own entry-point observation (because `--inject`'s
cookie fires on the very first navigate) and the run fails an `appFingerprint` check before
any step or outcome-detection logic runs at all — before the interesting behavior the demo
is trying to show. `--tenant escalation-demo` routes around this via the executor's
already-built tenant-override / fingerprint-mismatch escape hatch (see
`artifacts/lookup_member_balance.json`'s `tenantOverrides["escalation-demo"]._comment`, and
`evidence/README.md`, which documents the same workaround for the real committed evidence).
`--inject slow` is not currently exercised this way in committed evidence — the working
commands below are the ones actually verified.

```bash
npm install && npx playwright install chromium
cp .env.example .env            # add ANTHROPIC_API_KEY for the discover step below

npm run mock-app                # terminal 1, http://localhost:4173

# Discovery (needs API key) — real LLM-driven run against the live mock app
npm run discover -- \
  --goal "Log in, look up member {member_id}, and read their current savings balance" \
  --param member_id=10001 \
  --target http://localhost:4173 \
  --name lookup_member_balance_discovered

# Deterministic replay (no API key needed) — against the hand-written artifact
npm run replay -- --capability artifacts/lookup_member_balance.json --param member_id=10001
npm run replay -- --capability artifacts/lookup_member_balance.json --param member_id=99999   # → business_outcome: member_not_found
npm run replay -- --capability artifacts/lookup_member_balance.json --param member_id=10001 --inject dialog --tenant escalation-demo   # → recoverable, dismissed
npm run replay -- --capability artifacts/lookup_member_balance.json --param member_id=10001 --inject error  --tenant escalation-demo   # → hard failure with evidence
npm run replay -- --capability artifacts/lookup_member_balance.json --param member_id=10001 --inject stuck  --tenant escalation-demo   # → escalated; then, in a second terminal:
npm run operator -- --run <run_id>                                                                                                      #    take over, resume

# Tenant B (stretch goal — implemented)
TENANT=b PORT=4174 npm run mock-app                 # separate process/port from tenant A
npm run replay -- --capability artifacts/lookup_member_balance.json --param member_id=10001 --tenant b
```

`npm run capabilities` is listed in `package.json`'s scripts (per SPEC §2/§3) but
`src/cli/capabilities.ts` was never written — the capabilities-CLI stretch goal was
explicitly cut for time (see REPORT.md §7). Running it fails with
`ERR_MODULE_NOT_FOUND`; the tenant-variant stretch goal was implemented instead.

All commands above (mock app, both plain replays, the dialog/error injections, `npm test`,
`npm run typecheck`) were re-run live against this checkout while preparing this README.
`npm run discover` and the escalation/operator handoff were not re-run for this README (the
former spends real API tokens; both are already reproduced multiple times as committed
evidence — see below) but their commands are unchanged from what produced that evidence.

## Where evidence lives

- `evidence/discovery/<run_id>/` — one folder per real `npm run discover` invocation:
  `log.jsonl` (every turn, redacted), `screenshots/`, `transcript.redacted.json` (real
  per-call token usage, proving the run wasn't fabricated), and `capability.json` when the
  run reached `goal_complete`.
- `evidence/replay/<run_id>/` — one folder per real `npm run replay` invocation:
  `log.jsonl`, `screenshots/`, `result.json` (the final `ReplayResult`), plus
  `intervention.json`/`control.json` for escalated runs.
- `evidence/README.md` — the index: which folder came from which exact command, and what
  each one demonstrates (including seven real discovery attempts — four that hit and fixed
  real bugs, three that reached `goal_complete` — and the full SPEC §11 minimum replay set).

## What's mocked

- **The entire target application** is `src/mockapp/` ("CU Console"), a real (if
  deliberately old-fashioned) Express server with server-rendered HTML, table layout, no
  element ids, a same-origin iframe shell, and one alt-less `<input type="image">` submit
  button. It is not a stub — it's driven by a real browser exactly like a real internal
  banking tool would be, including a second tenant variant (`TENANT=b`) and a
  `GET /__inject` failure-injection endpoint (`slow`/`error`/`dialog`/`stuck`/`expire`) used
  only to produce reproducible failure-path evidence.
- **The LLM is real, not mocked** — discovery makes genuine `@anthropic-ai/sdk` calls to the
  Anthropic Messages API (optionally routed through `ANTHROPIC_BASE_URL` if you're using a
  proxy/gateway instead of calling Anthropic directly — see `.env.example`). The replay path
  never calls it at all.
- **The human operator in the escalation evidence was simulated via the `operator` CLI's
  REPL commands** (`snapshot`, `click <ref>`, `resume`, etc.) rather than a person clicking
  in a visible browser window during evidence capture, but the underlying mechanism (a real,
  separate Node process attaching to the same live Chromium session over CDP) is exactly
  what a real human operator would use.
