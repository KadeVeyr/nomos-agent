// Gateway — prefix → API base + credential → normalized chat call.
//
// Supports three wire formats: OpenAI chat-completions, Anthropic messages, and
// the OpenAI Responses API (the shape the ChatGPT/SuperGrok subscription
// endpoints speak). All normalize to { content, toolCalls, stopReason }.
//
// Multi-auth: the credential the user connected (api key / plan token / OAuth
// token) carries a METHOD. resolveRoute() looks that method up in the provider's
// `auth` table to pick the right endpoint base + wire format + auth header for
// THAT method (a paid-plan token can route to a different endpoint than the
// public API key). The secret is read from the server-side store and sent ONLY
// as an auth header. Provider error bodies are NEVER returned raw to the caller
// (they can echo request headers); we surface a sanitized status + message.

import { resolveModel } from "./providers.js";
import { getCredential, setCredential } from "./auth.js";
import { OAUTH, refreshCredential, isExpired } from "./oauth.js";

// Default output-token cap. A hardcoded 4096 truncated long outputs; 8192 is
// generous (≥ a long response) AND every caller can override via maxTokens
// (CLI --max-tokens / NOMOS_MAX_TOKENS / config).
export const DEFAULT_MAX_TOKENS = 8192;

// Pick endpoint base + wire format + auth headers for the connected method.
// Per-method overrides come from the registry (providers.js `auth`); anything
// not overridden falls back to the provider's defaults.
export function resolveRoute(provider, credential) {
  const method = credential?.method || "apikey";
  const table = Array.isArray(provider.auth) ? provider.auth : [];
  const entry = table.find((a) => a.method === method) || table[0] || null;

  const base = entry?.base || provider.base;
  const format = entry?.format || provider.format;
  const headers = { "content-type": "application/json" };

  if (provider.noAuth || !credential) return { base, format, headers };

  const style = entry?.headerStyle || (format === "anthropic-messages" ? "x-api-key" : "bearer");
  if (style === "x-api-key") {
    headers["x-api-key"] = credential.value;
  } else {
    // "bearer" and "oauth-bearer" both send the secret as a Bearer token. Used
    // by OpenAI-format providers and by Anthropic-compatible plan endpoints
    // (e.g. the GLM Coding Plan endpoint, which authenticates with Bearer).
    headers["authorization"] = `Bearer ${credential.value}`;
  }
  // The Anthropic wire format requires the version header regardless of how the
  // secret is carried (x-api-key on the real API, Bearer on plan endpoints).
  if (format === "anthropic-messages") headers["anthropic-version"] = entry?.anthropicVersion || "2023-06-01";
  // Static, non-secret per-method headers (e.g. anthropic-beta for OAuth tokens).
  if (entry?.betaHeader) headers["anthropic-beta"] = entry.betaHeader;
  // Responses-API (subscription / plan-oauth) extras — non-secret, per-method.
  // `originator` is load-bearing for the ChatGPT backend (wrong value → 403);
  // the account id comes from the connected credential, not the registry.
  if (entry?.originator) headers["originator"] = entry.originator;
  if (entry?.openaiBeta) headers["OpenAI-Beta"] = entry.openaiBeta;
  if (entry?.accountIdHeader && credential.accountId) headers[entry.accountIdHeader] = credential.accountId;
  if (entry?.extraHeaders && typeof entry.extraHeaders === "object") {
    for (const [k, v] of Object.entries(entry.extraHeaders)) if (typeof v === "string") headers[k] = v;
  }
  // `store` (Responses API): the ChatGPT backend requires store:false; other
  // Responses providers omit it. Surfaced on the route so the body builder can apply it.
  return { base, format, headers, store: entry?.responsesStore };
}

function toAnthropicTools(tools) {
  return (tools || []).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

function toOpenAITools(tools) {
  return (tools || []).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// Pure request-body builders — exported so the output-token cap is unit-tested
// without hitting the network (the gateway uses global fetch). maxTokens is the
// configurable cap; stream toggles the SSE variant.
export function anthropicBody({ model, messages, tools, maxTokens = DEFAULT_MAX_TOKENS, stream = false }) {
  const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const conv = messages.filter((m) => m.role !== "system").map(toAnthropicMessage);
  const body = {
    model,
    max_tokens: maxTokens,
    system: sys || undefined,
    messages: conv,
    tools: tools && tools.length ? toAnthropicTools(tools) : undefined,
  };
  if (stream) body.stream = true;
  return body;
}

// maxTokensParam: most OpenAI-compatible providers take "max_tokens"; OpenAI's
// own reasoning models reject it and require "max_completion_tokens" (set per
// provider in the registry). Defaults to the broadly-compatible "max_tokens".
export function openaiBody({ model, messages, tools, maxTokens = DEFAULT_MAX_TOKENS, maxTokensParam = "max_tokens", stream = false }) {
  const body = {
    model,
    messages: messages.map(toOpenAIMessage),
    tools: tools && tools.length ? toOpenAITools(tools) : undefined,
  };
  body[maxTokensParam] = maxTokens;
  if (stream) body.stream = true;
  return body;
}

// Responses-API body (the shape the ChatGPT/SuperGrok subscription endpoints
// speak — `input`/`instructions`, NOT `messages`). System messages become
// `instructions`; the rest become Responses input items. Output length is left
// to the backend (the ChatGPT path rejects an explicit cap), so maxTokens isn't
// sent here. `store` is included only when the route demands it (false on the
// ChatGPT backend).
export function responsesBody({ model, messages, tools, stream = true, store }) {
  const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const input = messages.filter((m) => m.role !== "system").flatMap(toResponsesInput);
  const body = {
    model,
    instructions: sys || undefined,
    input,
    tools: tools && tools.length ? toResponsesTools(tools) : undefined,
    stream,
  };
  if (store !== undefined) body.store = store;
  return body;
}

// Each provider-neutral message → one or more Responses input items. An assistant
// tool-call turn becomes a `function_call` item per call (so the following tool
// result's `function_call_output` has a matching `call_id` — an orphaned output is
// a 400). Returns an array (flat-mapped) since one turn can yield several items.
function toResponsesInput(m) {
  if (m.role === "tool") return [{ type: "function_call_output", call_id: m.toolCallId, output: String(m.content ?? "") }];
  if (m.toolCalls && m.toolCalls.length) {
    const items = m.content ? [{ role: "assistant", content: m.content }] : [];
    for (const c of m.toolCalls) items.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.args ?? {}) });
    return items;
  }
  return [{ role: m.role, content: m.content }];
}

function toResponsesTools(tools) {
  // Responses tools are flat ({type,name,description,parameters}), not nested
  // under "function" like chat/completions.
  return (tools || []).map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
}

function safeError(res) {
  // Never read or surface the provider body — it can echo request headers and
  // credentials. A status-only message cannot leak a secret.
  return new Error(`Provider returned HTTP ${res.status}. ${res.status === 401 ? "Check the credential for this provider (nomos connect)." : "Request failed."}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function backoff(attempt, res) {
  const ra = res && Number(res.headers?.get?.("retry-after"));
  if (ra) return Math.min(ra * 1000, 10000);
  return Math.min(500 * 2 ** attempt, 8000) + Math.random() * 250; // exp backoff + jitter
}

// fetch with retry on transient failures (429 / 5xx / network). Never retries an
// abort (cancellation) or a 4xx other than 429. Honors Retry-After.
async function fetchRetry(url, opts, retries = 3) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (e) {
      if (e?.name === "AbortError" || attempt >= retries) throw e;
      await sleep(backoff(attempt));
      continue;
    }
    if ((res.status === 429 || (res.status >= 500 && res.status <= 599)) && attempt < retries) {
      await sleep(backoff(attempt, res));
      continue;
    }
    return res;
  }
}

// One chat turn. messages = [{role, content, toolCalls?, toolResult?}] in a
// provider-neutral shape; we translate per format.
export async function chat({ spec, messages, tools, signal, maxTokens = DEFAULT_MAX_TOKENS }) {
  const { providerId, model, provider } = resolveModel(spec);
  const credential = await freshCredential(providerId);
  if (!credential && !provider.noAuth) {
    throw new Error(`No credential for "${providerId}". Run: nomos connect (or nomos auth login ${providerId})`);
  }
  const route = resolveRoute(provider, credential);

  if (route.format === "openai-responses") {
    return responsesStream({ route, model, messages, tools, signal, store: route.store });
  }

  if (route.format === "anthropic-messages") {
    const res = await fetchRetry(`${route.base}/messages`, {
      method: "POST",
      headers: route.headers,
      body: JSON.stringify(anthropicBody({ model, messages, tools, maxTokens })),
      signal,
    });
    if (!res.ok) throw safeError(res);
    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const toolCalls = (data.content || []).filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, args: b.input }));
    return { content: text, toolCalls, stopReason: data.stop_reason };
  }

  // openai-chat
  const res = await fetchRetry(`${route.base}/chat/completions`, {
    method: "POST",
    headers: route.headers,
    body: JSON.stringify(openaiBody({ model, messages, tools, maxTokens, maxTokensParam: provider.maxTokensParam })),
    signal,
  });
  if (!res.ok) throw safeError(res);
  const data = await res.json();
  const msg = data.choices?.[0]?.message || {};
  const toolCalls = (msg.tool_calls || []).map((c) => ({ id: c.id, name: c.function.name, args: safeJson(c.function.arguments) }));
  return { content: msg.content || "", toolCalls, stopReason: data.choices?.[0]?.finish_reason };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

// Resolve a credential, transparently refreshing an expired plan-oauth token
// before it's used (so a connected subscription keeps working without re-login).
// A refresh failure is swallowed — the stale token is returned and the request
// surfaces a clean 401 telling the user to reconnect.
async function freshCredential(providerId) {
  const cred = getCredential(providerId);
  if (cred?.type === "oauth" && isExpired(cred) && cred.refresh && OAUTH[providerId]) {
    try {
      setCredential(providerId, await refreshCredential(OAUTH[providerId], cred.refresh));
      return getCredential(providerId);
    } catch { /* fall through to the stale token */ }
  }
  return cred;
}

// Stream a Responses-API call (the subscription / plan-oauth path). Always
// streamed (the ChatGPT backend requires it); chat() drives it with a no-op
// onDelta and assembles the full result. Parses the Responses SSE event protocol.
// The event-name strings below are the standard OpenAI Responses streaming names
// (spec-derived, not quoted from a vendor CLI) — confirm on the first live run.
// The parser is defensive: unknown events are ignored and the stream still ends
// on a terminal event or body close, so a name mismatch degrades to empty output,
// never a hang.
async function responsesStream({ route, model, messages, tools, signal, onDelta, store }) {
  const res = await fetchRetry(`${route.base}/responses`, {
    method: "POST",
    headers: { ...route.headers, accept: "text/event-stream" },
    body: JSON.stringify(responsesBody({ model, messages, tools, stream: true, store })),
    signal,
  });
  if (!res.ok) throw safeError(res);
  let content = "";
  const calls = {};
  const order = [];
  for await (const data of sseData(res)) {
    if (data === "[DONE]") break;
    let j; try { j = JSON.parse(data); } catch { continue; }
    const t = j.type || "";
    if (t === "response.output_text.delta" && typeof j.delta === "string") {
      content += j.delta; onDelta?.(j.delta);
    } else if (t === "response.output_item.added" && j.item?.type === "function_call") {
      const id = j.item.id || j.item.call_id || `c${order.length}`;
      calls[id] = { id: j.item.call_id || id, name: j.item.name || "", argStr: "" };
      order.push(id);
    } else if (t === "response.function_call_arguments.delta") {
      const id = j.item_id || order[order.length - 1];
      if (calls[id]) calls[id].argStr += j.delta || "";
    } else if (t === "response.completed" || t === "response.done" || t === "error" || t === "response.failed") {
      break;
    }
  }
  const toolCalls = order.map((id) => calls[id]).filter(Boolean).map((c) => ({ id: c.id, name: c.name, args: safeJson(c.argStr) }));
  return { content, toolCalls, stopReason: toolCalls.length ? "tool_use" : "stop" };
}

// Yield each `data:` payload from a Server-Sent-Events response body.
async function* sseData(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trimEnd();
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}

// Streaming chat. Calls onDelta(textChunk) as tokens arrive; returns the same
// shape as chat() once complete. Same wire formats, retry, and abort behaviour.
export async function chatStream({ spec, messages, tools, signal, onDelta, maxTokens = DEFAULT_MAX_TOKENS }) {
  const { providerId, model, provider } = resolveModel(spec);
  const credential = await freshCredential(providerId);
  if (!credential && !provider.noAuth) throw new Error(`No credential for "${providerId}". Run: nomos connect (or nomos auth login ${providerId})`);
  const route = resolveRoute(provider, credential);

  if (route.format === "openai-responses") {
    return responsesStream({ route, model, messages, tools, signal, onDelta, store: route.store });
  }

  if (route.format === "anthropic-messages") {
    const res = await fetchRetry(`${route.base}/messages`, {
      method: "POST", headers: route.headers, signal,
      body: JSON.stringify(anthropicBody({ model, messages, tools, maxTokens, stream: true })),
    });
    if (!res.ok) throw safeError(res);
    let content = ""; const blocks = [];
    for await (const data of sseData(res)) {
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.type === "content_block_start") {
        blocks[j.index] = j.content_block?.type === "tool_use" ? { type: "tool_use", id: j.content_block.id, name: j.content_block.name, json: "" } : { type: "text" };
      } else if (j.type === "content_block_delta") {
        if (j.delta?.type === "text_delta") { content += j.delta.text; onDelta?.(j.delta.text); }
        else if (j.delta?.type === "input_json_delta" && blocks[j.index]) blocks[j.index].json += j.delta.partial_json;
      } else if (j.type === "message_stop") break;
    }
    const toolCalls = blocks.filter((b) => b?.type === "tool_use").map((b) => ({ id: b.id, name: b.name, args: safeJson(b.json) }));
    return { content, toolCalls, stopReason: toolCalls.length ? "tool_use" : "end_turn" };
  }

  // openai-chat
  const res = await fetchRetry(`${route.base}/chat/completions`, {
    method: "POST", headers: route.headers, signal,
    body: JSON.stringify(openaiBody({ model, messages, tools, maxTokens, maxTokensParam: provider.maxTokensParam, stream: true })),
  });
  if (!res.ok) throw safeError(res);
  let content = ""; const tc = []; let finish;
  for await (const data of sseData(res)) {
    if (data === "[DONE]") break;
    let j; try { j = JSON.parse(data); } catch { continue; }
    const d = j.choices?.[0]?.delta || {};
    if (d.content) { content += d.content; onDelta?.(d.content); }
    if (d.tool_calls) for (const t of d.tool_calls) {
      const i = t.index ?? 0;
      tc[i] = tc[i] || { id: "", name: "", argStr: "" };
      if (t.id) tc[i].id = t.id;
      if (t.function?.name) tc[i].name = t.function.name;
      if (t.function?.arguments) tc[i].argStr += t.function.arguments;
    }
    if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
  }
  return { content, toolCalls: tc.filter(Boolean).map((t) => ({ id: t.id, name: t.name, args: safeJson(t.argStr) })), stopReason: finish };
}

function toOpenAIMessage(m) {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  if (m.toolCalls) return { role: "assistant", content: m.content || "", tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
  return { role: m.role, content: m.content };
}

function toAnthropicMessage(m) {
  if (m.role === "tool") return { role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] };
  if (m.toolCalls) return { role: "assistant", content: [...(m.content ? [{ type: "text", text: m.content }] : []), ...m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args }))] };
  return { role: m.role, content: m.content };
}
