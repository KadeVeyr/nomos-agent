import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicBody, openaiBody, DEFAULT_MAX_TOKENS } from "../src/gateway.js";

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
