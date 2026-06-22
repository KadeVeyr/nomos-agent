# Nomos Event Spec — the live work-loop stream

Nomos runs on ONE event spine. The agent loop publishes a stream of small JSON
events through a single `onEvent(event)` callback; every surface — the CLI
renderer, the TUI, the session log, the verdict state machine, and (future) an
editor extension — consumes the SAME stream. There is no second code path.

This document is the stable shape of that stream. It is the groundwork an IDE
extension consumes: bind to these events and you can render the work loop —
plan, edits, diff, the cross-provider review, the verdict — without re-running
anything. Treated as a forward contract; new event types may be added, existing
ones are not removed or repurposed without a note here.

## Events (`onEvent(event)`)

Every event is a plain object with a `type`. Fields are additive.

| `type`        | fields | meaning |
|---------------|--------|---------|
| `state`       | `state: "running"` | the agent loop has started |
| `state`       | `state: "loop_done", loopExit: "done" \| "stuck" \| "exhausted"` | the loop ended; `loopExit` is how — a clean final answer (`done`), an early stop after repeating with no progress (`stuck`), or the step budget running out (`exhausted`). A REAL signal for the verdict, not a guess. |
| `delta`       | `text` | a chunk of streamed model output |
| `tool_call`   | `name, args` | the agent invoked a tool (`read_file`, `edit_file`, `run_shell`, …) |
| `tool_result` | `name, args, result` | the tool's result (string, truncated for display); `args` echoes the call's arguments so a result can be matched to its own command (e.g. attributing a test pass/fail) without relying on call/result ordering |
| `error`       | `message` | a recoverable error or an early stop reason |
| `phase`       | `phase: "propose" \| "verify", model` | which phase of a propose-then-verify run (the `nomos council` command) just started, and the model running it |
| `verdict`     | `verdict: "PASS" \| "CONCERNS" \| "FAIL", independent?: boolean` | the cross-provider VERIFIER's verdict on a change (council / verify path). `independent` is true when proposer and verifier are different providers. |
| `warn`        | `message` | a non-fatal warning (e.g. same-provider verify) |

## The run verdict (derived, persisted)

The run-level verdict — `PASS` / `HOLD` / `BLOCK` — is NOT a model opinion. It is
computed deterministically by folding the event stream above through the pure
state machine in `src/verdict.js` (`foldEvent` → `computeVerdict`):

- **PASS** — the loop ended `done` AND either nothing was changed or a REAL,
  independent positive check confirmed it (cross-provider verifier `PASS`, or the
  project's test command ran green *without the run having edited the test files* —
  a run that rewrites its own tests can't earn PASS from "green" alone, only from
  the verifier) AND no negatives were seen.
- **HOLD** — could not be confirmed: `loopExit` was `exhausted` or `stuck`, the
  verifier raised `CONCERNS`, or code changed but was never independently
  verified/tested. (Step-exhaustion is HOLD, never a silent success.)
- **BLOCK** — a real negative: the verifier `FAIL`ed the change, or the project's
  declared test command failed.

It is written to the session log as one record:

```json
{ "type": "verdict", "verdict": "PASS|HOLD|BLOCK", "reason": "...",
  "signals": { "loopExit": "done", "edits": 2, "toolErrors": 0,
               "testRan": true, "testFailed": false, "testsEdited": false,
               "verifier": "PASS", "verifierIndependent": true }, "ms": 12345 }
```

Because the verdict is a pure function of `signals`, `nomos replay <id>`
re-derives it OFFLINE (zero provider calls) and flags any divergence from the
logged value — so a verdict can be re-checked, never just trusted.

## Session log

A run is logged append-only to `~/.local/share/nomos/sessions/<id>.jsonl`: a
`meta` record, then one `msg` record per turn, the `verdict` record above, and a
`done` marker on a clean finish. Append-only means an interrupt (Ctrl+C) can only
ever truncate the LAST line; on resume the torn line is treated as end-of-file and
the dangling turn reconciled away — so the log is never corrupted.
