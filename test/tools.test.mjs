import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeTools } from "../src/tools.js";

function tmpRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-tools-"));
  fs.mkdirSync(path.join(d, "src"));
  fs.writeFileSync(path.join(d, "src", "a.js"), "function foo(){}\nfunction bar(){}\n");
  fs.writeFileSync(path.join(d, "readme.md"), "hello world\n");
  return d;
}
const tool = (d, name, opts) => makeTools({ root: d, ...opts }).find((t) => t.name === name);

test("edit_file replaces a unique substring; errors when not found", () => {
  const d = tmpRepo();
  tool(d, "edit_file").run({ path: "src/a.js", old_string: "foo", new_string: "FOO" });
  assert.match(fs.readFileSync(path.join(d, "src/a.js"), "utf8"), /function FOO/);
  assert.throws(() => tool(d, "edit_file").run({ path: "src/a.js", old_string: "nope", new_string: "x" }), /not found/);
  fs.rmSync(d, { recursive: true, force: true });
});

test("multi_edit is atomic (no partial write on failure)", () => {
  const d = tmpRepo();
  assert.throws(() => tool(d, "multi_edit").run({ path: "src/a.js", edits: [{ old_string: "foo", new_string: "X" }, { old_string: "MISSING", new_string: "Y" }] }), /not found/);
  assert.match(fs.readFileSync(path.join(d, "src/a.js"), "utf8"), /function foo/); // unchanged
  fs.rmSync(d, { recursive: true, force: true });
});

test("glob matches ** and *", () => {
  const d = tmpRepo();
  assert.equal(tool(d, "glob").run({ pattern: "src/**/*.js" }), "src/a.js");
  assert.equal(tool(d, "glob").run({ pattern: "*.md" }), "readme.md");
  fs.rmSync(d, { recursive: true, force: true });
});

test("search uses regex", () => {
  const d = tmpRepo();
  assert.equal(tool(d, "search").run({ query: "foo|bar" }).split("\n").length, 2);
  fs.rmSync(d, { recursive: true, force: true });
});

test("read_file offset/limit returns a numbered slice", () => {
  const d = tmpRepo();
  fs.writeFileSync(path.join(d, "big.txt"), Array.from({ length: 10 }, (_, i) => "L" + (i + 1)).join("\n"));
  const out = tool(d, "read_file").run({ path: "big.txt", offset: 3, limit: 2 });
  assert.match(out, /3\tL3/); assert.match(out, /4\tL4/); assert.doesNotMatch(out, /\bL5\b/);
  fs.rmSync(d, { recursive: true, force: true });
});

test("path confinement: reading outside root is rejected", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-conf-"));
  fs.writeFileSync(path.join(base, "outside.txt"), "SECRET");
  const root = path.join(base, "repo");
  fs.mkdirSync(root);
  const read = makeTools({ root }).find((t) => t.name === "read_file");
  assert.throws(() => read.run({ path: "../outside.txt" }), /escapes|blocked/); // existing parent file → escape caught
  assert.throws(() => read.run({ path: "../../../../etc/passwd" })); // any error — never returns content
  fs.rmSync(base, { recursive: true, force: true });
});

test("secret files (.env) are blocked", () => {
  const d = tmpRepo();
  fs.writeFileSync(path.join(d, ".env"), "SECRET=1");
  assert.throws(() => tool(d, "read_file").run({ path: ".env" }), /blocked/);
  fs.rmSync(d, { recursive: true, force: true });
});

test("run_shell / fetch_url are opt-in", () => {
  const d = tmpRepo();
  assert.equal(makeTools({ root: d }).some((t) => t.name === "run_shell"), false);
  assert.equal(makeTools({ root: d, allowShell: true }).some((t) => t.name === "run_shell"), true);
  assert.equal(makeTools({ root: d, allowFetch: true }).some((t) => t.name === "fetch_url"), true);
  fs.rmSync(d, { recursive: true, force: true });
});
