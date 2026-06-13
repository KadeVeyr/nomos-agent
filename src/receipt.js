// Receipt — the differentiator. A NOMOS receipt is a portable, hashable artifact
// proving that a task's answer was checked by a DIFFERENT provider acting as an
// adversarial verifier. OpenCode and Hermes run agents; neither emits a
// cross-provider verification receipt as a native primitive. The receipt is the
// headline: "ship the irreversible thing — here's proof an independent adversary
// checked it." The council that produces it is the mechanism, not the pitch.
//
// A receipt contains NO secrets — only models, the task, the outputs, the
// verdict, and a content hash. It is safe to commit / hand to a third party.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const RECEIPT_VERSION = "0.1";

function receiptDir(root) {
  return path.join(root, ".nomos", "receipts");
}

// Build a receipt object from a finished proposer→verifier run. `ts` is supplied
// by the caller (ISO string) so this stays pure/deterministic for the hash.
export function makeReceipt({ task, proposer, verifier, ts }) {
  const crossProvider = proposer.provider !== verifier.provider;
  const verdict = verifier.verdict || "UNKNOWN";
  // The hash binds the three load-bearing fields: a tampered task, answer, or
  // verifier reasoning changes the id. Canonical key order, stable stringify.
  const canonical = JSON.stringify({
    v: RECEIPT_VERSION,
    task,
    proposer_output: proposer.output,
    verifier_verdict: verdict,
    verifier_reasoning: verifier.reasoning,
    cross_provider: crossProvider,
  });
  const hash = crypto.createHash("sha256").update(canonical).digest("hex");
  return {
    nomos_receipt: RECEIPT_VERSION,
    id: hash.slice(0, 12),
    created: ts,
    task,
    proposer: { model: proposer.model, provider: proposer.provider, output: proposer.output, steps: proposer.steps ?? null },
    verifier: { model: verifier.model, provider: verifier.provider, verdict, reasoning: verifier.reasoning },
    cross_provider: crossProvider,
    verdict,
    hash,
  };
}

export function writeReceipt(root, receipt) {
  const dir = receiptDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${receipt.id}.json`);
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2));
  return file;
}

// Verify a receipt on disk hasn't been tampered with: recompute the hash from
// its load-bearing fields and compare. Returns true if intact.
export function verifyReceiptHash(receipt) {
  const canonical = JSON.stringify({
    v: receipt.nomos_receipt,
    task: receipt.task,
    proposer_output: receipt.proposer?.output,
    verifier_verdict: receipt.verifier?.verdict,
    verifier_reasoning: receipt.verifier?.reasoning,
    cross_provider: receipt.cross_provider,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex") === receipt.hash;
}

// Human-readable one-block summary for the terminal.
export function renderReceipt(r) {
  const mark = r.verdict === "PASS" ? "\x1b[32m✓\x1b[0m" : r.verdict === "FAIL" ? "\x1b[31m✗\x1b[0m" : "\x1b[33m‼\x1b[0m";
  const cross = r.cross_provider ? "\x1b[32mcross-provider\x1b[0m" : "\x1b[31m⚠ SAME provider — not independent\x1b[0m";
  return [
    `\x1b[2m──\x1b[0m NOMOS receipt \x1b[1m${r.id}\x1b[0m \x1b[2m──\x1b[0m`,
    `  proposer : ${r.proposer.model}`,
    `  verifier : ${r.verifier.model}  (${cross})`,
    `  verdict  : ${mark} \x1b[1m${r.verdict}\x1b[0m`,
    `  hash     : ${r.hash.slice(0, 16)}…`,
  ].join("\n");
}
