// Connect flow — shared by the TUI (`/connect`) and the CLI (`nomos connect`).
// One code path: choose provider → choose auth method (paid plan OR API key) →
// capture the secret with the screen MUTED → store it server-side + route it.
//
// The flow is driven entirely by the registry (providers.js `auth`): each
// provider advertises which methods it genuinely supports, and this flow offers
// exactly those. A secret is NEVER echoed to the screen, logged, or returned.

import readline from "node:readline";
import { PROVIDERS, listProviders } from "./providers.js";
import { setCredential } from "./auth.js";

const METHOD_LABEL = {
  apikey: "API key",
  "plan-token": "Paid-plan token",
  "plan-oauth": "Plan login (paste plan token)",
};
const METHOD_TYPE = { apikey: "apikey", "plan-token": "plan-token", "plan-oauth": "oauth" };

// What auth methods a provider supports, from the registry. Defensive fallback
// to a plain API key if a provider predates the `auth` table.
export function authMethods(provider) {
  if (Array.isArray(provider.auth) && provider.auth.length) return provider.auth;
  if (provider.noAuth) return [];
  return [{ method: "apikey", label: "API key", hint: provider.keyHint }];
}

// A readline bound to the REAL stdin/stdout so terminal line-editing + echo work
// (a custom output stream lacks the cursor methods readline needs in terminal
// mode, which silently breaks typing). Secret entry is hidden via the standard
// `_writeToOutput` override — the masked-password pattern. ask()/askHidden()
// resolve with the trimmed answer, or null on EOF/Ctrl-D (callers treat null as
// cancel/exit rather than crashing with ERR_USE_AFTER_CLOSE).
export function makeIo() {
  let closed = false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("close", () => { closed = true; });

  const ask = (q, hidden) => new Promise((res) => {
    if (closed) return res(null);
    let done = false;
    function onClose() { if (!done) { done = true; res(null); } }
    function finish(v) { if (!done) { done = true; rl.removeListener("close", onClose); res(v); } }
    rl.once("close", onClose);
    if (hidden) {
      process.stdout.write(q);
      const orig = rl._writeToOutput;
      rl._writeToOutput = () => {}; // suppress echo of the typed secret
      rl.question("", (a) => { rl._writeToOutput = orig; process.stdout.write("\n"); finish(a.trim()); });
    } else {
      rl.question(q, (a) => finish(a.trim()));
    }
  });

  return {
    print: (s) => process.stdout.write(s),
    ask: (q) => ask(q, false),
    askHidden: (q) => ask(q, true),
    close: () => { if (!closed) rl.close(); },
  };
}

function resolveProvider(pick) {
  if (!pick) return null;
  const provs = listProviders().filter((p) => !p.noAuth);
  if (/^\d+$/.test(pick)) return provs[Number(pick) - 1] || null;
  return PROVIDERS[pick] ? { id: pick, ...PROVIDERS[pick] } : null;
}

// io = { print, ask, askHidden }. Returns { providerId, method } on success,
// or null if cancelled. Throws on a storage error (sanitized — no secret).
export async function runConnect(io) {
  const provs = listProviders().filter((p) => !p.noAuth);
  io.print("\nConnect a provider — your paid plan OR an API key.\n\n");
  provs.forEach((p, i) => {
    const methods = authMethods(p).map((m) => METHOD_LABEL[m.method] || m.method).join("  ·  ");
    io.print(`  ${String(i + 1).padStart(2)}. ${p.id.padEnd(12)} ${p.name.padEnd(18)} ${methods}\n`);
  });

  const provider = resolveProvider(await io.ask("\nProvider (number or id, blank to cancel): "));
  if (!provider) { io.print("Cancelled.\n"); return null; }

  const methods = authMethods(provider);
  if (methods.length === 0) { io.print(`${provider.name} needs no credential (local).\n`); return null; }

  let chosen = methods[0];
  if (methods.length > 1) {
    io.print(`\nHow do you want to connect ${provider.name}?\n`);
    methods.forEach((m, i) => io.print(`  ${i + 1}. ${m.label || METHOD_LABEL[m.method] || m.method}${m.hint ? `  (${m.hint})` : ""}\n`));
    const mi = await io.ask("Method (number): ");
    chosen = methods[Number(mi) - 1] || null;
    if (!chosen) { io.print("Cancelled.\n"); return null; }
  }

  const what = chosen.method === "apikey" ? "API key"
    : chosen.method === "plan-token" ? `${provider.name} plan token`
    : `${provider.name} plan access token`;
  const value = await io.askHidden(`Paste your ${what}${chosen.hint ? ` (${chosen.hint})` : ""} — input hidden: `);
  if (!value) { io.print("Nothing entered — aborted.\n"); return null; }

  setCredential(provider.id, { type: METHOD_TYPE[chosen.method] || "apikey", value, method: chosen.method });
  io.print(`✓ Connected ${provider.name} via ${chosen.label || METHOD_LABEL[chosen.method]}. Stored locally (server-side, never committed).\n`);
  return { providerId: provider.id, method: chosen.method };
}
