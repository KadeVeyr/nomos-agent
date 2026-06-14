// Seat runner — fire a directive at a provider and capture a structured,
// auditable transcript. Calls the provider API DIRECTLY — no subprocess, no TUI,
// no PTY, no permission prompt — so it cannot hang the way a scripted TUI agent
// does. NOT an agent loop — a deterministic directive→transcript runner.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { chat } from "./gateway.js";
import { resolveModel } from "./providers.js";

export const TRANSCRIPT_VERSION = "0.1";

// Extract the FINAL sentinel-bounded block (never the first — that's the
// directive-echo trap). Primary form is `=== X START === … === X END ===`
// (matched marker); a relaxed fallback handles MISMATCHED wrappers seen in
// practice (e.g. `=== REVIEW START === … ===SEAT-END===`) so a real verdict
// block isn't missed just because the closer's name differs from the opener's.
export function extractFinalSentinel(text) {
  const s = String(text || "");
  // The marker is a short single-line label: bounding it to [^\n=]{1,200}? (no
  // '=', no newline) keeps the match LINEAR — an unbounded (.+?) backtracks
  // quadratically across a long `===…` divider line (a real ReDoS / event-loop
  // stall) and can absorb a stray `===`/newline into a junk marker.
  // 1. Strict: === X START === … === X END === with the SAME marker (back-ref).
  //    Take the LAST such block — the first is the directive-echo trap.
  const strict = /===\s*([^\n=]{1,200}?)\s+START\s*===\r?\n([\s\S]*?)\r?\n===\s*\1\s+END\s*===/g;
  let m, last = null;
  while ((m = strict.exec(s)) !== null) last = { marker: m[1].trim(), body: m[2].trim() };
  if (last) return last;
  // 2. Relaxed fallback for MISMATCHED wrappers (e.g. === REVIEW START === …
  //    ===SEAT-END===). Last opener (leading-echo safe). A closer is END as a
  //    STANDALONE token — preceded by ===, whitespace, or '-' — so "FRONTEND" /
  //    "APPEND" don't false-close; SEAT-END / X END / === END === do.
  const openers = [...s.matchAll(/===\s*([^\n=]{1,200}?)\s+START\s*===/g)];
  const closers = [...s.matchAll(/===\s*(?:[A-Za-z0-9 ._-]*[ \-])?END\s*===/g)];
  if (openers.length && closers.length) {
    const open = openers[openers.length - 1];
    const openEnd = open.index + open[0].length;
    const after = closers.filter((c) => c.index >= openEnd);
    // Prefer the FIRST canonical terminal closer (===SEAT-END=== / === END ===):
    // skips an in-body "=== STEP END ===" so the verdict isn't truncated, and
    // first-canonical avoids over-capturing trailing content. Else first any-END.
    const close = after.find((c) => /===\s*(?:SEAT-)?END\s*===/i.test(c[0])) || after[0];
    if (close) return { marker: open[1].trim(), body: s.slice(openEnd, close.index).trim() };
  }
  return null; // { marker, body } or null
}

// Deterministic context packing: an ALLOWLIST of explicit files, packed in a
// stable (sorted) order up to a byte cap, so a big repo can never drown a seat.
// Returns { block, audit } where audit = [{ path, bytes, included, reason }].
// No globbing, no recursion — explicit paths only (auditable by construction).
export function packContext(files = [], maxBytes = 100000, root = process.cwd()) {
  const audit = [];
  const blocks = [];
  let used = 0;
  for (const rel of [...new Set(files)].sort()) {
    let content;
    try {
      content = fs.readFileSync(path.resolve(root, rel), "utf8");
    } catch (e) {
      audit.push({ path: rel, bytes: 0, included: false, reason: e.code === "ENOENT" ? "not found" : "unreadable" });
      continue;
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (used + bytes > maxBytes) {
      audit.push({ path: rel, bytes, included: false, reason: "byte cap" });
      continue;
    }
    used += bytes;
    blocks.push(`### FILE: ${rel}\n\`\`\`\n${content}\n\`\`\``);
    audit.push({ path: rel, bytes, included: true, reason: "ok" });
  }
  return { block: blocks.length ? `REPOSITORY CONTEXT (read-only, provided — do not assume anything else exists):\n\n${blocks.join("\n\n")}\n\n` : "", audit };
}

// runSeat: directive in → transcript out. `deps` lets tests inject the model call.
export async function runSeat({ directive, spec, timeoutMs = 120000, context = null, maxTokens, minBytes = 0 }, deps = {}) {
  const _chat = deps.chat || chat;
  const _now = deps.now || (() => new Date().toISOString());
  const _hrtime = deps.hrtime || (() => Number(process.hrtime.bigint() / 1000000n));

  const { providerId, model } = resolveModel(spec);
  const run_id = (deps.run_id || crypto.randomBytes(6).toString("hex"));
  const started_at = _now();
  const t0 = _hrtime();

  // Pack allowlisted context (if any) BEFORE the directive — deterministic + audited.
  const packed = context && context.files && context.files.length
    ? packContext(context.files, context.maxBytes ?? 100000, context.root ?? process.cwd())
    : { block: "", audit: [] };
  const prompt = packed.block + directive;

  const controller = new AbortController();
  let timed_out = false;
  const timer = setTimeout(() => { timed_out = true; controller.abort(); }, timeoutMs);

  let status, exit_code, output = "", error = null;
  try {
    const res = await _chat({ spec, messages: [{ role: "user", content: prompt }], tools: [], signal: controller.signal, maxTokens });
    output = String(res?.content || "").trim();
    const bytes = Buffer.byteLength(output, "utf8");
    // empty → hard fail; non-empty but below an opt-in floor → "thin" (a
    // suspiciously short / near-empty reply isn't silently a clean fire — the
    // inverse of the max-tokens truncation guard); otherwise ok.
    if (!output) { status = "empty"; exit_code = 1; error = "provider returned no content"; }
    else if (minBytes > 0 && bytes < minBytes) { status = "thin"; exit_code = 1; error = `output below floor: ${bytes}b < ${minBytes}b`; }
    else { status = "ok"; exit_code = 0; }
  } catch (e) {
    if (timed_out) { status = "timeout"; exit_code = 124; error = "timed out"; }
    else { status = "provider_error"; exit_code = 1; error = e?.message || "provider call failed"; } // sanitized — gateway strips bodies
  } finally {
    clearTimeout(timer);
  }

  const ended_at = _now();
  return {
    nomos_transcript: TRANSCRIPT_VERSION,
    run_id,
    spec, provider: providerId, model,
    started_at, ended_at, duration_ms: _hrtime() - t0,
    status,          // ok | empty | thin | timeout | provider_error
    exit_code,       // 0 only when status === "ok"
    timed_out,
    output,
    output_bytes: Buffer.byteLength(output, "utf8"),
    final_block: extractFinalSentinel(output), // {marker, body} | null — the verdict block
    context_files: packed.audit,               // auditable packing decisions
    error,           // null unless the run failed
  };
}
