// oauth.js — "use your subscription" login. Some providers let you sign in with
// an existing plan (ChatGPT Plus/Pro, xAI SuperGrok) instead of paying
// per-token API credits. This runs the standard OAuth 2.0 PKCE loopback flow:
// open the provider's consent page in your browser, catch the redirect on a
// local port, and exchange the code for an access + refresh token stored locally.
//
// The client ids and endpoints are PUBLIC app registrations of each vendor's own
// first-party CLI (sourced from those CLIs, not guessed). This is personal-use,
// at-your-own-risk: a plan token is account-bound and outside the documented
// API path. Pure helpers (pkce / buildAuthUrl / decodeJwt / token bodies) take
// injectable deps so they're testable without a browser or network.

import http from "node:http";
import crypto from "node:crypto";
import { exec } from "node:child_process";

// Per-provider OAuth configuration. Endpoints + client ids are each vendor's
// first-party CLI registration (see docs/PLAN_OAUTH.md for provenance).
export const OAUTH = {
  openai: {
    label: "ChatGPT Plus/Pro — Sign in with ChatGPT",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
    redirectHost: "localhost",
    redirectPort: 1455,
    redirectPath: "/auth/callback",
    accountClaim: "https://api.openai.com/auth", // JWT claim → .chatgpt_account_id
  },
  xai: {
    label: "SuperGrok / X Premium+ — xAI login",
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    authorizeUrl: "https://auth.x.ai/oauth2/authorize",
    tokenUrl: "https://auth.x.ai/oauth2/token",
    scope: "openid profile email offline_access grok-cli:access api:access",
    redirectHost: "127.0.0.1",
    redirectPort: 56121,
    redirectPath: "/callback",
    extraAuthParams: { plan: "generic" },
    accountClaim: null, // xAI authenticates with the bearer token alone
  },
};

const SKEW_MS = 120000; // refresh 2 minutes before the token actually expires
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rnd = (deps, n) => (deps.rand ? deps.rand(n) : crypto.randomBytes(n));

export function providerHasOAuth(providerId) {
  return Object.prototype.hasOwnProperty.call(OAUTH, providerId);
}

// PKCE S256 verifier/challenge pair.
export function pkce(deps = {}) {
  const verifier = b64url(rnd(deps, 32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function redirectUri(cfg) {
  return `http://${cfg.redirectHost}:${cfg.redirectPort}${cfg.redirectPath}`;
}

// The consent URL the user opens in a browser.
export function buildAuthUrl(cfg, { challenge, state, nonce }) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri(cfg),
    scope: cfg.scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
    ...(cfg.extraAuthParams || {}),
  });
  return `${cfg.authorizeUrl}?${q.toString()}`;
}

// Decode a JWT payload WITHOUT verifying it — we only read public claims (the
// account id). The token's authenticity is proven by the backend accepting it,
// not by us; we never trust these claims for a security decision.
export function decodeJwt(token) {
  try {
    const part = String(token || "").split(".")[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

// Extract the provider account id (OpenAI requires it as a header); null if the
// provider doesn't use one.
export function accountIdFromTokens(cfg, { idToken, accessToken }) {
  if (!cfg.accountClaim) return null;
  for (const tok of [idToken, accessToken]) {
    const v = decodeJwt(tok)?.[cfg.accountClaim]?.chatgpt_account_id;
    if (typeof v === "string" && v) return v;
  }
  return null;
}

// Build the stored-credential record from a token-endpoint JSON response.
export function credentialFromTokenResponse(cfg, json, { now = Date.now(), prevRefresh = null } = {}) {
  const expiresAt = json?.expires_in ? now + json.expires_in * 1000 - SKEW_MS : null;
  return {
    type: "oauth",
    method: "plan-oauth",
    value: json?.access_token || "",
    refresh: json?.refresh_token || prevRefresh || null,
    expiresAt,
    accountId: accountIdFromTokens(cfg, { idToken: json?.id_token, accessToken: json?.access_token }),
  };
}

async function postToken(cfg, body, deps = {}) {
  const _fetch = deps.fetch || fetch;
  const res = await _fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new Error(`OAuth token request failed (HTTP ${res.status}). Try connecting again.`);
  return res.json();
}

// Exchange the authorization code for tokens.
export async function exchangeCode(cfg, { code, verifier }, deps = {}) {
  const json = await postToken(cfg, {
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri(cfg),
  }, deps);
  return credentialFromTokenResponse(cfg, json, { now: deps.now ? deps.now() : Date.now() });
}

// Refresh an expired access token using the refresh token. Returns the new
// credential record (carrying the old refresh token forward if none returned).
export async function refreshCredential(cfg, refreshToken, deps = {}) {
  const json = await postToken(cfg, {
    grant_type: "refresh_token",
    client_id: cfg.clientId,
    refresh_token: refreshToken,
  }, deps);
  return credentialFromTokenResponse(cfg, json, { now: deps.now ? deps.now() : Date.now(), prevRefresh: refreshToken });
}

export function isExpired(cred, now = Date.now()) {
  return cred?.type === "oauth" && typeof cred.expiresAt === "number" && cred.expiresAt <= now;
}

export function openBrowser(url) {
  const p = process.platform;
  const cmd = p === "win32" ? `start "" "${url}"` : p === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

// Run the full loopback login: start a local server on the redirect port, open
// the browser to the consent page, wait for the ?code= callback (state-checked),
// then exchange it. Returns the stored-credential record. deps inject
// http/open/fetch/timers for tests.
export async function loginLoopback(cfg, deps = {}) {
  const _http = deps.http || http;
  const _openBrowser = deps.openBrowser || openBrowser;
  const onUrl = deps.onUrl || (() => {});
  const timeoutMs = deps.timeoutMs ?? 300000;

  const { verifier, challenge } = pkce(deps);
  const state = b64url(rnd(deps, 16));
  const nonce = b64url(rnd(deps, 16));
  const url = buildAuthUrl(cfg, { challenge, state, nonce });

  const code = await new Promise((resolve, reject) => {
    let timer;
    let finished = false;
    const done = (fn, arg) => { if (finished) return; finished = true; clearTimeout(timer); try { server.close(); } catch { /* already closing */ } fn(arg); };
    const page = (title, body, ok) => `<!doctype html><meta charset=utf-8><body style='font-family:system-ui;background:#0a0b0d;color:#edf0f3;text-align:center;padding-top:84px'><h2 style='color:${ok ? "#42e08b" : "#ff7a7a"}'>${title}</h2><p>${body}</p></body>`;
    const server = _http.createServer((req, res) => {
      let u;
      try { u = new URL(req.url, `http://${cfg.redirectHost}:${cfg.redirectPort}`); }
      catch { res.writeHead(400); res.end(); return; }
      if (u.pathname !== cfg.redirectPath) { res.writeHead(404); res.end(); return; }
      // VALIDATE before we render success or tear down. Only the genuine callback
      // echoes our random `state`; a stray or cross-site hit (or a forged ?error=)
      // is ignored WITHOUT closing the server, so it can't deny an in-flight login.
      if (u.searchParams.get("state") !== state) {
        res.writeHead(400, { "content-type": "text/plain" }); res.end("Waiting for the Nomos login callback…"); return;
      }
      const err = u.searchParams.get("error");
      if (err) {
        res.writeHead(400, { "content-type": "text/html" });
        res.end(page("Login failed", `Sign-in was declined (${err}). You can close this tab.`, false));
        return done(reject, new Error(`Login was declined or failed (${err}).`));
      }
      const gotCode = u.searchParams.get("code");
      if (!gotCode) { res.writeHead(400, { "content-type": "text/plain" }); res.end("Waiting for the Nomos login callback…"); return; }
      // Valid: state matched + code present → succeed last.
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page("✓ Nomos connected", "You can close this tab and return to the terminal.", true));
      done(resolve, gotCode);
    });
    server.on("error", (e) => done(reject, new Error(`Could not start the local login server on port ${cfg.redirectPort} (${e.code || e.message}). Is something else using it?`)));
    server.listen(cfg.redirectPort, cfg.redirectHost, () => {
      onUrl(url);
      _openBrowser(url);
    });
    timer = setTimeout(() => done(reject, new Error("Login timed out — no response within 5 minutes.")), timeoutMs);
  });

  return exchangeCode(cfg, { code, verifier }, deps);
}
