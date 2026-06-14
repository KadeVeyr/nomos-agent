import { test } from "node:test";
import assert from "node:assert/strict";
import { getDiff, runVerify } from "../src/verify.js";

test("getDiff builds the right git args + returns stdout", async () => {
  let captured;
  const fake = (cmd, args, opts, cb) => { captured = { cmd, args }; cb(null, "diff-output"); };
  assert.equal(await getDiff({ staged: true }, { execFile: fake }), "diff-output");
  assert.deepEqual(captured.args, ["diff", "--cached"]);
  await getDiff({ against: "HEAD~1" }, { execFile: fake });
  assert.deepEqual(captured.args, ["diff", "HEAD~1"]);
  await getDiff({}, { execFile: fake });
  assert.deepEqual(captured.args, ["diff"]);
});

test("getDiff surfaces a clear error when not a git repo", async () => {
  const fake = (cmd, args, opts, cb) => cb(new Error("not a git repository"));
  await assert.rejects(() => getDiff({}, { execFile: fake }), /git repository/);
});

test("runVerify: external proposer, one-key verifier, cross_provider receipt", async () => {
  const r = await runVerify(
    { diff: "- a\n+ b", spec: "anthropic/claude-opus-4-8", source: "Cursor" },
    { chat: async ({ messages }) => { assert.match(messages[1].content, /- a/); return { content: "VERDICT: FAIL\nthe change breaks X" }; }, now: () => "2020" },
  );
  assert.equal(r.verdict, "FAIL");
  assert.match(r.reasoning, /breaks X/);
  assert.equal(r.receipt.proposer.provider, "external"); // the change came from another tool
  assert.equal(r.receipt.verifier.provider, "anthropic"); // Nomos = the one-key verifier
  assert.equal(r.receipt.cross_provider, true);
});

test("runVerify: threads maxTokens to the model call (no truncation on long diffs)", async () => {
  let seen;
  await runVerify(
    { diff: "x", spec: "anthropic/claude-opus-4-8", maxTokens: 16384 },
    { chat: async (a) => { seen = a.maxTokens; return { content: "VERDICT: PASS\nok" }; }, now: () => "t" },
  );
  assert.equal(seen, 16384);
});

test("runVerify: timeout → terminal CONCERNS receipt, never throws (the #8 guarantee)", async () => {
  const r = await runVerify(
    { diff: "x", spec: "anthropic/claude-opus-4-8", timeoutMs: 5 },
    {
      chat: ({ signal }) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
      now: () => "t",
    },
  );
  assert.equal(r.verdict, "CONCERNS"); // not a false PASS, not a CI-gating FAIL
  assert.match(r.reasoning, /timed out/);
  assert.ok(r.receipt); // a receipt is still emitted — terminal, never a hang
});
