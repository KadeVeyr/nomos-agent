// Ship-risk classification for the `verify = risky` mode: decide, from a change
// alone (no model call), whether it's worth a second provider's eyes. Deterministic,
// zero-dep. The point is a TARGETED signal, not "flag everything" — an over-broad
// rule (matching "key"/"log"/"pass" as substrings) makes every change risky and
// defeats the purpose. Paths are matched on boundary-delimited segments, and the
// classifier returns a concrete REASON so an auto-verified receipt can say WHY
// honestly ("auto-checked because it touched <reason>"), never "now safe".

// Boundary-delimited path patterns → ship-risk, each with a reason.
const RISKY_PATHS = [
  [/(^|[/._-])(auth|login|logout|signin|signup|session|oauth|sso|acl|rbac|permission|policy|middleware)([/._-]|$)/i, "auth / session / access-control"],
  [/(^|[/._-])(password|passwd|pwd|token|secret|credential|apikey|api[_-]?key|jwt|bearer|cookie|crypto|encrypt|decrypt|cipher|signing|signature)([/._-]|$)/i, "credentials / secrets / crypto"],
  [/(^|[/._-])(payment|billing|invoice|charge|refund|stripe|paypal|checkout|subscription|wallet|ledger|pricing)([/._-]|$)/i, "payment / billing"],
  [/(^|[/._-])(migration|migrations|schema|seed)([/._-]|$)|\.sql$/i, "database migration / schema"],
  [/(^|\/)\.github\/workflows\/|(^|[/._-])(Dockerfile|docker-compose|Jenkinsfile|deploy|terraform|k8s|kubernetes)([/._-]|$)|\.gitlab-ci\.ya?ml$/i, "CI / CD / deploy / infra"],
  [/(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.toml|Cargo\.lock|go\.mod|go\.sum|requirements\.txt|Gemfile|Gemfile\.lock|pyproject\.toml|composer\.json)$/i, "dependency manifest / lockfile"],
];
const LOW_RISK_TEXT = /\.(md|markdown|mdx|txt|rst|adoc|csv)$/i; // docs / prose — not ship-risk on their own
const RISKY_LINE_THRESHOLD = 40; // a single-file change bigger than this is worth a look

// Parse `git diff --numstat` output into [{ added, removed, path }]. A binary file
// shows "-\t-\tpath"; we treat its churn as 0 but still count the file.
export function parseNumstat(text) {
  const rows = [];
  for (const line of String(text || "").split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    rows.push({ added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]), path: m[3].replace(/^"|"$/g, "") });
  }
  return rows;
}

// Classify a set of changed files (parsed numstat) as ship-risk or not.
// Returns { risky: boolean, reason: string|null }.
export function classifyChange(rows) {
  const files = Array.isArray(rows) ? rows : [];
  if (!files.length) return { risky: false, reason: null };
  const code = files.filter((f) => !LOW_RISK_TEXT.test(f.path));
  // A sensitive PATH makes any change risky.
  for (const f of files) {
    for (const [re, reason] of RISKY_PATHS) if (re.test(f.path)) return { risky: true, reason: `touched ${reason} (${f.path})` };
  }
  // Touching more than one CODE file is a coordinated change worth a second read.
  if (code.length > 1) return { risky: true, reason: `${code.length} code files changed` };
  // A large single CODE change (docs/prose churn doesn't count — a long README edit
  // isn't ship-risk).
  const total = code.reduce((s, f) => s + f.added + f.removed, 0);
  if (total > RISKY_LINE_THRESHOLD) return { risky: true, reason: `${total} lines changed` };
  // Otherwise: a small, single, non-sensitive edit (or a docs-only change) — low-risk.
  return { risky: false, reason: null };
}
