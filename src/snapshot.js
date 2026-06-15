// Git snapshot / undo — make an agent run REVERSIBLE.
//
// Before the agent's first write, snapshot the repo's CURRENT state (working tree
// + index + untracked) as a DANGLING commit with ZERO side effects
// (`git stash create --include-untracked` — no HEAD move, no index/worktree/stash
// mutation). `nomos undo` restores tracked files to that snapshot, after first
// saving a pre-undo safety snapshot so nothing is ever lost; agent-CREATED
// untracked files are reported, never auto-deleted (we won't clobber your files).
//
// Like the read-only git tool, git runs with execFile (no shell) and a scrubbed
// env that ignores user/system config execution vectors.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const snapDir = (root) => path.join(root, ".nomos", "snapshots");

function gitEnv() {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/.test(k)) e[k] = v;
  e.GIT_PAGER = "cat"; e.GIT_TERMINAL_PROMPT = "0"; e.GIT_CONFIG_NOSYSTEM = "1";
  e.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  e.GIT_OPTIONAL_LOCKS = "0";
  return e;
}
function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: gitEnv() }).trim();
}
function tryGit(root, args) { try { return git(root, args); } catch { return null; } }

export function isGitRepo(root) { return tryGit(root, ["rev-parse", "--git-dir"]) !== null; }
function headSha(root) { return tryGit(root, ["rev-parse", "--verify", "HEAD"]); }

// Capture the current state as a commit-ish, ZERO side effects. Returns the sha or
// null if unavailable (not a git repo / no commits). On a clean tree, `stash
// create` is empty, so the snapshot is just HEAD.
export function captureState(root) {
  if (!isGitRepo(root) || !headSha(root)) return null;
  let sha = tryGit(root, ["stash", "create", "--include-untracked"]); // tracked+index+untracked
  if (!sha) sha = tryGit(root, ["stash", "create"]);                   // older git w/o -u
  if (!sha) sha = headSha(root);                                       // clean tree
  return sha || null;
}

// Full diff of everything that changed since baseSha — INCLUDING new untracked
// files. A plain `git diff <base>` only shows TRACKED changes, so the agent's new
// files (its most common output) would be invisible and `nomos run --verify` would
// see "nothing changed" on greenfield work. This stages the current working tree
// into a THROWAWAY index (GIT_INDEX_FILE — the user's real index is untouched),
// honoring .gitignore, then diffs it against the base. opts.numstat → per-file
// churn. Returns the diff text, or null (not a git repo / no base).
export function diffSince(root, baseSha, { numstat = false } = {}) {
  if (!isGitRepo(root) || !baseSha) return null;
  const idx = path.join(os.tmpdir(), `nomos-idx-${process.pid}-${Date.now()}`);
  const env = { ...gitEnv(), GIT_INDEX_FILE: idx };
  const run = (args) => execFileSync("git", args, { cwd: root, env, windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const ex = ":(exclude).nomos"; // NOMOS's own bookkeeping (.nomos/) is never part of the user's change
  try {
    run(["read-tree", baseSha]);                 // throwaway index = the base tree
    run(["add", "-A", "--", ".", ex]);           // stage the current working tree (incl NEW files), minus .nomos
    return run(numstat ? ["diff", "--cached", "--numstat", baseSha, "--", ".", ex] : ["diff", "--cached", baseSha, "--", ".", ex]);
  } catch { return null; }
  finally { try { fs.unlinkSync(idx); } catch { /* best effort */ } }
}

// Take + persist a snapshot for an agent run. Returns the record or null.
export function takeSnapshot(root, runId = "run") {
  const sha = captureState(root);
  if (!sha) return null;
  // record the user's pre-run untracked files NOW (before we create .nomos state)
  // so undo can tell them apart from files the agent creates during the run.
  const untracked = (tryGit(root, ["ls-files", "--others", "--exclude-standard"]) || "").split("\n").filter(Boolean);
  fs.mkdirSync(snapDir(root), { recursive: true });
  const rec = { runId, sha, head: headSha(root), ts: new Date().toISOString(), untracked };
  fs.writeFileSync(path.join(snapDir(root), "latest.json"), JSON.stringify(rec, null, 2));
  try { fs.appendFileSync(path.join(snapDir(root), "log.jsonl"), JSON.stringify(rec) + "\n"); } catch { /* best effort */ }
  return rec;
}

// Restore the working tree's TRACKED files to the latest snapshot. Saves a
// pre-undo safety snapshot first. Reports agent-created untracked files (does not
// delete them). Returns { ok, restored, safety, untracked } or { ok:false, error }.
export function undo(root) {
  if (!isGitRepo(root)) return { ok: false, error: "not a git repository — nothing to undo" };
  let rec;
  try { rec = JSON.parse(fs.readFileSync(path.join(snapDir(root), "latest.json"), "utf8")); }
  catch { return { ok: false, error: "no snapshot found for this repo (nothing to undo)" }; }
  const safety = captureState(root); // save current state — nothing is ever lost
  try { git(root, ["checkout", rec.sha, "--", "."]); }
  catch (e) { return { ok: false, error: "restore failed: " + (e.message || "git checkout") }; }
  // Report only files the AGENT created: current untracked, minus NOMOS's own
  // state and minus the files already untracked at snapshot time (the user's
  // pre-run work, recorded by takeSnapshot).
  const snapUntracked = new Set(rec.untracked || []);
  const untracked = (tryGit(root, ["ls-files", "--others", "--exclude-standard"]) || "")
    .split("\n").filter(Boolean)
    .filter((f) => !f.startsWith(".nomos/") && !snapUntracked.has(f));
  if (safety) {
    try { fs.writeFileSync(path.join(snapDir(root), "preundo.json"), JSON.stringify({ undoOf: rec.sha, sha: safety, ts: new Date().toISOString() }, null, 2)); } catch { /* best effort */ }
  }
  return { ok: true, restored: rec.sha.slice(0, 12), safety: safety ? safety.slice(0, 12) : null, untracked };
}
