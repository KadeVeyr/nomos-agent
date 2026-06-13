// Provider registry — the prefix-routing table.
// A model string is `provider/model` (e.g. "anthropic/claude-opus-4-8",
// "openai/gpt-5.5", "moonshot/kimi-k2"). The gateway looks the provider up
// here, resolves its API base + wire format, and pulls the credential from the
// auth store or the named env var. The registry holds NO secrets — only where
// the secret lives.

export const PROVIDERS = {
  anthropic: {
    name: "Anthropic",
    base: "https://api.anthropic.com/v1",
    format: "anthropic-messages",
    env: "ANTHROPIC_API_KEY",
    keyHint: "sk-ant-…",
  },
  openai: {
    name: "OpenAI",
    base: "https://api.openai.com/v1",
    format: "openai-chat",
    env: "OPENAI_API_KEY",
    keyHint: "sk-…",
  },
  moonshot: {
    name: "Moonshot (Kimi)",
    base: "https://api.moonshot.ai/v1",
    format: "openai-chat",
    env: "MOONSHOT_API_KEY",
    keyHint: "sk-…",
  },
  deepseek: {
    name: "DeepSeek",
    base: "https://api.deepseek.com/v1",
    format: "openai-chat",
    env: "DEEPSEEK_API_KEY",
    keyHint: "sk-…",
  },
  groq: {
    name: "Groq",
    base: "https://api.groq.com/openai/v1",
    format: "openai-chat",
    env: "GROQ_API_KEY",
    keyHint: "gsk_…",
  },
  openrouter: {
    name: "OpenRouter",
    base: "https://openrouter.ai/api/v1",
    format: "openai-chat",
    env: "OPENROUTER_API_KEY",
    keyHint: "sk-or-…",
  },
  zai: {
    name: "Z.ai (GLM)",
    base: "https://api.z.ai/api/paas/v4",
    format: "openai-chat",
    env: "ZAI_API_KEY",
    keyHint: "…",
  },
  dashscope: {
    name: "DashScope (Qwen)",
    base: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    format: "openai-chat",
    env: "DASHSCOPE_API_KEY",
    keyHint: "sk-…",
  },
  ollama: {
    name: "Ollama (local)",
    base: "http://localhost:11434/v1",
    format: "openai-chat",
    env: "OLLAMA_API_KEY",
    keyHint: "(none — local)",
    noAuth: true, // local server; no credential required
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
