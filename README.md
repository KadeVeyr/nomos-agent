# Nomos

**The headless agent you call from your editor. Bring your own subscriptions.**

Most agent tools want to be the place you live — a TUI, a desktop app, an IDE takeover. Nomos goes the other way. It's a provider-neutral agent you call **headless**, from Claude Code, a script, or CI, using **your own** model subscriptions. One prefix-routed gateway, your keys, your machine.

```sh
# bring your own sub (stored locally, server-side, never committed)
nomos auth login anthropic

# call it headless — the front door, pipeable, JSON-able
nomos run -m anthropic/claude-opus-4-8 "Summarise README.md in two lines."
nomos run -m openai/gpt-4o-mini "List the .js files" --json

# or just launch it
nomos
```

## Why

- **Headless-first.** `nomos run -m provider/model "task"` is the primary interface — task in, answer out, clean exit codes. `--json` makes stdout a single JSON object (events on stderr) so it composes in pipelines. The use other tools bury, Nomos leads with.
- **Bring your own subs.** You authenticate your own provider keys. Nomos never ships a key, never asks you to trust a hosted backend with one.
- **Provider-neutral.** A model is `provider/model`. Swap providers by config, not code.

## Providers

`nomos providers` lists them. v0: `anthropic`, `openai`, `moonshot` (Kimi), `deepseek`, `groq`, `openrouter`, `zai` (GLM), `dashscope` (Qwen), `ollama` (local, no key). A key is read from the local store (`nomos auth login`) or the provider's env var.

## Tools

The agent has hands: `read_file`, `write_file`, `list_dir`, `search`, plus `remember`/`recall` (memory). `fetch_url` and `run_shell` are **opt-in** (off by default — network egress and shell on an autonomous agent are exfil/abuse risks). Adding a tool is a small, clean interface in `src/tools.js`.

**Sandboxing** (security model, patterns matched to OpenCode/Hermes — see below):
- File tools are **confined to the working directory** — `../` traversal, absolute-outside paths, and symlink escapes are rejected.
- A **secret denylist** blocks reading or writing `.env*`, `auth.json`, `*.key`/`*.pem`, `.git/`, and the Nomos key store — a malicious prompt can't read your keys.
- `fetch_url` (opt-in) blocks non-http(s), **loopback/private/link-local/cloud-metadata** hosts, IPv4-mapped IPv6, numeric/encoded hosts, and URLs carrying secret-shaped tokens (no SSRF, no obvious key exfil). Enable per-project with `allowFetch` or `--allow-fetch`.
- `run_shell` is **off by default**. Enable per-project (`allowShell: true` in `nomos.json`) or `--allow-shell`. On = the agent can run shell; don't run untrusted prompts with it on. Runs with a timeout + output cap.

## Memory

**Stateful, file-based — not self-modifying.** Nomos keeps durable notes per project in `.nomos/notes.md` and logs each run to `.nomos/sessions/`. It loads notes into context at the start of every run, so it remembers across sessions. `nomos memory` shows them; `nomos memory clear` wipes them. `.nomos/` is gitignored by default.

## Config

`nomos.json` (per-project) or `~/.config/nomos/config.json` (global). Keys: `defaultModel`, `allowShell`, `maxSteps`. Env overrides: `NOMOS_MODEL`, `NOMOS_ALLOW_SHELL`, `NOMOS_MAX_STEPS`. Config holds no secrets.

## Where keys live

Your keys are stored at `~/.local/share/nomos/auth.json` (mode `0600`), **never** in this repo, **never** in logs/memory/stdout, and sent only as an auth header to the provider you chose. Errors are sanitized — no provider body is echoed.

## Security posture (honest)

The credential and tool surfaces follow the patterns proven by OpenCode and Hermes (MIT), with the known holes closed: keys local-only and never surfaced, tools sandboxed and path-confined, SSRF-guarded fetch, validated tool args, shell opt-in. **This is "patterns matched, known holes closed" — not a formal third-party audit.** Found a hole? Open an issue.

## Roadmap (now vs later)

- **v0 (now):** headless + BYO-subs + 9-provider routing + auth + memory + tools + config + TUI = working core.
- **v2+:** a receipt/accountability layer (witness and prove a deliberation), more tools, polish.
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
