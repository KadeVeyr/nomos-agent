// Minimal TUI — launch, see which subs are wired, pick a model, run tasks.
// Deliberately small: the TUI is a convenience over the same agent loop the
// headless `nomos run` uses. No second code path.

import readline from "node:readline";
import process from "node:process";
import { runAgent } from "./agent.js";
import { listAuth } from "./auth.js";
import { loadConfig } from "./config.js";

const C = { dim: "\x1b[2m", b: "\x1b[1m", g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[0m" };

export async function startTui() {
  const cfg = loadConfig();
  const configured = listAuth().filter((a) => a.configured);
  process.stdout.write(`\n${C.b}NOMOS${C.r} ${C.dim}v0.1 — the headless agent you call from your editor${C.r}\n`);

  if (configured.length === 0) {
    process.stdout.write(`\n${C.y}No subscriptions wired yet.${C.r} Add one, then relaunch:\n  ${C.dim}nomos auth login anthropic${C.r}   (or openai / moonshot / deepseek / groq / openrouter)\n  ${C.dim}nomos providers${C.r}            to see them all\n\n`);
    return;
  }

  process.stdout.write(`${C.dim}Wired subs:${C.r} ${configured.map((c) => C.g + c.id + C.r).join("  ")}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  let spec = await ask(`\nModel ${C.dim}(provider/model, e.g. ${configured[0].id}/<model>)${C.r}: `);
  spec = spec.trim();
  if (!spec) { rl.close(); return; }

  process.stdout.write(`${C.dim}Ready. Type a task, or /exit.${C.r}\n`);

  for (;;) {
    const task = (await ask(`\n${C.b}›${C.r} `)).trim();
    if (!task) continue;
    if (task === "/exit" || task === "/quit") break;
    if (task.startsWith("/model ")) { spec = task.slice(7).trim(); process.stdout.write(`${C.dim}model → ${spec}${C.r}\n`); continue; }
    try {
      const final = await runAgent({
        spec,
        task,
        root: cfg.root,
        allowShell: cfg.allowShell,
        allowFetch: cfg.allowFetch,
        maxSteps: cfg.maxSteps,
        onEvent: (e) => {
          if (e.type === "tool_call") process.stdout.write(`${C.dim}· calculator(${JSON.stringify(e.args)})${C.r}\n`);
          else if (e.type === "tool_result") process.stdout.write(`${C.dim}· = ${e.result}${C.r}\n`);
        },
      });
      process.stdout.write(`\n${(final || "").trim()}\n`);
    } catch (e) {
      process.stdout.write(`${C.y}error:${C.r} ${e.message}\n`);
    }
  }
  rl.close();
  process.stdout.write(`${C.dim}bye.${C.r}\n`);
}
