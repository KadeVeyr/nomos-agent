import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate the credential store BEFORE importing auth.js.
process.env.XDG_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-auth-"));
const { setCredential, getCredential, listAuth, removeKey } = await import("../src/auth.js");

test("credential round-trip; listAuth never exposes the value", () => {
  setCredential("openai", { type: "apikey", value: "sk-secret-12345", method: "apikey" });
  const c = getCredential("openai");
  assert.equal(c.value, "sk-secret-12345");
  assert.equal(c.method, "apikey");
  assert.ok(!JSON.stringify(listAuth()).includes("sk-secret-12345"));
});

test("oauth credential keeps refresh + expiry", () => {
  setCredential("anthropic", { type: "oauth", value: "tok-12345678", method: "plan-oauth", refresh: "ref-12345678", expiresAt: 123 });
  const c = getCredential("anthropic");
  assert.equal(c.type, "oauth");
  assert.equal(c.refresh, "ref-12345678");
});

test("removeKey works; short/invalid credential rejected", () => {
  assert.ok(removeKey("openai"));
  assert.equal(getCredential("openai"), null);
  assert.throws(() => setCredential("openai", { type: "apikey", value: "short" }), /valid credential|Aborted|doesn't look/);
  assert.throws(() => setCredential("nope-provider", { type: "apikey", value: "sk-12345678" }), /Unknown provider/);
});
