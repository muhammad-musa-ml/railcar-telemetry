import { env, envInt } from "../shared/config";
import { createLogger } from "../shared/logger";
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
const counts = { eventsSent: 0, eventsFailed: 0, queriesOk: 0, queriesFailed: 0, ticksSkipped: 0 };
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
      if (res.ok) {
        counts.eventsSent += batch.length;
      } else {
        counts.eventsFailed += batch.length;
      }
    } catch {
      counts.eventsFailed += batch.length;
    }
  }
}

async function sendQueries(): Promise<void> {
  await Promise.all(
    Array.from({ length: queriesPerSecond }, async () => {
      const id = encodeURIComponent(fleet.randomCarId());
      try {
        const res = await fetch(`${queryUrl}/v1/cars/${id}`, { signal: AbortSignal.timeout(5000) });
        // 404 is a normal answer for a car that has not been read yet.
        if (res.ok || res.status === 404) {
          counts.queriesOk += 1;
        } else {
          counts.queriesFailed += 1;
        }
      } catch {
        counts.queriesFailed += 1;
      }
    }),
  );
}

async function tick(): Promise<void> {
  // If the last second's requests have not finished, skip this one rather
  // than piling up requests against a slow service.
  if (busy) {
    counts.ticksSkipped += 1;
    return;
  }
  busy = true;
  try {
    await Promise.all([sendEvents(new Date()), sendQueries()]);
  } finally {
    busy = false;
  }
}

const tickTimer = setInterval(() => void tick(), 1000);
const reportTimer = setInterval(() => logger.info({ ...counts }, "simulator totals"), 30_000);
logger.info({ eventsPerSecond, queriesPerSecond, ingestUrl, queryUrl }, "reader simulator started");

const stop = () => {
  clearInterval(tickTimer);
  clearInterval(reportTimer);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
