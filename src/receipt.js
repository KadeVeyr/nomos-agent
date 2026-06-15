// Receipt — the differentiator. A NOMOS receipt is a portable, tamper-EVIDENT,
// offline-re-checkable RECORD that a task's answer was checked by a DIFFERENT
// provider acting as an adversarial verifier. OpenCode and Hermes run agents;
// neither emits a cross-provider verification receipt as a native primitive.
//
// Be precise about what it is (full contract: docs/RECEIPT_SPEC.md). It is NOT a
// signature: the hash is keyless content-addressing, so it proves a receipt
// matches its own id/content and is unaltered since written — NOT who authored it.
// Whoever generates a receipt can fabricate any field and recompute a matching
// hash, so trust in a receipt is trust in its GENERATOR (e.g. your own CI). The
// one thing that can't be flipped without changing the provider strings is
// `cross_provider` (re-derived in verifyReceiptHash). It does not prove which
// model actually ran, nor that the verifier did a thorough (non-rubber-stamp)
// check. Used as a pinnable record from a generator you trust, no other agent
// emits it natively; closing the zero-trust gap (signatures/attestation) is
// future work.
//
// A receipt contains NO secrets — only models, the task, the outputs, the
// verdict, and a content hash. It is safe to commit / hand to a third party.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// The canonical pre-image (canonicalReceipt), the sha256, the 12-hex id, and the
// cross_provider re-derivation are a stable public contract (docs/RECEIPT_SPEC.md)
// — a third party can re-implement the check and verify any receipt offline.
// 1.1 adds `prev_receipt_hash` (the append-only CHAIN — see auditChain); 1.2 adds
// `code_snapshot` (the git state the verdict was rendered against, so a verdict is
// bound to its code). Canonicalization is VERSION-AWARE — each field is in the
// pre-image only for versions that have it, so 1.0 and 1.1 receipts still verify
// unchanged (the locks hold).
export const RECEIPT_VERSION = "1.2";

// The only verdicts a complete receipt may carry. A receipt whose verifier verdict
// is anything else is treated as truncated/malformed (a cut-off verifier reply that
// never reached a verdict must not read as success).
export const VALID_VERDICTS = new Set(["PASS", "FAIL", "CONCERNS"]);

function receiptDir(root) {
  return path.join(root, ".nomos", "receipts");
}

// The canonical pre-image the hash signs — every trust-bearing field in a fixed
// key order. BOTH make and verify go through this one function, so they can
// never drift. `steps`/`created`/`id`/top-level `verdict` are convenience/derived
// fields and are deliberately NOT signed here (id+verdict are consistency-checked
// against the signed source in verifyReceiptHash instead).
export function canonicalReceipt(r) {
  const pre = {
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
  };
  // Version-aware extensions (appended in order so older versions hash unchanged):
  // 1.1+ binds the chain link; 1.2+ binds the code snapshot the verdict was about.
  if (r.nomos_receipt !== "1.0") pre.prev_receipt_hash = r.prev_receipt_hash ?? null;
  if (r.nomos_receipt !== "1.0" && r.nomos_receipt !== "1.1") pre.code_snapshot = r.code_snapshot ?? null;
  return JSON.stringify(pre);
}

// Build a receipt object from a finished proposer→verifier run. `ts` is supplied
// by the caller (ISO string) so this stays pure/deterministic for the hash.
export function makeReceipt({ task, proposer, verifier, ts, prev = null, codeSnapshot = null }) {
  const crossProvider = proposer.provider !== verifier.provider;
  const verdict = verifier.verdict || "UNKNOWN";
  // The hash binds every trust-bearing field — WHO proposed, WHO verified, with
  // what verdict and reasoning, over what task/output, whether it was truly
  // cross-provider, and the PREVIOUS receipt's hash (the chain link). Tampering
  // with any (incl. swapping the verifier model, flipping the verdict, or
  // re-pointing the chain) changes the id.
  const signed = {
    nomos_receipt: RECEIPT_VERSION,
    task,
    proposer: { model: proposer.model, provider: proposer.provider, output: proposer.output },
    verifier: { model: verifier.model, provider: verifier.provider, verdict, reasoning: verifier.reasoning },
    cross_provider: crossProvider,
    prev_receipt_hash: prev ?? null,
    code_snapshot: codeSnapshot ?? null,
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
    prev_receipt_hash: prev ?? null,
    code_snapshot: codeSnapshot ?? null,
    verdict,
    hash,
  };
}

// The hash of the current chain HEAD under root's receipt dir, to pass as `prev`
// when writing the next receipt (so the chain grows). Returns null if there are no
// receipts yet, or if the existing chain is broken — a new receipt then starts a
// fresh genesis rather than linking onto a broken history (the break stays visible
// to `nomos audit`). Best-effort + never throws.
export function headHash(root) {
  try {
    const files = fs.readdirSync(receiptDir(root)).filter((f) => f.endsWith(".json"));
    const receipts = [];
    for (const f of files) { try { receipts.push(JSON.parse(fs.readFileSync(path.join(receiptDir(root), f), "utf8"))); } catch { /* skip */ } }
    if (!receipts.length) return null;
    const res = auditChain(receipts);
    if (!res.ok || !res.head) return null;
    const head = receipts.find((r) => r.id === res.head);
    return head ? head.hash : null;
  } catch { return null; }
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

// Completeness/schema check, INDEPENDENT of the hash. A receipt can be intact
// (hash matches its content) yet incomplete — a truncated verifier reply that
// never reached a verdict, or a missing model/provider id. verifyReceiptHash
// catches tampering; this catches a malformed/cut-off receipt that would
// otherwise read as a valid pass. Returns a list of problems; empty = well-formed.
export function receiptIssues(r) {
  if (!r || typeof r !== "object") return ["receipt is not an object"];
  const issues = [];
  for (const side of ["proposer", "verifier"]) {
    if (!r[side] || typeof r[side] !== "object") { issues.push(`${side} block missing`); continue; }
    if (!r[side].model) issues.push(`${side}.model missing`);
    if (!r[side].provider) issues.push(`${side}.provider missing`);
  }
  if (!VALID_VERDICTS.has(r.verifier?.verdict)) issues.push(`verifier.verdict "${r.verifier?.verdict ?? ""}" is not PASS/FAIL/CONCERNS (truncated or missing verdict)`);
  if (!r.verifier?.reasoning || !String(r.verifier.reasoning).trim()) issues.push("verifier.reasoning is empty (truncated verdict)");
  if (r.task == null || String(r.task).trim() === "") issues.push("task missing");
  if (r.prev_receipt_hash != null && !/^[a-f0-9]{64}$/.test(String(r.prev_receipt_hash))) issues.push("prev_receipt_hash is not null or a 64-hex sha256");
  return issues;
}

// Verify a set of receipts forms ONE valid append-only chain, offline (no provider
// calls). Order is derived ONLY from prev_receipt_hash links — never filename or
// timestamp (both forgeable). Returns { ok, head, length, errors }. Each receipt
// must be intact (verifyReceiptHash) AND complete (receiptIssues); then the chain
// must have exactly one genesis (prev=null), exactly one head, every prev must
// resolve to a present receipt, and there must be no fork, cycle, duplicate, or
// detached entry. 1.0 receipts (no chain link) are ignored here — they verify
// standalone via `nomos receipt verify`.
//
// HONEST SCOPE: this is tamper-EVIDENCE, not authorship. It catches a post-hoc
// insert/delete/reorder/fork by anyone who does NOT control the generator, and
// collapses a whole history into one pinnable head id. It does NOT stop a
// generator from rebuilding the entire chain from scratch — trust in a chain is
// trust in its generator, reduced to trust in one head hash.
export function auditChain(receipts) {
  const errors = [];
  const nodes = [];
  for (const r of (receipts || [])) {
    if (!r || r.nomos_receipt === "1.0") continue; // chain is v1.1+
    if (!verifyReceiptHash(r)) { errors.push(`tampered/inconsistent receipt ${r.id ?? "?"} (hash mismatch)`); continue; }
    const iss = receiptIssues(r);
    if (iss.length) { errors.push(`incomplete receipt ${r.id ?? "?"}: ${iss[0]}`); continue; }
    nodes.push(r);
  }
  if (!nodes.length) return { ok: false, head: null, length: 0, errors: errors.length ? errors : ["no chain-eligible (v1.1+) receipts found"] };

  const byHash = new Map();
  for (const r of nodes) { if (byHash.has(r.hash)) errors.push(`duplicate receipt ${r.id}`); byHash.set(r.hash, r); }

  const childrenOf = new Map(); // prevHash -> [receipts]
  for (const r of nodes) {
    const p = r.prev_receipt_hash ?? null;
    if (p === null) continue;
    if (!byHash.has(p)) errors.push(`missing link: ${r.id} points to absent ${String(p).slice(0, 12)}…`);
    childrenOf.set(p, [...(childrenOf.get(p) || []), r]);
  }
  for (const [p, kids] of childrenOf) if (kids.length > 1) errors.push(`fork at ${String(p).slice(0, 12)}…: ${kids.map((k) => k.id).join(", ")}`);

  const genesis = nodes.filter((r) => (r.prev_receipt_hash ?? null) === null);
  if (genesis.length !== 1) errors.push(`expected exactly one genesis (prev=null), found ${genesis.length}`);
  const heads = nodes.filter((r) => !childrenOf.has(r.hash));
  if (heads.length !== 1) errors.push(`expected exactly one head, found ${heads.length}`);

  let head = null;
  const chain = []; // genesis → head order, so callers can tell the forensic story
  if (!errors.length) {
    const seen = new Set();
    let cur = genesis[0];
    while (cur) {
      if (seen.has(cur.hash)) { errors.push(`cycle at ${cur.id}`); break; }
      seen.add(cur.hash); chain.push(cur);
      const kids = childrenOf.get(cur.hash) || [];
      if (!kids.length) { head = cur; break; }
      cur = kids[0];
    }
    if (!errors.length && seen.size !== nodes.length) errors.push(`chain covers ${seen.size}/${nodes.length} receipts — ${nodes.length - seen.size} detached`);
  }
  return { ok: errors.length === 0, head: head ? head.id : null, length: nodes.length, chain, errors };
}

// Render a receipt HONESTLY (Da Vinci masterpiece council, binding adversarial
// veto on over-claim). The receipt describes an EVENT — "a second model reviewed
// this work" — it does NOT assert the code is correct/blessed. So: a NEUTRAL △
// marks the cross-check (never a green ✓, which would borrow CI's "guaranteed"
// grammar); the verdict is scoped to the actor ("agreed — no issues flagged"),
// not "PASS/verified"; ✓ is reserved strictly for the cryptographic fact that the
// content hash matches; and a mandatory footer states what was NOT proven.
export function renderReceipt(r) {
  const v = r.verifier || {}, p = r.proposer || {};
  const word = r.verdict === "PASS" ? "agreed — no issues flagged" : r.verdict === "FAIL" ? "flagged issues" : "raised concerns";
  const color = r.verdict === "FAIL" ? "\x1b[33m" : "\x1b[0m"; // not green — agreement is not a guarantee
  const indep = r.cross_provider ? `${p.provider || "?"} → ${v.provider || "?"}, independent` : `\x1b[31m⚠ same provider (${v.provider || "?"}) — NOT an independent check\x1b[0m`;
  const reason = String(v.reasoning || "").replace(/\s+/g, " ").trim().slice(0, 150);
  return [
    `\x1b[2m──\x1b[0m \x1b[1m△ cross-checked\x1b[0m \x1b[2m· receipt ${r.id}\x1b[0m`,
    `  ${v.model || "?"} reviewed ${p.model || "?"}'s work  \x1b[2m(${indep}\x1b[2m)\x1b[0m`,
    `  ${color}${word}\x1b[0m${reason ? ` \x1b[2m— ${reason}\x1b[0m` : ""}`,
    r.code_snapshot ? `  \x1b[2mbound to code ${String(r.code_snapshot).slice(0, 12)}\x1b[0m` : null,
    `  \x1b[2mre-checkable offline · not a certification · trust terminates at the generator\x1b[0m`,
    `  \x1b[2m\`nomos receipt verify\` re-checks the hash · \`nomos audit\` walks the chain\x1b[0m`,
  ].filter(Boolean).join("\n");
}
