// Config — sane defaults, single file, env overrides, per-project settings.
//
// Precedence (low → high):
//   1. built-in defaults
//   2. global   ~/.config/nomos/config.json   (user-controlled — may set capabilities)
//   3. project  ./nomos.json                  (repo-controlled — NON-capability only)
//   4. env      NOMOS_MODEL / NOMOS_ALLOW_SHELL / NOMOS_ALLOW_FETCH / NOMOS_MAX_STEPS
//   5. CLI flags (passed in by the caller)
//
// SECURITY: capability flags (allowShell, allowFetch) are STRIPPED from the
// project nomos.json — a cloned repo cannot silently grant shell or network.
// Those come only from the user's own global config, env, or an explicit flag.
// Config holds NO secrets — credentials live only in the auth store.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULTS = {
  defaultModel: null,
  allowShell: false,
  allowFetch: false,
  maxSteps: 30, // real coding tasks need many explore→edit→verify iterations
};
// Keys a repo-controlled project nomos.json may NOT set: capability flags
// (would grant shell/network) AND defaultModel — a cloned repo must not get to
// silently choose which provider your task + code + tool transcript egress to.
// These come only from the user's global config, env, or an explicit CLI flag.
const PROJECT_FORBIDDEN_KEYS = ["allowShell", "allowFetch", "defaultModel"];

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}

export function loadConfig({ root = process.cwd(), cli = {} } = {}) {
  const globalPath = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "nomos", "config.json");
  const projectPath = path.join(root, "nomos.json");

  const global = readJson(globalPath);
  const project = readJson(projectPath);
  // Strip capability + egress keys from the (repo-controlled) project file.
  for (const k of PROJECT_FORBIDDEN_KEYS) delete project[k];

  const env = {};
  if (process.env.NOMOS_MODEL) env.defaultModel = process.env.NOMOS_MODEL;
  if (process.env.NOMOS_ALLOW_SHELL) env.allowShell = process.env.NOMOS_ALLOW_SHELL === "true" || process.env.NOMOS_ALLOW_SHELL === "1";
  if (process.env.NOMOS_ALLOW_FETCH) env.allowFetch = process.env.NOMOS_ALLOW_FETCH === "true" || process.env.NOMOS_ALLOW_FETCH === "1";
  if (process.env.NOMOS_MAX_STEPS) env.maxSteps = Number(process.env.NOMOS_MAX_STEPS) || DEFAULTS.maxSteps;

  const merged = { ...DEFAULTS, ...global, ...project, ...env };
  for (const k of Object.keys(cli)) if (cli[k] !== undefined && cli[k] !== null) merged[k] = cli[k];
  merged.root = root;
  return merged;
}
