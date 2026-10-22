import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, urls } from "./lib/clients";

// Copies the pager's full log (every notification and every drill marker)
// into results/pager/, so the retrospective timelines can be checked against
// the raw records.
//
//   npx tsx gamedays/export-pager-log.ts

async function main() {
  const dir = join(repoRoot, "results", "pager");
  mkdirSync(dir, { recursive: true });
  for (const kind of ["pages", "markers"] as const) {
    const res = await fetch(`${urls.pager}/v1/${kind}`);
    if (!res.ok) throw new Error(`GET /v1/${kind} -> ${res.status}`);
    const records = ((await res.json()) as Record<string, unknown[]>)[kind] ?? [];
    writeFileSync(join(dir, `${kind}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    console.log(`${kind}: ${records.length} records`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
