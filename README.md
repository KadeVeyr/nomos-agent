# Nomos

**A coding agent for your terminal. Bring your own model.**

Nomos reads your code, edits it surgically, runs your tests, and shows its work — streaming, in your terminal — using **your own** model subscriptions or API keys. It's in the same category as OpenCode, Claude Code, and Hermes, with two things they don't do: it's truly provider-neutral (any of 13 providers, including coding-plan subscriptions, by config not code), and it can run a change past a **second, independent provider** and hand you a tamper-evident receipt.

```sh
npm link                                   # make `nomos` a global command
nomos connect                              # pick a provider, paste your key (stored locally, 0600)
nomos run -m kimi-for-coding/k2p6 "fix the failing test" --allow-shell
```

```
▸ kimi-for-coding/k2p6 · /your/repo · shell on
· read_file test.mjs
· read_file sum.js
· edit_file sum.js
  → Edited sum.js — 1 replacement.
· run_shell node test.mjs
  → PASS
Fixed the off-by-one in sum.js (loop started at 1, skipping the first element).
── ✓ done in 4.4s · 2 read, 1 edit, 1 shell
```

## What it does

- **Explore → edit → verify.** It reads the files it'll touch, makes the smallest correct change with surgical edits, and (with `--allow-shell`) runs the build/tests to confirm — then reports what it changed and how to check.
- **Streams.** Tokens and tool calls appear as they happen, with a `✓ done in Xs` summary. No blank-screen wait.
- **Real tools:** `read_file` (with line offset/limit), `write_file`, `edit_file` (exact-substring replace), `multi_edit` (atomic multi-edit), `glob`, `search` (regex), `list_dir`, plus opt-in `run_shell` and `fetch_url`, and durable `remember`/`recall` memory.
- **Robust loop:** parallel tool calls, retry-with-backoff on transient API errors (429/5xx), context trimming on long runs, a 30-step budget.
- **Project conventions:** drops an `AGENTS.md` / `NOMOS.md` / `CLAUDE.md` into its system prompt automatically.

## Providers — bring your own subs

`nomos providers` lists them. Direct APIs: `anthropic`, `openai`, `moonshot` (Kimi), `deepseek`, `groq`, `openrouter`, `xai` (Grok), `zai` (GLM), `dashscope` (Qwen), `ollama` (local). Coding-plan subscriptions on their own endpoints (the same ids OpenCode uses): `kimi-for-coding`, `zai-coding-plan`, `opencode-go`.

```sh
nomos connect                  # provider → method → paste secret (hidden); plan token OR API key
nomos models                   # live model list per connected provider (fetched with your key)
nomos                          # interactive TUI: pick a model, then chat/code
```

A model is `provider/model`. Swap providers by config, not code. Nomos never ships a credential and never asks you to trust a hosted backend with one — your keys live at `~/.local/share/nomos/auth.json` (mode `0600`), never in the repo, logs, or stdout.

## Headless & scriptable

`nomos run` is pipeable; `--json` makes stdout a single JSON object (events on stderr) with clean exit codes. And `nomos seat` runs a directive as a one-shot **council seat**, returning a structured, hashable transcript:

```sh
echo "List the .js files and explain one" | nomos run -m openai/gpt-5.5 --json
nomos seat -f directive.md -m kimi-for-coding/k2p6 --json   # → {status, output, final_block, duration_ms, …}
```

## Cross-provider receipts

Run a task, then have a **different provider** adversarially verify it and emit a content-hashed receipt:

```sh
nomos council -m kimi-for-coding/k2p6 "refactor utils.js" --verifier openai/gpt-5.5
```

The verifier is told to **refute, not agree**, and can return `FAIL` (exit code 2 — gates a CI step). The receipt (`.nomos/receipts/<id>.json`) binds the task + answer + verifier reasoning in a sha256; `cross_provider: true` is the point — a model grading its own family is grading its own homework, and the receipt says so honestly. It carries no secrets: commit it, attach it to a PR.

## Safety

- File tools are **confined to the working directory** — `../` traversal, absolute-outside paths, and symlink escapes are rejected (realpath-checked).
- A **secret denylist** blocks reading/writing `.env*`, `auth.json`, `*.key`/`*.pem`, `.git/`, and the key store.
- `run_shell` and `fetch_url` are **opt-in** (off by default). `fetch_url` has a best-effort SSRF guard (loopback/private/metadata/encoded hosts) — not full network isolation; don't enable it on untrusted prompts. The command is always shown before `run_shell` runs.
- A project `nomos.json` **cannot** grant capabilities or pick the model — a cloned repo can't silently enable shell/network or choose where your code egresses.

This is "patterns matched, known holes closed," **not** a third-party audit. Found a hole? Open an issue.

## Config & memory

`nomos.json` (project) or `~/.config/nomos/config.json` (global). Keys: `defaultModel`, `allowShell`, `maxSteps`. Env: `NOMOS_MODEL`, `NOMOS_ALLOW_SHELL`, `NOMOS_MAX_STEPS`. Durable per-project notes live in `.nomos/notes.md` (gitignored), loaded into context each run.

## Install & test

```sh
git clone <repo> nomos-agent && cd nomos-agent
npm link            # or: node bin/nomos.js …
npm test            # 22 tests, zero dependencies
```

Node 18+. **Zero runtime dependencies.** See [CHANGELOG.md](CHANGELOG.md).

## License

MIT. Free, open, fork it.
