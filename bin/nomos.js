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
import { Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { runAgent } from "../src/agent.js";
import { listProviders } from "../src/providers.js";
import { setKey, removeKey, listAuth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { readNotes, clearNotes, readLessons, clearLessons } from "../src/memory.js";
import { startTui } from "../src/tui.js";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
function getFlag(name, short) {
  const i = argv.findIndex((a) => a === name || a === short);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
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
  const cfg = loadConfig({ cli: { allowShell: has("--allow-shell") ? true : undefined, allowFetch: has("--allow-fetch") ? true : undefined } });
  const spec = getFlag("--model", "-m") || cfg.defaultModel;
  const json = has("--json");
  const skip = new Set(["run", "--json", "--allow-shell", "--allow-fetch"]);
  const parts = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (skip.has(a)) continue;
    if (a === "-m" || a === "--model") { i++; continue; }
    parts.push(a);
  }
  let task = parts.join(" ");
  if (!task) task = await readStdin(); // pipeable: echo "task" | nomos run -m model
  if (!spec) return fail('No model. Use -m provider/model, or set defaultModel in nomos.json.');
  if (!task) return fail('Missing task. Usage: nomos run -m provider/model "task"');

  const onEvent = (e) => {
    if (e.type === "tool_call") process.stderr.write(`\x1b[2m· ${e.name}(${JSON.stringify(e.args)})\x1b[0m\n`);
    else if (e.type === "tool_result") process.stderr.write(`\x1b[2m· → ${e.result.replace(/\n/g, " ⏎ ").slice(0, 160)}\x1b[0m\n`);
    else if (e.type === "error") process.stderr.write(`\x1b[31m· error: ${e.message}\x1b[0m\n`);
  };

  try {
    const result = await runAgent({ spec, task, root: cfg.root, allowShell: cfg.allowShell, allowFetch: cfg.allowFetch, maxSteps: cfg.maxSteps, onEvent });
    if (json) process.stdout.write(JSON.stringify({ ok: true, model: spec, result: (result || "").trim() }) + "\n");
    else process.stdout.write((result || "").trim() + "\n");
  } catch (e) {
    if (json) { process.stdout.write(JSON.stringify({ ok: false, model: spec, error: e.message }) + "\n"); process.exitCode = 1; }
    else fail(e.message);
  }
}

async function cmdAuth() {
  const sub = argv[1];
  if (sub === "list") {
    for (const a of listAuth()) console.log(`${a.configured ? "✓" : "·"} ${a.id.padEnd(12)} ${a.configured ? `(${a.source})` : "not configured"}`);
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
  console.log("Supported providers (model = provider/model):");
  for (const p of listProviders()) console.log(`  ${p.id.padEnd(12)} ${p.name.padEnd(18)} ${p.noAuth ? "(local, no key)" : `key: nomos auth login ${p.id}  or $${p.env}`}`);
}

function fail(msg) { process.stderr.write(`nomos: ${msg}\n`); process.exitCode = 1; }

function help() {
  console.log(`nomos — the headless agent you call from your editor. Bring your own subs.

  nomos run -m provider/model "task" [--json] [--allow-shell]
  nomos auth login <provider>        store your subscription's key (local, server-side)
  nomos auth list                    show configured providers
  nomos providers                    list supported providers
  nomos memory [clear]               show / clear this project's durable notes
  nomos                              launch the TUI

Config: nomos.json (project) or ~/.config/nomos/config.json. Keys: defaultModel, allowShell, maxSteps.`);
}

function version() {
  try { console.log("nomos " + JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version); }
  catch { console.log("nomos"); }
}

const cmd = argv[0];
if (cmd === "--version" || cmd === "-v") version();
else if (cmd === "run") await cmdRun();
else if (cmd === "auth") await cmdAuth();
else if (cmd === "memory") cmdMemory();
else if (cmd === "lessons") cmdLessons();
else if (cmd === "providers" || cmd === "models") cmdProviders();
else if (cmd === "--help" || cmd === "-h" || cmd === "help") help();
else if (!cmd) await startTui();
else fail(`Unknown command "${cmd}". Try: nomos --help`);
