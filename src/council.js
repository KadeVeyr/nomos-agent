// Council — the receipt-first cross-provider verification primitive.
//
// A proposer (one provider) does the task; a verifier (a DIFFERENT provider)
// adversarially checks the answer; the run emits a signed-by-content receipt.
// Cross-provider is the whole point: a model grading its own family is grading
// its own homework. The verifier is told to REFUTE, not agree, and it can BLOCK
// (verdict FAIL). This is the native primitive OpenCode/Hermes don't ship.

import { runAgent } from "./agent.js";
import { chat } from "./gateway.js";
import { resolveModel } from "./providers.js";
import { makeReceipt, writeReceipt } from "./receipt.js";

const VERIFIER_SYSTEM = `You are an adversarial CROSS-PROVIDER verifier. A different AI model — the "proposer", built by a different company — produced an answer to a task. Your job is to CATCH WHAT IT GOT WRONG, not to agree. Be skeptical, specific, and concrete. Default to scrutiny: an answer that is plausible but unsupported is a CONCERNS, not a PASS.

Reply in EXACTLY this shape (verdict on the first line):
VERDICT: PASS | CONCERNS | FAIL
<specific reasoning — name what is wrong, unsupported, or unsafe; if it holds, say precisely why>

PASS = correct, complete, and safe. CONCERNS = usable but has real issues you must name. FAIL = wrong, unsupported, or unsafe.`;

export function parseVerdict(text) {
  const m = /VERDICT:\s*(PASS|CONCERNS|FAIL)/i.exec(text || "");
  const verdict = m ? m[1].toUpperCase() : "CONCERNS"; // unparseable → default to scrutiny
  const reasoning = String(text || "").replace(/^[\s\S]*?VERDICT:\s*(PASS|CONCERNS|FAIL)\s*/i, "").trim() || String(text || "").trim();
  return { verdict, reasoning };
}

// Run a proposer→verifier council and produce a receipt.
// opts: { task, proposerSpec, verifierSpec, root, allowShell, allowFetch, maxSteps, onEvent, now }
// `deps` lets tests inject the model calls; defaults to the real ones.
export async function runCouncil(opts, deps = {}) {
  const { task, proposerSpec, verifierSpec, root = process.cwd(), allowShell, allowFetch, maxSteps, maxTokens, onEvent } = opts;
  const _runAgent = deps.runAgent || runAgent;
  const _chat = deps.chat || chat;
  const now = opts.now || (() => new Date().toISOString());

  const prop = resolveModel(proposerSpec);
  const ver = resolveModel(verifierSpec);
  if (prop.providerId === ver.providerId) {
    // Not fatal — but the receipt will record cross_provider:false and warn.
    onEvent?.({ type: "warn", message: `proposer and verifier are the same provider (${prop.providerId}) — the receipt will not be independent.` });
  }

  // 1. Proposer does the work (full agent loop — may use tools).
  onEvent?.({ type: "phase", phase: "propose", model: proposerSpec });
  let steps = 0;
  const output = await _runAgent({
    spec: proposerSpec, task, root, allowShell, allowFetch, maxSteps, maxTokens,
    onEvent: (e) => { if (e?.type === "tool_call") steps++; onEvent?.({ ...e, side: "proposer" }); },
  });

  // 2. Verifier adversarially checks the proposer's answer (single turn, other provider).
  onEvent?.({ type: "phase", phase: "verify", model: verifierSpec });
  const messages = [
    { role: "system", content: VERIFIER_SYSTEM },
    { role: "user", content: `TASK:\n${task}\n\nPROPOSER (${prop.providerId} / ${prop.model}) ANSWER:\n${(output || "").trim()}\n\nVerify it. Catch what it got wrong.` },
  ];
  const res = await _chat({ spec: verifierSpec, messages, tools: [], maxTokens });
  const { verdict, reasoning } = parseVerdict(res?.content);
  onEvent?.({ type: "verdict", verdict });

  // 3. Receipt.
  const receipt = makeReceipt({
    task,
    proposer: { model: proposerSpec, provider: prop.providerId, output: (output || "").trim(), steps },
    verifier: { model: verifierSpec, provider: ver.providerId, verdict, reasoning },
    ts: now(),
  });
  const file = writeReceipt(root, receipt);
  return { receipt, file };
}
