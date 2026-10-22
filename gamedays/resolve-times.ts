import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./lib/clients";
import { round, seconds, spread } from "./lib/stats";

// For every run, finds in the exported pager log (results/pager/pages.jsonl)
// when each alert that fired during the run was resolved, measured from the
// moment the pipeline had caught up ("recovered" marker). Answers "how long
// did alerts keep firing after the fix?".
//
//   npx tsx gamedays/resolve-times.ts

interface Page {
  received_at: string;
  status: string;
  alertname: string;
  receiver: string;
}

interface RunFile {
  drill: string;
  label: string;
  run: number;
  markers: { label: string; at: string }[];
}

function main() {
  const pages = readFileSync(join(repoRoot, "results", "pager", "pages.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Page);
  const runsDir = join(repoRoot, "results", "runs");
  const rows: { drill: string; label: string; run: number; alertname: string; receiver: string; resolved_after_recovery_s: number | null }[] = [];

  for (const drill of readdirSync(runsDir)) {
    for (const file of readdirSync(join(runsDir, drill)).filter((f) => f.endsWith(".json"))) {
      const run = JSON.parse(readFileSync(join(runsDir, drill, file), "utf8")) as RunFile;
      const at = (name: string) => run.markers.find((m) => m.label === name)!.at;
      const inject = at("inject-start");
      const recovered = at("recovered");
      const fired = pages.filter((p) => p.status === "firing" && p.received_at >= inject && p.received_at <= recovered);
      for (const alertname of new Set(fired.map((p) => p.alertname))) {
        const resolved = pages.find((p) => p.status === "resolved" && p.alertname === alertname && p.received_at > recovered);
        rows.push({
          drill: run.drill,
          label: run.label,
          run: run.run,
          alertname,
          receiver: fired.find((p) => p.alertname === alertname)!.receiver,
          resolved_after_recovery_s: resolved ? round(seconds(recovered, resolved.received_at)) : null,
        });
      }
    }
  }

  const groups = new Map<string, number[]>();
  for (const r of rows) {
    const key = `${r.drill}|${r.label}|${r.alertname}`;
    groups.set(key, [...(groups.get(key) ?? []), ...(r.resolved_after_recovery_s === null ? [] : [r.resolved_after_recovery_s])]);
  }
  const summary = [...groups.entries()].sort().map(([key, values]) => {
    const [drill, label, alertname] = key.split("|");
    return { drill, label, alertname, runs_fired: rows.filter((r) => `${r.drill}|${r.label}|${r.alertname}` === key).length, resolved_after_recovery_s: spread(values) };
  });
  writeFileSync(join(repoRoot, "results", "evidence", "alerts-resolved-after-recovery.json"), `${JSON.stringify({ summary, runs: rows }, null, 2)}\n`);
  for (const s of summary) {
    const r = s.resolved_after_recovery_s;
    console.log(`${s.drill} ${s.label} ${s.alertname}: fired in ${s.runs_fired} runs, resolved ${r.median}s (${r.min}-${r.max}) after recovery`);
  }
}

main();
