// Verdict state machine — PASS/HOLD/BLOCK derived deterministically from REAL
// outcomes (tool/test/verifier/loop-exit), never model prose. These lock the
// cascade and the event-folding, and prove a verdict is re-derivable offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  newRunSignals, foldEvent, computeVerdict, verdictFromEvents, runSummary, isErrorResult, VERDICTS,
} from "../src/verdict.js";
import { startSession, loadSession } from "../src/session.js";

const sig = (over = {}) => ({ ...newRunSignals(), ...over });

test("VERDICTS is exactly the three honest states", () => {
  assert.deepEqual([...VERDICTS], ["PASS", "HOLD", "BLOCK"]);
});

// ── BLOCK: real negatives ──
test("verifier FAIL → BLOCK", () => {
  assert.equal(computeVerdict(sig({ loopExit: "done", edits: 1, verifier: "FAIL" })).verdict, "BLOCK");
});
test("a failed test command → BLOCK", () => {
  assert.equal(computeVerdict(sig({ loopExit: "done", edits: 1, testRan: true, testFailed: true })).verdict, "BLOCK");
});
test("BLOCK on verifier FAIL outranks a passing test (a real negative wins)", () => {
  const v = computeVerdict(sig({ loopExit: "done", edits: 1, verifier: "FAIL", testRan: true, testFailed: false }));
  assert.equal(v.verdict, "BLOCK");
});

// ── HOLD: could-not-confirm (step-exhaustion is HOLD, never silent success) ──
test("step exhaustion → HOLD", () => {
  assert.equal(computeVerdict(sig({ loopExit: "exhausted", edits: 1 })).verdict, "HOLD");
});
test("stuck early-stop → HOLD", () => {
  assert.equal(computeVerdict(sig({ loopExit: "stuck", edits: 1 })).verdict, "HOLD");
});
test("verifier CONCERNS → HOLD", () => {
  assert.equal(computeVerdict(sig({ loopExit: "done", edits: 1, verifier: "CONCERNS" })).verdict, "HOLD");
});
test("edits with no verification and no test → HOLD (no silent green)", () => {
  assert.equal(computeVerdict(sig({ loopExit: "done", edits: 3 })).verdict, "HOLD");
});
test("tool failures not cleared by a passing verifier → HOLD", () => {
  assert.equal(computeVerdict(sig({ loopExit: "done", edits: 0, toolErrors: 2 })).verdict, "HOLD");
});

// ── PASS: completed + (nothing to verify OR a real positive check) + no negatives ──
test("completed, verifier PASS → PASS", () => {
  const v = computeVerdict(sig({ loopExit: "done", edits: 2, verifier: "PASS" }));
  assert.equal(v.verdict, "PASS");
  assert.match(v.reason, /verifier agreed/);
});
test("completed, tests passed (no verifier) → PASS", () => {
  const v = computeVerdict(sig({ loopExit: "done", edits: 2, testRan: true, testFailed: false }));
  assert.equal(v.verdict, "PASS");
  assert.match(v.reason, /tests passed/);
});
test("completed read-only task with no edits and no negatives → PASS", () => {
  const v = computeVerdict(sig({ loopExit: "done", edits: 0 }));
  assert.equal(v.verdict, "PASS");
  assert.match(v.reason, /no code changes/);
});
test("a passing verifier clears tool errors → PASS", () => {
  assert.equal(computeVerdict(sig({ loopExit: "done", edits: 1, toolErrors: 1, verifier: "PASS" })).verdict, "PASS");
});

// ── default ──
test("no clean loop exit → HOLD", () => {
  assert.equal(computeVerdict(sig({ loopExit: null, edits: 1 })).verdict, "HOLD");
});
test("empty signals → HOLD (never an empty PASS)", () => {
  assert.equal(computeVerdict(newRunSignals()).verdict, "HOLD");
  assert.equal(computeVerdict(undefined).verdict, "HOLD");
});

// ── foldEvent: signals come from the event stream ──
test("foldEvent counts edits from edit/write tool calls", () => {
  const s = newRunSignals();
  foldEvent(s, { type: "tool_call", name: "edit_file", args: {} });
  foldEvent(s, { type: "tool_call", name: "write_file", args: {} });
  foldEvent(s, { type: "tool_call", name: "read_file", args: {} });
  assert.equal(s.edits, 2);
});
test("foldEvent counts error-classified tool results", () => {
  const s = newRunSignals();
  foldEvent(s, { type: "tool_result", name: "run_shell", result: "Command failed: exit 1" });
  foldEvent(s, { type: "tool_result", name: "read_file", result: "ok contents" });
  assert.equal(s.toolErrors, 1);
});
test("foldEvent attributes the test command pass/fail by the RESULT's own command", () => {
  const pass = newRunSignals();
  foldEvent(pass, { type: "tool_result", name: "run_shell", args: { command: "npm test -- --run" }, result: "All tests passed" }, "npm test");
  assert.equal(pass.testRan, true);
  assert.equal(pass.testFailed, false);

  const fail = newRunSignals();
  foldEvent(fail, { type: "tool_result", name: "run_shell", args: { command: "npm test" }, result: "Command failed: 2 failing" }, "npm test");
  assert.equal(fail.testFailed, true);
});

// Adversarial-found regression: a turn with a FAILING non-test shell AND a PASSING
// test must NOT mis-attribute the failure as a test failure. The agent runs tool
// calls in PARALLEL, so attribution is per-result (by the result's own command),
// never "the next run_shell result".
test("a failing non-test shell is not mis-attributed as a test failure (no spurious BLOCK)", () => {
  const s = newRunSignals();
  foldEvent(s, { type: "tool_result", name: "run_shell", args: { command: "rm /nope" }, result: "Command failed: no such file" }, "npm test");
  foldEvent(s, { type: "tool_result", name: "run_shell", args: { command: "npm test" }, result: "ok — all passed" }, "npm test");
  assert.equal(s.testRan, true);
  assert.equal(s.testFailed, false); // the TEST passed; the rm failure is only a toolError
  assert.equal(s.toolErrors, 1);
  assert.equal(computeVerdict({ ...s, loopExit: "done", verifier: "PASS" }).verdict, "PASS"); // not a spurious BLOCK
});
test("foldEvent records loopExit from the state event and verdict from the verifier", () => {
  const s = newRunSignals();
  foldEvent(s, { type: "state", state: "loop_done", loopExit: "exhausted" });
  foldEvent(s, { type: "verdict", verdict: "pass", independent: true });
  assert.equal(s.loopExit, "exhausted");
  assert.equal(s.verifier, "PASS");
  assert.equal(s.verifierIndependent, true);
});

// ── offline re-derivation: a verdict is reproducible from a logged event array ──
test("verdictFromEvents re-derives a verdict offline from an event log", () => {
  const events = [
    { type: "state", state: "running" },
    { type: "tool_call", name: "edit_file", args: { path: "a.js" } },
    { type: "tool_result", name: "edit_file", result: "Edited a.js — 1 replacement." },
    { type: "state", state: "loop_done", loopExit: "done" },
    { type: "verdict", verdict: "PASS", independent: true },
  ];
  const a = verdictFromEvents(events);
  const b = verdictFromEvents(events);
  assert.equal(a.verdict, "PASS");
  assert.deepEqual(a.signals, b.signals); // deterministic
});

// ── runSummary: the event-derived "what changed / tested / unverified" ──
test("runSummary derives changed/tested/unverified from signals, not prose", () => {
  const s = sig({ loopExit: "done", edits: 2, testRan: false, verifier: null });
  const r = runSummary(s);
  assert.equal(r.verdict, "HOLD");
  assert.match(r.changed, /2 edits/);
  assert.match(r.tested, /not run/);
  assert.ok(r.unverified.some((u) => /cross-provider/.test(u)));
  assert.ok(r.unverified.some((u) => /no test command/.test(u)));
});

// ── offline replay: the verdict persists to the session and re-derives offline ──
test("a run's verdict round-trips through the session log and re-derives offline", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-verdict-"));
  const prevXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = tmp; // sandbox the sessions dir
  try {
    const s = startSession({ root: tmp, spec: "p/m", task: "fix the bug" });
    // The exact record cmdRun appends after a run.
    const signals = sig({ loopExit: "done", edits: 2, verifier: "PASS", verifierIndependent: true });
    const { verdict, reason } = computeVerdict(signals);
    s.append({ type: "msg", role: "assistant", content: "", toolCalls: [{ id: "1", name: "edit_file", args: {} }] });
    s.append({ type: "verdict", verdict, reason, signals, ms: 1234 });
    const loaded = loadSession(s.id);
    assert.ok(loaded, "session loads");
    assert.ok(loaded.verdict, "verdict record captured offline");
    assert.equal(loaded.verdict.verdict, "PASS");
    // Re-derive from the stored signals — same pure function, no provider call.
    const rederived = computeVerdict(loaded.verdict.signals);
    assert.equal(rederived.verdict, loaded.verdict.verdict); // deterministic, event-derived
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prevXdg;
  }
});

test("isErrorResult matches the agent's error grammar", () => {
  assert.ok(isErrorResult("Tool error: boom"));
  assert.ok(isErrorResult("Command failed: 1"));
  assert.ok(isErrorResult("git diff failed — not a repo"));
  assert.ok(!isErrorResult("Edited a.js — 1 replacement."));
  assert.ok(!isErrorResult(""));
});
