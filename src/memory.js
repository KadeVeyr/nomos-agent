// Memory — file-based, stateful (NOT self-modifying logic).
//
// Nomos keeps a small persistent memory per project in `.nomos/`:
//   .nomos/notes.md           durable notes the agent reads + appends
//   .nomos/sessions/<ts>.jsonl one transcript per run (audit/log)
// The agent loads notes.md into its context at the start of every run, so it
// "remembers across sessions." It never executes memory — memory is data.
//
// PRIVACY: `.nomos/` is gitignored by default (see README/init). Memory and
// logs must never be committed into a public repo.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function memDir(root) {
  return path.join(root, ".nomos");
}

// The agent's OWN evolving lessons live in the GLOBAL data dir — outside any
// repo, so they are never pushed. This is adaptive memory (the agent gets
// better at recurring work by reusing past lessons), NOT self-modifying logic:
// lessons are DATA loaded as guidance; the tool sandbox + refusal rules live in
// code and always win.
function lessonsPath() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "nomos", "lessons.md");
}
const MAX_LESSONS_BYTES = 16 * 1024; // cap growth; trim oldest beyond this

// Redact secret-shaped tokens + emails before anything is persisted to disk.
// Defence-in-depth: memory/logs must never hold a key or an identifying email,
// even if one reaches the agent's context.
const SECRET = /\b(sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|gsk_[A-Za-z0-9]{12,}|sk-or-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Fa-f0-9]{40,})\b/g;
function redact(s) {
  return String(s).replace(SECRET, "[redacted]");
}

export function readNotes(root) {
  try {
    // Redact on READ too (not just on write): if a secret reached the file via a
    // manual edit or an older version, it must not be injected into a provider
    // prompt or printed by `nomos memory`. Defence-in-depth.
    return redact(fs.readFileSync(path.join(memDir(root), "notes.md"), "utf8").trim());
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

// ── Global lessons (the agent's own evolving instructions, cross-project) ──
export function readLessons() {
  try { return redact(fs.readFileSync(lessonsPath(), "utf8").trim()); } catch { return ""; }
}

export function learnLesson(text) {
  const p = lessonsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const line = `- ${redact(String(text).replace(/\s+/g, " ").trim())}\n`;
  let next = readLessons() ? readLessons() + "\n" + line : line;
  if (Buffer.byteLength(next) > MAX_LESSONS_BYTES) {
    const lines = next.split("\n");
    while (Buffer.byteLength(lines.join("\n")) > MAX_LESSONS_BYTES && lines.length > 1) lines.shift();
    next = lines.join("\n");
  }
  fs.writeFileSync(p, next);
  return "learned.";
}

export function clearLessons() {
  try { fs.rmSync(lessonsPath()); return true; } catch { return false; }
}

// Memory tools the agent can call. They close over the working root.
export function memoryTools(root) {
  return [
    {
      name: "remember",
      description: "Save a short durable fact to THIS project's memory; available in future runs here.",
      parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
      run: ({ note }) => appendNote(root, note),
    },
    {
      name: "recall",
      description: "Read all durable notes saved to this project's memory.",
      parameters: { type: "object", properties: {}, required: [] },
      run: () => readNotes(root) || "(no notes yet)",
    },
    {
      name: "learn",
      description: "Save a durable LESSON — a reusable insight, preference, or technique — that should guide your future runs across ALL projects. Use sparingly, for genuinely reusable learnings.",
      parameters: { type: "object", properties: { lesson: { type: "string" } }, required: ["lesson"] },
      run: ({ lesson }) => learnLesson(lesson),
    },
  ];
}
