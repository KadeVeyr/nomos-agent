// Minimal TUI — launch, connect subs, pick a model from a live list, run tasks.
// Deliberately small: the TUI is a convenience over the same agent loop the
// headless `nomos run` uses, the same `/connect` flow the CLI uses, and the
// same model list `nomos models` prints. No second code path.

import process from "node:process";
import { runAgent } from "./agent.js";
import { listAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { makeIo, runConnect } from "./connect.js";
import { pickModelSpec } from "./picker.js";

const C = { dim: "\x1b[2m", b: "\x1b[1m", g: "\x1b[32m", y: "\x1b[33m", c: "\x1b[36m", r: "\x1b[0m" };

// Roman-inscription wordmark. NOMOS — Greek nómos, "law": the rule the agent
// answers to. Classical engraved capitals, framed by a double rule.
const BANNER = [
  "",
  `${C.dim}╓────────────────────────────────────────────────╖${C.r}`,
  `${C.c}███╗   ██╗ ██████╗ ███╗   ███╗ ██████╗ ███████╗${C.r}`,
  `${C.c}████╗  ██║██╔═══██╗████╗ ████║██╔═══██╗██╔════╝${C.r}`,
  `${C.c}██╔██╗ ██║██║   ██║██╔████╔██║██║   ██║███████╗${C.r}`,
  `${C.c}██║╚██╗██║██║   ██║██║╚██╔╝██║██║   ██║╚════██║${C.r}`,
  `${C.c}██║ ╚████║╚██████╔╝██║ ╚═╝ ██║╚██████╔╝███████║${C.r}`,
  `${C.c}╚═╝  ╚═══╝ ╚═════╝ ╚═╝     ╚═╝ ╚═════╝ ╚══════╝${C.r}`,
  `${C.dim}╙──── N · O · M · O · S ──── headless · bring your own subs ╜${C.r}`,
  "",
].join("\n");

const wired = () => listAuth().filter((a) => a.configured);

export async function startTui() {
  const cfg = loadConfig();
  const io = makeIo();
  const out = (s) => process.stdout.write(s);
  out(BANNER + "\n");

  try {
    // Connect-on-empty: a first-run user shouldn't hit a dead end.
    if (wired().length === 0) {
      out(`${C.y}No providers connected yet.${C.r} Let's connect one.\n`);
      await runConnect(io);
      if (wired().length === 0) { out(`\n${C.dim}Nothing connected. Run ${C.r}nomos connect${C.dim} when ready.${C.r}\n`); return; }
    }

    out(`${C.dim}Working in:${C.r} ${cfg.root}\n`);
    out(`${C.dim}Connected:${C.r} ${wired().map((c) => `${C.g}${c.id}${C.r}${C.dim}(${c.method})${C.r}`).join("  ")}\n`);
    out(`${C.dim}Commands: /model  /connect  /models <provider>  /help  /exit${C.r}\n`);

    // Pick a model from a live list instead of asking the user to type an id.
    let spec = await pickModelSpec(io);
    if (!spec) { out(`${C.dim}No model selected. Bye.${C.r}\n`); return; }
    out(`${C.g}▸ ${spec}${C.r}  ${C.dim}— type a task, or /help.${C.r}\n`);

    for (;;) {
      const ans = await io.ask(`\n${C.b}›${C.r} `);
      if (ans === null) break; // EOF / Ctrl-D exits cleanly
      const task = ans;
      if (!task) continue;
      if (task === "/exit" || task === "/quit") break;
      if (task === "/help") {
        out(`${C.dim}/model  pick a model (live list) · /connect  add a provider · /models <p>  list a provider's models · /exit${C.r}\n`);
        continue;
      }
      if (task === "/connect") { await runConnect(io); continue; }
      if (task === "/model" || task === "/models") {
        const next = await pickModelSpec(io);
        if (next) { spec = next; out(`${C.g}▸ ${spec}${C.r}\n`); }
        continue;
      }
      if (task.startsWith("/model ")) { spec = task.slice(7).trim(); out(`${C.dim}model → ${spec}${C.r}\n`); continue; }
      if (task.startsWith("/models ")) {
        const pid = task.slice(8).trim();
        const next = await pickModelSpec(io, pid);
        if (next) { spec = next; out(`${C.g}▸ ${spec}${C.r}\n`); }
        continue;
      }
      try {
        const t0 = Date.now();
        const counts = { read: 0, edit: 0, write: 0, shell: 0 };
        await runAgent({
          spec, task, root: cfg.root,
          allowShell: cfg.allowShell, allowFetch: cfg.allowFetch, maxSteps: cfg.maxSteps,
          onEvent: (e) => {
            if (e.type === "delta") out(e.text);
            else if (e.type === "tool_call") {
              const n = e.name;
              if (n === "read_file") counts.read++; else if (n === "edit_file" || n === "multi_edit") counts.edit++;
              else if (n === "write_file") counts.write++; else if (n === "run_shell") counts.shell++;
              const arg = e.args?.path || e.args?.command || e.args?.pattern || e.args?.query || "";
              out(`\n${C.dim}·${C.r} ${C.c}${n}${C.r} ${C.dim}${String(arg).slice(0, 70)}${C.r}\n`);
            }
            else if (e.type === "tool_result") out(`${C.dim}  → ${String(e.result).replace(/\n/g, " ⏎ ").slice(0, 120)}${C.r}\n`);
          },
        });
        const parts = [];
        if (counts.read) parts.push(`${counts.read} read`);
        if (counts.edit) parts.push(`${counts.edit} edit`);
        if (counts.write) parts.push(`${counts.write} write`);
        if (counts.shell) parts.push(`${counts.shell} shell`);
        out(`\n${C.dim}──${C.r} ${C.g}✓ done${C.r} ${C.dim}in ${((Date.now() - t0) / 1000).toFixed(1)}s${parts.length ? " · " + parts.join(", ") : ""}${C.r}\n`);
      } catch (e) {
        out(`\n${C.y}error:${C.r} ${e.message}\n`);
      }
    }
  } finally {
    io.close();
    out(`${C.dim}bye.${C.r}\n`);
  }
}
