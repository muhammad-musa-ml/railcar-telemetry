import type { Redis } from "ioredis";
import { describe, expect, it } from "vitest";
import { ageSeconds, oldestUnfinishedId, registerStreamGauges } from "../../src/ingest/stream-stats";
import { createRegistry } from "../../src/shared/metrics";

// A stand-in for the few Redis commands the gauges use.
function fakeRedis(state: {
  nowMs: number;
  pending: number;
  smallestPending: string | null;
  lastDelivered: string;
  nextUndelivered: string | null;
}): Redis {
  const fake = {
    xlen: async () => 10,
    time: async () => [String(Math.floor(state.nowMs / 1000)), String((state.nowMs % 1000) * 1000)],
    call: async (command: string, args: string[]) => {
      if (command === "XINFO") {
        return [["name", "tracker", "consumers", 1, "pending", state.pending, "last-delivered-id", state.lastDelivered, "entries-read", 5, "lag", 3]];
      }
      if (command === "XPENDING") {
        return [state.pending, state.smallestPending, state.smallestPending, [["tracker-1", String(state.pending)]]];
      }
      if (command === "XRANGE") {
        expect(args[1]).toBe(`(${state.lastDelivered}`);
        return state.nextUndelivered ? [[state.nextUndelivered, ["event", "{}"]]] : [];
      }
      throw new Error(`unexpected ${command}`);
    },
  };
  return fake as unknown as Redis;
}

async function oldestAge(redis: Redis): Promise<string | undefined> {
  const registry = createRegistry("ingest", false);
  registerStreamGauges(registry, redis);
  const text = await registry.metrics();
  return text.split("\n").find((l) => l.startsWith("railcar_stream_oldest_unacked_age_seconds{"));
}

describe("oldest unacknowledged event", () => {
  it("prefers the smallest pending id, else the first undelivered one", () => {
    expect(oldestUnfinishedId("100-0", "200-0")).toBe("100-0");
    expect(oldestUnfinishedId(null, "200-0")).toBe("200-0");
    expect(oldestUnfinishedId(null, null)).toBeNull();
  });

  it("measures age from the stream id's milliseconds, never below zero", () => {
    expect(ageSeconds("1000-0", 61_000)).toBe(60);
    expect(ageSeconds("5000-0", 4_000)).toBe(0);
    expect(ageSeconds(null, 61_000)).toBe(0);
  });

  it("reports the age of a stuck pending entry", async () => {
    const line = await oldestAge(
      fakeRedis({ nowMs: 1_700_000_090_000, pending: 1, smallestPending: "1700000000000-0", lastDelivered: "1700000080000-0", nextUndelivered: "1700000081000-0" }),
    );
    expect(line).toBe('railcar_stream_oldest_unacked_age_seconds{group="tracker",service="ingest"} 90');
  });

  it("reports the age of the first undelivered entry when nothing is pending", async () => {
    const line = await oldestAge(
      fakeRedis({ nowMs: 1_700_000_090_000, pending: 0, smallestPending: null, lastDelivered: "1700000080000-0", nextUndelivered: "1700000085500-0" }),
    );
    expect(line).toBe('railcar_stream_oldest_unacked_age_seconds{group="tracker",service="ingest"} 4.5');
  });

  it("reports 0 when the group has caught up", async () => {
    const line = await oldestAge(
      fakeRedis({ nowMs: 1_700_000_090_000, pending: 0, smallestPending: null, lastDelivered: "1700000089000-0", nextUndelivered: null }),
    );
    expect(line).toBe('railcar_stream_oldest_unacked_age_seconds{group="tracker",service="ingest"} 0');
  });
});
