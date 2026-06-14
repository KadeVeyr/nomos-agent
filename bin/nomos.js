#!/usr/bin/env node
// Nomos CLI — the headless agent you call from your editor. Bring your own subs.
//
//   nomos run -m provider/model "task" [--json] [--allow-shell]
//   nomos auth login <provider> | auth list | auth logout <provider>
//   nomos providers
//   nomos memory [clear]
//   nomos                       launch the TUI
//
// Headless is the front door: pipe a task in, get the answer out — call it from
// Claude Code, a script, or CI. With --json, stdout is a single JSON object and
// events go to stderr, so it composes cleanly in pipelines (exit 0 ok / 1 error).

import process from "node:process";
import readline from "node:readline";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { runAgent } from "../src/agent.js";
import { listProviders, PROVIDERS } from "../src/providers.js";
import { setKey, setCredential, removeKey, listAuth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { readNotes, clearNotes, readLessons, clearLessons } from "../src/memory.js";
import { startTui } from "../src/tui.js";
import { makeIo, runConnect, authMethods } from "../src/connect.js";
import { listModels, CURATED } from "../src/models.js";
import { runCouncil } from "../src/council.js";
import { renderReceipt, writeReceipt, verifyReceiptHash } from "../src/receipt.js";
import { runSeat } from "../src/seat.js";
import { getDiff, runVerify } from "../src/verify.js";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
function getFlag(name, short) {
  const i = argv.findIndex((a) => a === name || a === short);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}
// Numeric flag → a positive finite Number, else undefined — so a missing or
// malformed value (e.g. --max-tokens abc / 0) cleanly falls back to config
// instead of overriding it with NaN/0 (which would serialise to max_tokens:null
// and 400 the provider). Mirrors the env path's `Number(...) || DEFAULT` guard.
function getInt(name, short) {
  const v = getFlag(name, short);
  const n = v != null ? Number(v) : undefined;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function readStdin() {
  if (process.stdin.isTTY) return ""; // interactive — nothing piped
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function promptHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const muted = new Writable({ write(_c, _e, cb) { cb(); } });
    const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
    rl.question("", (value) => { rl.close(); process.stdout.write("\n"); resolve(value.trim()); });
  });
}

async function cmdRun() {
  const cfg = loadConfig({ cli: { allowShell: has("--allow-shell") ? true : undefined, allowFetch: has("--allow-fetch") ? true : undefined, maxTokens: getInt("--max-tokens") } });
  const spec = getFlag("--model", "-m") || cfg.defaultModel;
  const json = has("--json");
  const skip = new Set(["run", "--json", "--allow-shell", "--allow-fetch"]);
  const parts = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (skip.has(a)) continue;
    if (a === "-m" || a === "--model" || a === "--max-tokens") { i++; continue; }
    parts.push(a);
  }
  let task = parts.join(" ");
  if (!task) task = await readStdin(); // pipeable: echo "task" | nomos run -m model
  if (!spec) return fail('No model. Use -m provider/model, or set defaultModel in nomos.json.');
  if (!task) return fail('Missing task. Usage: nomos run -m provider/model "task"');

  // Header: which model, where (so the user knows the cwd + model before anything runs).
  if (!json) process.stderr.write(`\x1b[2m▸\x1b[0m \x1b[1m${spec}\x1b[0m \x1b[2m· ${cfg.root}${cfg.allowShell ? " · shell on" : ""}\x1b[0m\n`);
  const t0 = Date.now();
  const counts = { read: 0, edit: 0, write: 0, shell: 0, other: 0 };
  const onEvent = (e) => {
    if (e.type === "delta") { if (!json) process.stdout.write(e.text); }
    else if (e.type === "tool_call") {
      const n = e.name;
      if (n === "read_file") counts.read++; else if (n === "edit_file" || n === "multi_edit") counts.edit++;
      else if (n === "write_file") counts.write++; else if (n === "run_shell") counts.shell++; else counts.other++;
      const arg = e.args?.path || e.args?.command || e.args?.pattern || e.args?.query || "";
      process.stderr.write(`\n\x1b[2m·\x1b[0m \x1b[36m${n}\x1b[0m \x1b[2m${String(arg).slice(0, 70)}\x1b[0m\n`);
    }
    else if (e.type === "tool_result") process.stderr.write(`\x1b[2m  → ${String(e.result).replace(/\n/g, " ⏎ ").slice(0, 120)}\x1b[0m\n`);
    else if (e.type === "error") process.stderr.write(`\x1b[31m· error: ${e.message}\x1b[0m\n`);
  };

  try {
    const result = await runAgent({ spec, task, root: cfg.root, allowShell: cfg.allowShell, allowFetch: cfg.allowFetch, maxSteps: cfg.maxSteps, maxTokens: cfg.maxTokens, onEvent });
    if (json) { process.stdout.write(JSON.stringify({ ok: true, model: spec, result: (result || "").trim() }) + "\n"); return; }
    process.stdout.write("\n"); // streamed deltas already printed the answer
    const parts = [];
    if (counts.read) parts.push(`${counts.read} read`);
    if (counts.edit) parts.push(`${counts.edit} edit`);
    if (counts.write) parts.push(`${counts.write} write`);
    if (counts.shell) parts.push(`${counts.shell} shell`);
    process.stderr.write(`\x1b[2m──\x1b[0m \x1b[32m✓ done\x1b[0m \x1b[2min ${((Date.now() - t0) / 1000).toFixed(1)}s${parts.length ? " · " + parts.join(", ") : ""}\x1b[0m\n`);
  } catch (e) {
    if (json) { process.stdout.write(JSON.stringify({ ok: false, model: spec, error: e.message }) + "\n"); process.exitCode = 1; }
    else fail(e.message);
  }
}

async function cmdVerify() {
  // nomos verify [--staged] [--against <ref>] [-m verifier] — an independent
  // second opinion on a change another tool (Claude Code / Cursor / you) made.
  // ONE key: the verifier. The "proposer" is whatever wrote the diff.
  const cfg = loadConfig({ cli: { maxTokens: getInt("--max-tokens") } });
  const spec = getFlag("--model", "-m") || cfg.defaultModel;
  const staged = has("--staged");
  const against = getFlag("--against", null);
  const source = getFlag("--source", null) || "your editor";
  const json = has("--json");
  if (!spec) return fail("No verifier model. Use -m provider/model — the independent model that reviews the change.");

  let diff;
  try { diff = await getDiff({ root: cfg.root, staged, against }); }
  catch (e) { return fail(e.message); }
  if (!diff.trim()) return fail(staged ? "No staged changes to verify (run `git add` first, or drop --staged)." : "No changes to verify. Edit something first, or pass --staged / --against <ref>.");

  if (!json) process.stderr.write(`\x1b[2m▸ reviewing ${diff.split("\n").length} diff lines with ${spec}…\x1b[0m\n`);
  const { receipt, verdict, reasoning } = await runVerify({ diff, spec, source, maxTokens: cfg.maxTokens });
  const file = writeReceipt(cfg.root, receipt);
  if (json) {
    process.stdout.write(JSON.stringify(receipt) + "\n");
  } else {
    const mark = verdict === "PASS" ? "\x1b[32m✓ PASS\x1b[0m" : verdict === "FAIL" ? "\x1b[31m✗ FAIL\x1b[0m" : "\x1b[33m‼ CONCERNS\x1b[0m";
    process.stdout.write(`\n${mark} — ${reasoning}\n`);
    process.stdout.write(`\x1b[2m── receipt ${receipt.id} · independently checked by ${spec}\x1b[0m\n`);
  }
  process.stderr.write(`receipt: ${file}\n`);
  if (verdict === "FAIL") process.exitCode = 2;
}

async function cmdSeat() {
  // nomos seat -f <directive> -m <provider/model> [--timeout-ms N] [--json]
  // Fire a directive at a provider, return a structured transcript. Headless,
  // no TUI, no prompts — the reliable seat runner.
  const cfg = loadConfig({ cli: { maxTokens: getInt("--max-tokens") } });
  const spec = getFlag("--model", "-m") || cfg.defaultModel;
  const timeoutMs = Number(getFlag("--timeout-ms", null)) || 120000;
  const minBytes = getInt("--min-output-bytes") || 0; // 0 = off; flag a near-empty seat as "thin"
  const json = has("--json");
  const file = getFlag("--file", "-f");
  const contextBytes = Number(getFlag("--context-bytes", null)) || 100000;
  const contextFiles = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--context" && argv[i + 1]) contextFiles.push(argv[i + 1]);

  let directive = "";
  if (file) { try { directive = readFileSync(file, "utf8"); } catch (e) { return fail(`can't read directive file: ${e.message}`); } }
  if (!directive) {
    const skip = new Set(["seat", "--json"]);
    const parts = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (skip.has(a)) continue;
      if (a === "-m" || a === "--model" || a === "--timeout-ms" || a === "-f" || a === "--file" || a === "--context" || a === "--context-bytes" || a === "--max-tokens" || a === "--min-output-bytes") { i++; continue; }
      parts.push(a);
    }
    directive = parts.join(" ");
  }
  if (!directive) directive = await readStdin();
  if (!spec) return fail("No model. Use -m provider/model.");
  if (!directive) return fail('Missing directive. Usage: nomos seat -f directive.md -m provider/model  (or pass inline / via stdin)');

  const context = contextFiles.length ? { files: contextFiles, maxBytes: contextBytes, root: cfg.root } : null;
  const t = await runSeat({ directive, spec, timeoutMs, context, maxTokens: cfg.maxTokens, minBytes });
  if (json) {
    process.stdout.write(JSON.stringify(t) + "\n");
  } else {
    process.stdout.write((t.final_block ? t.final_block.body : t.output) + "\n");
    process.stderr.write(`\x1b[2m· ${t.status} · ${t.duration_ms}ms · ${t.output_bytes}b${t.final_block ? ` · block:${t.final_block.marker}` : ""}\x1b[0m\n`);
  }
  process.exitCode = t.exit_code; // 0 only when status === "ok"
}

async function cmdCouncil() {
  // nomos council -m <proposer> "task" [--verifier <provider/model>] [--json]
  // Proposer answers; a DIFFERENT provider adversarially verifies; emit a receipt.
  const cfg = loadConfig({ cli: { allowShell: has("--allow-shell") ? true : undefined, allowFetch: has("--allow-fetch") ? true : undefined, maxTokens: getInt("--max-tokens") } });
  const proposer = getFlag("--model", "-m") || cfg.defaultModel;
  let verifier = getFlag("--verifier", null);
  const json = has("--json");

  const skip = new Set(["council", "--json", "--allow-shell", "--allow-fetch"]);
  const parts = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (skip.has(a)) continue;
    if (a === "-m" || a === "--model" || a === "--verifier" || a === "--max-tokens") { i++; continue; }
    parts.push(a);
  }
  let task = parts.join(" ");
  if (!task) task = await readStdin();
  if (!proposer) return fail("No proposer model. Use -m provider/model.");
  if (!task) return fail('Missing task. Usage: nomos council -m provider/model "task" [--verifier provider/model]');

  // Auto-pick a cross-provider verifier from a connected provider if none given.
  if (!verifier) {
    const propProvider = proposer.split("/")[0];
    const other = listAuth().find((a) => a.configured && a.id !== propProvider);
    const model = other && (CURATED[other.id] || [])[0];
    if (other && model) verifier = `${other.id}/${model}`;
    if (!verifier) return fail("No verifier. Pass --verifier provider/model (a DIFFERENT provider than the proposer), or connect a second provider so one can be auto-picked.");
  }

  const onEvent = (e) => {
    if (e.type === "phase") process.stderr.write(`\x1b[2m· ${e.phase} → ${e.model}\x1b[0m\n`);
    else if (e.type === "warn") process.stderr.write(`\x1b[33m· ${e.message}\x1b[0m\n`);
    else if (e.type === "tool_call") process.stderr.write(`\x1b[2m· ${e.side}:${e.name}(${JSON.stringify(e.args)})\x1b[0m\n`);
    else if (e.type === "verdict") process.stderr.write(`\x1b[2m· verdict: ${e.verdict}\x1b[0m\n`);
  };

  try {
    const { receipt, file } = await runCouncil({ task, proposerSpec: proposer, verifierSpec: verifier, root: cfg.root, allowShell: cfg.allowShell, allowFetch: cfg.allowFetch, maxSteps: cfg.maxSteps, maxTokens: cfg.maxTokens, onEvent });
    if (json) {
      process.stdout.write(JSON.stringify(receipt) + "\n");
    } else {
      process.stdout.write(`\n${(receipt.proposer.output || "").trim()}\n\n`);
      process.stdout.write(renderReceipt(receipt) + "\n");
      if (receipt.verifier.reasoning) process.stdout.write(`\x1b[2m  ${receipt.verifier.reasoning.replace(/\s+/g, " ").slice(0, 400)}\x1b[0m\n`);
    }
    process.stderr.write(`receipt: ${file}\n`);
    if (receipt.verdict === "FAIL") process.exitCode = 2; // blocking verdict — composes in CI
  } catch (e) {
    if (json) { process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + "\n"); process.exitCode = 1; }
    else fail(e.message);
  }
}

async function cmdAuth() {
  const sub = argv[1];
  if (sub === "list") {
    for (const a of listAuth()) console.log(`${a.configured ? "✓" : "·"} ${a.id.padEnd(12)} ${a.configured ? `(${a.method} · ${a.source})` : "not configured"}`);
    return;
  }
  if (sub === "logout") {
    const p = argv[2];
    console.log(removeKey(p) ? `Removed credential for ${p}.` : `No stored credential for ${p}.`);
    return;
  }
  if (sub === "login") {
    const p = argv[2];
    if (!p) return fail("Usage: nomos auth login <provider>");
    const key = await promptHidden(`Paste your ${p} API key (input hidden): `);
    try { setKey(p, key); console.log(`Stored ${p} credential locally (server-side, never committed).`); }
    catch (e) { fail(e.message); }
    return;
  }
  fail("Usage: nomos auth <login|list|logout> [provider]");
}

async function cmdConnect() {
  // Interactive: pick provider → pick method (paid plan OR API key) → muted
  // capture → store + route. Same flow the TUI's /connect uses.
  if (process.stdin.isTTY === false) return fail("nomos connect is interactive — run it in a terminal (or use: nomos auth login <provider>).");
  const io = makeIo();
  try { await runConnect(io); } catch (e) { fail(e.message); } finally { io.close(); }
}

function cmdReceipt() {
  // nomos receipt verify <file> — re-check a receipt's content hash later. Proves
  // the task + proposer output + verifier verdict/reasoning are exactly what was
  // signed (sha256). The receipt carries no secrets; this is the integrity check
  // a third party runs on one you handed them. Tamper → exit 2 (gates CI).
  if (argv[1] !== "verify" || !argv[2]) return fail("Usage: nomos receipt verify <receipt.json> [--json]");
  let receipt;
  try { receipt = JSON.parse(readFileSync(argv[2], "utf8")); }
  catch (e) { return fail(`can't read receipt: ${e.message}`); }
  const intact = verifyReceiptHash(receipt);
  if (has("--json")) {
    // Emit the HASH-BOUND verdict (verifier.verdict), not the denormalized
    // top-level copy — so a script reading .verdict can't be fed a tampered value
    // (it's still gated by intact:false + exit 2, this is defense-in-depth).
    process.stdout.write(JSON.stringify({ id: receipt.id, intact, cross_provider: !!receipt.cross_provider, verdict: receipt.verifier?.verdict ?? receipt.verdict }) + "\n");
  } else if (intact) {
    process.stdout.write(`\x1b[32m✓ intact\x1b[0m receipt ${receipt.id ?? "?"} — verifier ${receipt.verifier?.model ?? "?"} · verdict ${receipt.verifier?.verdict ?? "?"}${receipt.cross_provider ? " · \x1b[32mcross-provider\x1b[0m" : " · \x1b[31m⚠ same provider\x1b[0m"}\n`);
  } else {
    process.stdout.write(`\x1b[31m✗ TAMPERED\x1b[0m receipt ${receipt.id ?? "?"} — content hash does not match. Do not trust it.\n`);
  }
  if (!intact) process.exitCode = 2;
}

async function cmdMcp() {
  // nomos mcp — run as an MCP server over stdio so editors (Claude Code, Cursor,
  // Codex) call nomos_verify / nomos_seat as tools. Speaks newline-delimited
  // JSON-RPC; stdout is the protocol channel, so all logging goes to stderr.
  const { runMcpServer } = await import("../src/mcp.js");
  let version = "0.0.0";
  try { version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version; } catch { /* keep default */ }
  process.stderr.write(`\x1b[2mnomos mcp · stdio JSON-RPC · tools: nomos_verify, nomos_seat\x1b[0m\n`);
  await runMcpServer({ version });
}

function cmdImport() {
  // Migrate credentials from OpenCode in one shot. OpenCode keeps per-provider
  // creds at <data>/opencode/auth.json, entries shaped { type:"api", key } or
  // { type:"oauth", access, refresh, expires }. We import any whose id matches a
  // Nomos provider (we deliberately mirror OpenCode's ids). Secrets are read
  // straight into the Nomos store and NEVER displayed.
  const dataHome = process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim()
    ? process.env.XDG_DATA_HOME : path.join(os.homedir(), ".local", "share");
  const ocPath = path.join(dataHome, "opencode", "auth.json");
  let store;
  try { store = JSON.parse(readFileSync(ocPath, "utf8")); }
  catch (e) { return fail(`Couldn't read OpenCode's auth store at ${ocPath} (${e.code || e.message}). Is OpenCode installed and logged in?`); }

  let imported = 0; const skipped = [];
  for (const [id, entry] of Object.entries(store || {})) {
    if (!PROVIDERS[id]) { skipped.push(`${id} (no matching Nomos provider)`); continue; }
    const isOauth = entry?.type === "oauth";
    const secret = isOauth ? entry?.access : (entry?.key || entry?.token || entry?.apiKey || entry?.access);
    if (typeof secret !== "string" || secret.length < 8) { skipped.push(`${id} (${entry?.type || "?"} — nothing importable)`); continue; }
    try {
      setCredential(id, isOauth
        ? { type: "oauth", value: secret, method: "plan-oauth", refresh: entry.refresh, expiresAt: entry.expires }
        : { type: "apikey", value: secret, method: "apikey" });
      imported++; console.log(`  ✓ ${id}${isOauth ? " (oauth)" : ""}`);
    } catch (e) { skipped.push(`${id} (${e.message})`); }
  }
  console.log(`\nImported ${imported} provider${imported === 1 ? "" : "s"} from OpenCode.`);
  if (skipped.length) console.log(`Skipped: ${skipped.join(", ")}`);
  console.log(`\nNext:  nomos auth list   then   nomos`);
}

function cmdMemory() {
  if (argv[1] === "clear") { console.log(clearNotes(process.cwd()) ? "Cleared project memory." : "No memory to clear."); return; }
  const notes = readNotes(process.cwd());
  console.log(notes || "(no notes yet — the agent writes durable notes here with the remember tool)");
}

function cmdLessons() {
  if (argv[1] === "clear") { console.log(clearLessons() ? "Cleared the agent's global lessons." : "No lessons to clear."); return; }
  const lessons = readLessons();
  console.log(lessons || "(no lessons yet — the agent writes reusable lessons here with the learn tool; global, never committed)");
}

function cmdProviders() {
  console.log("Supported providers (model = provider/model). Connect with: nomos connect\n");
  for (const p of listProviders()) {
    const ways = p.noAuth ? "local, no credential" : authMethods(p).map((m) => m.method).join(" / ");
    console.log(`  ${p.id.padEnd(16)} ${p.name.padEnd(24)} ${ways}`);
  }
}

async function cmdModels() {
  // `nomos models [provider]` — list models for one provider, or every
  // connected one. Live from each provider's /models endpoint (your key),
  // falling back to a curated list if it can't be reached.
  const target = argv[1];
  const ids = target ? [target] : listAuth().filter((a) => a.configured).map((a) => a.id);
  if (!ids.length) return fail("No providers connected. Run: nomos connect");
  for (const id of ids) {
    let res;
    try { res = await listModels(id); }
    catch (e) { console.log(`\n${id}: ${e.message}`); continue; }
    const { models, source, reason } = res;
    if (!models.length) { console.log(`\n${id}: no models (${reason})`); continue; }
    console.log(`\n${id} — ${models.length} models ${source === "live" ? "(live)" : `(offline list · ${reason})`}:`);
    for (const m of models) console.log(`  ${id}/${m}`);
  }
}

function fail(msg) { process.stderr.write(`nomos: ${msg}\n`); process.exitCode = 1; }

function help() {
  console.log(`nomos — the headless coding agent you call from your editor. Bring your own subs.

First time?   nomos connect        (pick a provider, paste ONE key)
              nomos verify -m anthropic/claude-opus-4-8   (review what your editor just changed)

  nomos verify [-m provider/model] [--staged] [--against <ref>] [--max-tokens N]
                                     independent second opinion on a change → receipt (one key)
  nomos run -m provider/model "task" [--json] [--allow-shell] [--max-tokens N]
  nomos seat -f directive.md -m provider/model [--timeout-ms N] [--max-tokens N] [--min-output-bytes N] [--json]
                                     fire a directive at a provider → structured transcript (a council seat)
  nomos council -m provider/model "task" [--verifier provider/model] [--max-tokens N]
                                     run it, then a DIFFERENT provider verifies → receipt
  nomos receipt verify <file>        re-check a receipt's content hash (tamper-evident; exit 2 if broken)
  nomos mcp                          run as an MCP server (stdio) so your editor calls nomos as a tool
  nomos connect                      connect a provider — paid plan OR API key (interactive)
  nomos auth login <provider>        quick path: store an API key (local, server-side)
  nomos auth list                    show connected providers + method
  nomos auth logout <provider>       remove a stored credential
  nomos models [provider]            list models (live from your key) to pick from
  nomos providers                    list supported providers + auth methods
  nomos memory [clear]               show / clear this project's durable notes
  nomos                              launch the TUI

Config: nomos.json (project) or ~/.config/nomos/config.json. Keys: defaultModel, allowShell, maxSteps, maxTokens.
Flags override config; env: NOMOS_MODEL / NOMOS_ALLOW_SHELL / NOMOS_MAX_STEPS / NOMOS_MAX_TOKENS.`);
}

function version() {
  try { console.log("nomos " + JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version); }
  catch { console.log("nomos"); }
}

const cmd = argv[0];
if (cmd === "--version" || cmd === "-v") version();
else if (cmd === "run") await cmdRun();
else if (cmd === "verify") await cmdVerify();
else if (cmd === "seat") await cmdSeat();
else if (cmd === "council") await cmdCouncil();
else if (cmd === "connect") await cmdConnect();
else if (cmd === "receipt") cmdReceipt();
else if (cmd === "mcp") await cmdMcp();
else if (cmd === "auth") await cmdAuth();
else if (cmd === "memory") cmdMemory();
else if (cmd === "lessons") cmdLessons();
else if (cmd === "providers") cmdProviders();
else if (cmd === "models") await cmdModels();
else if (cmd === "--help" || cmd === "-h" || cmd === "help") help();
else if (!cmd) await startTui();
else fail(`Unknown command "${cmd}". Try: nomos --help`);
