import Fastify from "fastify";
import { Counter } from "prom-client";
import { env, envInt } from "../shared/config";
import { createLogger } from "../shared/logger";
import { createRegistry, instrumentHttp } from "../shared/metrics";
import { Fleet } from "./fleet";

// Sends synthetic tag reads to ingest and position lookups to the query API
// at a steady rate, so the dashboards and alerts always have traffic.

const logger = createLogger("reader-sim");
const ingestUrl = env("INGEST_URL", "http://localhost:8081");
const queryUrl = env("QUERY_URL", "http://localhost:8083");
const eventsPerSecond = envInt("EVENTS_PER_SECOND", 25);
const queriesPerSecond = envInt("QUERIES_PER_SECOND", 5);
const BATCH = 100;

const fleet = new Fleet({ cars: envInt("CARS", 2000), yards: envInt("YARDS", 24), seed: envInt("SEED", 7) });
const registry = createRegistry("reader-sim");
const eventsSent = new Counter({
  name: "sim_events_sent_total",
  help: "Tag reads sent to ingest, by result (accepted or failed)",
  labelNames: ["result"],
  registers: [registry],
});
const lookups = new Counter({
  name: "sim_lookups_total",
  help: "Position lookups sent to the query API, by result (ok or failed)",
  labelNames: ["result"],
  registers: [registry],
});
const ticksSkipped = new Counter({
  name: "sim_ticks_skipped_total",
  help: "Seconds skipped because the previous second's requests had not finished",
  registers: [registry],
});
let busy = false;

async function sendEvents(now: Date): Promise<void> {
  const events = fleet.nextReads(eventsPerSecond, now);
  for (let i = 0; i < events.length; i += BATCH) {
    const batch = events.slice(i, i + BATCH);
    try {
      const res = await fetch(`${ingestUrl}/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: batch }),
        signal: AbortSignal.timeout(5000),
      });
      eventsSent.inc({ result: res.ok ? "accepted" : "failed" }, batch.length);
    } catch {
      eventsSent.inc({ result: "failed" }, batch.length);
    }
  }
}

async function sendLookups(): Promise<void> {
  await Promise.all(
    Array.from({ length: queriesPerSecond }, async () => {
      const id = encodeURIComponent(fleet.randomCarId());
      try {
        const res = await fetch(`${queryUrl}/v1/cars/${id}`, { signal: AbortSignal.timeout(5000) });
        // 404 is a normal answer for a car that has not been read yet.
        lookups.inc({ result: res.ok || res.status === 404 ? "ok" : "failed" });
      } catch {
        lookups.inc({ result: "failed" });
      }
    }),
  );
}

async function tick(): Promise<void> {
  // If the last second's requests have not finished, skip this one rather
  // than piling up requests against a slow service.
  if (busy) {
    ticksSkipped.inc();
    return;
  }
  busy = true;
  try {
    await Promise.all([sendEvents(new Date()), sendLookups()]);
  } finally {
    busy = false;
  }
}

async function main() {
  const http = Fastify({ logger: false });
  instrumentHttp(http, registry);
  http.get("/healthz", async () => ({ status: "ok" }));
  await http.listen({ host: "0.0.0.0", port: envInt("PORT", 8080) });

  const timer = setInterval(() => void tick(), 1000);
  logger.info({ eventsPerSecond, queriesPerSecond, ingestUrl, queryUrl }, "reader simulator started");

  const stop = async () => {
    clearInterval(timer);
    await http.close();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
