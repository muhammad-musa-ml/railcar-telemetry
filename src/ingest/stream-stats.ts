import type { Redis } from "ioredis";
import { Counter, Gauge, type Registry } from "prom-client";
import { STREAM_KEY, streamIdMillis } from "../shared/stream";

export interface GroupInfo {
  name: string;
  pending: number;
  lastDeliveredId: string;
  // Entries added to the stream that the group has not been given yet.
  // Redis reports null when it cannot work this out.
  lag: number | null;
}

// XINFO GROUPS returns one flat [key, value, key, value, ...] array per group.
export function parseXinfoGroups(raw: unknown): GroupInfo[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.map((entry: unknown[]) => {
    const info: Record<string, unknown> = {};
    for (let i = 0; i + 1 < entry.length; i += 2) {
      info[String(entry[i])] = entry[i + 1];
    }
    return {
      name: String(info.name),
      pending: Number(info.pending ?? 0),
      lastDeliveredId: String(info["last-delivered-id"] ?? "0-0"),
      lag: info.lag === null || info.lag === undefined ? null : Number(info.lag),
    };
  });
}

// The oldest entry a group has not finished with. Pending entries were
// delivered before any undelivered one, so the smallest pending id wins when
// there is one; otherwise it is the first entry after the last delivered id.
export function oldestUnfinishedId(smallestPendingId: string | null, firstUndeliveredId: string | null): string | null {
  return smallestPendingId ?? firstUndeliveredId;
}

// Seconds between a stream id's timestamp and nowMs (both Redis server time).
export function ageSeconds(id: string | null, nowMs: number): number {
  return id === null ? 0 : Math.max(0, nowMs - streamIdMillis(id)) / 1000;
}

function isMissingStream(err: unknown): boolean {
  return err instanceof Error && /no such key/i.test(err.message);
}

// The backlog is reported from the producer side: when the tracker is down,
// its own metrics endpoint is down too, but ingest can still read the stream.
export function registerStreamGauges(registry: Registry, redis: Redis): void {
  const errors = new Counter({
    name: "railcar_stream_stats_errors_total",
    help: "Failures reading stream statistics from Redis during a scrape",
    registers: [registry],
  });

  new Gauge({
    name: "railcar_stream_length",
    help: "Entries currently held in the event stream",
    // Labelled so that reset() removes the sample rather than reporting 0.
    labelNames: ["stream"],
    registers: [registry],
    async collect() {
      this.reset();
      try {
        this.set({ stream: STREAM_KEY }, await redis.xlen(STREAM_KEY));
      } catch {
        // XLEN of a missing key is 0, so any error here is a real one.
        errors.inc();
      }
    },
  });

  const groupGauge = (name: string, help: string, pick: (g: GroupInfo) => number | null) =>
    new Gauge({
      name,
      help,
      labelNames: ["group"],
      registers: [registry],
      async collect() {
        this.reset();
        try {
          const groups = parseXinfoGroups(await redis.call("XINFO", ["GROUPS", STREAM_KEY]));
          for (const group of groups) {
            const value = pick(group);
            if (value !== null) {
              this.set({ group: group.name }, value);
            }
          }
        } catch (err) {
          if (!isMissingStream(err)) {
            errors.inc();
          }
        }
      },
    });

  groupGauge(
    "railcar_stream_group_lag",
    "Stream entries not yet delivered to the consumer group",
    (g) => g.lag,
  );
  groupGauge(
    "railcar_stream_group_pending",
    "Entries delivered to the consumer group but not yet acknowledged",
    (g) => g.pending,
  );

  // How long the oldest event the group has not finished has been waiting.
  // The entry count above depends on the traffic rate; this does not, and it
  // keeps growing whether the tracker is stopped, stuck retrying one event,
  // or too slow to keep up.
  new Gauge({
    name: "railcar_stream_oldest_unacked_age_seconds",
    help: "Age in seconds of the oldest stream entry the group has not acknowledged (0 when there is none)",
    labelNames: ["group"],
    registers: [registry],
    async collect() {
      this.reset();
      try {
        const groups = parseXinfoGroups(await redis.call("XINFO", ["GROUPS", STREAM_KEY]));
        const [secs, micros] = await redis.time();
        const nowMs = Number(secs) * 1000 + Math.floor(Number(micros) / 1000);
        for (const group of groups) {
          let smallestPending: string | null = null;
          if (group.pending > 0) {
            const summary = (await redis.call("XPENDING", [STREAM_KEY, group.name])) as unknown[];
            smallestPending = typeof summary[1] === "string" ? summary[1] : null;
          }
          const next = (await redis.call("XRANGE", [STREAM_KEY, `(${group.lastDeliveredId}`, "+", "COUNT", "1"])) as [
            string,
            string[],
          ][];
          const id = oldestUnfinishedId(smallestPending, next[0]?.[0] ?? null);
          this.set({ group: group.name }, ageSeconds(id, nowMs));
        }
      } catch (err) {
        if (!isMissingStream(err)) {
          errors.inc();
        }
      }
    },
  });
}
