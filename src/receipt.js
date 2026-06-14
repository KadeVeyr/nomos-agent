// Receipt — the differentiator. A NOMOS receipt is a portable, hashable artifact
// proving that a task's answer was checked by a DIFFERENT provider acting as an
// adversarial verifier. OpenCode and Hermes run agents; neither emits a
// cross-provider verification receipt as a native primitive. The receipt is the
// headline: "ship the irreversible thing — here's proof an independent adversary
// checked it." The cross-provider check that produces it is the mechanism.
//
// A receipt contains NO secrets — only models, the task, the outputs, the
// verdict, and a content hash. It is safe to commit / hand to a third party.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const RECEIPT_VERSION = "0.2"; // 0.2 binds the proposer/verifier MODEL+PROVIDER (not just the verdict) into the hash

function receiptDir(root) {
  return path.join(root, ".nomos", "receipts");
}

// The canonical pre-image the hash signs — every trust-bearing field in a fixed
// key order. BOTH make and verify go through this one function, so they can
// never drift. `steps`/`created`/`id`/top-level `verdict` are convenience/derived
// fields and are deliberately NOT signed here (id+verdict are consistency-checked
// against the signed source in verifyReceiptHash instead).
export function canonicalReceipt(r) {
  return JSON.stringify({
    v: r.nomos_receipt,
    task: r.task ?? null,
    proposer_model: r.proposer?.model ?? null,
    proposer_provider: r.proposer?.provider ?? null,
    proposer_output: r.proposer?.output ?? null,
    verifier_model: r.verifier?.model ?? null,
    verifier_provider: r.verifier?.provider ?? null,
    verifier_verdict: r.verifier?.verdict ?? null,
    verifier_reasoning: r.verifier?.reasoning ?? null,
    cross_provider: r.cross_provider ?? null,
  });
}

// Build a receipt object from a finished proposer→verifier run. `ts` is supplied
// by the caller (ISO string) so this stays pure/deterministic for the hash.
export function makeReceipt({ task, proposer, verifier, ts }) {
  const crossProvider = proposer.provider !== verifier.provider;
  const verdict = verifier.verdict || "UNKNOWN";
  // The hash binds every trust-bearing field — WHO proposed, WHO verified, with
  // what verdict and reasoning, over what task/output, and whether it was truly
  // cross-provider. Tampering with any (incl. swapping the verifier model to a
  // more authoritative one, or flipping the verdict) changes the id.
  const signed = {
    nomos_receipt: RECEIPT_VERSION,
    task,
    proposer: { model: proposer.model, provider: proposer.provider, output: proposer.output },
    verifier: { model: verifier.model, provider: verifier.provider, verdict, reasoning: verifier.reasoning },
    cross_provider: crossProvider,
  };
  const hash = crypto.createHash("sha256").update(canonicalReceipt(signed)).digest("hex");
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

// Verify a receipt hasn't been tampered with: recompute the hash over its
// trust-bearing fields and compare, AND check the denormalized display fields
// (top-level verdict, id) still agree with the signed source — otherwise flipping
// the convenience copies would slip past the hash. Returns true only if intact.
export function verifyReceiptHash(receipt) {
  const r = receipt || {};
  const hashOk = crypto.createHash("sha256").update(canonicalReceipt(r)).digest("hex") === r.hash;
  // Denormalized/derived fields must agree with their source. cross_provider is
  // RE-DERIVED from the two providers (not just trusted from the field), so a
  // forged "cross_provider:true with the same provider" is caught even if the
  // hash was recomputed. (The hash itself is keyless content-addressing, not a
  // signature — it proves a receipt matches its id, not who authored it.)
  const consistent =
    r.verdict === r.verifier?.verdict &&
    r.id === String(r.hash || "").slice(0, 12) &&
    r.cross_provider === (r.proposer?.provider !== r.verifier?.provider);
  return hashOk && consistent;
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
