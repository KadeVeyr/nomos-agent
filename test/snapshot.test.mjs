import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { takeSnapshot, undo, captureState, isGitRepo } from "../src/snapshot.js";

let HAS_GIT = true;
try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { HAS_GIT = false; }
function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-snaptest-"));
  const g = (a) => execFileSync("git", a, { cwd: d, stdio: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  g(["init", "-q"]); g(["config", "user.email", "t@t.t"]); g(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(d, "keep.txt"), "original\n");
  fs.writeFileSync(path.join(d, "gone.txt"), "doomed\n");
  g(["add", "."]); g(["commit", "-q", "-m", "init"]);
  return d;
}

test("snapshot/undo is a no-op outside a git repo (never throws)", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "nomos-nogit-"));
  assert.equal(isGitRepo(d), false);
  assert.equal(captureState(d), null);
  assert.equal(takeSnapshot(d), null);
  assert.equal(undo(d).ok, false);
  fs.rmSync(d, { recursive: true, force: true });
});

test("captureState has ZERO side effects (no new commits, untracked preserved)", { skip: !HAS_GIT }, () => {
  const d = repo();
  fs.writeFileSync(path.join(d, "user-untracked.txt"), "user work\n");
  const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: d, encoding: "utf8" }).trim();
  const sha = captureState(d);
  assert.ok(/^[a-f0-9]{40}$/.test(sha));
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: d, encoding: "utf8" }).trim(), headBefore); // HEAD unmoved
  assert.ok(fs.existsSync(path.join(d, "user-untracked.txt"))); // untracked preserved
  fs.rmSync(d, { recursive: true, force: true });
});

test("undo reverts tracked edits + deletions, RESTORES the file the agent deleted, REPORTS (not deletes) agent-created files", { skip: !HAS_GIT }, () => {
  const d = repo();
  fs.writeFileSync(path.join(d, "user-untracked.txt"), "pre-run user file\n");
  assert.ok(takeSnapshot(d, "t").sha);
  // simulate the agent
  fs.writeFileSync(path.join(d, "keep.txt"), "AGENT EDIT\n");
  fs.rmSync(path.join(d, "gone.txt"));
  fs.writeFileSync(path.join(d, "agent-made.mjs"), "x\n");
  const res = undo(d);
  assert.ok(res.ok);
  assert.equal(fs.readFileSync(path.join(d, "keep.txt"), "utf8"), "original\n"); // edit reverted
  assert.ok(fs.existsSync(path.join(d, "gone.txt"))); // deletion restored
  assert.ok(fs.existsSync(path.join(d, "agent-made.mjs"))); // NOT deleted
  assert.deepEqual(res.untracked, ["agent-made.mjs"]); // only the agent's file (not user-untracked, not .nomos)
  assert.ok(res.safety); // a pre-undo safety snapshot was saved
  fs.rmSync(d, { recursive: true, force: true });
});
