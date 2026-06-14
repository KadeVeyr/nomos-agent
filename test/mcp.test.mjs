import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMessage, MCP_TOOLS } from "../src/mcp.js";

test("initialize returns serverInfo + tools capability + echoes protocol version", async () => {
  const r = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, { version: "9.9.9" });
  assert.equal(r.result.serverInfo.name, "nomos");
  assert.equal(r.result.serverInfo.version, "9.9.9");
  assert.ok(r.result.capabilities.tools);
  assert.equal(r.result.protocolVersion, "2025-06-18");
});

test("notifications produce no response (no id)", async () => {
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} }), null);
});

test("tools/list exposes exactly nomos_verify + nomos_seat with schemas", async () => {
  const r = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = r.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["nomos_seat", "nomos_verify"]);
  for (const t of MCP_TOOLS) assert.equal(t.inputSchema.type, "object");
});

test("tools/call nomos_verify: runs verify, threads maxTokens, FAIL → isError", async () => {
  let seenMaxTokens;
  const deps = {
    loadConfig: () => ({ root: "/r", defaultModel: "anthropic/claude-opus-4-8", maxTokens: 8192 }),
    getDiff: async ({ staged }) => { assert.equal(staged, true); return "- a\n+ b"; },
    runVerify: async ({ maxTokens, source }) => { seenMaxTokens = maxTokens; assert.equal(source, "Cursor"); return { receipt: { id: "abc123", cross_provider: true }, verdict: "FAIL", reasoning: "assigns instead of compares" }; },
    writeReceipt: () => "/r/.nomos/receipts/abc123.json",
  };
  const r = await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nomos_verify", arguments: { staged: true, source: "Cursor" } } }, deps);
  assert.equal(seenMaxTokens, 8192);
  assert.match(r.result.content[0].text, /FAIL/);
  assert.match(r.result.content[0].text, /assigns instead of compares/);
  assert.match(r.result.content[0].text, /cross_provider=true/);
  assert.equal(r.result.isError, true); // FAIL surfaces as a tool error to the editor
});

test("tools/call nomos_verify: clean tree → tool error, no crash", async () => {
  const deps = {
    loadConfig: () => ({ root: "/r", defaultModel: "anthropic/claude-opus-4-8", maxTokens: 8192 }),
    getDiff: async () => "",
  };
  const r = await handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nomos_verify", arguments: {} } }, deps);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /No changes/);
});

test("tools/call nomos_verify: per-call max_tokens overrides config", async () => {
  let seen;
  const deps = {
    loadConfig: ({ root }) => ({ root, defaultModel: "anthropic/x", maxTokens: 8192 }),
    getDiff: async () => "- a\n+ b",
    runVerify: async ({ maxTokens }) => { seen = maxTokens; return { receipt: { id: "z", cross_provider: true }, verdict: "PASS", reasoning: "ok" }; },
    writeReceipt: () => "/r/z.json",
  };
  await handleMessage({ jsonrpc: "2.0", id: 90, method: "tools/call", params: { name: "nomos_verify", arguments: { max_tokens: 20000 } } }, deps);
  assert.equal(seen, 20000); // per-call beats cfg.maxTokens (8192)
});

test("tools/call: a cwd outside the server root is refused (SEC-1 confinement)", async () => {
  const deps = {
    loadConfig: ({ root }) => ({ root, defaultModel: "anthropic/x", maxTokens: 8192 }),
    getDiff: async () => "diff",
    runVerify: async () => ({ receipt: { id: "z", cross_provider: true }, verdict: "PASS", reasoning: "ok" }),
    writeReceipt: () => "/r/z.json",
  };
  const escape = process.platform === "win32" ? "C:\\Windows\\System32" : "/etc";
  const r = await handleMessage({ jsonrpc: "2.0", id: 91, method: "tools/call", params: { name: "nomos_verify", arguments: { cwd: escape } } }, deps);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /outside the server root|refused/i);
});

test("tools/call nomos_seat: returns the final block; missing directive → tool error", async () => {
  const deps = {
    loadConfig: () => ({ root: "/r", defaultModel: "openai/gpt-5.5", maxTokens: 8192 }),
    runSeat: async ({ directive }) => { assert.equal(directive, "grade this"); return { final_block: { body: "VERDICT: GREEN" }, output: "x", status: "ok", exit_code: 0 }; },
  };
  const ok = await handleMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nomos_seat", arguments: { directive: "grade this" } } }, deps);
  assert.match(ok.result.content[0].text, /GREEN/);
  assert.ok(!ok.result.isError);

  const bad = await handleMessage({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nomos_seat", arguments: {} } }, deps);
  assert.equal(bad.result.isError, true);
});

test("tools/call: a thrown tool error is reported in-band, not as a protocol crash", async () => {
  const deps = {
    loadConfig: () => ({ root: "/r", defaultModel: "anthropic/x", maxTokens: 8192 }),
    getDiff: async () => { throw new Error("not a git repository"); },
  };
  const r = await handleMessage({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nomos_verify", arguments: {} } }, deps);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /not a git repository/);
});

test("unknown request method → method-not-found; unknown tool → invalid-params", async () => {
  const m = await handleMessage({ jsonrpc: "2.0", id: 8, method: "floop" });
  assert.equal(m.error.code, -32601);
  const t = await handleMessage({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "nomos_nope", arguments: {} } });
  assert.equal(t.error.code, -32602);
});
