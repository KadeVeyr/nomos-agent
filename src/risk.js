// Ship-risk classification for the `verify = risky` mode: decide, from a change
// alone (no model call), whether it's worth a second provider's eyes. Deterministic,
// zero-dep. A TARGETED signal, not "flag everything" — but it must catch real risky
// files in idiomatic code, so the path is NORMALIZED before matching: camelCase is
// split (authMiddleware → auth-middleware) and lowercased, and stems tolerate a
// plural suffix (secrets, tokens, sessions). Boundary-anchored so "tokenizer" /
// "keyboard" still DON'T flag. Returns a concrete REASON so an auto-verified receipt
// can say WHY honestly ("auto: touched <reason>"), never "now safe". (Hardened after
// an adversarial pass found a camelCase/plural/.env/script/deletion blind spot.)

// Normalize a path for matching: split camelCase to hyphens, lowercase. So
// "src/authMiddleware.ts" → "src/auth-middleware.ts", "jwtVerify" → "jwt-verify".
function norm(p) {
  return String(p).replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

// Patterns matched against the NORMALIZED path. `(s|es|ies)?` tolerates plurals.
const RISKY_PATHS = [
  [/(^|[/._-])(auth|login|logout|signin|signup|session|oauth|sso|acl|rbac|permission|polic(y|ies)|middleware|access|guard|admin|cors|csp|csrf|xss|firewall)(s|es)?([/._-]|$)/, "auth / session / access-control"],
  [/(^|[/._-])(password|passwd|pwd|token|secret|credential|api-?key|jwt|bearer|cookie|crypto|encrypt|decrypt|cipher|signing|signature|keystore|key-store|key-manager|private-key|secret-key|signing-key)(s|es)?([/._-]|$)/, "credentials / secrets / crypto"],
  [/(^|[/._-])(payment|billing|invoice|charge|refund|stripe|paypal|checkout|subscription|wallet|ledger|pricing)(s|es)?([/._-]|$)/, "payment / billing"],
  [/(^|[/._-])(migration|schema|seed)(s|es)?([/._-]|$)|\.sql$/, "database migration / schema"],
  [/(^|\/)\.github\/workflows\/|(^|[/._-])(dockerfile|docker-compose|jenkinsfile|deploy|terraform|k8s|kubernetes|helm)([/._-]|$)|\.gitlab-ci\.ya?ml$/, "CI / CD / deploy / infra"],
  [/(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|cargo\.toml|cargo\.lock|go\.mod|go\.sum|requirements\.txt|gemfile(\.lock)?|pyproject\.toml|composer\.json)$/, "dependency manifest / lockfile"],
  [/(^|\/)\.env(\.[\w.-]+)?$|(^|[/._-])secrets?\.env([/._-]|$)/, "env / secrets config"],
  [/(^|\/)(nginx\.conf|\.htaccess|\.htpasswd|\.npmrc|\.yarnrc|web\.config)$/, "server / supply-chain config"],
  [/\.(sh|bash|zsh|ps1|bat|cmd)$/, "executable script"],
];
const LOW_RISK_TEXT = /\.(md|markdown|mdx|txt|rst|adoc|csv)$/i;       // docs / prose — not ship-risk on their own
const GENERATED = /(^|\/)(dist|build|out|vendor|node_modules|generated|__generated__|\.next|coverage)\/|\.min\.|\.snap$|\.lock$/i; // churn here isn't review-worthy
const RISKY_LINE_THRESHOLD = 40;   // a single code change bigger than this is worth a look
const RISKY_DELETE_THRESHOLD = 12; // pure removals (deleted checks/guards) are high-signal — a lower bar

// Parse `git diff --numstat` into [{ added, removed, path }]. Binary = "-\t-\tpath".
export function parseNumstat(text) {
  const rows = [];
  for (const line of String(text || "").split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    rows.push({ added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]), path: m[3].replace(/^"|"$/g, "") });
  }
  return rows;
}

// Classify a set of changed files (parsed numstat). Returns { risky, reason }.
export function classifyChange(rows) {
  const files = Array.isArray(rows) ? rows : [];
  if (!files.length) return { risky: false, reason: null };
  // A sensitive PATH makes any change risky (matched on the normalized path).
  for (const f of files) {
    const n = norm(f.path);
    for (const [re, reason] of RISKY_PATHS) if (re.test(n)) return { risky: true, reason: `touched ${reason} (${f.path})` };
  }
  // A near-total removal of a code file (deleting checks/guards/auth) is high-signal.
  const code = files.filter((f) => !LOW_RISK_TEXT.test(f.path) && !GENERATED.test(f.path));
  const del = code.find((f) => f.added === 0 && f.removed >= RISKY_DELETE_THRESHOLD);
  if (del) return { risky: true, reason: `${del.removed} lines removed from ${del.path}` };
  // More than one CODE file changed = a coordinated change worth a second read.
  if (code.length > 1) return { risky: true, reason: `${code.length} code files changed` };
  // A large single CODE change (docs/generated churn excluded).
  const total = code.reduce((s, f) => s + f.added + f.removed, 0);
  if (total > RISKY_LINE_THRESHOLD) return { risky: true, reason: `${total} lines changed` };
  // Otherwise: a small, single, non-sensitive edit (or docs-only) — low-risk.
  return { risky: false, reason: null };
}
