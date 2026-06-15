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
  // a 200-line README change is NOT ship-risk (docs)
  assert.equal(classifyChange([{ added: 200, removed: 0, path: "README.md" }]).risky, false);
  // two doc files aren't "code files changed"
  assert.equal(classifyChange([{ added: 5, removed: 0, path: "a.md" }, { added: 5, removed: 0, path: "b.md" }]).risky, false);
  assert.equal(classifyChange([]).risky, false);
});
