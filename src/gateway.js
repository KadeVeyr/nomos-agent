// Gateway — prefix → API base + credential → normalized chat call.
//
// Supports two wire formats (covers ~every provider): OpenAI chat-completions
// and Anthropic messages. Both normalize to { content, toolCalls, stopReason }.
// The credential is read from the server-side store and sent ONLY as an auth
// header. Provider error bodies are NEVER returned raw to the caller (they can
// echo request headers); we surface a sanitized status + message.

import { resolveModel } from "./providers.js";
import { getKey } from "./auth.js";

function authHeaders(provider, key) {
  if (provider.format === "anthropic-messages") {
    return { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  }
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
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
  // credentials. A status-only message cannot leak a key.
  return new Error(`Provider returned HTTP ${res.status}. ${res.status === 401 ? "Check the key for this provider (nomos auth login)." : "Request failed."}`);
}

// One chat turn. messages = [{role, content, toolCalls?, toolResult?}] in a
// provider-neutral shape; we translate per format.
export async function chat({ spec, messages, tools, signal }) {
  const { providerId, model, provider } = resolveModel(spec);
  const key = getKey(providerId);
  if (!key) {
    throw new Error(`No credential for "${providerId}". Run: nomos auth login ${providerId}`);
  }

  if (provider.format === "anthropic-messages") {
    const sys = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const conv = messages.filter((m) => m.role !== "system").map(toAnthropicMessage);
    const res = await fetch(`${provider.base}/messages`, {
      method: "POST",
      headers: authHeaders(provider, key),
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
  const res = await fetch(`${provider.base}/chat/completions`, {
    method: "POST",
    headers: authHeaders(provider, key),
    body: JSON.stringify({ model, messages: messages.map(toOpenAIMessage), tools: tools && tools.length ? toOpenAITools(tools) : undefined }),
    signal,
  });
  if (!res.ok) throw await safeError(res);
  const data = await res.json();
  const msg = data.choices?.[0]?.message || {};
  const toolCalls = (msg.tool_calls || []).map((c) => ({ id: c.id, name: c.function.name, args: safeJson(c.function.arguments) }));
  return { content: msg.content || "", toolCalls, stopReason: data.choices?.[0]?.finish_reason };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
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
