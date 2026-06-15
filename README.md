# Nomos

**A coding agent for your terminal — that proves its work.** Bring your own model.

Nomos reads your code, edits it surgically, runs your tests, and shows its work — streaming, in your terminal — on **your own** model subscriptions or API keys. It's in the same category as OpenCode, Claude Code, and Hermes. The thing they don't do: Nomos can run a change past a **second, independent provider**, show you the review as it happens, and leave you a **tamper-evident, forensically auditable receipt** — so when something breaks three weeks from now, you can see exactly what was checked, by whom, against which code.

```sh
npm link                                   # make `nomos` a global command
nomos connect                              # pick a provider, paste your key (stored locally, 0600)
nomos run -m kimi-for-coding/k2p6 "fix the failing test" --allow-shell
```

## The second seat — make the work checkable

AI wrote your change. Do you trust it? Have a **different provider** review it, and get a receipt you can re-check forever:

```sh
nomos run -m kimi-for-coding/k2p6 "fix the retry bug" --allow-shell \
  --verify --verifier openai/gpt-5.5
```

```
· edit_file retry.js
  → Edited retry.js — 1 replacement.
Fixed the off-by-one in the retry loop (started at 1, skipping the first attempt).

  △ openai/gpt-5.5 is reviewing kimi-for-coding/k2p6's work…

── △ cross-checked · receipt 507a57770abb
  openai/gpt-5.5 reviewed kimi-for-coding/k2p6's work  (kimi-for-coding → openai, independent)
  agreed — no issues flagged — checked the loop bound and the first-attempt case; correct
  bound to code be024f2afa19
  re-checkable offline · not a certification · trust terminates at the generator
  `nomos receipt verify` re-checks the hash · `nomos audit` walks the chain
```

A receipt is honest about what it is. **It records an event — a second model reviewed this work — not a guarantee that the code is correct.** It's keyless content-addressing, not a signature: it proves the receipt hasn't been altered since it was written and lets anyone re-check it offline, but trust in a receipt is trust in whoever generated it (e.g. your own CI). No green checkmark, no "verified," no badge that borrows a guarantee Nomos can't make.

### The chain — the moment of dispute

Every receipt links to the previous one, so a directory of them is a tamper-evident, append-only history under one pinnable id. When something breaks and you ask *"what happened?"*, `nomos audit` tells the story:

```sh
nomos audit .nomos/receipts
```

```
✓ chain intact (hashes match — no entry inserted, deleted, or reordered)
  3 cross-checks, head 828c8d18751b — pin this id

  △ 59a9f3d2  openai/gpt-5.5 reviewed kimi-for-coding/k2p6 · agreed · code a1fe4fc3
        checked the parser handles quoted commas + the trailing-newline guard; correct
  △ 97b61657  openai/gpt-5.5 reviewed kimi-for-coding/k2p6 · agreed · code f68a6294
        added TTL expiry; verified lazy reaping in get/has/size; sound
  △ 828c8d18  openai/gpt-5.5 reviewed zai-coding-plan/glm-5.2 · concerns · code 77078385
        the migration drops a column without a backup step — flagged

  not a certification · re-checkable offline · trust terminates at the generator
```

Hand a receipt to anyone; they re-check it offline with no provider call (`nomos receipt verify <file>`, exit 2 if altered). Insert, delete, or reorder a receipt in the chain and `nomos audit` catches it. The full contract — the canonical hash, the chain, the honest scope — is in [docs/RECEIPT_SPEC.md](docs/RECEIPT_SPEC.md); anyone can re-implement the check.

> Verification is **opt-in** — `nomos run` is fast and quiet by default. Add `--verify` (and a `--verifier` from a *different* provider) when a change is worth a second pair of eyes; the review streams live, and the receipt is the trophy. Or set a default mode so it happens for you:
>
> ```sh
> export NOMOS_VERIFIER=openai/gpt-5.5
> export NOMOS_VERIFY=risky      # off (default) | risky | always
> ```
>
> **`risky`** auto-cross-checks only ship-risk changes — a targeted, deterministic read of the diff: a sensitive path (auth, secrets/crypto, payment, migration, CI/deploy, dependency manifests, `.env*`, shell scripts), a big deletion, more than one code file, or a large change. A trivial single edit or a docs change is left alone. The receipt says *why* it was checked (`auto: touched auth / session`). **`always`** checks everything; **`off`** is the default. (`verifier` is an egress choice — a cloned repo's `nomos.json` can't set it.)

## Reversible & resumable

- **Undo a run.** Before its first write, `nomos run` snapshots the repo (zero side effects). `nomos undo` reverts the run's tracked changes — saving a pre-undo safety snapshot first (nothing is ever lost) and *reporting*, never deleting, files the agent created.
- **Resume a run.** Every turn is logged to `~/.local/share/nomos/sessions/<id>.jsonl`. A crash or step-cap doesn't lose state — `nomos resume <id>` continues from where it stopped; `nomos sessions` lists them.

## What it does

- **Explore → edit → verify.** Reads the files it'll touch, makes the smallest correct change, and (with `--allow-shell`) runs the build/tests to confirm — then reports what it changed and how to check. It reviews its own diff with the built-in read-only `git` tool before finishing.
- **Doesn't thrash.** If it repeats a failing action, it's nudged to change approach and ends early with an honest "stuck on X" rather than burning the step budget.
- **Honest about workarounds.** If your declared test command is broken and it succeeds another way, it tells you — instead of reporting a green that hides a broken config.
- **Real tools:** `read_file` (offset/limit), `write_file`, `edit_file`, `multi_edit` (atomic), `glob`, `search` (regex), `list_dir`, a hardened read-only `git` (status/diff/log/show/branch — no shell needed), plus opt-in `run_shell`/`fetch_url`, and durable `remember`/`recall` memory.
- **Per-tool permissions:** `allow` / `ask` / `deny` per class (read / write / git / fetch / shell). Headless resolves `ask`→`deny` so CI never hangs; a repo's `nomos.json` can only *tighten*, never grant.
- **Project conventions:** loads `AGENTS.md` / `NOMOS.md` / `CLAUDE.md`, and a `nomos.json` `commands` map (test/build/lint) so it uses your real commands.

## Providers — bring your own subs

`nomos providers` lists them. Direct APIs: `anthropic`, `openai`, `google` (Gemini), `moonshot` (Kimi), `deepseek`, `groq`, `openrouter`, `xai` (Grok), `zai` (GLM), `dashscope` (Qwen), `minimax`, `ollama`. Coding-plan subscriptions on their own endpoints (the ids OpenCode uses): `kimi-for-coding`, `zai-coding-plan`, `opencode-go`.

```sh
nomos connect                  # provider → method → paste secret (hidden); plan token OR API key
nomos models                   # live model list per connected provider
nomos                          # interactive TUI
```

A model is `provider/model`. Swap providers by config, not code. Your keys live at `~/.local/share/nomos/auth.json` (mode `0600`) — never in the repo, logs, or stdout.

## Editor integration (MCP) & CI

```sh
nomos mcp            # stdio JSON-RPC server; exposes nomos_verify + nomos_seat to Claude Code / Cursor / Codex
```

`nomos_verify` has a *different* model review the diff your editor just produced and returns the honest receipt. And `nomos verify --against origin/<base>` exits 2 on a flagged change, so it gates a PR:

```yaml
# .github/workflows/nomos-verify.yml
on: [pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: git clone https://github.com/KadeVeyr/nomos-agent && ( cd nomos-agent && npm link )
      - run: nomos verify --against origin/${{ github.base_ref }} -m anthropic/claude-opus-4-8
        env: { ANTHROPIC_API_KEY: "${{ secrets.ANTHROPIC_API_KEY }}" }
```

## Safety

- File tools are **confined to the working directory** (realpath-checked; `../`, absolute-outside, and symlink escapes rejected). A **secret denylist** blocks `.env*`, `auth.json`, `*.key`/`*.pem`/keystores, `.git/`, the key store.
- The read-only `git` tool can't mutate the repo, escape the directory, read a denylisted secret, or run code from a hostile repo's git config (env-scrubbed, config-execution neutralized) — verified against a hostile repo.
- `run_shell` / `fetch_url` are **opt-in** (off by default); `fetch_url` has a best-effort SSRF guard. A project `nomos.json` **cannot** grant capabilities or pick the model.

"Patterns matched, known holes closed," **not** a third-party audit. Found a hole? Open an issue.

## Install & test

```sh
git clone https://github.com/KadeVeyr/nomos-agent && cd nomos-agent
npm link
npm test            # 76 tests, zero dependencies
```

Node 18+. **Zero runtime dependencies.** See [CHANGELOG.md](CHANGELOG.md) · [docs/RECEIPT_SPEC.md](docs/RECEIPT_SPEC.md).

## License

MIT. Free, open, fork it.
