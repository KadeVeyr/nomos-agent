import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated store so we can set a fake credential for the route resolver.
process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-sse-"));
const { setCredential } = await import("../src/auth.js");
const { chatStream } = await import("../src/gateway.js");

// A minimal Response whose body yields the given string chunks (split anywhere).
function streamResponse(chunks) {
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { value: new TextEncoder().encode(chunks[i++]), done: false } : { value: undefined, done: true }) }) },
  };
}
async function withFetch(chunks, fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => streamResponse(chunks);
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

test("openai SSE: content split across chunks + a malformed frame is skipped, not crashed", async () => {
  setCredential("openai", { type: "apikey", value: "sk-test-12345", method: "apikey" });
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hel',          // split mid-JSON
    'lo"}}]}\n',
    'data: {bad json}\n',                                   // malformed — must be skipped
    'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n',
    "data: [DONE]\n",
  ];
  let streamed = "";
  const res = await withFetch(chunks, () => chatStream({ spec: "openai/gpt-5.5", messages: [{ role: "user", content: "hi" }], tools: [], onDelta: (t) => (streamed += t) }));
  assert.equal(res.content, "Hello world");
  assert.equal(streamed, "Hello world");
  assert.equal(res.stopReason, "stop");
});

test("anthropic SSE: tool_use args assembled across input_json_delta chunks", async () => {
  setCredential("kimi-for-coding", { type: "apikey", value: "sk-test-12345", method: "apikey" });
  const chunks = [
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"read_file"}}\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"a.js\\"}"}}\n',
    'data: {"type":"content_block_stop","index":0}\n',
    'data: {"type":"message_stop"}\n',
  ];
  const res = await withFetch(chunks, () => chatStream({ spec: "kimi-for-coding/k2p6", messages: [{ role: "user", content: "hi" }], tools: [] }));
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0].name, "read_file");
  assert.deepEqual(res.toolCalls[0].args, { path: "a.js" });
});
