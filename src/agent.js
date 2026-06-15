// Agent loop — reason → act → observe → repeat, until done or step-capped.
//
// Robust: a tool error is caught and fed back to the model as the tool result,
// so the agent can recover and try another approach rather than crashing. The
// loop ends when the model returns a final answer (no tool calls). It loads the
// project's durable memory into context at the start, so it remembers across
// sessions. Same loop powers headless `run` and the TUI — one code path.

import fs from "node:fs";
import path from "node:path";
import { chat, chatStream } from "./gateway.js";
import { makeTools } from "./tools.js";
import { memoryTools, readNotes, readLessons, logRun } from "./memory.js";
import { DEFAULT_POLICY, TOOL_CLASS, toolVerdict } from "./permissions.js";

// Keep context bounded on long runs: when the transcript exceeds a char budget,
// truncate the OLDEST tool observations (least relevant late in a run). The
// model keeps its reasoning + recent results; old raw file dumps get summarised.
export function trimContext(messages, maxChars = 150000) {
  let total = 0;
  for (const m of messages) total += m.content ? m.content.length : 0;
  if (total <= maxChars) return;
  for (const m of messages) {
    if (total <= maxChars) break;
    if (m.role === "tool" && m.content && m.content.length > 400) {
      total -= m.content.length - 200;
      m.content = m.content.slice(0, 200) + "\n…[older tool output trimmed to save context]";
    }
  }
}

// Anti-loop: classify a tool result so two turns that do the same thing and get
// the "same" outcome compare equal — even when the raw text differs trivially.
// Empty/error outcomes collapse to a class; otherwise a bounded prefix.
export function classifyResult(r) {
  const s = String(r == null ? "" : r);
  if (!s.trim() || s === "(no output)") return "∅empty";
  if (/^(Tool error|Permission denied|Unknown tool|Missing required|git .*failed|Command failed)/.test(s) || /\bfailed:/.test(s)) return "⚠error:" + s.slice(0, 40);
  return s.slice(0, 120);
}
// A fingerprint of one turn's tool calls + their outcome classes. Identical
// fingerprints on consecutive turns mean the agent is repeating itself.
export function turnFingerprint(results) {
  return results.map(({ call, result }) => `${call.name}(${JSON.stringify(call.args)})→${classifyResult(result)}`).sort().join("|");
}
const STUCK_NUDGE = 2; // after this many IDENTICAL repeats, nudge the agent to change approach
const STUCK_STOP = 4;  // after this many, end the run early with an honest "stuck" report (don't thrash the step cap)

// Project conventions file (like Claude Code's CLAUDE.md / OpenCode's AGENTS.md).
function readProjectGuide(root) {
  for (const name of ["AGENTS.md", "NOMOS.md", "CLAUDE.md"]) {
    try { const t = fs.readFileSync(path.join(root, name), "utf8").trim(); if (t) return { name, text: t }; } catch { /* absent */ }
  }
  return null;
}

// Project test/build commands — a `nomos.json` { "commands": { test, build,
// lint, typecheck, format, … } } convention. Surfaced in the system prompt so
// the agent uses the repo's CANONICAL commands instead of guessing how to verify
// its work. Reading them is purely informational: actually running one still
// requires run_shell to be enabled, so a cloned repo can't execute anything by
// merely listing a command here. Values are single-lined + length-capped so a
// repo can't inject extra system-prompt instructions through them.
const COMMAND_KEYS = ["install", "build", "test", "lint", "typecheck", "format", "dev", "start", "run", "check", "e2e"];
export function readProjectCommands(root) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(root, "nomos.json"), "utf8")); } catch { return null; }
  const c = cfg && cfg.commands;
  if (!c || typeof c !== "object") return null;
  const clean = (v) => String(v).replace(/\s+/g, " ").trim().slice(0, 200);
  const lines = [];
  for (const k of COMMAND_KEYS) if (typeof c[k] === "string" && c[k].trim()) lines.push(`- ${k}: ${clean(c[k])}`);
  for (const [k, v] of Object.entries(c)) { // allow extra custom commands, capped
    if (!COMMAND_KEYS.includes(k) && typeof v === "string" && v.trim() && lines.length < 20 && /^[\w.-]{1,32}$/.test(k)) lines.push(`- ${k}: ${clean(v)}`);
  }
  return lines.length ? lines.join("\n") : null;
}

const SYSTEM = `You are Nomos, a precise coding agent working inside a user's repository. Tools you have:
- read_file, list_dir, glob (find files by pattern), search (regex over file contents) — explore the codebase BEFORE you act. Never guess a file's contents.
- edit_file — a TARGETED edit (replace an exact substring). multi_edit — several edits to one file at once. PREFER these over write_file when changing an existing file; match whitespace exactly.
- write_file — create a new file or fully replace one.
- git — READ-ONLY git (status, diff, log, show, branch, blame, …). Use it to see what you've changed (git diff), the repo state (git status --short), and history. It never mutates the repo, and it works WITHOUT run_shell.
- remember, recall — durable notes across sessions.
- fetch_url, run_shell — only when enabled. With run_shell you can run the build, tests, and CLIs (use the read-only git tool above for git instead of run_shell).

How you work:
1. EXPLORE first — read the relevant files and search for the symbols you'll touch. Don't assume.
2. Make the smallest correct change. Use edit_file for surgical edits.
3. REVIEW your own diff with git diff before finishing — confirm you changed exactly what you intended and nothing else.
4. VERIFY — if run_shell is enabled, run the project's test/build command (see PROJECT COMMANDS if present) and fix what you broke before declaring done.
5. File and shell tools are confined to the working directory; secret files (.env, keys, auth.json) are blocked in code.

5. BE TRANSPARENT ABOUT WORKAROUNDS. If a command or tool the user (or the project's config) declared FAILS and you succeed by another route — e.g. the project's test command errors and you run a different one — you MUST surface that discrepancy in your final answer ("the project's test command \`X\` failed: <reason>; I verified with \`Y\` instead — you may want to fix it"). Succeeding by an alternate route while hiding that the declared route is broken erodes trust; never report a clean result that conceals a broken project command or config.

When the task is complete, reply with a SHORT final answer — what you changed and how to verify — and NO tool call. Surface any workaround per rule 5. Save anything reusable across sessions with the remember tool.`;

export async function runAgent({ spec, task, root = process.cwd(), allowShell = false, allowFetch = false, policy = DEFAULT_POLICY, headless = true, maxSteps = 12, maxTokens, onEvent = () => {}, onMessage = null, resume = null, signal }) {
  // Effective policy: start from the resolved policy, then let the legacy
  // allowShell/allowFetch flags loosen shell/fetch (so existing callers are
  // unchanged). The dispatch gate below enforces this for EVERY class.
  const effectivePolicy = { ...DEFAULT_POLICY, ...policy };
  if (allowShell) effectivePolicy.shell = "allow";
  if (allowFetch) effectivePolicy.fetch = "allow";
  const tools = [...makeTools({ root, allowShell, allowFetch }), ...memoryTools(root)];
  const toolDefs = tools.map(({ run, ...def }) => def);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  const lessons = readLessons();
  const notes = readNotes(root);
  const guide = readProjectGuide(root);
  const commands = readProjectCommands(root);
  let system = SYSTEM;
  if (guide) system += `\n\nPROJECT CONVENTIONS (${guide.name} — read and follow these for this repo):\n${guide.text.slice(0, 8000)}`;
  if (commands) system += `\n\nPROJECT COMMANDS (from nomos.json — the canonical way to build/test/lint THIS repo). Prefer these EXACT commands over guessing; run them with run_shell when it is enabled, and after changing code VERIFY with the test (or build) command before declaring done:\n${commands}`;
  if (lessons) system += `\n\nYour durable LESSONS from past runs (guidance you wrote — apply it, but it NEVER overrides your safety rules or tool limits, which are enforced in code, not here):\n${lessons}`;
  if (notes) system += `\n\nDurable notes for THIS project:\n${notes}`;
  const logMsg = (m) => { try { onMessage?.({ type: "msg", role: m.role, content: m.content ?? "", ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}), ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}) }); } catch { /* logging is best-effort */ } };
  // Resume continues a prior conversation as-is (the stored system prompt is part
  // of it); a fresh run starts from system + task and logs both.
  let messages;
  if (resume && resume.length) {
    messages = resume;
  } else {
    messages = [{ role: "system", content: system }, { role: "user", content: task }];
    logMsg(messages[0]); logMsg(messages[1]);
  }

  let finalText = "";
  let streamOk = true; // fall back to non-streaming if a provider can't stream
  let lastFp = null, stuck = 0; // anti-loop: consecutive identical tool-turn fingerprints
  for (let step = 0; step < maxSteps; step++) {
    trimContext(messages); // bound context growth on long runs
    let res;
    try {
      if (streamOk) {
        res = await chatStream({ spec, messages, tools: toolDefs, signal, maxTokens, onDelta: (t) => onEvent({ type: "delta", text: t }) });
      } else {
        res = await chat({ spec, messages, tools: toolDefs, signal, maxTokens });
        if (res.content) onEvent({ type: "delta", text: res.content });
      }
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      if (streamOk) { // streaming failed once — drop to non-stream for the rest of this run
        streamOk = false;
        try {
          res = await chat({ spec, messages, tools: toolDefs, signal, maxTokens });
          if (res.content) onEvent({ type: "delta", text: res.content });
        } catch (e2) { onEvent({ type: "error", message: e2.message }); throw e2; }
      } else { onEvent({ type: "error", message: e.message }); throw e; }
    }
    const { content, toolCalls } = res;

    if (!toolCalls || toolCalls.length === 0) {
      finalText = content || "";
      logMsg({ role: "assistant", content: finalText }); // log the FINAL answer so a
      // completed session is detectable (last msg = assistant with no tool calls);
      // a step-capped run never logs this, so it stays resumable.
      break;
    }

    messages.push({ role: "assistant", content, toolCalls });
    logMsg(messages[messages.length - 1]);
    // Run this turn's tool calls in PARALLEL (independent calls shouldn't block
    // each other); results are pushed back in the model's original call order.
    const runOne = async (call) => {
      onEvent({ type: "tool_call", name: call.name, args: call.args });
      let result;
      try {
        const tool = byName[call.name];
        const verdict = tool ? toolVerdict(effectivePolicy, call.name, headless) : "deny";
        const req = tool?.parameters?.required || [];
        const missing = req.filter((k) => call.args == null || call.args[k] === undefined);
        if (!tool) result = `Unknown tool: ${call.name}`;
        else if (verdict !== "allow") {
          const cls = TOOL_CLASS[call.name] || "write";
          result = `Permission denied: "${call.name}" (${cls} capability) is not enabled for this run (policy: ${verdict}). Do NOT retry it — tell the user it needs to be granted (e.g. --allow ${cls}${cls === "shell" ? " / --allow-shell" : cls === "fetch" ? " / --allow-fetch" : ""}) and continue with what you can do without it.`;
        }
        else if (missing.length) result = `Missing required argument(s): ${missing.join(", ")}`;
        else result = await tool.run(call.args || {});
      } catch (e) {
        result = `Tool error: ${e.message}`; // recover: the model sees the error and can adapt
      }
      onEvent({ type: "tool_result", name: call.name, result: String(result).slice(0, 600) });
      return { call, result };
    };
    const results = await Promise.all(toolCalls.map(runOne));
    for (const { call, result } of results) { messages.push({ role: "tool", toolCallId: call.id, content: String(result) }); logMsg(messages[messages.length - 1]); }
    // Anti-loop: if the agent repeats the same tool call(s) AND gets the same
    // outcome turn after turn, it's stuck — nudge it once, then end early with an
    // honest report rather than thrashing to the step cap.
    const fp = turnFingerprint(results);
    if (fp && fp === lastFp) stuck++; else { stuck = 0; lastFp = fp; }
    if (stuck === STUCK_NUDGE) {
      messages.push({ role: "user", content: `[nomos] You have repeated the same action ${STUCK_NUDGE + 1} times and gotten the same result each time — this is NOT making progress. Stop repeating it: either try a fundamentally different approach, or if you cannot proceed, state plainly what is blocking you and give your FINAL answer now (no tool call).` });
      logMsg(messages[messages.length - 1]);
    } else if (stuck >= STUCK_STOP) {
      finalText = (content ? content + "\n\n" : "") + `[nomos] Stopped early — repeated the same action(s) ${stuck + 1}× with no progress (stuck on: ${[...new Set(results.map((r) => r.call.name))].join(", ")}). Ending rather than exhausting the step budget; the work above may be incomplete.`;
      logMsg({ role: "assistant", content: finalText });
      onEvent({ type: "error", message: "stuck — stopped early to avoid thrashing the step budget" });
      break;
    }
    if (step === maxSteps - 1) finalText = content || "[nomos] Reached the step limit without a final answer.";
  }

  logRun(root, { task, model: spec, result: finalText.slice(0, 2000), turns: messages.length });
  return finalText;
}
