// Gateway — prefix → API base + credential → normalized chat call.
//
// Supports two wire formats (covers ~every provider): OpenAI chat-completions
// and Anthropic messages. Both normalize to { content, toolCalls, stopReason }.
//
// Multi-auth: the credential the user connected (api key / plan token / OAuth
// token) carries a METHOD. resolveRoute() looks that method up in the provider's
// `auth` table to pick the right endpoint base + wire format + auth header for
// THAT method (a paid-plan token can route to a different endpoint than the
// public API key). The secret is read from the server-side store and sent ONLY
// as an auth header. Provider error bodies are NEVER returned raw to the caller
// (they can echo request headers); we surface a sanitized status + message.

import { resolveModel } from "./providers.js";
import { getCredential } from "./auth.js";

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
  if (entry?.extraHeaders && typeof entry.extraHeaders === "object") {
    for (const [k, v] of Object.entries(entry.extraHeaders)) if (typeof v === "string") headers[k] = v;
  }
  return { base, format, headers };
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
export async function chat({ spec, messages, tools, signal }) {
  const { providerId, model, provider } = resolveModel(spec);
  const credential = getCredential(providerId);
  if (!credential && !provider.noAuth) {
    throw new Error(`No credential for "${providerId}". Run: nomos connect (or nomos auth login ${providerId})`);
  }
  const route = resolveRoute(provider, credential);

  if (route.format === "anthropic-messages") {
    const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const conv = messages.filter((m) => m.role !== "system").map(toAnthropicMessage);
    const res = await fetchRetry(`${route.base}/messages`, {
      method: "POST",
      headers: route.headers,
      body: JSON.stringify({ model, max_tokens: 4096, system: sys || undefined, messages: conv, tools: tools && tools.length ? toAnthropicTools(tools) : undefined }),
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
    body: JSON.stringify({ model, messages: messages.map(toOpenAIMessage), tools: tools && tools.length ? toOpenAITools(tools) : undefined }),
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
export async function chatStream({ spec, messages, tools, signal, onDelta }) {
  const { providerId, model, provider } = resolveModel(spec);
  const credential = getCredential(providerId);
  if (!credential && !provider.noAuth) throw new Error(`No credential for "${providerId}". Run: nomos connect (or nomos auth login ${providerId})`);
  const route = resolveRoute(provider, credential);

  if (route.format === "anthropic-messages") {
    const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const conv = messages.filter((m) => m.role !== "system").map(toAnthropicMessage);
    const res = await fetchRetry(`${route.base}/messages`, {
      method: "POST", headers: route.headers, signal,
      body: JSON.stringify({ model, max_tokens: 4096, system: sys || undefined, messages: conv, tools: tools && tools.length ? toAnthropicTools(tools) : undefined, stream: true }),
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
    body: JSON.stringify({ model, messages: messages.map(toOpenAIMessage), tools: tools && tools.length ? toOpenAITools(tools) : undefined, stream: true }),
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
