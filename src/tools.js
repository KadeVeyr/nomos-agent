// Tools — the harness's hands. read/write/list files, search, fetch, shell.
//
// SECURITY MODEL (hardened after adversarial review — "patterns matched, known
// holes closed", NOT audited):
//   - Path confinement via REALPATH: every file op resolves the real path
//     (following symlinks, normalising Windows 8.3/ADS) and is rejected if it
//     escapes the working root or hits the secret denylist.
//   - Secret denylist: .env*, auth.json, *.key/*.pem/*.pfx, .git/, .npmrc,
//     id_rsa, the nomos key store — never read or written.
//   - SSRF guard: http(s) only; blocks loopback/private/link-local/metadata,
//     IPv4-mapped IPv6, and numeric (decimal/hex/octal) hosts; no redirects.
//   - fetch_url and run_shell are BOTH opt-in (off by default): network egress
//     and shell on an autonomous agent are exfil/abuse risks. fetch additionally
//     scrubs URLs carrying secret-shaped tokens.
//   - Capability flags come from CLI/env/global config only — never from a
//     project's committed nomos.json (a cloned repo can't silently enable them).
// Residual (documented, honest): a fetch to a PUBLIC host can still carry data
// the agent legitimately holds; enable fetch only for trusted workloads.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import dns from "node:dns/promises";
import net from "node:net";
import { execFile } from "node:child_process";

const DENY_BASENAMES = new Set([".env", "auth.json", ".git", ".npmrc", "id_rsa", "secrets.json", "credentials"]);
const DENY_EXT = new Set([".key", ".pem", ".pfx", ".p12"]);
const NOMOS_DATA = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "nomos");

// Normalise a basename for denylist checks: strip Windows alternate-data-stream
// suffix and trailing dots/spaces, lowercase.
function normBase(name) {
  return String(name).toLowerCase().replace(/::\$data$/i, "").replace(/[. ]+$/g, "");
}

function denied(abs) {
  const base = normBase(path.basename(abs));
  if (DENY_BASENAMES.has(base)) return true;
  if (DENY_EXT.has(path.extname(base))) return true;
  if (base.startsWith(".env")) return true;
  const norm = path.resolve(abs).toLowerCase();
  if (norm.startsWith(path.resolve(NOMOS_DATA).toLowerCase())) return true;
  if (norm.split(path.sep).includes(".git")) return true;
  return false;
}

// Resolve p inside root or throw. Uses realpath to defeat symlink + 8.3 + ADS
// tricks. For a not-yet-existing file, realpath the parent and lstat the leaf.
function safePath(root, p) {
  const rootReal = fs.realpathSync(root);
  const abs = path.resolve(rootReal, p);
  let real;
  try {
    real = fs.realpathSync(abs); // existing path: resolves symlinks, 8.3, case
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    // New file: parent must exist & be inside root; leaf must not be a symlink.
    const parentReal = fs.realpathSync(path.dirname(abs));
    try { if (fs.lstatSync(abs).isSymbolicLink()) throw new Error(`Refusing a symlink path: ${p}`); } catch { /* leaf absent */ }
    real = path.join(parentReal, path.basename(abs));
  }
  const rel = path.relative(rootReal, real);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the working directory: ${p}`);
  }
  if (denied(real)) throw new Error(`Access to "${p}" is blocked (secret or protected path).`);
  return real;
}

function isPrivateIp(ipRaw) {
  let ip = ipRaw;
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip); // IPv4-mapped IPv6
  if (m) ip = m[1];
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 127 || a === 10 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || a >= 224;
  }
  const low = String(ip).toLowerCase();
  return low === "::1" || low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe80") || low === "::" || low.startsWith("::ffff:");
}

const SECRET_IN_URL = /\b(sk-[a-z0-9_-]{12,}|bearer\s|gsk_[a-z0-9]{12,}|[a-f0-9]{32,})\b/i;

async function guardUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("Invalid URL."); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http(s) URLs are allowed.");
  if (SECRET_IN_URL.test(raw)) throw new Error("Refusing a URL that contains a secret-shaped token.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".internal") || host.endsWith(".local")) throw new Error("Refusing to fetch an internal host.");
  // Numeric hosts (decimal/hex/octal) can encode 127.0.0.1 etc. — reject.
  if (/^[0-9]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host) || /^[0-9]+(\.[0-9]+){0,3}$/.test(host) === false && /^\d/.test(host) && !net.isIP(host)) {
    if (!net.isIP(host)) throw new Error("Refusing a numeric/encoded host.");
  }
  if (net.isIP(host) && isPrivateIp(host)) throw new Error("Refusing a private/loopback/metadata address.");
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { throw new Error("Could not resolve host."); }
  if (!addrs.length) throw new Error("Host did not resolve.");
  for (const { address } of addrs) if (isPrivateIp(address)) throw new Error("Refusing a private/loopback/metadata address.");
  return u;
}

// Convert a glob (*, **, ?) to an anchored RegExp matching forward-slash paths.
function globToRegExp(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (".+^${}()|[]\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(re + "$");
}

// Walk files under root (skipping node_modules/.git/symlinks/denied), call cb(absPath).
function walkFiles(rootReal, cb, cap = 5000) {
  let n = 0;
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (n >= cap) return;
      if (d.isSymbolicLink()) continue;
      const abs = path.join(dir, d.name);
      if (denied(abs)) continue;
      if (d.isDirectory()) { if (d.name !== "node_modules" && d.name !== ".git" && d.name !== ".nomos") walk(abs); continue; }
      n++; cb(abs);
    }
  };
  walk(rootReal);
}

export function makeTools({ root = process.cwd(), allowShell = false, allowFetch = false } = {}) {
  const defs = [
    {
      name: "read_file",
      description: "Read a UTF-8 text file inside the working directory. Optional offset (1-based start line) + limit (max lines) to read part of a large file.",
      parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] },
      run: ({ path: p, offset, limit }) => {
        const data = fs.readFileSync(safePath(root, p), "utf8");
        if (offset == null && limit == null) {
          return data.length > 60000 ? data.slice(0, 60000) + "\n…[truncated — use offset/limit to read more]" : data;
        }
        const lines = data.split("\n");
        const start = Math.max(0, (offset || 1) - 1);
        const end = limit ? start + limit : lines.length;
        const slice = lines.slice(start, end);
        return slice.map((ln, i) => `${start + i + 1}\t${ln}`).join("\n") + (end < lines.length ? `\n…[${lines.length - end} more lines]` : "");
      },
    },
    {
      name: "write_file",
      description: "Create or overwrite a UTF-8 text file inside the working directory.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
      run: ({ path: p, content }) => {
        const abs = safePath(root, p);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(content));
        return `Wrote ${Buffer.byteLength(String(content))} bytes to ${p}`;
      },
    },
    {
      name: "edit_file",
      description: "Make a TARGETED edit: replace an exact, unique substring (old_string) with new_string. Preferred over write_file for changing part of a file — surgical, preserves the rest. old_string must match exactly (incl. whitespace) and be unique unless replace_all is set.",
      parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["path", "old_string", "new_string"] },
      run: ({ path: p, old_string, new_string, replace_all }) => {
        const abs = safePath(root, p);
        const orig = fs.readFileSync(abs, "utf8");
        if (old_string === new_string) throw new Error("old_string and new_string are identical — nothing to do.");
        const count = old_string === "" ? 0 : orig.split(old_string).length - 1;
        if (count === 0) throw new Error("old_string not found in the file (must match exactly, including whitespace).");
        if (count > 1 && !replace_all) throw new Error(`old_string appears ${count} times — make it unique or pass replace_all:true.`);
        const next = replace_all ? orig.split(old_string).join(new_string) : orig.replace(old_string, new_string);
        fs.writeFileSync(abs, next);
        return `Edited ${p} — ${replace_all ? count : 1} replacement${(replace_all ? count : 1) === 1 ? "" : "s"}.`;
      },
    },
    {
      name: "multi_edit",
      description: "Apply MULTIPLE targeted edits to ONE file in sequence — each is an exact old_string→new_string replacement. Atomic: if any old_string isn't found, the file is left untouched. Use for several changes in the same file.",
      parameters: { type: "object", properties: { path: { type: "string" }, edits: { type: "array", items: { type: "object", properties: { old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["old_string", "new_string"] } } }, required: ["path", "edits"] },
      run: ({ path: p, edits }) => {
        const abs = safePath(root, p);
        let content = fs.readFileSync(abs, "utf8");
        if (!Array.isArray(edits) || !edits.length) throw new Error("edits must be a non-empty array.");
        edits.forEach((e, i) => {
          if (!e || typeof e.old_string !== "string") throw new Error(`edit #${i + 1}: missing old_string.`);
          const count = e.old_string === "" ? 0 : content.split(e.old_string).length - 1;
          if (count === 0) throw new Error(`edit #${i + 1}: old_string not found (must match exactly).`);
          if (count > 1 && !e.replace_all) throw new Error(`edit #${i + 1}: old_string appears ${count} times — make it unique or set replace_all.`);
          content = e.replace_all ? content.split(e.old_string).join(e.new_string) : content.replace(e.old_string, e.new_string);
        });
        fs.writeFileSync(abs, content);
        return `Applied ${edits.length} edit${edits.length === 1 ? "" : "s"} to ${p}.`;
      },
    },
    {
      name: "glob",
      description: "Find files matching a glob pattern (e.g. 'src/**/*.js', '*.md', '**/test_*.py') under the working directory. Returns matching paths, sorted.",
      parameters: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
      run: ({ pattern }) => {
        const rootReal = fs.realpathSync(root);
        const re = globToRegExp(String(pattern));
        const out = [];
        walkFiles(rootReal, (abs) => {
          const rel = path.relative(rootReal, abs).split(path.sep).join("/");
          if (out.length < 300 && re.test(rel)) out.push(rel);
        });
        return out.length ? out.sort().join("\n") : "(no matches)";
      },
    },
    {
      name: "list_dir",
      description: "List entries in a directory inside the working directory.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: [] },
      run: ({ path: p = "." }) =>
        fs.readdirSync(safePath(root, p), { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name + "/" : d.name)).join("\n") || "(empty)",
    },
    {
      name: "search",
      description: "Search file contents under a directory for a REGEX (case-insensitive; falls back to a literal substring if the pattern isn't valid regex). Returns matching path:line: text.",
      parameters: { type: "object", properties: { query: { type: "string" }, path: { type: "string" } }, required: ["query"] },
      run: ({ query, path: p = "." }) => {
        const start = safePath(root, p);
        const rootReal = fs.realpathSync(root);
        let re = null;
        try { re = new RegExp(query, "i"); } catch { /* not valid regex — literal fallback */ }
        const needle = String(query).toLowerCase();
        const test = (ln) => (re ? re.test(ln) : ln.toLowerCase().includes(needle));
        const out = [];
        const walk = (dir) => {
          for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
            const abs = path.join(dir, d.name);
            if (d.isSymbolicLink()) continue; // never follow symlinks out of root
            if (denied(abs)) continue;
            if (d.isDirectory()) { if (d.name !== "node_modules" && d.name !== ".git" && d.name !== ".nomos") walk(abs); continue; }
            if (out.length >= 100) return;
            try {
              fs.readFileSync(abs, "utf8").split("\n").forEach((ln, i) => {
                if (out.length < 100 && test(ln)) out.push(`${path.relative(rootReal, abs).split(path.sep).join("/")}:${i + 1}: ${ln.trim().slice(0, 200)}`);
              });
            } catch { /* binary/unreadable */ }
          }
        };
        walk(start);
        return out.length ? out.join("\n") : "(no matches)";
      },
    },
  ];

  if (allowFetch) {
    defs.push({
      name: "fetch_url",
      description: "HTTP GET a public http(s) URL and return the text body (internal hosts + secret-bearing URLs blocked). Enabled by config.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      run: async ({ url }) => {
        const u = await guardUrl(url);
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 15000);
        try {
          const res = await fetch(u, { signal: ctrl.signal, redirect: "error", headers: { "user-agent": "nomos-agent" } });
          const body = await res.text();
          return `HTTP ${res.status}\n` + (body.length > 40000 ? body.slice(0, 40000) + "\n…[truncated]" : body);
        } finally { clearTimeout(t); }
      },
    });
  }

  if (allowShell) {
    defs.push({
      name: "run_shell",
      description: "Run a shell command in the working directory and return stdout/stderr. (Enabled by config; full shell access.)",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      run: ({ command }) =>
        new Promise((resolve) => {
          const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
          const flag = process.platform === "win32" ? "/c" : "-c";
          execFile(shell, [flag, String(command)], { cwd: root, timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
            const out = `${stdout || ""}${stderr ? "\n[stderr]\n" + stderr : ""}`.slice(0, 20000);
            resolve(err && !out ? `Command failed: ${err.code || err.message}` : out || "(no output)");
          });
        }),
    });
  }

  return defs;
}
