import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRoute } from "../src/gateway.js";
import { PROVIDERS } from "../src/providers.js";
import { parseModels } from "../src/models.js";
import { extractFinalSentinel, runSeat, packContext } from "../src/seat.js";
import { parseVerdict } from "../src/council.js";
import { makeReceipt, verifyReceiptHash } from "../src/receipt.js";
import { trimContext } from "../src/agent.js";

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

test("runSeat: ok + empty transcripts (mocked)", async () => {
  const ok = await runSeat({ task: "q", spec: "openai/gpt-5.5" }, { chat: async () => ({ content: "=== R START ===\nhi\n=== R END ===" }), now: () => "2020", hrtime: (() => { let n = 0; return () => (n += 1); })(), run_id: "x" });
  assert.equal(ok.status, "ok"); assert.equal(ok.exit_code, 0); assert.equal(ok.final_block.body, "hi");
  const empty = await runSeat({ task: "q", spec: "openai/gpt-5.5" }, { chat: async () => ({ content: "" }), now: () => "2020", hrtime: () => 1, run_id: "x" });
  assert.equal(empty.status, "empty"); assert.equal(empty.exit_code, 1);
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
