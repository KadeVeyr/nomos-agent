import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeTools } from "../src/tools.js";

function tmpRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-tools-"));
  fs.mkdirSync(path.join(d, "src"));
  fs.writeFileSync(path.join(d, "src", "a.js"), "function foo(){}\nfunction bar(){}\n");
  fs.writeFileSync(path.join(d, "readme.md"), "hello world\n");
  return d;
}
const tool = (d, name, opts) => makeTools({ root: d, ...opts }).find((t) => t.name === name);

let HAS_GIT = true;
try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { HAS_GIT = false; }
function gitRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-git-"));
  const g = (args) => execFileSync("git", args, { cwd: d, stdio: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  g(["init", "-q"]); g(["config", "user.email", "t@t.t"]); g(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(d, "a.txt"), "hello\n");
  g(["add", "a.txt"]); g(["commit", "-q", "-m", "init"]);
  return d;
}

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

test("git tool is always available (NOT opt-in, unlike run_shell)", () => {
  const d = tmpRepo();
  assert.equal(makeTools({ root: d }).some((t) => t.name === "git"), true);
  fs.rmSync(d, { recursive: true, force: true });
});

test("git: read-only commands run; mutating + escaping ones are refused", { skip: !HAS_GIT }, async () => {
  const d = gitRepo();
  const git = tool(d, "git");
  // read-only forms work
  assert.equal(typeof (await git.run({ args: ["status", "--short"] })), "string");
  assert.match(await git.run({ args: ["log", "--oneline"] }), /init/);
  assert.match(await git.run({ args: ["diff", "HEAD"] }), /[\s\S]*/);
  // mutating subcommands are refused outright (and cat-file removed — blob exfil)
  for (const bad of [["commit", "-m", "x"], ["push"], ["add", "."], ["checkout", "."], ["reset", "--hard"], ["rebase"], ["stash"], ["merge", "x"], ["cat-file", "-p", "HEAD"]]) {
    await assert.rejects(() => git.run({ args: bad }), /not a permitted/, `should refuse: git ${bad.join(" ")}`);
  }
  // dual-use subcommands: mutating FLAG forms refused
  await assert.rejects(() => git.run({ args: ["branch", "-D", "main"] }), /not a permitted read-only/);
  await assert.rejects(() => git.run({ args: ["tag", "-d", "v1"] }), /not a permitted read-only/);
  await assert.rejects(() => git.run({ args: ["remote", "add", "o", "url"] }), /permitted/);
  // POSITIONAL create forms (no mutating flag) — the adversarial-audit finding
  await assert.rejects(() => git.run({ args: ["tag", "v1", "HEAD"] }), /create or move a ref/);
  await assert.rejects(() => git.run({ args: ["branch", "newbr", "HEAD"] }), /create or move a ref/);
  await assert.rejects(() => git.run({ args: ["remote", "set-branches", "origin", "x"] }), /permitted/);
  // global-option injection (escape the repo / write a file), incl. glued -c / -C
  await assert.rejects(() => git.run({ args: ["-C", "/", "status"] }), /must be a subcommand/);
  await assert.rejects(() => git.run({ args: ["diff", "--output", "x"] }), /not allowed/);
  await assert.rejects(() => git.run({ args: ["diff", "--output=x"] }), /not allowed/);
  await assert.rejects(() => git.run({ args: ["log", "-ccore.pager=!touch pwned", "-1"] }), /not allowed/);
  await assert.rejects(() => git.run({ args: ["status", "-Cother"] }), /not allowed/);
  await assert.rejects(() => git.run({ args: ["diff", "--no-index", "/etc/passwd", "/etc/hosts"] }), /not allowed/);
  // working-directory ESCAPE via rev:path traversal / absolute path
  await assert.rejects(() => git.run({ args: ["show", "HEAD:../../etc/passwd"] }), /escapes/);
  await assert.rejects(() => git.run({ args: ["diff", "--", "/etc/passwd"] }), /escapes/);
  await assert.rejects(() => git.run({ args: ["log", "--", "../../.ssh/config"] }), /escapes/);
  // whole-history CONTENT dump refused (committed-then-gitignored secret)
  await assert.rejects(() => git.run({ args: ["log", "-p"] }), /historical file content/);
  await assert.rejects(() => git.run({ args: ["log", "-S", "API_KEY", "-p"] }), /historical file content/);
  // secret-path args (mirror the file denylist), incl. pathspec-magic + double-ext
  await assert.rejects(() => git.run({ args: ["show", "HEAD:.env"] }), /secret/);
  await assert.rejects(() => git.run({ args: ["diff", "--", "id_rsa"] }), /secret/);
  await assert.rejects(() => git.run({ args: ["show", "HEAD:deploy.pem"] }), /secret/);
  await assert.rejects(() => git.run({ args: ["show", ":(top).env"] }), /secret/);
  await assert.rejects(() => git.run({ args: ["show", "HEAD:cfg/server.key.bak"] }), /secret/);
  await assert.rejects(() => git.run({ args: ["show", "HEAD:config/prod.env"] }), /secret/);      // env file without leading dot
  await assert.rejects(() => git.run({ args: ["show", "HEAD:env.production"] }), /secret/);        // ditto
  // empty args
  await assert.rejects(() => git.run({ args: [] }), /non-empty/);
  fs.rmSync(d, { recursive: true, force: true });
});

test("git: read-only LISTING + metadata forms still work after hardening", { skip: !HAS_GIT }, async () => {
  const d = gitRepo();
  const git = tool(d, "git");
  await assert.doesNotReject(() => git.run({ args: ["branch"] }));
  await assert.doesNotReject(() => git.run({ args: ["branch", "-vv"] }));
  await assert.doesNotReject(() => git.run({ args: ["branch", "--contains", "HEAD"] })); // bareword as value of --contains is allowed
  await assert.doesNotReject(() => git.run({ args: ["tag", "-l"] }));
  await assert.doesNotReject(() => git.run({ args: ["remote", "-v"] }));
  await assert.doesNotReject(() => git.run({ args: ["log", "--stat"] }));
  await assert.doesNotReject(() => git.run({ args: ["log", "--oneline", "-n", "5"] }));
  assert.match(await git.run({ args: ["show", "--stat", "HEAD"] }), /init/);
  fs.rmSync(d, { recursive: true, force: true });
});

test("git: redactSecrets scrubs a credential-shaped token from git output", { skip: !HAS_GIT }, async () => {
  const d = gitRepo();
  // inject a credential-shaped token via a log --format literal; the output-side
  // redactor must scrub it (the defense against committed-then-gitignored secrets)
  const red = await tool(d, "git").run({ args: ["log", "--format=%h sk-abcd1234567890ABCD1234"] });
  assert.match(red, /redacted/);
  assert.doesNotMatch(red, /sk-abcd1234567890ABCD1234/);
  fs.rmSync(d, { recursive: true, force: true });
});
