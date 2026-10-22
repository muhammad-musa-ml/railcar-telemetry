import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./lib/clients";
import { round, spread, type Spread } from "./lib/stats";

// Reads every run in results/runs/ and writes results/summary.json and
// results/summary.md: per drill and label, the median and range of each
// measurement. Prints the markdown table too.
//
//   npx tsx gamedays/summarize.ts

interface Run {
  drill: string;
  label: string;
  run: number;
  injected_at: string;
  observation_window_s: number;
  paged: boolean;
  ttd_page_s: number | null;
  first_page_alert: string | null;
  ttd_ticket_s: number | null;
  first_ticket_alert: string | null;
  ttr_s: number;
  impact_s: number;
  max_canary_delay_s: number | null;
  peak_backlog: number | null;
  peak_freshness_s: number | null;
  failed_attempts: number | null;
  peak_oldest_unacked_age_s: number | null;
  baseline_canary_delay_s: number | null;
  markers: { label: string; after_inject_s: number }[];
  timeline: { series: Record<string, [number, number][]> };
}

// Seconds from the pipeline catching up to the last alert clearing (no
// alert pending or firing in Prometheus, none active in Alertmanager).
function clearAfterRecovery(run: Run): number | null {
  const at = (label: string) => run.markers.find((m) => m.label === label)?.after_inject_s;
  const recovered = at("recovered");
  const clear = at("all-clear");
  return recovered === undefined || clear === undefined ? null : clear - recovered;
}

// Highest oldest-unacknowledged age in the 30 s before injection, when the
// stack was running normally. Null for runs before the metric existed.
function normalOldestAge(run: Run): number | null {
  const points = (run.timeline.series.oldest_unacked_age_s ?? []).filter(([t]) => t >= -30 && t < 0);
  return points.length === 0 ? null : Math.max(...points.map(([, v]) => v));
}

const runsDir = join(repoRoot, "results", "runs");

function loadRuns(): Run[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir).flatMap((drill) =>
    readdirSync(join(runsDir, drill))
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(runsDir, drill, f), "utf8")) as Run),
  );
}

function fmt(s: Spread, unit = "s"): string {
  if (s.n === 0 || s.median === null) return "-";
  const r = (v: number | null) => String(round(v, 1));
  return `${r(s.median)}${unit} (${r(s.min)}-${r(s.max)})`;
}

function counts(values: (string | null)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    const key = v ?? "none";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function main() {
  const runs = loadRuns();
  const groups = new Map<string, Run[]>();
  for (const run of runs) {
    const key = `${run.drill}|${run.label}`;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }

  const summary = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => {
      const [drill, label] = key.split("|");
      group.sort((a, b) => a.run - b.run);
      return {
        drill,
        label,
        runs: group.length,
        first_injected_at: group[0]!.injected_at,
        last_injected_at: group.at(-1)!.injected_at,
        observation_window_s: group[0]!.observation_window_s,
        paged_runs: group.filter((r) => r.paged).length,
        first_page_alerts: counts(group.map((r) => r.first_page_alert)),
        ttd_page_s: spread(group.map((r) => r.ttd_page_s)),
        first_ticket_alerts: counts(group.map((r) => r.first_ticket_alert)),
        ttd_ticket_s: spread(group.map((r) => r.ttd_ticket_s)),
        ttr_s: spread(group.map((r) => r.ttr_s)),
        impact_s: spread(group.map((r) => r.impact_s)),
        max_canary_delay_s: spread(group.map((r) => r.max_canary_delay_s)),
        peak_backlog: spread(group.map((r) => r.peak_backlog)),
        peak_freshness_s: spread(group.map((r) => r.peak_freshness_s)),
        failed_attempts: spread(group.map((r) => r.failed_attempts)),
        peak_oldest_unacked_age_s: spread(group.map((r) => r.peak_oldest_unacked_age_s)),
        alerts_clear_after_recovery_s: spread(group.map(clearAfterRecovery)),
        oldest_unacked_age_before_injection_s: spread(group.map(normalOldestAge)),
        canary_delay_before_injection_s: spread(group.map((r) => r.baseline_canary_delay_s)),
        files: group.map((r) => `runs/${r.drill}/${r.label}-${String(r.run).padStart(2, "0")}.json`),
      };
    });

  const lines = [
    "| drill | label | runs | paged | time to page | first page | time to ticket | time to recover | impact | peak backlog |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...summary.map((s) =>
      [
        s.drill,
        s.label,
        s.runs,
        `${s.paged_runs}/${s.runs}`,
        fmt(s.ttd_page_s),
        Object.entries(s.first_page_alerts)
          .map(([k, v]) => `${k} x${v}`)
          .join(", "),
        fmt(s.ttd_ticket_s),
        fmt(s.ttr_s),
        fmt(s.impact_s),
        fmt(s.peak_backlog, ""),
      ].join(" | "),
    ).map((l) => `| ${l} |`),
  ];
  const note =
    "Each cell is the median with the range (min-max) over the runs in brackets. Time to page counts only runs that paged.\n";
  writeFileSync(join(repoRoot, "results", "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(repoRoot, "results", "summary.md"), `# Game day summary\n\n${note}\n${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
}

main();
