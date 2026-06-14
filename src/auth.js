// Auth store — server-side credential custody (multi-auth: plan OR key).
//
// SECURITY CONTRACT (non-negotiable):
//   - Credentials live ONLY in the local data dir (~/.local/share/nomos/auth.json),
//     never in the repo, never in client-shipped code, never printed.
//   - The file is created 0600 (owner read/write only) on POSIX.
//   - getCredential() resolves store-first, then a named env var (server process
//     env). The returned secret is used internally by the gateway and is NEVER
//     surfaced to stdout, logs, or any caller other than the HTTPS request.
//   - listAuth() reports WHICH providers are configured and by which METHOD —
//     never the secret value.
//
// A provider can be connected by more than one method (see providers.js `auth`):
//   - apikey      a normal API key                          (type "apikey")
//   - plan-token  a token your paid plan/subscription issues (type "plan-token")
//   - plan-oauth  a browser/device login → access (+refresh) (type "oauth")
// The store records the credential TYPE and the connect METHOD so the gateway
// can pick the right endpoint + header for that method. The registry
// (providers.js, committable) says where a secret lives and how to route it;
// this store holds the secret, out of the repo.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PROVIDERS } from "./providers.js";

const VALID_TYPES = new Set(["apikey", "plan-token", "oauth"]);

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

// Normalize a stored entry (current OR legacy) to a credential record.
// Legacy entries were { key, savedAt } — treat as an apikey.
function normalize(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (typeof entry.value === "string" && entry.value) {
    const type = VALID_TYPES.has(entry.type) ? entry.type : "apikey";
    return {
      type,
      value: entry.value,
      method: entry.method || (type === "apikey" ? "apikey" : type === "oauth" ? "plan-oauth" : "plan-token"),
      refresh: typeof entry.refresh === "string" ? entry.refresh : null,
      expiresAt: typeof entry.expiresAt === "number" ? entry.expiresAt : null,
      accountId: typeof entry.accountId === "string" ? entry.accountId : null,
    };
  }
  if (typeof entry.key === "string" && entry.key) {
    return { type: "apikey", value: entry.key, method: "apikey", refresh: null, expiresAt: null };
  }
  return null;
}

// Store a credential. `cred` = { type, value, method?, refresh?, expiresAt? }.
// Called by `nomos auth login` / `nomos connect`. The secret never leaves this
// machine except as an auth header to the provider.
export function setCredential(providerId, cred) {
  if (!PROVIDERS[providerId]) throw new Error(`Unknown provider "${providerId}".`);
  const type = cred?.type;
  if (!VALID_TYPES.has(type)) throw new Error(`Unknown credential type "${type}".`);
  const value = typeof cred?.value === "string" ? cred.value.trim() : "";
  if (!value || value.length < 8) {
    throw new Error("That doesn't look like a valid credential. Aborted — nothing stored.");
  }
  const record = {
    type,
    value,
    method: cred.method || (type === "apikey" ? "apikey" : type === "oauth" ? "plan-oauth" : "plan-token"),
    savedAt: new Date().toISOString(),
  };
  if (type === "oauth") {
    if (typeof cred.refresh === "string" && cred.refresh.trim()) record.refresh = cred.refresh.trim();
    if (typeof cred.expiresAt === "number") record.expiresAt = cred.expiresAt;
    if (typeof cred.accountId === "string" && cred.accountId) record.accountId = cred.accountId;
  }
  const store = readStore();
  store[providerId] = record;
  writeStore(store);
}

// Back-compat helper: store a plain API key (used by `nomos auth login`).
export function setKey(providerId, key) {
  setCredential(providerId, { type: "apikey", value: key, method: "apikey" });
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

// Resolve a credential: store first, then the provider's named env var
// (server-side process env → treated as an apikey). Returns a normalized record
// { type, value, method, refresh, expiresAt, source } or null. NEVER log .value.
export function getCredential(providerId) {
  const store = readStore();
  const stored = normalize(store[providerId]);
  if (stored) return { ...stored, source: "store" };
  const provider = PROVIDERS[providerId];
  if (provider?.env && process.env[provider.env]) {
    return { type: "apikey", value: process.env[provider.env], method: "apikey", refresh: null, expiresAt: null, source: "env" };
  }
  return null;
}

// Back-compat: just the secret value (the gateway prefers getCredential).
export function getKey(providerId) {
  return getCredential(providerId)?.value ?? null;
}

// Report configuration status — provider id + method + source, NEVER the value.
export function listAuth() {
  const store = readStore();
  return Object.keys(PROVIDERS).map((id) => {
    const stored = normalize(store[id]);
    let source = null;
    let method = null;
    if (stored) { source = "store"; method = stored.method; }
    else if (PROVIDERS[id].env && process.env[PROVIDERS[id].env]) { source = "env"; method = "apikey"; }
    return { id, name: PROVIDERS[id].name, configured: source !== null, source, method };
  });
}

export const STORE_PATH = authPath();
