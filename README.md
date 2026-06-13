# Nomos

**The headless agent you call from your editor. Bring your own subscriptions.**

Most agent tools want to be the place you live — a TUI, a desktop app, an IDE takeover. Nomos goes the other way. It's a small agent you call **headless**, from Claude Code, a script, or CI, using **your own** model subscriptions. Provider-neutral by design: one prefix-routed gateway, your keys, your machine.

```sh
# bring your own sub (stored locally, server-side, never committed)
nomos auth login anthropic

# call it headless — the front door
nomos run -m anthropic/claude-opus-4-8 "What is (12 + 5) * 3? Use the calculator."

# or just launch it
nomos
```

## Why

- **Headless-first.** `nomos run -m provider/model "task"` is the primary interface — pipe a task in, get the answer out. Drop it into any editor or pipeline.
- **Bring your own subs.** You authenticate your own provider keys. Nomos never ships a key, never asks you to trust a hosted backend with one.
- **Provider-neutral.** A model is `provider/model`. Swap `anthropic/…` for `openai/…` or `moonshot/…` without changing anything else.
- **Real tools, verifiable loop.** v0 ships one sandboxed tool (a calculator) through a real agent loop — a harness, not a chatbot wrapper.

## Install

```sh
git clone <repo> nomos-agent && cd nomos-agent
npm link        # or: node bin/nomos.js …
```

Node 18+. Zero runtime dependencies.

## Providers

`nomos providers` lists them. v0: `anthropic`, `openai`, `moonshot` (Kimi), `deepseek`, `groq`, `openrouter`. A key is read from the local store (`nomos auth login`) or the provider's env var.

## Where keys live

Your keys are stored at `~/.local/share/nomos/auth.json` (mode `0600`), **never** in this repo and **never** sent anywhere except as an auth header to the provider you chose. Nothing in this codebase holds a secret.

## What it does NOT do yet (roadmap, not done)

- No multi-provider routing policy, no fallback — you pick the model per call.
- No receipt / verification layer yet (the cross-provider accountability layer is the roadmap differentiator, not v0).
- No persistence/memory across runs. No web/shell/file tools (only the sandboxed calculator).
- Not a platform, not an OS, not self-improving. v0 is a working, minimal harness.

## License

MIT. Free, open, fork it. See `LICENSE`.
