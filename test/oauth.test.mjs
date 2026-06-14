import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  OAUTH, pkce, buildAuthUrl, redirectUri, decodeJwt, accountIdFromTokens,
  credentialFromTokenResponse, exchangeCode, refreshCredential, isExpired, providerHasOAuth,
} from "../src/oauth.js";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const makeJwt = (payload) => `${b64({ alg: "none" })}.${b64(payload)}.sig`;

test("providerHasOAuth: openai + xai yes, others no", () => {
  assert.equal(providerHasOAuth("openai"), true);
  assert.equal(providerHasOAuth("xai"), true);
  assert.equal(providerHasOAuth("anthropic"), false);
});

test("pkce: S256 challenge = base64url(sha256(verifier)), url-safe, no padding", () => {
  const { verifier, challenge } = pkce({ rand: (n) => Buffer.alloc(n, 7) });
  assert.ok(verifier.length >= 40);
  assert.ok(!/[+/=]/.test(verifier) && !/[+/=]/.test(challenge));
  assert.equal(challenge, crypto.createHash("sha256").update(verifier).digest().toString("base64url"));
});

test("buildAuthUrl: required PKCE params; xai carries plan=generic", () => {
  const u = new URL(buildAuthUrl(OAUTH.openai, { challenge: "CH", state: "ST", nonce: "NO" }));
  assert.equal(u.origin + u.pathname, "https://auth.openai.com/oauth/authorize");
  assert.equal(u.searchParams.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("code_challenge"), "CH");
  assert.equal(u.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  const ux = new URL(buildAuthUrl(OAUTH.xai, { challenge: "CH", state: "ST", nonce: "NO" }));
  assert.equal(ux.searchParams.get("plan"), "generic");
  assert.equal(ux.searchParams.get("redirect_uri"), "http://127.0.0.1:56121/callback");
});

test("decodeJwt + accountIdFromTokens: pulls chatgpt_account_id (openai only)", () => {
  const tok = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_123" } });
  assert.equal(decodeJwt(tok)["https://api.openai.com/auth"].chatgpt_account_id, "acc_123");
  assert.equal(accountIdFromTokens(OAUTH.openai, { idToken: tok }), "acc_123");
  assert.equal(accountIdFromTokens(OAUTH.openai, { accessToken: tok }), "acc_123"); // falls back to access token
  assert.equal(accountIdFromTokens(OAUTH.xai, { idToken: tok }), null); // xai has no account claim
  assert.equal(decodeJwt("not-a-jwt"), null);
});

test("credentialFromTokenResponse: expiry with skew, account id, refresh", () => {
  const tok = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_9" } });
  const c = credentialFromTokenResponse(OAUTH.openai, { access_token: "AT", refresh_token: "RT", expires_in: 3600, id_token: tok }, { now: 1_000_000 });
  assert.equal(c.type, "oauth");
  assert.equal(c.method, "plan-oauth");
  assert.equal(c.value, "AT");
  assert.equal(c.refresh, "RT");
  assert.equal(c.expiresAt, 1_000_000 + 3600 * 1000 - 120_000); // 2-min skew
  assert.equal(c.accountId, "acc_9");
});

test("exchangeCode: posts the right form body, returns a credential", async () => {
  let seen;
  const fakeFetch = async (url, opts) => { seen = { url, body: opts.body }; return { ok: true, json: async () => ({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }) }; };
  const c = await exchangeCode(OAUTH.openai, { code: "CODE", verifier: "VER" }, { fetch: fakeFetch, now: () => 0 });
  assert.equal(seen.url, "https://auth.openai.com/oauth/token");
  for (const frag of ["grant_type=authorization_code", "client_id=app_EMoamEEZ73f0CkXaXp7hrann", "code=CODE", "code_verifier=VER"]) {
    assert.ok(seen.body.includes(frag), `body should contain ${frag}`);
  }
  assert.equal(c.value, "AT");
});

test("refreshCredential: refresh_token grant; carries old refresh forward if none returned", async () => {
  let seen;
  const fakeFetch = async (_url, opts) => { seen = opts.body; return { ok: true, json: async () => ({ access_token: "AT2", expires_in: 3600 }) }; };
  const c = await refreshCredential(OAUTH.openai, "OLD_RT", { fetch: fakeFetch, now: () => 0 });
  assert.ok(seen.includes("grant_type=refresh_token"));
  assert.ok(seen.includes("refresh_token=OLD_RT"));
  assert.equal(c.value, "AT2");
  assert.equal(c.refresh, "OLD_RT"); // no new refresh returned → keep the old one
});

test("refreshCredential: surfaces a clean error on non-200 (no body leak)", async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(() => refreshCredential(OAUTH.openai, "RT", { fetch: fakeFetch }), /HTTP 401/);
});

test("isExpired: only oauth with a past expiresAt", () => {
  assert.equal(isExpired({ type: "oauth", expiresAt: 100 }, 200), true);
  assert.equal(isExpired({ type: "oauth", expiresAt: 300 }, 200), false);
  assert.equal(isExpired({ type: "apikey" }, 200), false);
  assert.equal(isExpired({ type: "oauth", expiresAt: null }, 200), false);
});

test("redirectUri: built from host/port/path", () => {
  assert.equal(redirectUri(OAUTH.openai), "http://localhost:1455/auth/callback");
  assert.equal(redirectUri(OAUTH.xai), "http://127.0.0.1:56121/callback");
});
