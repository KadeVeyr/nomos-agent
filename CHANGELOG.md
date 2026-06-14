# Changelog

All notable changes to Nomos.

## [Unreleased]

## [1.5.0] — Subscription login (use your plan, not API credits)
- **Sign in with your subscription** instead of paying per-token. `nomos connect` → **OpenAI** does a browser sign-in ("ChatGPT Plus/Pro login", OAuth 2.0 PKCE loopback, token auto-refreshes); **xAI** is a paste — SuperGrok hands you a token after sign-in, so you paste it ("SuperGrok / X Premium+ token"). No API key either way. Tokens live only in local `auth.json` (0600).
- **Responses-API wire format** — these subscription endpoints speak the OpenAI **Responses API** (`input`/`instructions`, not `messages`) on a different base than the public key, so the gateway now has a third format (`openai-responses`) alongside chat-completions and Anthropic messages. For OpenAI it sends the `chatgpt-account-id` (decoded from the token) + the `originator` header its CLI requires.
- Client ids / endpoints are each vendor's **first-party CLI** registration (Codex, pi-grok, xAI OIDC discovery) — sourced, not guessed. Provenance + the personal-use caveat: [docs/PLAN_OAUTH.md](docs/PLAN_OAUTH.md).
- **64 tests**: + PKCE / auth-URL / JWT account-id / token exchange + refresh (skew, carry-forward, sanitized errors), + the Responses body builder, the tool-call round-trip (function_call ↔ output ids), and the plan-oauth route headers.
- *Note:* the OAuth + token flows and the Responses request shape are unit-tested; the live browser login and the exact streaming event names want a real run against each subscription to confirm end to end.

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
