// Interactive model picker — pick a provider (if more than one is connected),
// then pick a model from that provider's LIVE list. Type to filter (like a
// fuzzy finder), number to select. Keeps onboarding to: launch → pick → go.
//
// io = { print(str), ask(question)->Promise<string> } (see connect.js makeIo).
// Returns a "provider/model" spec, or null if cancelled.

import { listAuth } from "./auth.js";
import { listModels } from "./models.js";

const PAGE = 30;

export async function pickFromList(io, items, label) {
  let filter = "";
  for (;;) {
    const view = filter ? items.filter((i) => i.toLowerCase().includes(filter.toLowerCase())) : items;
    io.print(`\n${label}${filter ? ` — filter "${filter}" (${view.length})` : ` (${items.length})`}:\n`);
    view.slice(0, PAGE).forEach((m, i) => io.print(`  ${String(i + 1).padStart(2)}. ${m}\n`));
    if (view.length > PAGE) io.print(`  …and ${view.length - PAGE} more — type to filter\n`);
    if (view.length === 0) io.print(`  (no match — type a different filter, or blank to cancel)\n`);
    const ans = await io.ask(`\nPick # (or type to filter · blank cancels): `);
    if (!ans) return null; // blank or EOF
    if (/^\d+$/.test(ans)) {
      const pick = view[Number(ans) - 1];
      if (pick) return pick;
      io.print(`  ${ans} is out of range.\n`);
      continue;
    }
    filter = ans; // treat any non-number as a filter
  }
}

// Pick a provider/model spec interactively. `preferred` skips the provider step.
export async function pickModelSpec(io, preferred) {
  const connected = listAuth().filter((a) => a.configured);
  if (connected.length === 0) {
    io.print("No providers connected. Run /connect (or `nomos connect`) first.\n");
    return null;
  }

  let providerId = preferred && connected.some((c) => c.id === preferred) ? preferred : null;
  if (!providerId) {
    if (connected.length === 1) {
      providerId = connected[0].id;
    } else {
      io.print(`\nProvider:\n`);
      connected.forEach((c, i) => io.print(`  ${String(i + 1).padStart(2)}. ${c.id}  (${c.method})\n`));
      const pi = await io.ask(`\nPick provider # (blank cancels): `);
      if (!pi) return null;
      providerId = connected[Number(pi) - 1]?.id;
      if (!providerId) { io.print("Cancelled.\n"); return null; }
    }
  }

  io.print(`\nFetching ${providerId} models…\n`);
  const { models, source, reason } = await listModels(providerId);

  if (models.length === 0) {
    io.print(`Couldn't list ${providerId} models (${reason}). Enter the model id manually:\n`);
    const m = await io.ask(`${providerId}/`);
    return m ? `${providerId}/${m}` : null;
  }

  const note = source === "fallback" ? ` (offline list — ${reason})` : "";
  const chosen = await pickFromList(io, models, `${providerId} models${note}`);
  return chosen ? `${providerId}/${chosen}` : null;
}
