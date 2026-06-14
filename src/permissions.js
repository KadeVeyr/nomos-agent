// Per-tool permissions — a real, legible gate so a verification receipt means
// something (a proposer that ran unrestricted shell makes the receipt hollow).
//
// Every tool maps to a CLASS; every class has a verdict: allow | ask | deny.
// The gate is checked at tool-dispatch time (agent.js), so a denied tool returns
// a recoverable error to the model instead of silently running.
//
// PRECEDENCE (low → high): built-in defaults < global config < env < CLI flags.
// The project's own nomos.json may only TIGHTEN a class (restrict-only) — a cloned
// repo can never loosen a class to grant itself shell/network/write. This mirrors
// the config invariant that capability flags don't come from the repo.
//
// HEADLESS (nomos run / seat have no TTY): "ask" deterministically resolves to
// "deny" so a CI run is reproducible and never hangs. Escalate explicitly with
// --allow <class> / --allow-shell / --allow-fetch.

export const CLASSES = ["read", "write", "git", "fetch", "shell"];

// tool name → permission class. Anything unmapped is treated as "write" (the
// safe-but-not-most-dangerous default) so a new tool can't accidentally be unguarded.
export const TOOL_CLASS = {
  read_file: "read", list_dir: "read", glob: "read", search: "read",
  git: "git",
  write_file: "write", edit_file: "write", multi_edit: "write",
  fetch_url: "fetch",
  run_shell: "shell",
  remember: "write", recall: "read",
};

// Built-in defaults preserve today's behaviour: read/write/git on, network + shell
// off until explicitly enabled.
export const DEFAULT_POLICY = { read: "allow", write: "allow", git: "allow", fetch: "deny", shell: "deny" };

const RANK = { allow: 0, ask: 1, deny: 2 };
const normVerdict = (v) => (v === "allow" || v === "ask" || v === "deny" ? v : null);

// Merge a layer that is TRUSTED to loosen or tighten (global config, env, CLI).
function applyTrusted(policy, layer) {
  if (!layer || typeof layer !== "object") return policy;
  for (const c of CLASSES) { const v = normVerdict(layer[c]); if (v) policy[c] = v; }
  return policy;
}

// Apply a layer that may only TIGHTEN (the repo-controlled project file): a class
// can move toward deny, never toward allow.
function applyRestrictOnly(policy, layer) {
  if (!layer || typeof layer !== "object") return policy;
  for (const c of CLASSES) { const v = normVerdict(layer[c]); if (v && RANK[v] > RANK[policy[c]]) policy[c] = v; }
  return policy;
}

// Resolve the effective policy. `project` is the repo's nomos.json `permissions`
// (restrict-only); `global`/`env`/`cli` are trusted (user-controlled).
export function buildPolicy({ global, env, cli, project } = {}) {
  let p = { ...DEFAULT_POLICY };
  p = applyTrusted(p, global);
  p = applyTrusted(p, env);
  p = applyTrusted(p, cli);
  p = applyRestrictOnly(p, project); // repo can only tighten, last word on restriction
  return p;
}

// Read NOMOS_POLICY_<CLASS> env vars (e.g. NOMOS_POLICY_SHELL=allow) into a layer.
export function policyFromEnv(envObj = process.env) {
  const layer = {};
  for (const c of CLASSES) { const v = normVerdict((envObj[`NOMOS_POLICY_${c.toUpperCase()}`] || "").toLowerCase()); if (v) layer[c] = v; }
  return layer;
}

// Verdict for a class given the run mode. headless=true → "ask" becomes "deny".
export function resolveClass(policy, cls, headless) {
  const v = policy[cls] ?? "deny";
  if (v === "ask") return headless ? "deny" : "ask";
  return v;
}

// Verdict for a specific tool call. Returns "allow" | "ask" | "deny".
export function toolVerdict(policy, toolName, headless) {
  const cls = TOOL_CLASS[toolName] || "write";
  return resolveClass(policy, cls, headless);
}
