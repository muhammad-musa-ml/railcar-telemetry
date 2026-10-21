import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { drills, restoreBaseline, type Drill, type DrillContext } from "./drills";
import { Canary } from "./lib/canary";
import {
  alertmanager,
  fileSha256,
  gitCommit,
  imageId,
  pager,
  prometheus,
  repoRoot,
  serviceStates,
  toxiproxy,
  type Marker,
  type Page,
} from "./lib/clients";
import { round, seconds } from "./lib/stats";

// Runs one drill several times and records every run in results/.
//
//   npx tsx gamedays/run.ts <drill> --runs 5 --label baseline [--window-min 20]
//
// One run:
//   1. put the stack back to normal and wait until no alert is pending or
//      firing and the backlog is small
//   2. start the canary, wait 30 s, inject the fault
//   3. wait for the first page (or the end of the observation window)
//   4. apply the drill's mitigation, then wait until a canary read posted at
//      that moment is visible through the query API
//   5. wait until every alert has resolved
// Times for steps 2-5 are pager markers, so injection and pages share one clock.

const RESULTS = join(repoRoot, "results");
const BACKLOG = 'sum(railcar_stream_group_lag{group="tracker"}) + sum(railcar_stream_group_pending{group="tracker"})';

const CONFIG_FILES = [
  "observability/prometheus/rules/railcar.rules.yml",
  "observability/prometheus/prometheus.yml",
  "observability/alertmanager/alertmanager.yml",
  "src/tracker/tracker.ts",
  "src/ingest/stream-stats.ts",
];

const CSV_COLUMNS = [
  "drill",
  "label",
  "run",
  "injected_at",
  "paged",
  "ttd_page_s",
  "first_page_alert",
  "ttd_ticket_s",
  "first_ticket_alert",
  "ttr_s",
  "impact_s",
  "max_canary_delay_s",
  "peak_backlog",
  "peak_freshness_s",
  "failed_attempts",
  "sim_failed_events",
  "sim_failed_lookups",
  "git_commit",
  "rules_sha256",
  "file",
] as const;

function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}

async function waitForQuiet(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = "";
  while (Date.now() < deadline) {
    try {
      const alerts = await prometheus.query("ALERTS");
      const active = await alertmanager.activeAlerts();
      const backlog = await prometheus.scalar(BACKLOG);
      const freshness = await prometheus.scalar("max(railcar_positions_freshness_seconds)");
      const states = await serviceStates();
      const notRunning = Object.entries(states).filter(([, s]) => s !== "running");
      if (alerts.length > 0) lastReason = `alerts in Prometheus: ${alerts.map((a) => `${a.metric.alertname}/${a.metric.alertstate}`).join(",")}`;
      else if (active.length > 0) lastReason = `alerts in Alertmanager: ${active.map((a) => a.labels.alertname).join(",")}`;
      else if (backlog === null || backlog > 200) lastReason = `backlog ${backlog}`;
      else if (freshness === null || freshness > 30) lastReason = `freshness ${freshness}`;
      else if (notRunning.length > 0) lastReason = `not running: ${notRunning.map(([n]) => n).join(",")}`;
      else return;
    } catch (err) {
      lastReason = String(err);
    }
    await sleep(5000);
  }
  throw new Error(`stack did not settle within ${timeoutMs / 1000} s (${lastReason})`);
}

function nextRunNumber(dir: string, label: string): number {
  if (!existsSync(dir)) return 1;
  const used = readdirSync(dir)
    .map((f) => f.match(new RegExp(`^${label}-(\\d+)\\.json$`)))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => Number(m[1]));
  return used.length === 0 ? 1 : Math.max(...used) + 1;
}

function csvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function metricsOver(fromIso: string, toIso: string) {
  const window = `${Math.max(5, Math.ceil(seconds(fromIso, toIso)))}s`;
  const at = (expr: string) => prometheus.scalar(expr, toIso).catch(() => null);
  return {
    peak_backlog: await at(`max_over_time((${BACKLOG})[${window}:5s])`),
    peak_freshness_s: await at(`max_over_time(max(railcar_positions_freshness_seconds)[${window}:5s])`),
    peak_oldest_unacked_age_s: await at(`max_over_time(max(railcar_stream_oldest_unacked_age_seconds)[${window}:5s])`),
    failed_attempts: await at(`sum(increase(tracker_events_failed_total[${window}])) or vector(0)`),
    sim_failed_events: await at(`sum(increase(sim_events_sent_total{result="failed"}[${window}])) or vector(0)`),
    sim_failed_lookups: await at(`sum(increase(sim_lookups_total{result="failed"}[${window}])) or vector(0)`),
  };
}

// Prometheus series for the run's timeline, as [seconds since injection, value].
async function seriesOver(startIso: string, endIso: string, injectIso: string) {
  const exprs: Record<string, string> = {
    backlog: BACKLOG,
    freshness_s: "max(railcar_positions_freshness_seconds)",
    oldest_unacked_age_s: "max(railcar_stream_oldest_unacked_age_seconds)",
    processed_per_s: "sum(rate(tracker_events_processed_total[30s]))",
    failed_per_s: "sum(rate(tracker_events_failed_total[30s])) or vector(0)",
    tracker_up: 'up{job="tracker"}',
    query_5xx_per_s: 'sum(rate(http_server_requests_total{job="query",status_code=~"5.."}[30s])) or vector(0)',
  };
  const injectS = Date.parse(injectIso) / 1000;
  const out: Record<string, [number, number][]> = {};
  for (const [name, expr] of Object.entries(exprs)) {
    const result = await prometheus.range(expr, startIso, endIso).catch(() => []);
    out[name] = (result[0]?.values ?? []).map(([t, v]) => [Math.round(t - injectS), round(Number(v), 3) ?? 0]);
  }
  // For each alert and state (pending, firing): the first and last second it was seen.
  const alerts = await prometheus.range("ALERTS", startIso, endIso).catch(() => []);
  const alertStates: Record<string, { from_s: number; to_s: number }> = {};
  for (const series of alerts) {
    const times = series.values.map(([t]) => Math.round(t - injectS));
    alertStates[`${series.metric.alertname}/${series.metric.alertstate}`] = { from_s: Math.min(...times), to_s: Math.max(...times) };
  }
  return { series: out, alert_states: alertStates };
}

async function runOnce(drill: Drill, label: string, windowMs: number) {
  log(`[${drill.name}] restoring baseline`);
  await restoreBaseline();
  await waitForQuiet(30 * 60_000);
  log(`[${drill.name}] stack is quiet`);

  const ctx: DrillContext = { state: {} };
  const canary = new Canary();
  canary.start();
  const markers: Marker[] = [];
  const mark = async (name: string, details: Record<string, unknown> = {}) => {
    const m = await pager.mark(name, { drill: drill.name, label, ...details });
    markers.push(m);
    log(`[${drill.name}] ${name}`);
    return m;
  };

  const start = await mark("start", { canary_car: canary.carId });
  await sleep(30_000);
  const baselineDelay = canary.maxDelaySeconds(Date.now() - 30_000, Date.now() - 3_000);

  const injectStart = await mark("inject-start");
  const injectHostMs = Date.now();
  await drill.inject(ctx);
  await mark("inject-done", { ...ctx.state });

  // Wait for the first page, or the end of the observation window.
  let firstPage: Page | undefined;
  const windowEnd = Date.now() + windowMs;
  while (Date.now() < windowEnd) {
    const pages = await pager.pages(injectStart.received_at);
    firstPage = pages.find((p) => p.receiver === "page" && p.status === "firing");
    if (firstPage) break;
    await sleep(1000);
  }
  log(`[${drill.name}] ${firstPage ? `paged by ${firstPage.alertname}` : "no page within the window"}`);

  const mitigateHostMs = Date.now();
  const mitigateStart = await mark("mitigate-start", { reason: firstPage ? "paged" : "window ended" });
  const recoveryRead = await canary.post();
  await drill.mitigate(ctx);
  await mark("mitigate-done", { ...ctx.state });

  const visibleMs = await canary.waitVisible(recoveryRead, 15 * 60_000);
  if (visibleMs === null) {
    throw new Error("pipeline did not recover within 15 minutes of mitigation");
  }
  const recovered = await mark("recovered");
  const ttrSeconds = (visibleMs - mitigateHostMs) / 1000;

  await waitForQuiet(25 * 60_000);
  const allClear = await mark("all-clear");
  canary.stop();

  const pages = (await pager.pages(start.received_at)).filter((p) => Date.parse(p.received_at) <= Date.parse(allClear.received_at));
  const injectedMs = Date.parse(injectStart.received_at);
  const firstTicket = pages.find((p) => p.receiver === "ticket" && p.status === "firing" && Date.parse(p.received_at) >= injectedMs);
  const metrics = await metricsOver(injectStart.received_at, recovered.received_at);
  const timeline = await seriesOver(start.received_at, allClear.received_at, injectStart.received_at);

  return {
    drill: drill.name,
    description: drill.description,
    label,
    observation_window_s: windowMs / 1000,
    canary_car: canary.carId,
    injected_at: injectStart.received_at,
    paged: firstPage !== undefined,
    ttd_page_s: firstPage ? round(seconds(injectStart.received_at, firstPage.received_at)) : null,
    first_page_alert: firstPage?.alertname ?? null,
    ttd_ticket_s: firstTicket ? round(seconds(injectStart.received_at, firstTicket.received_at)) : null,
    first_ticket_alert: firstTicket?.alertname ?? null,
    mitigated_after_s: round(seconds(injectStart.received_at, mitigateStart.received_at)),
    ttr_s: round(ttrSeconds),
    impact_s: round((visibleMs - injectHostMs) / 1000),
    all_clear_after_s: round(seconds(injectStart.received_at, allClear.received_at)),
    baseline_canary_delay_s: round(baselineDelay, 2),
    max_canary_delay_s: round(canary.maxDelaySeconds(injectHostMs, visibleMs), 1),
    ...Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, round(v, 1)])),
    mitigation: ctx.state,
    markers: markers.map((m) => ({ label: m.label, at: m.received_at, after_inject_s: round(seconds(injectStart.received_at, m.received_at)) })),
    notifications: pages.map((p) => ({
      at: p.received_at,
      after_inject_s: round(seconds(injectStart.received_at, p.received_at)),
      receiver: p.receiver,
      status: p.status,
      alertname: p.alertname,
      severity: p.severity,
    })),
    canary_reads: canary.reads
      .filter((r) => r.postedAtMs >= injectHostMs - 30_000)
      .map((r) => ({
        posted_after_inject_s: round((r.postedAtMs - injectHostMs) / 1000),
        delay_s: r.visibleAtMs === null ? null : round((r.visibleAtMs - r.postedAtMs) / 1000, 2),
        post_failed: r.postFailed,
      })),
    timeline,
    environment: {
      git_commit: await gitCommit(),
      config_sha256: Object.fromEntries(CONFIG_FILES.map((f) => [f, fileSha256(f)])),
      tracker_image: await imageId("tracker"),
      ingest_image: await imageId("ingest"),
      loaded_alert_rules: await prometheus.loadedAlertRules(),
      toxics_after: await toxiproxy.toxics(),
    },
  };
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      runs: { type: "string", default: "5" },
      label: { type: "string", default: "baseline" },
      "window-min": { type: "string", default: "20" },
    },
  });
  const drill = drills[positionals[0] ?? ""];
  if (!drill) {
    console.error(`usage: run.ts <${Object.keys(drills).join("|")}> --runs N --label NAME [--window-min M]`);
    process.exit(2);
  }
  if (!/^[a-z0-9-]+$/.test(values.label)) {
    console.error("label must be lowercase letters, digits and dashes");
    process.exit(2);
  }
  const runs = Number(values.runs);
  const windowMs = Number(values["window-min"]) * 60_000;
  const dir = join(RESULTS, "runs", drill.name);
  mkdirSync(dir, { recursive: true });
  const csvPath = join(RESULTS, "runs.csv");
  if (!existsSync(csvPath)) {
    writeFileSync(csvPath, `${CSV_COLUMNS.join(",")}\n`);
  }

  for (let i = 0; i < runs; i++) {
    const n = nextRunNumber(dir, values.label);
    const result = await runOnce(drill, values.label, windowMs);
    const file = `runs/${drill.name}/${values.label}-${String(n).padStart(2, "0")}.json`;
    writeFileSync(join(RESULTS, file), `${JSON.stringify({ run: n, ...result }, null, 2)}\n`);
    const row: Record<string, unknown> = {
      ...result,
      run: n,
      git_commit: result.environment.git_commit,
      rules_sha256: result.environment.config_sha256["observability/prometheus/rules/railcar.rules.yml"],
      file,
    };
    appendFileSync(csvPath, `${CSV_COLUMNS.map((c) => csvValue(row[c])).join(",")}\n`);
    log(
      `[${drill.name}] run ${n}: paged=${result.paged} ttd=${result.ttd_page_s}s (${result.first_page_alert}) ticket=${result.ttd_ticket_s}s ttr=${result.ttr_s}s impact=${result.impact_s}s -> ${file}`,
    );
  }
}

main().catch(async (err) => {
  console.error(err);
  // Never leave a fault behind.
  await restoreBaseline().catch(() => undefined);
  process.exit(1);
});
