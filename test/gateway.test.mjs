import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicBody, openaiBody, responsesBody, resolveRoute, DEFAULT_MAX_TOKENS } from "../src/gateway.js";
import { PROVIDERS } from "../src/providers.js";

const M = [{ role: "system", content: "sys" }, { role: "user", content: "hi" }];

test("anthropicBody: configurable max_tokens, system split, tools omitted when empty", () => {
  const b = anthropicBody({ model: "m", messages: M, tools: [], maxTokens: 9999 });
  assert.equal(b.max_tokens, 9999);
  assert.equal(b.system, "sys");
  assert.equal(b.messages.length, 1); // system stripped from conv
  assert.equal(b.tools, undefined);   // no tools → field omitted
  assert.equal(b.stream, undefined);
});

test("anthropicBody: generous default (not the old 4096) + stream flag", () => {
  const b = anthropicBody({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true });
  assert.equal(b.max_tokens, DEFAULT_MAX_TOKENS);
  assert.ok(DEFAULT_MAX_TOKENS >= 8192, "default cap must exceed the old 4096 that truncated long outputs");
  assert.equal(b.stream, true);
});

test("openaiBody: default field is max_tokens; reasoning models use max_completion_tokens", () => {
  const def = openaiBody({ model: "m", messages: M, maxTokens: 5000 });
  assert.equal(def.max_tokens, 5000);
  assert.equal(def.max_completion_tokens, undefined);

  const reasoning = openaiBody({ model: "m", messages: M, maxTokens: 5000, maxTokensParam: "max_completion_tokens" });
  assert.equal(reasoning.max_completion_tokens, 5000);
  assert.equal(reasoning.max_tokens, undefined); // never send both — would 400 on OpenAI
});

test("openaiBody: tools omitted when empty, present when supplied", () => {
  assert.equal(openaiBody({ model: "m", messages: M }).tools, undefined);
  const withTools = openaiBody({ model: "m", messages: M, tools: [{ name: "t", description: "d", parameters: { type: "object" } }] });
  assert.equal(withTools.tools[0].function.name, "t");
});

test("responsesBody: system → instructions, rest → input, stream + store, no max_output_tokens", () => {
  const b = responsesBody({ model: "gpt-5.1-codex", messages: M, tools: [{ name: "t", description: "d", parameters: { type: "object" } }], store: false });
  assert.equal(b.instructions, "sys");
  assert.equal(b.input.length, 1);
  assert.deepEqual(b.input[0], { role: "user", content: "hi" });
  assert.equal(b.stream, true);
  assert.equal(b.store, false);
  assert.equal(b.tools[0].type, "function"); // flat Responses tool shape
  assert.equal(b.tools[0].name, "t");
  assert.equal(b.max_output_tokens, undefined); // backend manages output length
});

test("responsesBody: store omitted when the route doesn't set it (e.g. xAI)", () => {
  const b = responsesBody({ model: "grok-4.3", messages: [{ role: "user", content: "hi" }] });
  assert.equal(b.store, undefined);
  assert.equal(b.tools, undefined);
});

test("responsesBody: an assistant tool-call turn round-trips with matching call_ids (no orphaned output → no 400)", () => {
  const msgs = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_file", args: { path: "a.js" } }] },
    { role: "tool", toolCallId: "call_1", content: "file contents" },
  ];
  const b = responsesBody({ model: "gpt-5.1-codex", messages: msgs });
  const fc = b.input.find((i) => i.type === "function_call");
  const fo = b.input.find((i) => i.type === "function_call_output");
  assert.ok(fc, "assistant tool call must become a function_call input item");
  assert.ok(fo, "tool result is a function_call_output");
  assert.equal(fc.call_id, "call_1");
  assert.equal(fo.call_id, "call_1"); // the ids align — what the Responses API requires
  assert.equal(fc.name, "read_file");
  assert.equal(fc.arguments, JSON.stringify({ path: "a.js" }));
});

test("resolveRoute: openai plan-oauth → Responses base + bearer + account/originator/beta", () => {
  const r = resolveRoute(PROVIDERS.openai, { value: "AT", method: "plan-oauth", accountId: "acc_9" });
  assert.equal(r.format, "openai-responses");
  assert.equal(r.base, "https://chatgpt.com/backend-api/codex");
  assert.equal(r.headers.authorization, "Bearer AT");
  assert.equal(r.headers.originator, "codex_cli_rs");
  assert.equal(r.headers["OpenAI-Beta"], "responses=experimental");
  assert.equal(r.headers["chatgpt-account-id"], "acc_9");
  assert.equal(r.store, false);
});

test("resolveRoute: xai SuperGrok token (plan-token) → api.x.ai Responses + bearer only (no account/originator)", () => {
  const r = resolveRoute(PROVIDERS.xai, { value: "AT", method: "plan-token" });
  assert.equal(r.format, "openai-responses");
  assert.equal(r.base, "https://api.x.ai/v1");
  assert.equal(r.headers.authorization, "Bearer AT");
  assert.ok(!r.headers["chatgpt-account-id"]);
  assert.ok(!r.headers.originator);
  assert.equal(r.store, undefined);
});
