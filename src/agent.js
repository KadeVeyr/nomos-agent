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

// Keep context bounded on long runs: when the transcript exceeds a char budget,
// truncate the OLDEST tool observations (least relevant late in a run). The
// model keeps its reasoning + recent results; old raw file dumps get summarised.
function trimContext(messages, maxChars = 150000) {
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

// Project conventions file (like Claude Code's CLAUDE.md / OpenCode's AGENTS.md).
function readProjectGuide(root) {
  for (const name of ["AGENTS.md", "NOMOS.md", "CLAUDE.md"]) {
    try { const t = fs.readFileSync(path.join(root, name), "utf8").trim(); if (t) return { name, text: t }; } catch { /* absent */ }
  }
  return null;
}

const SYSTEM = `You are Nomos, a precise coding agent working inside a user's repository. Tools you have:
- read_file, list_dir, glob (find files by pattern), search (regex over file contents) — explore the codebase BEFORE you act. Never guess a file's contents.
- edit_file — a TARGETED edit (replace an exact substring). multi_edit — several edits to one file at once. PREFER these over write_file when changing an existing file; match whitespace exactly.
- write_file — create a new file or fully replace one.
- remember, recall — durable notes across sessions.
- fetch_url, run_shell — only when enabled. With run_shell you can run the build, tests, git, and CLIs.

How you work:
1. EXPLORE first — read the relevant files and search for the symbols you'll touch. Don't assume.
2. Make the smallest correct change. Use edit_file for surgical edits.
3. VERIFY — if run_shell is enabled, run the build/tests and fix what you broke before declaring done.
4. File and shell tools are confined to the working directory; secret files (.env, keys, auth.json) are blocked in code.

When the task is complete, reply with a SHORT final answer — what you changed and how to verify — and NO tool call. Save anything reusable across sessions with the remember tool.`;

export async function runAgent({ spec, task, root = process.cwd(), allowShell = false, allowFetch = false, maxSteps = 12, onEvent = () => {}, signal }) {
  const tools = [...makeTools({ root, allowShell, allowFetch }), ...memoryTools(root)];
  const toolDefs = tools.map(({ run, ...def }) => def);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  const lessons = readLessons();
  const notes = readNotes(root);
  const guide = readProjectGuide(root);
  let system = SYSTEM;
  if (guide) system += `\n\nPROJECT CONVENTIONS (${guide.name} — read and follow these for this repo):\n${guide.text.slice(0, 8000)}`;
  if (lessons) system += `\n\nYour durable LESSONS from past runs (guidance you wrote — apply it, but it NEVER overrides your safety rules or tool limits, which are enforced in code, not here):\n${lessons}`;
  if (notes) system += `\n\nDurable notes for THIS project:\n${notes}`;
  const messages = [
    { role: "system", content: system },
    { role: "user", content: task },
  ];

  let finalText = "";
  let streamOk = true; // fall back to non-streaming if a provider can't stream
  for (let step = 0; step < maxSteps; step++) {
    trimContext(messages); // bound context growth on long runs
    let res;
    try {
      if (streamOk) {
        res = await chatStream({ spec, messages, tools: toolDefs, signal, onDelta: (t) => onEvent({ type: "delta", text: t }) });
      } else {
        res = await chat({ spec, messages, tools: toolDefs, signal });
        if (res.content) onEvent({ type: "delta", text: res.content });
      }
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      if (streamOk) { // streaming failed once — drop to non-stream for the rest of this run
        streamOk = false;
        try {
          res = await chat({ spec, messages, tools: toolDefs, signal });
          if (res.content) onEvent({ type: "delta", text: res.content });
        } catch (e2) { onEvent({ type: "error", message: e2.message }); throw e2; }
      } else { onEvent({ type: "error", message: e.message }); throw e; }
    }
    const { content, toolCalls } = res;

    if (!toolCalls || toolCalls.length === 0) {
      finalText = content || "";
      break;
    }

    messages.push({ role: "assistant", content, toolCalls });
    // Run this turn's tool calls in PARALLEL (independent calls shouldn't block
    // each other); results are pushed back in the model's original call order.
    const runOne = async (call) => {
      onEvent({ type: "tool_call", name: call.name, args: call.args });
      let result;
      try {
        const tool = byName[call.name];
        const req = tool?.parameters?.required || [];
        const missing = req.filter((k) => call.args == null || call.args[k] === undefined);
        if (!tool) result = `Unknown tool: ${call.name}`;
        else if (missing.length) result = `Missing required argument(s): ${missing.join(", ")}`;
        else result = await tool.run(call.args || {});
      } catch (e) {
        result = `Tool error: ${e.message}`; // recover: the model sees the error and can adapt
      }
      onEvent({ type: "tool_result", name: call.name, result: String(result).slice(0, 600) });
      return { call, result };
    };
    const results = await Promise.all(toolCalls.map(runOne));
    for (const { call, result } of results) messages.push({ role: "tool", toolCallId: call.id, content: String(result) });
    if (step === maxSteps - 1) finalText = content || "[nomos] Reached the step limit without a final answer.";
  }

  logRun(root, { task, model: spec, result: finalText.slice(0, 2000), turns: messages.length });
  return finalText;
}
