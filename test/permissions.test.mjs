import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPolicy, policyFromEnv, resolveClass, toolVerdict, DEFAULT_POLICY } from "../src/permissions.js";

test("defaults preserve today's behaviour (read/write/git on, shell/fetch off)", () => {
  const p = buildPolicy();
  assert.deepEqual(p, DEFAULT_POLICY);
  assert.equal(p.read, "allow"); assert.equal(p.write, "allow"); assert.equal(p.git, "allow");
  assert.equal(p.shell, "deny"); assert.equal(p.fetch, "deny");
});

test("precedence: global < env < cli (each overrides the prior)", () => {
  const p = buildPolicy({ global: { shell: "allow" }, env: { shell: "ask" }, cli: { shell: "deny" } });
  assert.equal(p.shell, "deny"); // cli wins
  const q = buildPolicy({ global: { fetch: "allow" }, env: { fetch: "ask" } });
  assert.equal(q.fetch, "ask"); // env over global
});

test("project nomos.json is RESTRICT-ONLY — can tighten, never loosen", () => {
  // a repo trying to GRANT shell is ignored (deny stays deny)
  const granted = buildPolicy({ project: { shell: "allow" } });
  assert.equal(granted.shell, "deny");
  // a repo trying to grant write also can't loosen below the trusted layer
  const loosen = buildPolicy({ cli: { write: "deny" }, project: { write: "allow" } });
  assert.equal(loosen.write, "deny"); // project cannot move deny→allow
  // but a repo CAN tighten an otherwise-allowed class
  const tighten = buildPolicy({ project: { write: "deny" } });
  assert.equal(tighten.write, "deny"); // allow→deny accepted
  const askTighten = buildPolicy({ project: { git: "ask" } });
  assert.equal(askTighten.git, "ask"); // allow→ask accepted
});

test("headless resolves 'ask' to 'deny' (CI never hangs); interactive keeps 'ask'", () => {
  const p = buildPolicy({ cli: { write: "ask" } });
  assert.equal(resolveClass(p, "write", true), "deny");   // headless
  assert.equal(resolveClass(p, "write", false), "ask");   // interactive (caller prompts)
  assert.equal(resolveClass(p, "read", true), "allow");
  assert.equal(resolveClass(p, "shell", true), "deny");
});

test("policyFromEnv parses NOMOS_POLICY_<CLASS>", () => {
  const layer = policyFromEnv({ NOMOS_POLICY_SHELL: "allow", NOMOS_POLICY_WRITE: "ask", NOMOS_POLICY_BOGUS: "nope" });
  assert.deepEqual(layer, { shell: "allow", write: "ask" });
});

test("toolVerdict maps tools to classes; unmapped tool defaults to 'write' (never unguarded)", () => {
  const allowShell = buildPolicy({ cli: { shell: "allow" } });
  assert.equal(toolVerdict(allowShell, "run_shell", true), "allow");
  assert.equal(toolVerdict(DEFAULT_POLICY, "run_shell", true), "deny");
  assert.equal(toolVerdict(DEFAULT_POLICY, "read_file", true), "allow");
  assert.equal(toolVerdict(DEFAULT_POLICY, "git", true), "allow");
  // a brand-new tool nobody mapped is gated as write, not silently allowed
  assert.equal(toolVerdict({ ...DEFAULT_POLICY, write: "deny" }, "some_new_tool", true), "deny");
});
