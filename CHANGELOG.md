# Changelog

All notable changes to Nomos. Working toward v1.0.

## [Unreleased]

## [0.3.0] — Agent-loop robustness
*Planned via 3 rounds (deepseek-flash + mimo converged on these exact gaps); live-tested.*
- **Transient-error retry** — 429 / 5xx / network errors retry with exponential backoff + jitter, honoring `Retry-After`. A single hiccup no longer kills a session. Aborts (cancellation) are never retried.
- **Parallel tool execution** — independent tool calls in a turn run concurrently (results preserved in order), instead of serializing and burning the step budget.
- **Context trimming** — on long runs the oldest tool observations are truncated over a char budget, so the transcript can't balloon and degrade late-turn reasoning.
- **Live-tested:** NOMOS added a function + its test across two files with parallel reads, verified green.

## [0.2.0] — Tooling parity
*Planned via 3 rounds (what's next / how to improve / what the others do); built and live-tested.*
- **`glob`** — find files by pattern (`src/**/*.js`, `**/test_*.py`).
- **`multi_edit`** — apply several exact edits to one file atomically (atomic: all-or-nothing).
- **`search`** upgraded to regex (case-insensitive) with literal fallback; 100-result cap; skips `node_modules`/`.git`/`.nomos`.
- **`read_file`** gains `offset`/`limit` (read part of a large file, line-numbered) — Claude Code's Read convention.
- **AGENTS.md / NOMOS.md / CLAUDE.md** project conventions loaded into the agent's system prompt.
- System prompt advertises glob/multi_edit/regex-search; explore→edit→verify discipline.
- **Live-tested:** NOMOS performed a multi-file `sum`→`total` rename using `multi_edit` + `edit_file` + `run_shell`, verified green.

## [0.1.0]
- Headless-first agent: `nomos run -m provider/model "task"` (reason→act→observe loop).
- 13 providers incl. coding-plan subs (kimi-for-coding, zai-coding-plan, opencode-go).
- Tools: read_file, write_file, **edit_file** (surgical edits), list_dir, search, opt-in fetch_url/run_shell.
- Sandboxed: realpath confinement, secret denylist, SSRF guard.
- Multi-auth (API key or plan token), live model picker, file memory, TUI.
- `nomos seat` — headless seat runner emitting a structured transcript (council-grade).
- `nomos council` — cross-provider verification receipts.
- Coding system prompt (explore → surgical edit → verify), 30-step budget.
- Verified live: fixed a real off-by-one bug end-to-end (read → edit_file → run test → PASS).
