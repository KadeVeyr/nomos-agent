// Model catalog — list the models a connected provider exposes, so the user
// picks from a list instead of memorising a model id.
//
// Primary source is LIVE: we GET {base}/models with the connected credential,
// so the list reflects exactly what THAT key/plan can actually call (better
// than a static catalog that drifts). Falls back to a small curated list when
// the endpoint is unreachable / the provider isn't connected / it returns
// nothing. The credential is sent only as the auth header (same route the
// gateway uses); error reasons are sanitized — no key, no provider body.

import { PROVIDERS } from "./providers.js";
import { getCredential } from "./auth.js";
import { resolveRoute } from "./gateway.js";

// Curated fallback ids (current as of June 2026), used only when the live
// /models call can't be made. Seeded from cited per-provider recon. Keep short:
// this is a safety net, not the source of truth — the live list is.
export const CURATED = {
  anthropic: ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-5", "claude-sonnet-4-5"],
  openai: ["gpt-5.5", "gpt-5.5-2026-04-23", "gpt-5.4", "gpt-5.4-mini", "gpt-5", "gpt-5-mini", "gpt-5-nano"],
  moonshot: ["kimi-k2.7-code", "kimi-k2.6", "kimi-k2.5", "moonshot-v1-128k", "moonshot-v1-32k", "moonshot-v1-8k"],
  deepseek: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
  groq: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant", "qwen/qwen3-32b", "moonshotai/kimi-k2-instruct", "meta-llama/llama-4-scout-17b-16e-instruct", "groq/compound"],
  openrouter: ["anthropic/claude-opus-4.8", "openai/gpt-5.5", "google/gemini-3.1-pro-preview", "google/gemini-3.5-flash", "deepseek/deepseek-v4-pro", "moonshotai/kimi-k2.6", "x-ai/grok-4.20"],
  xai: ["grok-4.3", "grok-4-0709", "grok-4-1-fast-non-reasoning", "grok-3", "grok-3-fast"],
  zai: ["glm-5.1", "glm-5", "glm-5-turbo", "glm-4.7", "glm-4.6", "glm-4.5", "glm-4.5-air", "glm-4.5-x"],
  dashscope: ["qwen3-max", "qwen-max", "qwen-plus", "qwen-flash", "qwen-turbo", "qwen3-vl-plus", "qwen-vl-max", "qwen3-coder-plus", "qwq-plus"],
  google: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3-pro-preview"],
  minimax: ["MiniMax-M2.5", "MiniMax-M2.1", "MiniMax-M1"],
  ollama: ["llama3.2", "llama3.1", "qwen3", "qwen2.5-coder", "gemma3", "deepseek-r1", "mistral", "phi4", "gpt-oss"],
  // Coding-plan subscriptions (ids per OpenCode's catalog):
  "kimi-for-coding": ["k2p7", "k2p6", "k2p5", "kimi-k2-thinking"],
  "zai-coding-plan": ["glm-5.2", "glm-5.1", "glm-4.7", "glm-5-turbo", "glm-5v-turbo", "glm-4.5-air"],
  "opencode-go": ["kimi-k2.7-code", "deepseek-v4-pro", "deepseek-v4-flash", "glm-5.1", "qwen3.7-max", "qwen3.7-plus", "minimax-m3", "minimax-m2.5"],
};

// Parse a provider /models response into a flat list of model ids. Handles the
// OpenAI shape ({ data:[{id}] }), the Anthropic shape ({ data:[{id,display_name}] }),
// and the Ollama native shape ({ models:[{name}] }) / plain string arrays.
export function parseModels(data) {
  const arr = Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.models) ? data.models
    : Array.isArray(data) ? data
    : [];
  return arr
    .map((m) => (typeof m === "string" ? m : m?.id || m?.name || m?.model))
    .filter((s) => typeof s === "string" && s.length)
    // de-dupe while preserving first-seen order, then sort for a stable list
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
}

// Returns { models: string[], source: "live" | "fallback", reason? }.
// Never throws on a network/credential problem — degrades to the fallback so
// the picker always has something to show.
export async function listModels(providerId, { timeoutMs = 8000 } = {}) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new Error(`Unknown provider "${providerId}".`);

  const credential = getCredential(providerId);
  const fallback = (reason) => ({ models: CURATED[providerId] || [], source: "fallback", reason });
  if (!credential && !provider.noAuth) return fallback("not connected");

  const route = resolveRoute(provider, credential);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // For Ollama, the OpenAI-compatible /models lives under the same base; the
    // native /api/tags is a fallback path but /v1/models is fine here.
    const res = await fetch(`${route.base}/models`, { headers: route.headers, signal: controller.signal });
    if (!res.ok) return fallback(`HTTP ${res.status}`); // status only — never the body
    const ids = parseModels(await res.json());
    if (!ids.length) return fallback("empty list");
    return { models: ids, source: "live" };
  } catch (e) {
    return fallback(e?.name === "AbortError" ? "timeout" : "unreachable");
  } finally {
    clearTimeout(timer);
  }
}
