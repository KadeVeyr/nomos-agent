// Provider registry — the prefix-routing table.
//
// A model string is `provider/model` (e.g. "anthropic/claude-opus-4-8",
// "openai/gpt-5.5", "moonshot/kimi-k2"). The gateway looks the provider up
// here, resolves its API base + wire format, and pulls the credential from the
// auth store or the named env var. The registry holds NO secrets — only where
// the secret lives and how to route it.
//
// MULTI-AUTH (`auth`): each provider advertises the connect methods it genuinely
// supports. A method is one of:
//   - apikey       a normal API key                         (works for all)
//   - plan-token   a token a paid plan/subscription issues   (may route to a
//                  different endpoint than the public API key)
//   - plan-oauth   a plan login token (stored as an OAuth token)
// Per-method fields override the provider defaults for THAT method:
//   { method, label, hint, base?, format?, headerStyle?, betaHeader?, extraHeaders? }
// headerStyle: "x-api-key" (Anthropic) | "bearer" (default for OpenAI-format).
// Omitted overrides fall back to the provider's base/format. Only methods with
// a real, known route are listed — we do not advertise a plan path we can't
// honestly fulfil.

const KEY = (hint) => ({ method: "apikey", label: "API key", hint });

export const PROVIDERS = {
  anthropic: {
    name: "Anthropic",
    base: "https://api.anthropic.com/v1",
    format: "anthropic-messages",
    env: "ANTHROPIC_API_KEY",
    keyHint: "sk-ant-…",
    auth: [KEY("sk-ant-…")],
  },
  openai: {
    name: "OpenAI",
    base: "https://api.openai.com/v1",
    format: "openai-chat",
    env: "OPENAI_API_KEY",
    keyHint: "sk-…",
    // OpenAI's reasoning models reject "max_tokens" and require this field name.
    maxTokensParam: "max_completion_tokens",
    auth: [KEY("sk-…")],
  },
  moonshot: {
    name: "Moonshot (Kimi)",
    base: "https://api.moonshot.ai/v1",
    format: "openai-chat",
    env: "MOONSHOT_API_KEY",
    keyHint: "sk-…",
    auth: [KEY("sk-…")],
  },
  deepseek: {
    name: "DeepSeek",
    base: "https://api.deepseek.com/v1",
    format: "openai-chat",
    env: "DEEPSEEK_API_KEY",
    keyHint: "sk-…",
    auth: [KEY("sk-…")],
  },
  groq: {
    name: "Groq",
    base: "https://api.groq.com/openai/v1",
    format: "openai-chat",
    env: "GROQ_API_KEY",
    keyHint: "gsk_…",
    auth: [KEY("gsk_…")],
  },
  openrouter: {
    name: "OpenRouter",
    base: "https://openrouter.ai/api/v1",
    format: "openai-chat",
    env: "OPENROUTER_API_KEY",
    keyHint: "sk-or-…",
    auth: [KEY("sk-or-…")],
  },
  xai: {
    name: "xAI (Grok)",
    base: "https://api.x.ai/v1",
    format: "openai-chat",
    env: "XAI_API_KEY",
    keyHint: "xai-…",
    auth: [KEY("xai-…")],
  },
  zai: {
    name: "Z.ai (GLM)",
    base: "https://api.z.ai/api/paas/v4",
    format: "openai-chat",
    env: "ZAI_API_KEY",
    keyHint: "…",
    auth: [KEY("API key — api.z.ai")],
  },
  dashscope: {
    name: "DashScope (Qwen)",
    base: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    format: "openai-chat",
    env: "DASHSCOPE_API_KEY",
    keyHint: "sk-…",
    auth: [KEY("sk-…")],
  },
  google: {
    name: "Google (Gemini)",
    // Gemini's OpenAI-compatible endpoint (gateway appends /chat/completions + /models).
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    format: "openai-chat",
    env: "GEMINI_API_KEY",
    keyHint: "AIza… (Google AI Studio key)",
    auth: [KEY("AIza… — Google AI Studio")],
  },
  minimax: {
    name: "MiniMax",
    base: "https://api.minimax.io/v1",
    format: "openai-chat",
    env: "MINIMAX_API_KEY",
    keyHint: "MiniMax API key",
    auth: [KEY("MiniMax API key")],
  },
  // ── Coding-plan subscriptions: dedicated endpoints (OpenAI-compatible),
  // mirroring the provider ids OpenCode uses, so the same model strings work
  // (e.g. "kimi-for-coding/k2p6"). The credential is the token your plan issues,
  // pasted via the API-key method. Endpoints sourced from OpenCode's provider
  // catalog (the working setup), not guessed. ──
  "kimi-for-coding": {
    name: "Kimi for Coding",
    base: "https://api.kimi.com/coding/v1",
    format: "anthropic-messages", // endpoint speaks Anthropic (OpenCode uses @ai-sdk/anthropic);
                                  // POSTs to {base}/messages with x-api-key (ANTHROPIC_API_KEY convention)
    env: "KIMI_API_KEY",
    keyHint: "Kimi for Coding plan token (sk-…)",
    auth: [KEY("Kimi for Coding plan token (sk-…)")],
  },
  "zai-coding-plan": {
    name: "Z.AI Coding Plan (GLM)",
    base: "https://api.z.ai/api/coding/paas/v4",
    format: "openai-chat",
    env: "ZHIPU_API_KEY",
    keyHint: "GLM Coding Plan token",
    auth: [KEY("GLM Coding Plan token")],
  },
  "opencode-go": {
    name: "OpenCode Go",
    base: "https://opencode.ai/zen/go/v1",
    format: "openai-chat",
    env: "OPENCODE_API_KEY",
    keyHint: "OpenCode Go token",
    auth: [KEY("OpenCode Go token")],
  },
  ollama: {
    name: "Ollama (local)",
    base: "http://localhost:11434/v1",
    format: "openai-chat",
    env: "OLLAMA_API_KEY",
    keyHint: "(none — local)",
    noAuth: true, // local server; no credential required
    auth: [],
  },
};

// Split "provider/model" into { providerId, model, provider }.
// Throws a clear error if the prefix is unknown — never guesses.
export function resolveModel(spec) {
  const slash = spec.indexOf("/");
  if (slash === -1) {
    throw new Error(
      `Model "${spec}" has no provider prefix. Use "provider/model", e.g. "anthropic/claude-opus-4-8". Run "nomos providers" to list.`,
    );
  }
  const providerId = spec.slice(0, slash);
  const model = spec.slice(slash + 1);
  const provider = PROVIDERS[providerId];
  if (!provider) {
    throw new Error(
      `Unknown provider "${providerId}". Run "nomos providers" to list the supported ones.`,
    );
  }
  if (!model) throw new Error(`Model "${spec}" is missing the model name after the "/".`);
  return { providerId, model, provider };
}

export function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({ id, ...p }));
}
