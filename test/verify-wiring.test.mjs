// End-to-end wiring of the verify=risky decision: the EXACT pipeline verifyRun
// uses — snapshot the repo, make a change, then diffSince (incl new files, minus
// .nomos) → parseNumstat → classifyChange. Asserts each risk bar fires/skips on a
// REAL git repo (no model call). Locks the behaviour the unit tests imply.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { captureState, diffSince } from "../src/snapshot.js";
import { parseNumstat, classifyChange } from "../src/risk.js";

let HAS_GIT = true;
try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { HAS_GIT = false; }

// Set up a repo with `seed` files committed, snapshot it, apply `change`, then run
// the real verifyRun pipeline and return the classification.
function classifyAfter(seed, change) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-wire-"));
  const g = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const w = (p, c) => { fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true }); fs.writeFileSync(path.join(d, p), c); };
  g(["init", "-q"]); g(["config", "user.email", "t@t.t"]); g(["config", "user.name", "t"]);
  for (const [p, c] of Object.entries(seed)) w(p, c);
  g(["add", "."]); g(["commit", "-q", "-m", "init"]);
  const base = captureState(d);           // pre-change snapshot (as `nomos run` takes)
  change(w, d);                            // apply the agent's "change"
  const r = classifyChange(parseNumstat(diffSince(d, base, { numstat: true }) || ""));
  fs.rmSync(d, { recursive: true, force: true });
  return r;
}
const lines = (n, p = "x") => Array.from({ length: n }, (_, i) => `const ${p}${i} = ${i};`).join("\n") + "\n";

test("risk wiring: a single sensitive-path edit FIRES", { skip: !HAS_GIT }, () => {
  const r = classifyAfter({ "src/auth.mjs": "export const ok = 1;\n" }, (w) => w("src/auth.mjs", "export const ok = 2;\n"));
  assert.equal(r.risky, true); assert.match(r.reason, /auth/);
});

test("risk wiring: a 12+ line guard DELETION FIRES", { skip: !HAS_GIT }, () => {
  const r = classifyAfter({ "src/server.mjs": lines(15, "g") }, (w) => w("src/server.mjs", lines(2, "g")));
  assert.equal(r.risky, true); assert.match(r.reason, /removed|code files|lines/);
});

test("risk wiring: a 41+ line single non-sensitive change FIRES (line threshold)", { skip: !HAS_GIT }, () => {
  const r = classifyAfter({ "README.md": "# p\n" }, (w) => w("src/util.mjs", lines(45, "u"))); // new 45-line code file
  assert.equal(r.risky, true);
});

test("risk wiring: a NEW multi-file greenfield change FIRES (and diffSince sees new files)", { skip: !HAS_GIT }, () => {
  const r = classifyAfter({ "README.md": "# p\n" }, (w) => { w("src/a.mjs", "export const a=1;\n"); w("src/b.mjs", "export const b=2;\n"); });
  assert.equal(r.risky, true); assert.match(r.reason, /code files/);
});

test("risk wiring: a docs-only change SKIPS", { skip: !HAS_GIT }, () => {
  const r = classifyAfter({ "README.md": "# p\n" }, (w) => w("README.md", lines(200, "d").replace(/const/g, "word")));
  assert.equal(r.risky, false);
});

test("risk wiring: a tiny single non-sensitive edit SKIPS", { skip: !HAS_GIT }, () => {
  const r = classifyAfter({ "src/format.mjs": "export const v = 1;\n" }, (w) => w("src/format.mjs", "export const v = 2;\n"));
  assert.equal(r.risky, false);
});
