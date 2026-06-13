// Auth store — server-side credential custody.
//
// SECURITY CONTRACT (non-negotiable):
//   - Keys live ONLY in the local data dir (~/.local/share/nomos/auth.json),
//     never in the repo, never in client-shipped code, never printed.
//   - The file is created 0600 (owner read/write only) on POSIX.
//   - getKey() resolves store-first, then a named env var (server process env).
//     The returned key is used internally by the gateway and is NEVER surfaced
//     to stdout, logs, or any caller other than the HTTPS request to the provider.
//   - listAuth() reports WHICH providers are configured — never the key value.
//
// The registry (providers.js, committable) says where a secret lives; this
// store holds it, out of the repo.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PROVIDERS } from "./providers.js";

function dataDir() {
  // XDG data dir, with a Windows-friendly fallback.
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), ".local", "share");
  return path.join(base, "nomos");
}

function authPath() {
  return path.join(dataDir(), "auth.json");
}

function readStore() {
  try {
    const raw = fs.readFileSync(authPath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store) {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = authPath();
  // Write then tighten perms (0600). chmod is a no-op on Windows but harmless.
  fs.writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* non-POSIX */
  }
}

// Store a provider credential. Called by `nomos auth login`. The key never
// leaves this machine except as an Authorization header to the provider.
export function setKey(providerId, key) {
  if (!PROVIDERS[providerId]) throw new Error(`Unknown provider "${providerId}".`);
  if (!key || typeof key !== "string" || key.length < 8) {
    throw new Error("That doesn't look like an API key. Aborted — nothing stored.");
  }
  const store = readStore();
  store[providerId] = { key: key.trim(), savedAt: new Date().toISOString() };
  writeStore(store);
}

export function removeKey(providerId) {
  const store = readStore();
  if (store[providerId]) {
    delete store[providerId];
    writeStore(store);
    return true;
  }
  return false;
}

// Resolve a key: store first, then the provider's named env var (server-side
// process env). Returns null if neither is set. NEVER log the return value.
export function getKey(providerId) {
  const store = readStore();
  if (store[providerId]?.key) return store[providerId].key;
  const provider = PROVIDERS[providerId];
  if (provider?.env && process.env[provider.env]) return process.env[provider.env];
  return null;
}

// Report configuration status — provider id + source, NEVER the key value.
export function listAuth() {
  const store = readStore();
  return Object.keys(PROVIDERS).map((id) => {
    let source = null;
    if (store[id]?.key) source = "store";
    else if (PROVIDERS[id].env && process.env[PROVIDERS[id].env]) source = "env";
    return { id, name: PROVIDERS[id].name, configured: source !== null, source };
  });
}

export const STORE_PATH = authPath();
