// Agent loop — task → model → (tool calls) → result → model → final answer.
//
// v0 ships ONE real tool: a sandboxed arithmetic calculator. It uses a tiny
// recursive-descent parser, NOT eval — no arbitrary code, no filesystem, no
// network (Kimi tool-sandbox rule). The loop is provider-neutral: the same
// agent runs against any provider in the registry. This is what makes Nomos a
// harness and not a chatbot — it routes tools through a verifiable loop.

import { chat } from "./gateway.js";

// ── Safe calculator (no eval) ──────────────────────────────────────────────
function calc(expr) {
  let i = 0;
  const s = String(expr).replace(/\s+/g, "");
  if (!/^[0-9+\-*/().]+$/.test(s)) throw new Error("Only numbers and + - * / ( ) are allowed.");
  function peek() { return s[i]; }
  function num() {
    let start = i;
    while (i < s.length && /[0-9.]/.test(s[i])) i++;
    const n = Number(s.slice(start, i));
    if (Number.isNaN(n)) throw new Error("Bad number.");
    return n;
  }
  function factor() {
    if (peek() === "(") { i++; const v = expr2(); if (peek() !== ")") throw new Error("Missing )."); i++; return v; }
    if (peek() === "-") { i++; return -factor(); }
    return num();
  }
  function term() { let v = factor(); while (peek() === "*" || peek() === "/") { const op = s[i++]; const r = factor(); v = op === "*" ? v * r : v / r; } return v; }
  function expr2() { let v = term(); while (peek() === "+" || peek() === "-") { const op = s[i++]; const r = term(); v = op === "+" ? v + r : v - r; } return v; }
  const result = expr2();
  if (i !== s.length) throw new Error("Unexpected character.");
  return result;
}

export const TOOLS = [
  {
    name: "calculator",
    description: "Evaluate a basic arithmetic expression using + - * / and parentheses. Use for any exact arithmetic.",
    parameters: { type: "object", properties: { expression: { type: "string", description: "e.g. (12+5)*3" } }, required: ["expression"] },
    run: ({ expression }) => String(calc(expression)),
  },
];

const SYSTEM = "You are Nomos, a concise agent. When a task needs exact arithmetic, call the calculator tool rather than computing in your head. Answer directly and briefly.";

// Run one task to completion. Emits events via onEvent for streaming UIs.
// Returns the final assistant text.
export async function runAgent({ spec, task, onEvent = () => {}, maxSteps = 6, signal }) {
  const toolDefs = TOOLS.map(({ run, ...def }) => def);
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: task },
  ];

  for (let step = 0; step < maxSteps; step++) {
    const { content, toolCalls } = await chat({ spec, messages, tools: toolDefs, signal });
    if (content) onEvent({ type: "text", text: content });

    if (!toolCalls || toolCalls.length === 0) {
      return content;
    }

    messages.push({ role: "assistant", content, toolCalls });
    for (const call of toolCalls) {
      onEvent({ type: "tool_call", name: call.name, args: call.args });
      let result;
      try {
        const tool = byName[call.name];
        result = tool ? await tool.run(call.args) : `Unknown tool: ${call.name}`;
      } catch (e) {
        result = `Tool error: ${e.message}`;
      }
      onEvent({ type: "tool_result", name: call.name, result });
      messages.push({ role: "tool", toolCallId: call.id, content: result });
    }
  }
  return "[nomos] Reached the step limit without a final answer.";
}
