// MCP server — expose Nomos as tools an editor (Claude Code / Cursor / Codex)
// calls directly. Stdio transport: newline-delimited JSON-RPC 2.0 (one JSON
// object per line, no Content-Length framing). Zero dependencies.
//
// The killer editor feature is `nomos_verify`: a DIFFERENT model independently
// reviews the diff your editor just produced and returns a verdict + a
// content-hashed receipt — one key, cross-provider by construction (you, the
// editor, are the proposer). `nomos_seat` exposes the hang-resistant
// directive→transcript primitive for grading/answers from inside the editor.
//
// stdout is the protocol channel — NEVER write logs there; logs go to stderr.

import path from "node:path";
import { getDiff, runVerify } from "./verify.js";
import { runSeat } from "./seat.js";
import { writeReceipt } from "./receipt.js";
import { loadConfig } from "./config.js";

const PROTOCOL_VERSION = "2025-06-18";

// The MCP channel is driven by the editor's model — treat its `cwd` argument as
// untrusted. Confine it to the server's working directory (or a subdirectory),
// matching the file-tool safePath posture: a model can't point Nomos at an
// arbitrary absolute path to read a diff (egressed to the provider) or write a
// receipt file outside the workspace. Absent/empty cwd = the server's own root.
function resolveCwd(arg, base = process.cwd()) {
  if (!arg) return base;
  const resolved = path.resolve(base, arg);
  const rel = path.relative(base, resolved);
  if (rel && (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel))) {
    throw new Error(`cwd "${arg}" is outside the server root (${base}) — refused.`);
  }
  return resolved;
}

export const MCP_TOOLS = [
  {
    name: "nomos_verify",
    description:
      "Independent second opinion on a code change. A DIFFERENT model reviews the git diff your editor just produced (working tree, staged, or vs a ref), told to refute not agree, and returns a PASS/CONCERNS/FAIL verdict with reasoning plus a content-hashed receipt id. One key — the verifier; you (the editor) are the proposer, so it's cross-provider by construction. Use it before you commit AI-written code.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "verifier model as provider/model (e.g. anthropic/claude-opus-4-8). Defaults to config defaultModel." },
        staged: { type: "boolean", description: "verify staged changes (git diff --cached) instead of the working tree" },
        against: { type: "string", description: "verify the diff against a git ref (e.g. main, HEAD~1) instead of the working tree" },
        source: { type: "string", description: "name of the tool that produced the change, recorded on the receipt (e.g. 'Cursor', 'Claude Code')" },
        max_tokens: { type: "number", description: "max output tokens for the verifier (defaults to config; raise it for very large diffs)" },
        cwd: { type: "string", description: "repository root — must be the server's working dir or a subdirectory (defaults to it)" },
      },
    },
  },
  {
    name: "nomos_seat",
    description:
      "Fire a directive at a model and return its full response as a structured transcript — a non-agentic, hang-resistant 'seat' primitive (directive in → transcript out, no tool/skill hijack, always a terminal status). Use it to get an independent model's grade or answer on a prompt from your editor.",
    inputSchema: {
      type: "object",
      properties: {
        directive: { type: "string", description: "the prompt/directive to fire at the model" },
        model: { type: "string", description: "model as provider/model. Defaults to config defaultModel." },
        timeout_ms: { type: "number", description: "wall-clock timeout in ms (default 120000); on timeout it still returns a terminal status, never hangs" },
        max_tokens: { type: "number", description: "max output tokens (defaults to config; raise it for long responses)" },
        min_output_bytes: { type: "number", description: "flag a suspiciously short reply: below this many bytes the result is status 'thin' (isError), not a silent clean fire" },
        cwd: { type: "string", description: "working directory — must be the server's working dir or a subdirectory (defaults to it)" },
      },
      required: ["directive"],
    },
  },
];

function toolText(text, isError = false) {
  return { content: [{ type: "text", text: String(text) }], isError };
}

// Dispatch ONE JSON-RPC message. Returns a response object, or null for
// notifications (messages with no id / the *notifications/* methods). `deps`
// injects the heavy functions so the protocol is unit-testable without network.
export async function handleMessage(msg, deps = {}) {
  const _getDiff = deps.getDiff || getDiff;
  const _runVerify = deps.runVerify || runVerify;
  const _runSeat = deps.runSeat || runSeat;
  const _writeReceipt = deps.writeReceipt || writeReceipt;
  const _loadConfig = deps.loadConfig || loadConfig;
  const version = deps.version || "0.0.0";

  if (msg == null || typeof msg.method !== "string") return null;
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const errReply = (code, message) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "nomos", version },
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: MCP_TOOLS });
    case "tools/call": {
      const name = msg.params?.name;
      const args = msg.params?.arguments || {};
      try {
        if (name === "nomos_verify") {
          const cfg = _loadConfig({ root: resolveCwd(args.cwd) });
          const spec = args.model || cfg.defaultModel;
          if (!spec) return reply(toolText("No model. Pass `model` (provider/model) or set defaultModel in nomos.json.", true));
          const diff = await _getDiff({ root: cfg.root, staged: !!args.staged, against: args.against || null });
          if (!diff.trim()) return reply(toolText("No changes to verify (working tree clean — pass staged:true or against:<ref>).", true));
          const { receipt, verdict, reasoning } = await _runVerify({ diff, spec, source: args.source || "your editor", maxTokens: args.max_tokens || cfg.maxTokens });
          const file = _writeReceipt(cfg.root, receipt);
          const text = `${verdict} — ${reasoning}\n\nreceipt ${receipt.id} (${file}) · cross_provider=${receipt.cross_provider}`;
          return reply(toolText(text, verdict === "FAIL"));
        }
        if (name === "nomos_seat") {
          if (!args.directive) return reply(toolText("Missing required argument: directive.", true));
          const cfg = _loadConfig({ root: resolveCwd(args.cwd) });
          const spec = args.model || cfg.defaultModel;
          if (!spec) return reply(toolText("No model. Pass `model` (provider/model) or set defaultModel.", true));
          const t = await _runSeat({ directive: args.directive, spec, timeoutMs: args.timeout_ms || 120000, maxTokens: args.max_tokens || cfg.maxTokens, minBytes: args.min_output_bytes || 0 });
          const body = t.final_block ? t.final_block.body : t.output;
          return reply(toolText(body || `(no output — status: ${t.status})`, t.exit_code !== 0));
        }
        return errReply(-32602, `Unknown tool: ${name}`);
      } catch (e) {
        // A tool failure is reported as an in-band tool error (isError), not a
        // protocol error, so the editor surfaces it to the model.
        return reply(toolText(`Error: ${e.message}`, true));
      }
    }
    default:
      // notifications/* and any other notification (no id) are silently ignored;
      // an unknown *request* (has an id) gets a proper method-not-found error.
      if (msg.method.startsWith("notifications/")) return null;
      return msg.id != null ? errReply(-32601, `Method not found: ${msg.method}`) : null;
  }
}

// Run the stdio server: read newline-delimited JSON-RPC from stdin, write
// responses to stdout. One object per line. Notifications produce no reply.
export async function runMcpServer(deps = {}) {
  const stdin = deps.stdin || process.stdin;
  const stdout = deps.stdout || process.stdout;
  let buf = "";
  stdin.setEncoding?.("utf8");
  const emit = async (msg) => {
    const res = await handleMessage(msg, deps);
    if (res) stdout.write(JSON.stringify(res) + "\n");
  };
  for await (const chunk of stdin) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; } // skip malformed frames
      if (Array.isArray(parsed)) { for (const m of parsed) await emit(m); }
      else await emit(parsed);
    }
  }
}
