import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// isolate session files to a temp dir (sessionsDir reads XDG_DATA_HOME each call)
process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-sess-"));
const { startSession, loadSession, listSessions } = await import("../src/session.js");

test("session round-trip: meta + messages reconstruct; done detected", () => {
  const s = startSession({ root: "/r", spec: "a/x", task: "do the thing" });
  s.append({ type: "msg", role: "system", content: "SYS" });
  s.append({ type: "msg", role: "user", content: "do the thing" });
  s.append({ type: "msg", role: "assistant", content: "ok", toolCalls: [{ id: "c1", name: "t", args: {} }] });
  s.append({ type: "msg", role: "tool", toolCallId: "c1", content: "result" });
  s.append({ type: "msg", role: "assistant", content: "done" });
  s.append({ type: "done", ts: "2020" });
  const L = loadSession(s.id);
  assert.equal(L.spec, "a/x"); assert.equal(L.task, "do the thing"); assert.equal(L.root, "/r");
  assert.equal(L.messages.length, 5);
  assert.equal(L.messages[2].toolCalls[0].id, "c1");
  assert.equal(L.done, true);
});

test("crash-safety: a torn final line is treated as EOF and dropped", () => {
  const s = startSession({ root: "/r", spec: "a/x", task: "t" });
  s.append({ type: "msg", role: "user", content: "hi" });
  fs.appendFileSync(s.file, '{"type":"msg","role":"assist'); // half-written line (crash mid-write)
  const L = loadSession(s.id);
  assert.equal(L.messages.length, 1); // only the clean user msg survives
  assert.equal(L.done, false);
});

test("reconcile: a DANGLING assistant tool-call turn is dropped (provider-valid resume)", () => {
  const s = startSession({ root: "/r", spec: "a/x", task: "t" });
  s.append({ type: "msg", role: "system", content: "S" });
  s.append({ type: "msg", role: "user", content: "u" });
  s.append({ type: "msg", role: "assistant", content: "calling a tool", toolCalls: [{ id: "c1", name: "t", args: {} }] }); // crashed before the result
  const L = loadSession(s.id);
  assert.equal(L.messages.length, 2); // dangling assistant turn removed
  assert.equal(L.messages[L.messages.length - 1].role, "user");
  assert.equal(L.done, false); // not done — the loop will regenerate this turn
});

test("reconcile: a COMPLETE tool turn is kept", () => {
  const s = startSession({ root: "/r", spec: "a/x", task: "t" });
  s.append({ type: "msg", role: "user", content: "u" });
  s.append({ type: "msg", role: "assistant", content: "call", toolCalls: [{ id: "c1", name: "t", args: {} }] });
  s.append({ type: "msg", role: "tool", toolCallId: "c1", content: "r" });
  const L = loadSession(s.id);
  assert.equal(L.messages.length, 3); // all kept — the tool result is present
  assert.equal(L.done, false); // ends on a tool result → more work to do
});

test("loadSession returns null for an unknown id; listSessions lists recent", () => {
  assert.equal(loadSession("nope-does-not-exist"), null);
  const rows = listSessions();
  assert.ok(rows.length >= 1 && rows[0].id && typeof rows[0].turns === "number");
});
