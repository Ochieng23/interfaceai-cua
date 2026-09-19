# Evidence index

SPEC §11's evidence index: every run folder committed under `evidence/discovery/` or
`evidence/replay/`, and the command that produced it. Every run folder's own `log.jsonl` is
the full, redacted record of actions/decisions/guard checks/detections/control transitions for
that run — this file is only a map into those folders, not a substitute for reading them.

All replay runs below were executed against a live mock app instance (`npm run mock-app`),
not simulated — see each run's `log.jsonl`/`result.json` for the real output.

## Discovery runs (`evidence/discovery/`)

All seven runs below were produced by variations of:

```
npm run discover -- --goal "Log in, look up member {member_id}, and read their current savings balance" \
  --target http://localhost:4173 --name lookup_member_balance_discovered --param member_id=10001
```

| Run id | Produced `capability.json`? | Notes |
|---|---|---|
| `2026-09-19T17-20-18-170Z-210fa0` | no | Early iteration; discovery loop did not converge to a complete capability within this run. |
| `2026-09-19T17-29-07-709Z-c537fb` | no | Same as above. |
| `2026-09-19T17-32-47-709Z-7b6779` | no | Same as above. |
| `2026-09-19T17-34-38-577Z-cad836` | no | Same as above. |
| `2026-09-19T17-41-52-030Z-884854` | yes | First run to produce a complete `capability.json`. |
| `2026-09-19T17-45-53-622Z-2a57ba` | yes | Later iteration. |
| `2026-09-19T18-38-06-790Z-520bcd` | yes | Latest discovery run; satisfies SPEC §11's "one discovery run" minimum-evidence requirement. |

## Replay runs (`evidence/replay/`)

All five runs below used `artifacts/lookup_member_balance.json`. Each folder contains
`log.jsonl` (every action/decision/guard-check/detection/control-transition, redacted),
`result.json` (the final `ReplayResult`, redacted, with `evidencePaths` populated), and
`screenshots/NNN-<event>.png` (masked; written on every checkpoint failure and every 3rd
step — see `src/cli/replay.ts`'s `SCREENSHOT_EVERY_N_STEPS`). `snapshot-<step>.txt` is
present whenever the run ended in `status: "failure"`.

| Run id | Command | Result |
|---|---|---|
| `2026-09-19T21-35-08-837Z-a641b4` | `npm run replay -- --capability artifacts/lookup_member_balance.json --param member_id=10001` | `success`; `savings_balance: "4,200.00"`. Minimum-evidence "replay success". |
| `2026-09-19T21-35-24-698Z-00be3a` | `npm run replay -- --capability artifacts/lookup_member_balance.json --param member_id=99999` | `business_outcome` / `member_not_found`. Minimum-evidence "replay business_outcome". |
| `2026-09-19T21-37-20-408Z-4bf1a2` | `npm run replay -- --capability artifacts/lookup_member_balance.json --param member_id=10001 --inject dialog --tenant escalation-demo` | `success`, with a genuine recovery: `recoveriesApplied` includes `dismiss:session_notice_dialog:attempt1`. `--tenant escalation-demo` is required alongside `--inject dialog` — without it, `--inject`'s one-shot cookie fires on the capability's own entry-point navigate, so the injected page becomes the ENTRY observation and fails the `appFingerprint` check before any step or outcome-detection logic ever runs (see the capability's own `tenantOverrides.escalation-demo._comment`, and Task 8's identical note for `--inject stuck`). Minimum-evidence "one recoverable". |
| `2026-09-19T21-37-44-583Z-af5cb2` | `npm run replay -- --capability artifacts/lookup_member_balance.json --param member_id=10001 --inject error --tenant escalation-demo` | `failure` / `failureClass: "unknown_condition"` / `outcomeName: "application_error"` (a declared hard_failure, correctly attributed — not a fingerprint-mismatch coincidence). Same `--tenant escalation-demo` requirement as above. Minimum-evidence "one hard failure". |
| `2026-09-19T21-41-14-473Z-26f487` | `TENANT=b PORT=4174 npm run mock-app` (second instance) then `npm run replay -- --capability artifacts/lookup_member_balance.json --param member_id=10001 --tenant b` | `success`; `savings_balance: "4,200.00"`, genuinely run against the tenant-B instance (`/portal` prefix, "Find member" label, "Member Portal — Second Federal CU" title). Minimum-evidence "the tenant-b replay". |

### Already-committed: escalated-and-resumed run (Task 8)

| Run id | Command | Result |
|---|---|---|
| `2026-09-19T19-09-43-547Z-8a3920` | `npm run replay -- --capability artifacts/lookup_member_balance.json --param member_id=10001 --inject stuck --tenant escalation-demo`, resumed via `npm run operator -- --run <runId>` | `status: "success"` after a human operator resumed a `locator_unresolved` escalation. `log.jsonl` contains human actions from BOTH the operator's own REPL commands (`operator_attached`, `operator_snapshot`, `operator_click`, `operator_resume`, all `actor: "human"`) AND genuine DOM-level capture (`human_action` entries, `actor: "human"`, from `src/escalation/humanCapture.ts`) — satisfies SPEC §11's "one escalated-and-resumed run with human actions in the log" on both counts, not just the REPL-command reading of that requirement. |

## Notable finding fixed as part of producing this evidence (Task 9)

`artifacts/lookup_member_balance.json`'s `session_notice_dialog` outcome originally copied
`outcomes/cu-console.yaml`'s seeded `maxRetries: 0` verbatim. `src/replay/outcomes.ts`'s
`applyRecovery` treats `attemptNumber > maxRetries` as exhausted BEFORE performing the
recovery action at all, so with `maxRetries: 0` the first (and only) call is already
"exhausted" on `attemptNumber === 1` — the `dismiss` click never fires, even though the
outcome's own `messageTemplate` claims "A session notice interstitial appeared and was
dismissed." Confirmed live: a real `--inject dialog --tenant escalation-demo` run against
the pre-fix artifact failed immediately with that misleading message and an empty
`recoveriesApplied`. Fixed by bumping this artifact's own copy of `maxRetries` to `1` (see
the `_maxRetriesNote` next to it in the JSON) — `outcomes/cu-console.yaml`'s seed catalog and
`src/replay/outcomes.ts`'s general `maxRetries` semantics were left untouched, since fixing
the general "dismiss should not be gated by a retry counter with no actual retries" issue is
an `outcomes.ts` design decision outside this task's scope.
