#!/usr/bin/env node
// Nomos CLI — the headless agent you call from your editor.
//
//   nomos run -m provider/model "task"   headless run (the wedge)
//   nomos auth login <provider>          store YOUR sub's key (server-side)
//   nomos auth list | logout <provider>  manage credentials (never prints keys)
//   nomos providers                      list supported providers
//   nomos                                launch the TUI
//
// Headless is the front door: pipe a task in, get the answer out — call it from
// Claude Code, a script, or CI, bringing your own subscriptions.

import process from "node:process";
import readline from "node:readline";
import { Writable } from "node:stream";
import { runAgent } from "../src/agent.js";
import { listProviders } from "../src/providers.js";
import { setKey, removeKey, listAuth } from "../src/auth.js";
import { startTui } from "../src/tui.js";

const argv = process.argv.slice(2);

function getFlag(name, short) {
  const i = argv.findIndex((a) => a === name || a === short);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

async function promptHidden(question) {
  // Read with a muted output stream so NO key characters are ever echoed.
  return new Promise((resolve) => {
    process.stdout.write(question);
    const muted = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
    rl.question("", (value) => { rl.close(); process.stdout.write("\n"); resolve(value.trim()); });
  });
}

async function cmdRun() {
  const spec = getFlag("--model", "-m");
  // Task = everything that isn't the `run` subcommand or the model flag+value.
  const parts = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "run") continue;
    if (a === "-m" || a === "--model") { i++; continue; } // skip flag and its value
    parts.push(a);
  }
  const task = parts.join(" ");
  if (!spec) return fail('Missing model. Usage: nomos run -m provider/model "task"');
  if (!task) return fail('Missing task. Usage: nomos run -m provider/model "task"');
  try {
    const final = await runAgent({
      spec,
      task,
      onEvent: (e) => {
        if (e.type === "tool_call") process.stderr.write(`\x1b[2m· calculator(${JSON.stringify(e.args)})\x1b[0m\n`);
        else if (e.type === "tool_result") process.stderr.write(`\x1b[2m· = ${e.result}\x1b[0m\n`);
      },
    });
    process.stdout.write((final || "").trim() + "\n");
  } catch (e) {
    fail(e.message);
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

function cmdProviders() {
  console.log("Supported providers (model = provider/model):");
  for (const p of listProviders()) console.log(`  ${p.id.padEnd(12)} ${p.name.padEnd(18)} key via: nomos auth login ${p.id}  (or $${p.env})`);
}

function fail(msg) {
  process.stderr.write(`nomos: ${msg}\n`);
  process.exitCode = 1;
}

function help() {
  console.log(`nomos — the headless agent you call from your editor. Bring your own subs.

  nomos run -m provider/model "task"   headless run (pipe-friendly)
  nomos auth login <provider>          store your subscription's key (local, server-side)
  nomos auth list                      show which providers are configured
  nomos providers                      list supported providers
  nomos                                launch the TUI`);
}

const cmd = argv[0];
if (cmd === "run") await cmdRun();
else if (cmd === "auth") await cmdAuth();
else if (cmd === "providers" || cmd === "models") cmdProviders();
else if (cmd === "--help" || cmd === "-h" || cmd === "help") help();
else if (!cmd) await startTui();
else fail(`Unknown command "${cmd}". Try: nomos --help`);
