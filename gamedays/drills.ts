import { randomUUID } from "node:crypto";
import { compose, redisCli, toxiproxy } from "./lib/clients";

// Each drill injects one real fault into the running stack and knows how to
// undo it. `mitigate` is what the on-call person would do after reading the
// runbook; the harness runs it as soon as the first page arrives.

export interface DrillContext {
  // Anything inject() wants mitigate() to know, recorded in the results.
  state: Record<string, unknown>;
}

export interface Drill {
  name: string;
  description: string;
  inject(ctx: DrillContext): Promise<void>;
  mitigate(ctx: DrillContext): Promise<void>;
}

export const POSTGRES_LATENCY_MS = 100;

const trackerStop: Drill = {
  name: "tracker-stop",
  description: "Stop the tracker container. Events keep arriving but nothing consumes them.",
  inject: async () => {
    await compose("stop", "tracker");
  },
  mitigate: async () => {
    await compose("start", "tracker");
  },
};

const postgresLatency: Drill = {
  name: "postgres-latency",
  description: `Add ${POSTGRES_LATENCY_MS} ms to every response from Postgres (toxiproxy latency toxic). Postgres stays up, but each tracker write takes over ${POSTGRES_LATENCY_MS} ms.`,
  inject: async () => {
    await toxiproxy.addLatency(POSTGRES_LATENCY_MS);
  },
  mitigate: async () => {
    await toxiproxy.removeAll();
  },
};

const postgresStop: Drill = {
  name: "postgres-stop",
  description: "Stop the Postgres container. The tracker cannot write and the query API cannot read.",
  inject: async () => {
    await compose("stop", "postgres");
  },
  mitigate: async () => {
    await compose("start", "postgres");
  },
};

// A read whose location contains a NUL character. It is valid JSON and passes
// the event schema, but Postgres rejects the text ("invalid byte sequence for
// encoding UTF8: 0x00"). It is written straight to the stream, the way a
// backfill script or a second producer would, so ingest never sees it.
const poisonEvent: Drill = {
  name: "poison-event",
  description: "Write one event that Postgres rejects directly into the Redis stream.",
  inject: async (ctx) => {
    const event = {
      event_id: randomUUID(),
      car_id: "RCTX 100001",
      reader_id: "AEI-YD04-E",
      location: "YD04\u0000",
      observed_at: new Date().toISOString(),
    };
    const [id] = await redisCli("XADD", "railcar:events", "*", "event", JSON.stringify(event));
    ctx.state.poison_id = id;
  },
  // The runbook step for a stuck event (docs/runbooks/tracker-processing-errors.md):
  // if the oldest unacknowledged entry is the poison event, copy it to the
  // dead-letter stream and acknowledge it. If the tracker already moved it on
  // by itself, there is nothing to do.
  mitigate: async (ctx) => {
    const [oldest] = await redisCli("XPENDING", "railcar:events", "tracker", "-", "+", "1");
    if (oldest === undefined || oldest !== ctx.state.poison_id) {
      ctx.state.mitigation = "nothing stuck";
      return;
    }
    const entry = await redisCli("XRANGE", "railcar:events", oldest, oldest);
    const event = entry[entry.indexOf("event") + 1] ?? "";
    await redisCli("XADD", "railcar:events:dead", "*", "source_id", oldest, "reason", "manual", "event", event);
    await redisCli("XACK", "railcar:events", "tracker", oldest);
    ctx.state.mitigation = "parked the stuck entry by hand";
  },
};

export const drills: Record<string, Drill> = Object.fromEntries(
  [trackerStop, postgresLatency, postgresStop, poisonEvent].map((d) => [d.name, d]),
);

// Put the stack back to normal no matter what a previous (possibly
// interrupted) drill left behind.
export async function restoreBaseline(): Promise<void> {
  await compose("start", "postgres", "redis", "toxiproxy", "tracker", "ingest", "query", "reader-sim");
  await toxiproxy.removeAll();
}
