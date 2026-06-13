// Agent loop — reason → act → observe → repeat, until done or step-capped.
//
// Robust: a tool error is caught and fed back to the model as the tool result,
// so the agent can recover and try another approach rather than crashing. The
// loop ends when the model returns a final answer (no tool calls). It loads the
// project's durable memory into context at the start, so it remembers across
// sessions. Same loop powers headless `run` and the TUI — one code path.

import { chat } from "./gateway.js";
import { makeTools } from "./tools.js";
import { memoryTools, readNotes, logRun } from "./memory.js";

const SYSTEM =
  "You are Nomos, a capable, concise agent. You have tools: read_file, write_file, list_dir, search, fetch_url, remember, recall (and run_shell only if enabled). " +
  "Use tools to gather facts and act, rather than guessing. File and shell tools are confined to the working directory; secret files are blocked. " +
  "When the task is complete, give a short final answer with no tool call. Save anything worth remembering across sessions with the remember tool.";

export async function runAgent({ spec, task, root = process.cwd(), allowShell = false, allowFetch = false, maxSteps = 12, onEvent = () => {}, signal }) {
  const tools = [...makeTools({ root, allowShell, allowFetch }), ...memoryTools(root)];
  const toolDefs = tools.map(({ run, ...def }) => def);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  const notes = readNotes(root);
  const system = SYSTEM + (notes ? `\n\nDurable project memory (from past runs):\n${notes}` : "");
  const messages = [
    { role: "system", content: system },
    { role: "user", content: task },
  ];

  let finalText = "";
  for (let step = 0; step < maxSteps; step++) {
    let res;
    try {
      res = await chat({ spec, messages, tools: toolDefs, signal });
    } catch (e) {
      onEvent({ type: "error", message: e.message });
      throw e;
    }
    const { content, toolCalls } = res;
    if (content) onEvent({ type: "text", text: content });

    if (!toolCalls || toolCalls.length === 0) {
      finalText = content || "";
      break;
    }

    messages.push({ role: "assistant", content, toolCalls });
    for (const call of toolCalls) {
      onEvent({ type: "tool_call", name: call.name, args: call.args });
      let result;
      try {
        const tool = byName[call.name];
        // Validate required args before running.
        const req = tool?.parameters?.required || [];
        const missing = req.filter((k) => call.args == null || call.args[k] === undefined);
        if (!tool) result = `Unknown tool: ${call.name}`;
        else if (missing.length) result = `Missing required argument(s): ${missing.join(", ")}`;
        else result = await tool.run(call.args || {});
      } catch (e) {
        result = `Tool error: ${e.message}`; // recover: the model sees the error and can adapt
      }
      onEvent({ type: "tool_result", name: call.name, result: String(result).slice(0, 600) });
      messages.push({ role: "tool", toolCallId: call.id, content: String(result) });
    }
    if (step === maxSteps - 1) finalText = content || "[nomos] Reached the step limit without a final answer.";
  }

  logRun(root, { task, model: spec, result: finalText.slice(0, 2000), turns: messages.length });
  return finalText;
}
