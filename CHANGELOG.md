# Changelog

All notable changes to Nomos.

## [Unreleased]
- **Transparency on workarounds** — when a command or tool the user/project declared FAILS and the agent succeeds by another route (e.g. the project's test command errors and it runs a different one), it now MUST surface the discrepancy in its final answer instead of silently reporting green. Closes a trust-eroding behaviour where a "passing" run could mask a broken project test command. (Verified: the agent now reports "the project's test command X failed: …; I verified with Y instead — use Z".)
- **Per-tool permissions (`allow` | `ask` | `deny` per class)** — every tool maps to a class (`read` / `write` / `git` / `fetch` / `shell`) and is checked at dispatch, so the agent loop can be restricted and a verification receipt actually means something (a proposer that ran unrestricted shell makes the receipt hollow). Defaults preserve today's behaviour (read/write/git on, fetch/shell off). Precedence: built-in < global config < env (`NOMOS_POLICY_SHELL=allow`) < CLI (`--allow <class>` / `--deny <class>`, plus the existing `--allow-shell`/`--allow-fetch`). A repo's own `nomos.json` `permissions` may only **tighten** a class, never grant one (a cloned repo can't enable shell/network/write on itself). Headless `nomos run` has no TTY, so `ask` resolves deterministically to `deny` — a CI run is reproducible and never hangs. A denied tool returns a recoverable message the model explains to you, not a crash. An unmapped new tool is gated as `write`, never silently unguarded.
- **Read-only `git` tool** — inspect repo state (status / diff / log --stat / show --stat / branch listing / blame / ls-files / rev-parse) **without enabling full shell**: repo introspection is its own capability, so the agent can review its own working-tree diff and the history without `run_shell`. Mutating commands (commit/add/push/checkout/reset/merge/rebase/stash, branch/tag create) are refused — it never changes the repo.
- **`git` tool hardened in security review** (it ships only after this): a single dispatch wrapper applies, on every call — listing-only ref subcommands (no positional `tag v1`/`branch name` create), working-directory escape + secret-path argument refusal (incl. `:(magic)` pathspecs and `..`/absolute paths), glued `-cKEY=VAL`/`-Cdir` and `--no-index` blocked, and repo-controlled command execution neutralized (env scrub + trusted `-c` overrides + `--no-ext-diff`/`--no-textconv`) so a hostile cloned repo's `diff.external`/`core.fsmonitor`/textconv can't run code on a plain `git diff`/`status`. `git log -p` (whole-history patch) is refused; credential-shaped tokens and the hunks of denylisted files are redacted from output. Verified empirically against a hostile repo (all three RCE vectors dead, committed-`.env` content redacted).
- **Project test/build commands** — a `nomos.json` `commands` map (test / build / lint / typecheck / …) is surfaced into the agent's system prompt so it uses the repo's **real** commands instead of guessing, and reviews its own diff with `git diff` before finishing. Reading the commands is informational; running one still requires `run_shell`, so a cloned repo can't execute anything by listing a command.
- **Receipt schema LOCKED to v1.0 + published spec** (`docs/RECEIPT_SPEC.md`) — the canonical pre-image, sha256, id derivation, `cross_provider` re-derivation, and the verify algorithm are now a stable public contract, so a third party can re-implement the check and re-verify any v1.0 receipt **offline, forever**.
- **`nomos receipt verify` catches a third failure mode** — a truncated/missing verifier verdict (a cut-off reply that never reached a verdict) no longer reads as a pass: a completeness check (independent of the hash) requires both models+providers, a verdict ∈ {PASS,FAIL,CONCERNS}, non-empty reasoning, and a task. Exit 2 on tamper, faked cross-provider, **or** an incomplete receipt.
- **Honest receipt framing** (corrected in review): the spec now states plainly that a keyless receipt is **tamper-evident and offline-re-checkable**, but is **not** a zero-trust proof — whoever generates it can fabricate fields and recompute a matching hash, so a receipt is trusted relative to its **generator** (e.g. your own CI). It does not prove which model ran or that the verifier did a thorough (non-rubber-stamp) check. Canonicalization determinism rules (no Unicode normalization, fixed types) added so independent implementations agree.
- **Extended secret denylist** — keystore/cert/key extensions (`.p8 .pkcs12 .jks .keystore .asc .gpg .ppk .ovpn .kdbx .env`) and env files without a leading dot (`foo.env`, `env.production`) are refused across the file and git tools.
- **56 tests** (`npm test`): + the read-only git tool (always-available, mutation/escape/RCE/secret refusals, listing forms, output redaction) + project-command parsing + receipt v1 lock and the truncated-verdict completeness check.

## [1.4.0] — Provider breadth + receipt verification + CI
- **Two more providers** (now 15): `google` (Gemini, via its OpenAI-compatible endpoint `…/v1beta/openai`) and `minimax` (`api.minimax.io/v1`). Both bring-your-own-key, OpenAI-chat wire format; endpoints taken from each vendor's official docs. Curated model fallbacks added; live `nomos models` stays the source of truth.
- **`nomos receipt verify <file>`** — re-check a receipt's content hash later (the integrity check a third party runs on a receipt you hand them). `✗ TAMPERED` → exit 2. Closes the loop: verify → receipt → **re-verify**.
- **Receipt hash hardened to bind the whole trust claim (schema 0.1 → 0.2).** The hash now also binds the **proposer/verifier model + provider**; verify re-checks the denormalized `verdict`/`id` against the signed source and **re-derives `cross_provider` from the two providers** (so a forged "independent" claim is caught even if the keyless hash was recomputed). Previously the hash bound only `verifier.verdict` — so flipping the displayed top-level `verdict`, swapping the verifier model to a more authoritative one, or forging the verifier's provider, all passed as "intact." Now caught. The receipt is honest content-addressing (proves a receipt matches its id), **not** a signature — pin the id out-of-band. (0.1 receipts, of which there are none in the wild, won't forward-verify — re-issue them.)
- **CI recipe** — a GitHub Action in the README: `nomos verify --against origin/<base>` on every PR, exit 2 on FAIL gates the merge.
- **49 tests**: + google/minimax routing (OpenAI-compatible bearer) + the receipt tamper vectors (verdict flip, model swap, provider forge, id tamper, recomputed-hash cross_provider forge).

## [1.3.0] — Seat robustness
- **`thin` seat status** (`--min-output-bytes N`, MCP `min_output_bytes`) — a near-empty reply was silently `status: ok`. With a floor set, a non-empty reply below it is now `status: "thin"` (exit 1), so a suspiciously short response isn't treated as a clean run. Off by default.
- **Robust final-block extraction** — `extractFinalSentinel` now falls back to a relaxed match for **mismatched** sentinel wrappers (e.g. `=== X START ===` … `===SEAT-END===`). Previously a verdict block with a non-matching closer left `final_block` null even though the verdict was in `output`. Strict matched-pair is still tried first; the relaxed path takes the last opener (leading-echo safe) and the first *canonical* closer (`===SEAT-END===` / `=== END ===`), so an in-body `=== STEP END ===` can't truncate the verdict.
- **Hardened** (found in pre-release review): the sentinel marker is bounded to `[^\n=]{1,200}?` — this kills a real ReDoS (an unbounded `(.+?)` backtracked **quadratically**: ~11.5s of event-loop-blocking CPU on a 200KB `===…` divider, *outside* the wall-clock timeout; now ~1ms) and prevents `=`/newline pollution of the marker. The closer requires `END` as a standalone token, so `FRONTEND`/`APPEND` no longer false-close. *Known limitation:* a transcript that **echoes the START…END template after** the real verdict can still mis-extract via the relaxed path — keep the verdict last and use one canonical sentinel (the full `output` is always preserved regardless).
- **46 tests**: + the relaxed/mismatched sentinel cases (strict still wins, embedded-END, FRONTEND, marker pollution, ReDoS perf guard), + the `thin` floor.

## [1.2.0] — Configurable output cap + MCP editor integration
- **Configurable max output tokens** (`--max-tokens`, `NOMOS_MAX_TOKENS`, `maxTokens` in config). A hardcoded `max_tokens: 4096` truncated long outputs; the default is now a generous **8192** and overridable on every command (run / seat / verify / council). OpenAI reasoning models correctly receive `max_completion_tokens` instead of `max_tokens` (per-provider, registry-driven) so raising the cap can't 400 them.
- **MCP server** (`nomos mcp`) — run Nomos as a stdio JSON-RPC tool server so editors (Claude Code, Cursor, Codex) call it directly. Exposes **`nomos_verify`** (independent second opinion on your diff → receipt — the killer editor feature) and **`nomos_seat`** (hang-resistant directive→transcript). Newline-delimited JSON-RPC 2.0, zero dependencies.
- **Hang-resistance guarantee, locked by tests** — `seat` AND `verify` always return a terminal result (a verifier timeout emits a CONCERNS receipt instead of throwing), never a 0-byte hang. That's OpenCode's exact failure mode on a large directive; for Nomos it's a covered guarantee on both the seat and the editor (`nomos_verify`) paths.
- **Hardened** (found in pre-release review): `--max-tokens` rejects non-numeric / non-positive values (falls back to config instead of sending `max_tokens:null`); the MCP `cwd` argument is confined to the server's working directory (a model can't point Nomos at an arbitrary path to read a diff or write a receipt); MCP tools also accept a per-call `max_tokens`.
- **43 automated tests** (`npm test`): + gateway body-builders (configurable cap, per-provider field name, tool omission), + the full MCP protocol dispatch (initialize / tools list+call / notifications / error codes / cwd confinement / per-call cap), + the seat AND verify timeout guarantees, + maxTokens threading.

## [1.1.0] — The second seat
- **`nomos verify`** — independent second opinion on a change another tool (Claude Code / Cursor / you) made. Point it at your working/staged diff (or `--against <ref>`); ONE model reviews it and emits a receipt. One key — the verifier; the proposer is whatever wrote the change. Caught a real `=` vs `===` auth-bypass bug.

## [1.0.0] — First stable release
A real terminal coding agent: explore → surgical edit → verify, streaming, on your own models.
- Verified on real tasks (off-by-one fix, multi-file rename, feature + test add) — correct, build-passing edits, end to end.
- Full surface: 9 tools, parallel tool calls, retry, context trimming, streaming, clean UX, 13 providers, headless seat runner, cross-provider receipts.
- **22 automated tests** (`npm test`), zero runtime dependencies.
- Positioned as a coding agent in the OpenCode / Claude Code / Hermes category.

## [0.6.0] — Reliability & tests
- **22 automated tests** (`npm test`, zero-dep `node --test`): tools (edit/multi_edit/glob/regex-search/read-offset), **path confinement + secret denylist**, gateway routing (anthropic vs bearer vs noAuth), model parsing, **SSE stream parser** (content split across chunks, malformed frames skipped, tool-use assembled across deltas — both wire formats), seat/receipt/council verdict + tamper hash, credential store (no value leak), context trimming.
- The SSE parser is the protocol single-point-of-failure — now covered for split-chunk and malformed-frame cases.

## [0.5.0] — UX
- **Run header** — `▸ model · /working/dir · shell on` so you always know what's running and where.
- **Clean tool display** — `· read_file math.js` (tool + key arg) instead of raw JSON spam.
- **Closing summary** — `── ✓ done in 12.3s · 2 read, 1 edit, 1 shell`; no more output trailing off into silence.
- **Working dir** shown at TUI startup; **help** now opens with a concrete getting-started example.
- *Deferred:* per-command shell confirmation in the TUI — for now `--allow-shell` is the explicit consent gate and the command is always shown before it runs.

## [0.4.0] — Streaming & feel
- **Token-by-token streaming** (`nomos run` + TUI) — `chatStream` parses SSE for both Anthropic and OpenAI wire formats and prints the answer as it arrives. Falls back cleanly to non-streaming if a provider can't stream.
- **Live tool-call status** — `· read_file(...)` shows the instant the model decides, not after the tool returns.
- **Elapsed time** — `·· 4.4s` after each run, so a wait never feels infinite.
- `--json` keeps stdout clean (no deltas; structured object only).

## [0.3.0] — Agent-loop robustness
- **Transient-error retry** — 429 / 5xx / network errors retry with exponential backoff + jitter, honoring `Retry-After`. A single hiccup no longer kills a session. Aborts (cancellation) are never retried.
- **Parallel tool execution** — independent tool calls in a turn run concurrently (results preserved in order), instead of serializing and burning the step budget.
- **Context trimming** — on long runs the oldest tool observations are truncated over a char budget, so the transcript can't balloon and degrade late-turn reasoning.

## [0.2.0] — Tooling parity
- **`glob`** — find files by pattern (`src/**/*.js`, `**/test_*.py`).
- **`multi_edit`** — apply several exact edits to one file atomically (all-or-nothing).
- **`search`** upgraded to regex (case-insensitive) with literal fallback; 100-result cap; skips `node_modules`/`.git`/`.nomos`.
- **`read_file`** gains `offset`/`limit` (read part of a large file, line-numbered).
- **AGENTS.md / NOMOS.md / CLAUDE.md** project conventions loaded into the agent's system prompt.
- System prompt advertises glob/multi_edit/regex-search; explore→edit→verify discipline.

## [0.1.0]
- Headless-first agent: `nomos run -m provider/model "task"` (reason→act→observe loop).
- 13 providers incl. coding-plan subs (kimi-for-coding, zai-coding-plan, opencode-go).
- Tools: read_file, write_file, **edit_file** (surgical edits), list_dir, search, opt-in fetch_url/run_shell.
- Sandboxed: realpath confinement, secret denylist, SSRF guard.
- Multi-auth (API key or plan token), live model picker, file memory, TUI.
- `nomos seat` — headless seat runner emitting a structured transcript.
- `nomos council` — cross-provider verification receipts.
- Coding system prompt (explore → surgical edit → verify), 30-step budget.
- Verified: fixed a real off-by-one bug end-to-end (read → edit_file → run test → PASS).
