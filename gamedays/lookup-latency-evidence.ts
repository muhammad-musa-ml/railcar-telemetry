import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prometheus, repoRoot } from "./lib/clients";
import { round, seconds } from "./lib/stats";

// For each run of a drill, asks Prometheus for the query API's p95 lookup
// latency just before the fault and its highest value while the fault was
// in place, to check it against the 500 ms QueryLatencyHigh threshold.
//
//   npx tsx gamedays/lookup-latency-evidence.ts <drill> <label>

// The alert's own expression (5-minute window) for the peak during the
// fault, and a 1-minute window for the value just before it, so the earlier
// run's fault does not leak into "before".
const p95 = (window: string) =>
  `histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_seconds_bucket{job="query",route=~"/v1/.*"}[${window}])))`;
const P95 = p95("5m");

interface RunFile {
  markers: { label: string; at: string }[];
}

async function main() {
  const [drill = "postgres-latency", label = "baseline"] = process.argv.slice(2);
  const dir = join(repoRoot, "results", "runs", drill);
  const runs = [];
  for (const file of readdirSync(dir).filter((f) => f.startsWith(`${label}-`) && f.endsWith(".json")).sort()) {
    const run = JSON.parse(readFileSync(join(dir, file), "utf8")) as RunFile;
    const at = (name: string) => run.markers.find((m) => m.label === name)!.at;
    const inject = at("inject-start");
    const mitigate = at("mitigate-start");
    const window = `${Math.floor(seconds(inject, mitigate))}s`;
    const before = await prometheus.scalar(p95("1m"), inject);
    const peak = await prometheus.scalar(`max_over_time((${P95})[${window}:5s])`, mitigate);
    runs.push({
      file: `runs/${drill}/${file}`,
      p95_1m_window_before_fault_ms: before === null ? null : round(before * 1000, 0),
      p95_5m_window_peak_during_fault_ms: peak === null ? null : round(peak * 1000, 0),
    });
  }
  mkdirSync(join(repoRoot, "results", "evidence"), { recursive: true });
  const out = join(repoRoot, "results", "evidence", `${drill}-${label}-lookup-p95.json`);
  writeFileSync(out, `${JSON.stringify({ query: P95, runs }, null, 2)}\n`);
  console.log(JSON.stringify(runs, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
