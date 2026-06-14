import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { resolveRoute } from "../src/gateway.js";
import { PROVIDERS, resolveModel } from "../src/providers.js";
import { parseModels } from "../src/models.js";
import { extractFinalSentinel, runSeat, packContext } from "../src/seat.js";
import { parseVerdict } from "../src/council.js";
import { makeReceipt, verifyReceiptHash, canonicalReceipt } from "../src/receipt.js";
import { trimContext, readProjectCommands } from "../src/agent.js";

test("resolveRoute: kimi-for-coding = anthropic + x-api-key + version, no bearer", () => {
  const r = resolveRoute(PROVIDERS["kimi-for-coding"], { value: "sk-k123456789", method: "apikey" });
  assert.equal(r.format, "anthropic-messages");
  assert.equal(r.base, "https://api.kimi.com/coding/v1");
  assert.equal(r.headers["x-api-key"], "sk-k123456789");
  assert.equal(r.headers["anthropic-version"], "2023-06-01");
  assert.ok(!r.headers.authorization);
});

test("resolveRoute: openai = bearer; ollama (noAuth) = none", () => {
  assert.equal(resolveRoute(PROVIDERS.openai, { value: "sk-abc12345", method: "apikey" }).headers.authorization, "Bearer sk-abc12345");
  const o = resolveRoute(PROVIDERS.ollama, null);
  assert.ok(!o.headers.authorization && !o.headers["x-api-key"]);
});

test("resolveRoute: google + minimax route over OpenAI-compatible bearer endpoints", () => {
  assert.equal(PROVIDERS.google.format, "openai-chat");
  const g = resolveRoute(PROVIDERS.google, { value: "AIzaXXXX", method: "apikey" });
  assert.equal(g.base, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(g.headers.authorization, "Bearer AIzaXXXX");
  assert.ok(!g.headers["x-api-key"]);
  const mm = resolveRoute(PROVIDERS.minimax, { value: "mm-key", method: "apikey" });
  assert.equal(mm.base, "https://api.minimax.io/v1");
  assert.equal(mm.headers.authorization, "Bearer mm-key");
  assert.equal(resolveModel("google/gemini-2.5-pro").providerId, "google");
  assert.equal(resolveModel("minimax/MiniMax-M2.5").providerId, "minimax");
});

test("parseModels: openai / anthropic / ollama / empty", () => {
  assert.deepEqual(parseModels({ object: "list", data: [{ id: "b" }, { id: "a" }] }), ["a", "b"]);
  assert.deepEqual(parseModels({ data: [{ id: "x", display_name: "X" }], has_more: false }), ["x"]);
  assert.deepEqual(parseModels({ models: [{ name: "m1" }] }), ["m1"]);
  assert.deepEqual(parseModels(null), []);
});

test("extractFinalSentinel takes the LAST block (echo-trap safe)", () => {
  const fb = extractFinalSentinel("=== X START ===\nfirst\n=== X END ===\n=== X START ===\nVERDICT: OK\n=== X END ===");
  assert.equal(fb.body, "VERDICT: OK");
  assert.equal(extractFinalSentinel("no sentinels"), null);
});

test("extractFinalSentinel: relaxed match for mismatched START / SEAT-END wrappers", () => {
  const fb = extractFinalSentinel("=== REVIEW R1 START ===\nVERDICT: GREEN\n===SEAT-END===");
  assert.equal(fb.body, "VERDICT: GREEN");
  assert.equal(fb.marker, "REVIEW R1");
  // still takes the LAST block (echo-trap safe) even with mismatched closers
  const last = extractFinalSentinel("=== X START ===\nfirst\n===SEAT-END===\n=== Y START ===\nVERDICT: OK\n===SEAT-END===");
  assert.equal(last.body, "VERDICT: OK");
  // strict matched-pair form still wins (and still takes the last)
  const strict = extractFinalSentinel("=== A START ===\nfirst\n=== A END ===\n=== A START ===\nsecond\n=== A END ===");
  assert.equal(strict.body, "second");
  // relaxed prefers the first CANONICAL closer — no over-capture of a trailing
  // END-like line past the real closer
  const tight = extractFinalSentinel("=== S START ===\nverdict\n===SEAT-END===\ntrailing === FOO END === note");
  assert.equal(tight.body, "verdict");
  // an in-body "=== STEP END ===" must NOT truncate the verdict (skip to SEAT-END)
  const embedded = extractFinalSentinel("=== REVIEW START ===\nStep 1 done === STEP END ===\nVERDICT: PASS\n===SEAT-END===");
  assert.match(embedded.body, /VERDICT: PASS/);
  // a word ending in END (FRONTEND/APPEND) is NOT a closer
  const frontend = extractFinalSentinel("=== REVIEW START ===\nUse the FRONTEND.\n=== FRONTEND ===\nVERDICT: OK\n===SEAT-END===");
  assert.match(frontend.body, /VERDICT: OK/);
  // marker isn't polluted by a preceding ===…=== line (bounded marker, no '=')
  const poll = extractFinalSentinel("=== TASK START ===\nsetup\n===SEAT-END===\n=== VERDICT START ===\nGREEN\n===SEAT-END===");
  assert.equal(poll.marker, "VERDICT");
  assert.equal(poll.body, "GREEN");
});

test("extractFinalSentinel: linear on a long === divider (no ReDoS event-loop stall)", () => {
  const big = "=".repeat(200000) + "\n=== SEAT START ===\nVERDICT: OK\n===SEAT-END===";
  const t0 = process.hrtime.bigint();
  const fb = extractFinalSentinel(big);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(fb.body, "VERDICT: OK");
  assert.ok(ms < 2000, `extraction took ${ms.toFixed(0)}ms on 200KB — should be ~linear (was 11s+ with unbounded marker)`);
});

test("parseVerdict maps PASS/FAIL/default", () => {
  assert.equal(parseVerdict("VERDICT: FAIL\nbad").verdict, "FAIL");
  assert.equal(parseVerdict("VERDICT: pass\nok").verdict, "PASS");
  assert.equal(parseVerdict("no verdict here").verdict, "CONCERNS");
});

test("receipt hash detects tamper + cross_provider flag", () => {
  const r = makeReceipt({ task: "t", proposer: { model: "a/x", provider: "a", output: "o" }, verifier: { model: "b/y", provider: "b", verdict: "PASS", reasoning: "r" }, ts: "2020" });
  assert.ok(verifyReceiptHash(r));
  assert.ok(!verifyReceiptHash({ ...r, task: "changed" }));
  assert.equal(r.cross_provider, true);
  const same = makeReceipt({ task: "t", proposer: { model: "a/x", provider: "a", output: "o" }, verifier: { model: "a/z", provider: "a", verdict: "PASS", reasoning: "r" }, ts: "2020" });
  assert.equal(same.cross_provider, false);
});

test("receipt hash binds verifier model + the denormalized verdict/id (no display-field swap)", () => {
  const r = makeReceipt({ task: "t", proposer: { model: "a/x", provider: "a", output: "o" }, verifier: { model: "b/weak", provider: "b", verdict: "FAIL", reasoning: "r" }, ts: "2020" });
  assert.ok(verifyReceiptHash(r));
  // flipping ONLY the top-level (displayed) verdict must be caught
  assert.ok(!verifyReceiptHash({ ...r, verdict: "PASS" }));
  // swapping the verifier model to a more authoritative one must be caught
  assert.ok(!verifyReceiptHash({ ...r, verifier: { ...r.verifier, model: "b/strong" } }));
  // forging the verifier's provider (faking cross-provider independence) must be caught
  assert.ok(!verifyReceiptHash({ ...r, verifier: { ...r.verifier, provider: "c" } }));
  // tampering the id must be caught
  assert.ok(!verifyReceiptHash({ ...r, id: "000000000000" }));
});

test("verifyReceiptHash: a recomputed-hash forge of cross_provider is still caught (re-derivation)", () => {
  // same-provider run → cross_provider must be false
  const r = makeReceipt({ task: "t", proposer: { model: "a/x", provider: "a", output: "o" }, verifier: { model: "a/z", provider: "a", verdict: "PASS", reasoning: "r" }, ts: "2020" });
  assert.equal(r.cross_provider, false);
  // forger flips cross_provider:true AND recomputes a *matching* hash (it's keyless)
  const forged = { ...r, cross_provider: true };
  forged.hash = crypto.createHash("sha256").update(canonicalReceipt(forged)).digest("hex");
  forged.id = forged.hash.slice(0, 12);
  // the hash now matches the forged content, but re-deriving cross_provider from
  // the (equal) providers exposes the lie — independence can't be faked
  assert.ok(!verifyReceiptHash(forged));
});

test("runSeat: ok + empty transcripts (mocked)", async () => {
  const ok = await runSeat({ task: "q", spec: "openai/gpt-5.5" }, { chat: async () => ({ content: "=== R START ===\nhi\n=== R END ===" }), now: () => "2020", hrtime: (() => { let n = 0; return () => (n += 1); })(), run_id: "x" });
  assert.equal(ok.status, "ok"); assert.equal(ok.exit_code, 0); assert.equal(ok.final_block.body, "hi");
  const empty = await runSeat({ task: "q", spec: "openai/gpt-5.5" }, { chat: async () => ({ content: "" }), now: () => "2020", hrtime: () => 1, run_id: "x" });
  assert.equal(empty.status, "empty"); assert.equal(empty.exit_code, 1);
});

test("runSeat: timeout → terminal status, never a 0-byte hang (the guarantee)", async () => {
  const t = await runSeat(
    { directive: "q", spec: "openai/gpt-5.5", timeoutMs: 5 },
    {
      // a provider call that never resolves on its own — only the abort ends it
      chat: ({ signal }) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
      now: () => "2020", hrtime: () => 1, run_id: "x",
    },
  );
  assert.equal(t.status, "timeout");
  assert.equal(t.exit_code, 124);
  assert.equal(t.timed_out, true);
  assert.equal(typeof t.output, "string"); // always a structured transcript, never undefined/hang
});

test("runSeat: output below --min-output-bytes floor → status thin, exit 1", async () => {
  const thin = await runSeat(
    { directive: "q", spec: "openai/gpt-5.5", minBytes: 200 },
    { chat: async () => ({ content: "too short" }), now: () => "2020", hrtime: () => 1, run_id: "x" },
  );
  assert.equal(thin.status, "thin");
  assert.equal(thin.exit_code, 1);
  assert.match(thin.error, /below floor/);
  // a healthy output clears the floor
  const ok = await runSeat(
    { directive: "q", spec: "openai/gpt-5.5", minBytes: 5 },
    { chat: async () => ({ content: "this is plenty long" }), now: () => "2020", hrtime: () => 1, run_id: "x" },
  );
  assert.equal(ok.status, "ok");
  assert.equal(ok.exit_code, 0);
});

test("runSeat: threads maxTokens to the model call", async () => {
  let seen;
  await runSeat(
    { directive: "q", spec: "openai/gpt-5.5", maxTokens: 16384 },
    { chat: async (a) => { seen = a.maxTokens; return { content: "=== R START ===\nhi\n=== R END ===" }; }, now: () => "2020", hrtime: () => 1, run_id: "x" },
  );
  assert.equal(seen, 16384);
});

test("packContext: sorted + byte cap + audit", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-ctx-"));
  fs.writeFileSync(path.join(d, "a.txt"), "AAAA");
  fs.writeFileSync(path.join(d, "b.txt"), "B".repeat(100));
  const { audit } = packContext(["b.txt", "a.txt"], 10, d);
  assert.equal(audit[0].path, "a.txt");
  assert.equal(audit.find((x) => x.path === "a.txt").included, true);
  assert.equal(audit.find((x) => x.path === "b.txt").included, false);
  fs.rmSync(d, { recursive: true, force: true });
});

test("trimContext truncates old tool messages over budget", () => {
  const msgs = [{ role: "system", content: "s" }, { role: "user", content: "u" }, { role: "tool", content: "X".repeat(1000) }, { role: "tool", content: "Y".repeat(1000) }];
  trimContext(msgs, 500);
  assert.ok(msgs.reduce((s, m) => s + m.content.length, 0) <= 700);
});

test("readProjectCommands: reads nomos.json commands, sanitizes, ignores junk", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-cmd-"));
  assert.equal(readProjectCommands(d), null); // no nomos.json
  fs.writeFileSync(path.join(d, "nomos.json"), JSON.stringify({
    commands: {
      test: "node --test",
      build: "npm run build",
      "weird key!": "should be dropped (bad key)",
      deploy: "custom one\nwith newline and " + "x".repeat(300),
      bogus: 123,
    },
  }));
  const out = readProjectCommands(d);
  assert.match(out, /- test: node --test/);
  assert.match(out, /- build: npm run build/);
  assert.match(out, /- deploy: custom one with newline/); // newline collapsed
  assert.ok(!/weird key/.test(out)); // invalid key name dropped
  assert.ok(!/bogus/.test(out)); // non-string dropped
  assert.ok(out.split("\n").every((l) => l.length <= 210)); // length-capped values
  // a nomos.json without a commands object → null
  fs.writeFileSync(path.join(d, "nomos.json"), JSON.stringify({ maxSteps: 5 }));
  assert.equal(readProjectCommands(d), null);
  fs.rmSync(d, { recursive: true, force: true });
});
