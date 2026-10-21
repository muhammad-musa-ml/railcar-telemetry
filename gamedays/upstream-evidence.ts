import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compose, repoRoot } from "./lib/clients";
import { round, seconds } from "./lib/stats";

// For each postgres-stop run, reads the toxiproxy and Postgres container logs
// and records where toxiproxy tried to send Postgres connections while
// Postgres was down and right after it came back. Only counts and times are
// written, never the addresses, so no detail of the host's network ends up in
// the results.
//
//   npx tsx gamedays/upstream-evidence.ts <label>

interface RunFile {
  run: number;
  label: string;
  markers: { label: string; at: string }[];
}

interface ToxiLine {
  time: string;
  message: string;
  error?: string;
}

function parseJsonLines(text: string): ToxiLine[] {
  const out: ToxiLine[] = [];
  for (const line of text.split("\n")) {
    const start = line.indexOf("{");
    if (start < 0) continue;
    try {
      out.push(JSON.parse(line.slice(start)) as ToxiLine);
    } catch {
      // not a JSON log line
    }
  }
  return out;
}

function upstreamAddress(error: string | undefined): string | null {
  const m = error?.match(/dial tcp ([0-9.]+):5432/) ?? error?.match(/->([0-9.]+):5432/);
  return m ? m[1]! : null;
}

async function main() {
  const label = process.argv[2] ?? "baseline";
  const dir = join(repoRoot, "results", "runs", "postgres-stop");
  const subnet = (await compose("exec", "-T", "redis", "hostname", "-i")).trim().split(".").slice(0, 2).join(".") + ".";
  const toxi = parseJsonLines(await compose("logs", "--no-log-prefix", "toxiproxy"));
  const pgLog = await compose("logs", "--no-log-prefix", "postgres");
  const readyTimes = [...pgLog.matchAll(/^(\S+ \S+) UTC \[\d+\] LOG:\s+database system is ready to accept connections/gm)].map(
    (m) => new Date(`${m[1]!.replace(" ", "T")}Z`).toISOString(),
  );

  const report = [];
  for (const file of readdirSync(dir).filter((f) => f.startsWith(`${label}-`) && f.endsWith(".json"))) {
    const run = JSON.parse(readFileSync(join(dir, file), "utf8")) as RunFile;
    const at = (name: string) => run.markers.find((m) => m.label === name)!.at;
    const inject = at("inject-start");
    const mitigated = at("mitigate-start");
    const recovered = at("recovered");
    // toxiproxy logs with one-second resolution; widen the window by a second.
    const inWindow = toxi.filter((l) => l.time && l.time >= inject.slice(0, 19) && l.time <= recovered.slice(0, 19) + "Z");
    const dials = inWindow.filter((l) => l.message === "Unable to open connection to upstream");
    const outside = dials.filter((l) => {
      const addr = upstreamAddress(l.error);
      return addr !== null && !addr.startsWith(subnet);
    });
    const ready = readyTimes.find((t) => t >= mitigated.slice(0, 19));
    const lastOutside = outside.at(-1)?.time;
    report.push({
      file: `runs/postgres-stop/${file}`,
      failed_upstream_dials: dials.length,
      dials_to_address_outside_compose_network: outside.length,
      postgres_ready_after_mitigation_start_s: ready ? round(seconds(mitigated, ready), 1) : null,
      last_outside_dial_after_postgres_ready_s: ready && lastOutside ? round(seconds(ready, lastOutside), 0) : null,
      recovered_after_postgres_ready_s: ready ? round(seconds(ready, recovered), 1) : null,
    });
  }
  report.sort((a, b) => a.file.localeCompare(b.file));
  mkdirSync(join(repoRoot, "results", "evidence"), { recursive: true });
  const out = join(repoRoot, "results", "evidence", `postgres-stop-${label}-upstream.json`);
  writeFileSync(out, `${JSON.stringify({ note: "toxiproxy logs times to the second", runs: report }, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
