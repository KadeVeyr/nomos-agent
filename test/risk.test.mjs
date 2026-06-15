import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNumstat, classifyChange } from "../src/risk.js";

test("parseNumstat parses added/removed/path, incl. a binary file", () => {
  const rows = parseNumstat("3\t1\tsrc/a.js\n10\t0\ttest/b.test.mjs\n-\t-\timg.png");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { added: 3, removed: 1, path: "src/a.js" });
  assert.equal(rows[2].added, 0); // binary churn counts as 0
});

test("classifyChange: a sensitive PATH is always ship-risk, with a concrete reason", () => {
  assert.match(classifyChange([{ added: 2, removed: 0, path: "src/auth/login.js" }]).reason, /auth/);
  assert.match(classifyChange([{ added: 1, removed: 1, path: "src/payment/charge.js" }]).reason, /payment/);
  assert.match(classifyChange([{ added: 1, removed: 1, path: "db/migrations/003_users.sql" }]).reason, /migration/);
  assert.match(classifyChange([{ added: 1, removed: 0, path: "package.json" }]).reason, /dependency/);
  assert.match(classifyChange([{ added: 1, removed: 0, path: ".github/workflows/ci.yml" }]).reason, /CI/);
  assert.match(classifyChange([{ added: 1, removed: 0, path: "src/crypto.js" }]).reason, /crypto/);
});

test("classifyChange: camelCase / plural / .env / script / generic-access names ARE caught (the adversarial blind spots)", () => {
  const risky = (p) => classifyChange([{ added: 1, removed: 1, path: p }]).risky;
  // camelCase — the dominant JS/TS convention
  for (const p of ["src/authMiddleware.ts", "src/verifyToken.ts", "src/getSession.ts", "src/jwtVerify.ts", "src/decryptPayload.ts", "src/runMigration.js"]) assert.equal(risky(p), true, `camelCase: ${p}`);
  // plural filenames
  for (const p of ["src/secrets.js", "src/tokens.js", "src/sessions.js", "src/permissions.js", "src/credentials.js", "src/policies.js"]) assert.equal(risky(p), true, `plural: ${p}`);
  // env / secrets config + web/supply-chain config + scripts
  for (const p of [".env", ".env.production", "config/secrets.env", "nginx.conf", ".npmrc", "scripts/rotate-keys.sh", "deploy.bat"]) assert.equal(risky(p), true, `config/script: ${p}`);
  // generic access-control names
  for (const p of ["src/cors.js", "src/firewall.js", "src/admin.js", "src/guard.js", "src/access.js"]) assert.equal(risky(p), true, `access: ${p}`);
});

test("classifyChange ignores NOMOS's own .nomos/ bookkeeping (no false 'session' positive)", () => {
  // a trivial user edit + the agent's own .nomos session/snapshot files → still LOW-risk
  // (".nomos/sessions/…" must NOT match the "session" rule)
  const rows = [
    { added: 1, removed: 1, path: "src/greeting.mjs" },
    { added: 5, removed: 0, path: ".nomos/sessions/20260615T0334.jsonl" },
    { added: 2, removed: 0, path: ".nomos/snapshots/latest.json" },
  ];
  assert.equal(classifyChange(rows).risky, false);
});

test("classifyChange: a big DELETION from a code file is ship-risk (deleted checks/guards)", () => {
  assert.match(classifyChange([{ added: 0, removed: 30, path: "src/server.mjs" }]).reason, /removed/);
  assert.equal(classifyChange([{ added: 0, removed: 3, path: "src/server.mjs" }]).risky, false); // a tiny removal isn't
});

test("classifyChange: >1 code file OR a large single change is ship-risk", () => {
  assert.equal(classifyChange([{ added: 2, removed: 0, path: "a.js" }, { added: 2, removed: 0, path: "b.js" }]).risky, true);
  assert.equal(classifyChange([{ added: 50, removed: 0, path: "a.js" }]).risky, true);
});

test("classifyChange does NOT over-flag (targeted, not 'everything is risky')", () => {
  // a small single non-sensitive edit
  assert.equal(classifyChange([{ added: 3, removed: 1, path: "src/util.js" }]).risky, false);
  // names that merely CONTAIN a risky substring are not flagged (boundary-anchored)
  assert.equal(classifyChange([{ added: 2, removed: 0, path: "src/keyboard.js" }]).risky, false); // not "apikey"
  assert.equal(classifyChange([{ added: 2, removed: 0, path: "src/tokenizer.js" }]).risky, false); // not "token"
  assert.equal(classifyChange([{ added: 2, removed: 0, path: "src/authority-list.js" }]).risky, false); // not "auth"
  // a 200-line README change is NOT ship-risk (docs)
  assert.equal(classifyChange([{ added: 200, removed: 0, path: "README.md" }]).risky, false);
  // two doc files aren't "code files changed"
  assert.equal(classifyChange([{ added: 5, removed: 0, path: "a.md" }, { added: 5, removed: 0, path: "b.md" }]).risky, false);
  // a huge GENERATED-file churn is not ship-risk (excluded from the line threshold)
  assert.equal(classifyChange([{ added: 5000, removed: 0, path: "src/generated/api.ts" }]).risky, false);
  assert.equal(classifyChange([]).risky, false);
});
