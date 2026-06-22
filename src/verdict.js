// verdict.js — the run-level verdict state machine. PASS / HOLD / BLOCK, derived
// DETERMINISTICALLY from REAL outcomes — tool errors, the project's test command,
// the cross-provider verifier verdict, and how the agent loop ended — NEVER from
// model prose. Pure and side-effect-free, so the same event stream always yields
// the same verdict, and a verdict can be RE-DERIVED offline from a session's
// logged events (the receipt renders from these signals, not from a summary a
// model wrote about itself).
//
// The three states are HONEST, not optimistic:
//   PASS  — the run completed AND either there was nothing to verify (no code
//           changed) or a REAL positive check confirmed it (cross-provider verifier
//           PASS, or the project's test command ran green) — and nothing negative
//           was observed.
//   HOLD  — the run could not be CONFIRMED: the step budget was exhausted, the
//           agent stopped early (stuck), the verifier raised concerns or couldn't
//           complete, or code was changed but never independently verified/tested.
//           "I did the work; I can't prove it's right." Step-exhaustion is HOLD,
//           never a silent success.
//   BLOCK — a REAL negative was observed: the verifier FAILED the change, or the
//           project's declared test command FAILED.
//
// PASS is never asserted without a real positive signal: an unverified, un-tested
// code change completes as HOLD, not a silent green.

export const VERDICTS = Object.freeze(["PASS", "HOLD", "BLOCK"]);

// A fresh signal accumulator. Every field is filled by FOLDING the agent's event
// stream (foldEvent), so the verdict is exactly as auditable as the events.
export function newRunSignals() {
  return {
    loopExit: null,            // "done" | "stuck" | "exhausted" — how the agent loop ended
    edits: 0,                  // count of write/edit tool calls (did the run change code?)
    toolErrors: 0,             // tool_result events classified as failures (unrecovered)
    testRan: false,            // the project's declared test command was executed
    testFailed: null,          // true/false once a test command ran; null if none ran
    verifier: null,            // "PASS" | "CONCERNS" | "FAIL" | null — cross-provider verdict
    verifierIndependent: null, // true if cross-provider; false if same-provider; null if none
  };
}

const EDIT_TOOLS = new Set(["write_file", "edit_file", "multi_edit"]);
// Mirrors agent.js classifyResult's error grammar: an error-classified tool result.
const ERROR_RE = /^(Tool error|Permission denied|Unknown tool|Missing required|git .*failed|Command failed)|\bfailed:/;
export function isErrorResult(s) { return ERROR_RE.test(String(s == null ? "" : s)); }

// Does this run_shell invocation look like the project's declared test command?
// Loose containment both ways so `npm test` matches `npm test -- --watch=false` etc.
function looksLikeTest(args, testCmd) {
  if (!testCmd) return false;
  const cmd = String((args && (args.command ?? args.cmd)) || "").toLowerCase().trim();
  const t = String(testCmd).toLowerCase().trim();
  return !!cmd && (cmd === t || cmd.includes(t) || t.includes(cmd));
}

// Fold ONE event into the signals (mutates + returns sig). `testCmd` (optional, from
// nomos.json's commands.test) lets a test run's pass/fail be attributed. Test
// attribution matches a run_shell RESULT to its OWN command (the agent runs a
// turn's tool calls in PARALLEL, so "the next result" would mis-pair a failing
// non-test shell onto the test). The dominant signals are loopExit + verifier +
// toolErrors, all always reliable.
export function foldEvent(sig, ev, testCmd = null) {
  if (!sig || !ev || typeof ev !== "object") return sig;
  switch (ev.type) {
    case "tool_call":
      if (EDIT_TOOLS.has(ev.name)) sig.edits++;
      break;
    case "tool_result": {
      const failed = isErrorResult(ev.result);
      if (failed) sig.toolErrors++;
      // Attribute against THIS result's own command — never "the next result".
      if (ev.name === "run_shell" && looksLikeTest(ev.args, testCmd)) { sig.testRan = true; sig.testFailed = failed; }
      break;
    }
    case "state":
      if (ev.loopExit) sig.loopExit = ev.loopExit; // "done" | "stuck" | "exhausted"
      break;
    case "verdict": // the cross-provider verifier's verdict (council / verify path)
      if (ev.verdict) sig.verifier = String(ev.verdict).toUpperCase();
      if (typeof ev.independent === "boolean") sig.verifierIndependent = ev.independent;
      break;
  }
  return sig;
}

// Compute the run-level verdict from accumulated signals. Ordered cascade, first
// match wins; the reason names the deciding rule. Pure + deterministic.
export function computeVerdict(sig) {
  const s = sig || newRunSignals();
  // Plain-English conditions, so each rule below reads like a sentence.
  const completed = s.loopExit === "done";        // the loop produced a final answer
  const verifierPassed = s.verifier === "PASS";   // a different provider reviewed it and agreed
  const testsPassed = s.testFailed === false;     // the project's test command ran green
  const confirmed = verifierPassed || testsPassed; // a REAL positive check happened

  // BLOCK — a real negative was observed.
  if (s.verifier === "FAIL") return { verdict: "BLOCK", reason: "the cross-provider verifier FAILED the change" };
  if (s.testFailed === true) return { verdict: "BLOCK", reason: "the project's test command FAILED" };

  // HOLD — could not be confirmed (step-exhaustion is HOLD, never a silent success).
  if (s.loopExit === "exhausted") return { verdict: "HOLD", reason: "step budget exhausted before a final answer" };
  if (s.loopExit === "stuck") return { verdict: "HOLD", reason: "stopped early — repeated the same action with no progress" };
  if (s.verifier === "CONCERNS") return { verdict: "HOLD", reason: "the cross-provider verifier raised concerns" };
  if (s.edits > 0 && !confirmed) return { verdict: "HOLD", reason: "code changed but not independently verified or tested" };
  if (s.toolErrors > 0 && !verifierPassed) return { verdict: "HOLD", reason: `${s.toolErrors} tool failure${s.toolErrors > 1 ? "s" : ""} during the run` };

  // PASS — completed, no negatives, and either nothing to verify or a real positive check.
  if (completed) {
    const why = verifierPassed ? "cross-provider verifier agreed"
      : testsPassed ? "the project's tests passed"
      : "completed with no code changes to verify";
    return { verdict: "PASS", reason: why };
  }
  return { verdict: "HOLD", reason: "run did not reach a confirmed completion" };
}

// Convenience: fold a whole event array, then compute. Used by offline replay so a
// verdict is RE-DERIVED from logged events with zero provider calls (boundary:
// replay must work offline; receipt renders from events).
export function verdictFromEvents(events, testCmd = null) {
  const sig = newRunSignals();
  for (const ev of (events || [])) foldEvent(sig, ev, testCmd);
  return { signals: sig, ...computeVerdict(sig) };
}

// The event-derived run summary that renders on the receipt / live surface —
// "what changed, what was tested, what remains UNVERIFIED" — all from signals,
// never from model prose.
export function runSummary(sig) {
  const s = sig || newRunSignals();
  const { verdict, reason } = computeVerdict(s);
  const changed = s.edits > 0 ? `${s.edits} edit${s.edits > 1 ? "s" : ""}` : "no code changes";
  const tested = s.testRan ? (s.testFailed ? "tests FAILED" : "tests passed") : "tests not run";
  const unverified = [];
  if (s.edits > 0 && s.verifier !== "PASS") unverified.push("changes not confirmed by a cross-provider review");
  if (s.edits > 0 && !s.testRan) unverified.push("no test command was run");
  if (s.loopExit === "exhausted") unverified.push("agent did not finish within the step budget");
  if (s.loopExit === "stuck") unverified.push("agent stopped early (stuck)");
  if (s.verifier === "CONCERNS") unverified.push("verifier raised concerns");
  if (s.toolErrors > 0) unverified.push(`${s.toolErrors} tool failure${s.toolErrors > 1 ? "s" : ""} occurred`);
  return { verdict, reason, changed, tested, unverified };
}
