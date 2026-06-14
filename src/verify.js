// verify — the second-seat primitive. Take a change ANOTHER tool made (Claude
// Code, Cursor, Copilot, a teammate) as a git diff, and have ONE independent
// model adversarially review it, emitting a receipt. The proposer is "external"
// (whatever produced the change), so you bring just ONE key — Nomos is the
// second opinion, not the author.

import { execFile } from "node:child_process";
import { chat } from "./gateway.js";
import { resolveModel } from "./providers.js";
import { parseVerdict } from "./council.js";
import { makeReceipt } from "./receipt.js";

export const VERIFY_SYSTEM = `You are an INDEPENDENT code reviewer — a second opinion on a change another AI tool (Claude Code, Cursor, Copilot) or person just made. You did NOT write it. Your job is to catch what's wrong: bugs, broken logic, edge cases, security issues, things that won't compile or pass tests, or changes that don't do what they claim. Be specific and skeptical; an unsupported "looks fine" is a CONCERNS, not a PASS.

Reply in EXACTLY this shape (verdict on the first line):
VERDICT: PASS | CONCERNS | FAIL
<specific reasoning — name what is wrong or, if it holds, precisely why>

PASS = correct, complete, safe. CONCERNS = works but has real issues you must name. FAIL = wrong, unsafe, or broken.`;

// Get the change to verify as a unified diff. `against` overrides; else staged
// or working-tree changes. deps.execFile lets tests inject.
export function getDiff({ root = process.cwd(), staged = false, against = null } = {}, deps = {}) {
  const run = deps.execFile || execFile;
  const args = against ? ["diff", against] : staged ? ["diff", "--cached"] : ["diff"];
  return new Promise((resolve, reject) => {
    run("git", args, { cwd: root, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error("git diff failed — is this a git repository? " + (err.message || "")));
      resolve(String(stdout || ""));
    });
  });
}

// Verify a diff with ONE model. Returns { receipt, verdict, reasoning }.
export async function runVerify({ diff, spec, source = "your editor", timeoutMs = 120000, maxTokens, prev = null }, deps = {}) {
  const _chat = deps.chat || chat;
  const now = deps.now || (() => new Date().toISOString());
  const { providerId } = resolveModel(spec);

  const controller = new AbortController();
  let timed_out = false;
  const timer = setTimeout(() => { timed_out = true; controller.abort(); }, timeoutMs);
  let content;
  try {
    const res = await _chat({
      spec,
      messages: [
        { role: "system", content: VERIFY_SYSTEM },
        { role: "user", content: `A change was produced by another tool (${source}). Review it independently.\n\nUNIFIED DIFF:\n${String(diff).slice(0, 60000)}` },
      ],
      tools: [],
      signal: controller.signal,
      maxTokens,
    });
    content = res?.content || "";
  } catch (e) {
    // Terminal-status guarantee (parity with runSeat): a verifier timeout or
    // error NEVER throws out of runVerify. We still emit a receipt, recording
    // that the second opinion could not be obtained — as CONCERNS, so it neither
    // falsely PASSes nor hard-FAILs (which would gate CI) on an infra hiccup.
    const reason = timed_out
      ? `verifier did not complete: timed out after ${timeoutMs}ms`
      : `verifier call did not complete: ${e?.message || "error"}`; // sanitized — gateway strips bodies
    content = `VERDICT: CONCERNS\n${reason}`;
  } finally {
    clearTimeout(timer);
  }

  const { verdict, reasoning } = parseVerdict(content);
  // The "proposer" is whatever external tool wrote the change; Nomos is the
  // independent verifier. cross_provider is true by construction (external ≠ nomos provider).
  const receipt = makeReceipt({
    task: `independent review of a change (${source})`,
    proposer: { model: source, provider: "external", output: diff },
    verifier: { model: spec, provider: providerId, verdict, reasoning },
    ts: now(),
    prev, // chain link, supplied by the caller (which knows the receipt dir)
  });
  return { receipt, verdict, reasoning };
}
