# Nomos

**The headless agent you call from your editor. Bring your own subscriptions.**

Most agent tools want to be the place you live — a TUI, a desktop app, an IDE takeover. Nomos goes the other way. It's a provider-neutral agent you call **headless**, from Claude Code, a script, or CI, using **your own** model subscriptions. One prefix-routed gateway, your keys, your machine.

```sh
# connect a provider — your paid plan OR an API key (stored locally, never committed)
nomos connect

# call it headless — the front door, pipeable, JSON-able
nomos run -m anthropic/claude-opus-4-8 "Summarise README.md in two lines."
nomos run -m openai/gpt-4o-mini "List the .js files" --json

# or just launch it
nomos
```

## Why

- **Receipts, not vibes.** `nomos council` runs a task, then has a **different provider** adversarially verify the answer, and emits a content-hashed **receipt** proving an independent adversary checked it. Ship the irreversible change without a human reviewer in the loop — and keep the proof. No other harness ships cross-provider verification as a native primitive.
- **Headless-first.** `nomos run -m provider/model "task"` is the primary interface — task in, answer out, clean exit codes. `--json` makes stdout a single JSON object (events on stderr) so it composes in pipelines. The use other tools bury, Nomos leads with.
- **Bring your own subs.** You connect your own providers — a **paid-plan token** or an **API key**, per provider. Nomos never ships a credential, never asks you to trust a hosted backend with one.
- **Provider-neutral.** A model is `provider/model`. Swap providers by config, not code.

## Providers

`nomos providers` lists them. Direct APIs: `anthropic`, `openai`, `moonshot` (Kimi), `deepseek`, `groq`, `openrouter`, `xai` (Grok), `zai` (GLM), `dashscope` (Qwen), `ollama` (local, no key). Coding-plan subscriptions (their own endpoints, OpenAI-compatible — same ids OpenCode uses): `kimi-for-coding`, `zai-coding-plan`, `opencode-go`.

## Connecting (paid plan or API key)

```sh
nomos connect                # pick a provider → choose method → paste the secret (hidden)
nomos auth list              # show what's connected, and by which method
nomos auth logout moonshot   # remove a stored credential
```

`nomos connect` (or `/connect` in the TUI) walks you through it. **Every provider connects with an API key or plan token** — paste the credential your account/subscription issues. A coding-plan sub (e.g. `kimi-for-coding`, `zai-coding-plan`) is its own provider that routes to that plan's endpoint, so you run on the subscription you already pay for. The credential's type is stored alongside it, so the gateway sends the correct header to the correct endpoint. A quick path also exists: `nomos auth login <provider>` stores a plain API key, and any provider's env var (e.g. `ANTHROPIC_API_KEY`) is read if set.

## Pick a model

You don't need to memorise model ids. After connecting, Nomos lists a provider's models **live** — fetched from its `/models` endpoint with your key, so you see exactly what your plan can call (with a small curated fallback if the endpoint is unreachable).

```sh
nomos models                 # list models for every connected provider
nomos models kimi-for-coding # list one provider's models
```

In the TUI, launching `nomos` opens a picker: choose a provider, then type to filter the model list and pick by number. `/model` reopens it any time.

## Council — cross-provider receipts (the differentiator)

OpenCode and Hermes run agents. Nomos runs an agent **and proves a second, independent provider checked its work.**

```sh
# proposer answers; a DIFFERENT provider adversarially verifies; you get a receipt
nomos council -m kimi-for-coding/k2p6 "refactor utils.js and explain the risk" \
  --verifier openai/gpt-5.5
```

The verifier is told to **refute, not agree**, and can return `FAIL` (a blocking verdict → exit code 2, so it gates a CI step). The run writes a receipt to `.nomos/receipts/<id>.json`:

```json
{
  "nomos_receipt": "0.1",
  "id": "a1b2c3d4e5f6",
  "task": "refactor utils.js and explain the risk",
  "proposer": { "model": "kimi-for-coding/k2p6", "provider": "kimi-for-coding", "output": "…" },
  "verifier": { "model": "openai/gpt-5.5", "provider": "openai", "verdict": "CONCERNS", "reasoning": "…" },
  "cross_provider": true,
  "verdict": "CONCERNS",
  "hash": "sha256…"
}
```

The `hash` binds the task, the answer, and the verifier's reasoning — tamper any of them and the id changes. **`cross_provider` is the whole point:** a model grading its own family is grading its own homework, and the receipt says so honestly (`cross_provider: false` + a warning if you point both at the same provider). Omit `--verifier` and Nomos auto-picks a connected provider different from the proposer. The receipt carries no secrets — commit it, attach it to a PR, hand it to a reviewer who wasn't there.

## Tools

The agent has hands: `read_file`, `write_file`, `list_dir`, `search`, plus `remember`/`recall` (memory). `fetch_url` and `run_shell` are **opt-in** (off by default — network egress and shell on an autonomous agent are exfil/abuse risks). Adding a tool is a small, clean interface in `src/tools.js`.

**Sandboxing** (security model, patterns matched to OpenCode/Hermes — see below):
- File tools are **confined to the working directory** — `../` traversal, absolute-outside paths, and symlink escapes are rejected.
- A **secret denylist** blocks reading or writing `.env*`, `auth.json`, `*.key`/`*.pem`, `.git/`, and the Nomos key store — a malicious prompt can't read your keys.
- `fetch_url` (opt-in) blocks non-http(s), **loopback/private/link-local/cloud-metadata** hosts, IPv4-mapped IPv6, numeric/encoded hosts, and URLs carrying secret-shaped tokens. This is a best-effort SSRF guard, **not** network isolation (e.g. DNS-rebinding between check and connect is a known class it doesn't fully close) — don't enable it for untrusted prompts on a host with sensitive local services. Enable per-project with `allowFetch` or `--allow-fetch`.
- `run_shell` is **off by default**. Enable per-project (`allowShell: true` in `nomos.json`) or `--allow-shell`. On = the agent can run shell; don't run untrusted prompts with it on. Runs with a timeout + output cap.

## Memory

**Stateful, file-based — not self-modifying.** Nomos keeps durable notes per project in `.nomos/notes.md` and logs each run to `.nomos/sessions/`. It loads notes into context at the start of every run, so it remembers across sessions. `nomos memory` shows them; `nomos memory clear` wipes them. `.nomos/` is gitignored by default.

## Config

`nomos.json` (per-project) or `~/.config/nomos/config.json` (global). Keys: `defaultModel`, `allowShell`, `maxSteps`. Env overrides: `NOMOS_MODEL`, `NOMOS_ALLOW_SHELL`, `NOMOS_MAX_STEPS`. Config holds no secrets. For safety, a **project** `nomos.json` cannot set capability flags (`allowShell`/`allowFetch`) or `defaultModel` — a cloned repo must not silently grant shell/network or choose which provider your task egresses to; those come only from your global config, env, or an explicit flag.

## Where credentials live

Your credentials — API keys **and** paid-plan tokens alike — are stored at `~/.local/share/nomos/auth.json` (mode `0600`), **never** in this repo, **never** in logs/memory/stdout, and sent only as an auth header to the provider you chose. Errors are sanitized — no provider body is echoed.

## Security posture (honest)

The credential and tool surfaces follow the patterns proven by OpenCode and Hermes (MIT), with the known holes closed: keys local-only and never surfaced, tools sandboxed and path-confined, SSRF-guarded fetch, validated tool args, shell opt-in. **This is "patterns matched, known holes closed" — not a formal third-party audit.** Found a hole? Open an issue.

## Roadmap (now vs later)

- **v0 (now):** headless + BYO-subs + multi-provider routing (direct APIs + coding-plan subs) + multi-auth (plan **or** key) + live model picker + memory + tools + config + TUI + **cross-provider verification receipts** (`nomos council`) = working core.
- **v2+:** richer receipts (multi-round, parent/child receipt graphs, a standalone verifier), more tools, polish.
- **v7:** local-first + Rust-hardened sovereign build.

Not a platform, not an OS, not self-improving. v0 is a working, honest harness.

## Install

```sh
git clone <repo> nomos-agent && cd nomos-agent
npm link        # or: node bin/nomos.js …
```

Node 18+. Zero runtime dependencies.

## License

MIT. Free, open, fork it. See `LICENSE`.
