// Memory — file-based, stateful (NOT self-modifying logic).
//
// Nomos keeps a small persistent memory per project in `.nomos/`:
//   .nomos/notes.md           durable notes the agent reads + appends
//   .nomos/sessions/<ts>.jsonl one transcript per run (audit/log)
// The agent loads notes.md into its context at the start of every run, so it
// "remembers across sessions." It never executes memory — memory is data.
//
// KADE FIREWALL: `.nomos/` is gitignored by default (see README/init). Memory
// and logs must never be committed into a public repo.

import fs from "node:fs";
import path from "node:path";

function memDir(root) {
  return path.join(root, ".nomos");
}

// Redact secret-shaped tokens + emails before anything is persisted to disk.
// Defence-in-depth for the Kade firewall: memory/logs must never hold a key
// or an identifying email, even if one reaches the agent's context.
const SECRET = /\b(sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|gsk_[A-Za-z0-9]{12,}|sk-or-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Fa-f0-9]{40,})\b/g;
function redact(s) {
  return String(s).replace(SECRET, "[redacted]");
}

export function readNotes(root) {
  try {
    return fs.readFileSync(path.join(memDir(root), "notes.md"), "utf8").trim();
  } catch {
    return "";
  }
}

export function appendNote(root, text) {
  const dir = memDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const line = `- ${redact(String(text).replace(/\s+/g, " ").trim())}\n`;
  fs.appendFileSync(path.join(dir, "notes.md"), line);
  return "noted.";
}

export function clearNotes(root) {
  try { fs.rmSync(path.join(memDir(root), "notes.md")); return true; } catch { return false; }
}

// Append a run record. `ts` is supplied by the caller (no Date in hot path here
// is unnecessary — this is fine, but kept simple and explicit).
export function logRun(root, record) {
  try {
    const dir = path.join(memDir(root), "sessions");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = record.ts || new Date().toISOString().replace(/[:.]/g, "-");
    const safe = { ...record, task: redact(record.task || ""), result: redact(record.result || "") };
    fs.appendFileSync(path.join(dir, `${stamp}.jsonl`), JSON.stringify(safe) + "\n");
  } catch {
    /* logging must never break a run */
  }
}

// Memory tools the agent can call. They close over the working root.
export function memoryTools(root) {
  return [
    {
      name: "remember",
      description: "Save a short durable note to project memory; it will be available in future runs.",
      parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
      run: ({ note }) => appendNote(root, note),
    },
    {
      name: "recall",
      description: "Read all durable notes saved to project memory.",
      parameters: { type: "object", properties: {}, required: [] },
      run: () => readNotes(root) || "(no notes yet)",
    },
  ];
}
