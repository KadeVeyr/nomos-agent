// Session resume — an append-only JSONL log of an agent run, so a crashed or
// step/timeout-capped long run can be replayed and CONTINUED (`nomos resume <id>`).
//
// One file per session: ~/.local/share/nomos/sessions/<id>.jsonl (honours
// XDG_DATA_HOME). Line 1 is a `meta` record (model, task, root, the resolved
// system prompt, created-ts); each subsequent line is one provider-neutral message
// as it was appended; a final `done` record marks a clean finish. Append-only — the
// file is never rewritten, so a crash can only ever truncate the LAST line.
//
// On resume the log is reconstructed crash-safely: parse line-by-line, treat the
// first unparseable line as end-of-file (a torn final write), then RECONCILE so the
// replayed conversation is valid for the provider — every assistant tool-call must
// have a matching tool result, or the trailing incomplete turn is dropped and the
// loop regenerates it. The stored system prompt is replayed (the prior turns were
// generated conditioned on it; rebuilding could contradict them).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export function sessionsDir() {
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "nomos", "sessions");
}

// Sortable (timestamp-prefixed) + collision-resistant, zero-dep.
export function makeSessionId() {
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  return `${ts}-${crypto.randomBytes(4).toString("hex")}`;
}

// Start a new session log. Returns { id, file, append(record) }. The append
// closure writes one JSONL line per call (synchronous, line-buffered → a crash
// can only truncate the last line).
export function startSession({ root, spec, task, system }) {
  const id = makeSessionId();
  const dir = sessionsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + ".jsonl");
  const append = (record) => { try { fs.appendFileSync(file, JSON.stringify(record) + "\n"); } catch { /* best effort */ } };
  append({ type: "meta", id, spec, task, root, system, created: new Date().toISOString() });
  return { id, file, append };
}

// A message-appender bound to an existing session file (used on resume so a
// resumed run keeps logging to the SAME file and is itself resumable).
export function appenderFor(file) {
  return (record) => { try { fs.appendFileSync(file, JSON.stringify(record) + "\n"); } catch { /* best effort */ } };
}

// Drop the trailing incomplete turn: if the last assistant message has tool-calls
// whose results aren't all present, remove it (and any partial tool messages after
// it) so the replayed conversation is provider-valid and the loop regenerates it.
function reconcile(messages) {
  let lastAsst = -1;
  for (let i = messages.length - 1; i >= 0; i--) { if (messages[i].role === "assistant") { lastAsst = i; break; } }
  if (lastAsst === -1) return messages;
  const asst = messages[lastAsst];
  if (!asst.toolCalls || !asst.toolCalls.length) return messages; // final answer — complete
  const resultIds = new Set(messages.slice(lastAsst + 1).filter((m) => m.role === "tool").map((m) => m.toolCallId));
  const resolved = asst.toolCalls.every((tc) => resultIds.has(tc.id));
  return resolved ? messages : messages.slice(0, lastAsst); // drop the dangling turn
}

// Load + crash-safely reconstruct a session. Returns { id, file, spec, task, root,
// system, messages, done } or null if the file/meta is missing. `messages` is a
// provider-valid conversation ready to continue; `done` is true if the run already
// finished (last turn is a final assistant answer, or a `done` record was logged).
export function loadSession(id) {
  const file = path.join(sessionsDir(), id.endsWith(".jsonl") ? id : id + ".jsonl");
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch { return null; }
  let meta = null; const messages = []; let doneRecord = false;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec; try { rec = JSON.parse(line); } catch { break; } // first torn line = EOF
    if (rec.type === "meta") meta = rec;
    else if (rec.type === "done") doneRecord = true;
    else if (rec.type === "msg" && rec.role) messages.push({ role: rec.role, content: rec.content ?? "", ...(rec.toolCalls ? { toolCalls: rec.toolCalls } : {}), ...(rec.toolCallId ? { toolCallId: rec.toolCallId } : {}) });
  }
  if (!meta) return null;
  const reconciled = reconcile(messages);
  const last = reconciled[reconciled.length - 1];
  const done = doneRecord || (last && last.role === "assistant" && !(last.toolCalls && last.toolCalls.length));
  return { id: meta.id, file, spec: meta.spec, task: meta.task, root: meta.root, system: meta.system, messages: reconciled, done };
}

// Recent sessions, newest first: { id, task, turns, when, done }.
export function listSessions(limit = 20) {
  let files;
  try { files = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith(".jsonl")); } catch { return []; }
  return files.sort().reverse().slice(0, limit).map((f) => {
    const s = loadSession(f);
    return s ? { id: s.id, task: String(s.task || "").slice(0, 60), turns: s.messages.length, done: s.done } : null;
  }).filter(Boolean);
}
