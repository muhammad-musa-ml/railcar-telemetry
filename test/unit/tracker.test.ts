import { randomUUID } from "node:crypto";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { LocationEvent } from "../../src/shared/event";
import { createRegistry } from "../../src/shared/metrics";
import type { StreamMessage } from "../../src/shared/stream";
import type { ApplyOutcome, PositionStore } from "../../src/tracker/positions";
import type { StreamClient } from "../../src/tracker/stream-client";
import { decodeMessage, isPermanentWriteError, Tracker } from "../../src/tracker/tracker";

// In-memory stand-in for a consumer group with one consumer.
class FakeStream implements StreamClient {
  queue: StreamMessage[] = [];
  pending: StreamMessage[] = [];
  acked: string[] = [];
  dead: { id: string; reason: string }[] = [];
  reads: ("0" | ">")[] = [];
  private seq = 0;

  add(fields: Record<string, string>): string {
    const id = `${1_700_000_000_000 + this.seq}-0`;
    this.seq += 1;
    this.queue.push({ id, fields });
    return id;
  }

  async ensureGroup(): Promise<void> {}

  async read(from: "0" | ">", count: number): Promise<StreamMessage[]> {
    this.reads.push(from);
    if (from === "0") {
      return this.pending.slice(0, count);
    }
    const batch = this.queue.splice(0, count);
    this.pending.push(...batch);
    return batch;
  }

  async ack(id: string): Promise<void> {
    this.pending = this.pending.filter((m) => m.id !== id);
    this.acked.push(id);
  }

  async deadLetter(message: StreamMessage, reason: string): Promise<void> {
    this.pending = this.pending.filter((m) => m.id !== message.id);
    this.dead.push({ id: message.id, reason });
  }
}

// node-postgres errors carry the SQLSTATE (or a system error code) in `code`.
class CodedError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

class FakeStore implements PositionStore {
  applied: LocationEvent[] = [];
  failures = 0;
  failureCode = "ECONNREFUSED";
  rejectCar: string | null = null;
  async apply(event: LocationEvent): Promise<ApplyOutcome> {
    if (event.car_id === this.rejectCar) {
      throw new CodedError('invalid byte sequence for encoding "UTF8": 0x00', "22021");
    }
    if (this.failures > 0) {
      this.failures -= 1;
      throw new CodedError("connection refused", this.failureCode);
    }
    this.applied.push(event);
    return "applied";
  }
}

function event(carId: string): LocationEvent {
  return {
    event_id: randomUUID(),
    car_id: carId,
    reader_id: "AEI-YD01-W",
    location: "YD01",
    observed_at: new Date(1_700_000_000_000).toISOString(),
  };
}

const quiet = pino({ level: "silent" });
const noWait = { batchSize: 10, blockMs: 0, minBackoffMs: 0, maxBackoffMs: 0 };

function setup() {
  const stream = new FakeStream();
  const store = new FakeStore();
  const registry = createRegistry("tracker", false);
  const tracker = new Tracker(stream, store, registry, quiet, noWait);
  return { stream, store, registry, tracker };
}

describe("Tracker", () => {
  it("checks its own backlog first, then reads new entries", async () => {
    const { stream, store, tracker } = setup();
    stream.add({ event: JSON.stringify(event("RCTX 1")) });
    await tracker.runOnce(); // backlog is empty
    await tracker.runOnce(); // new entries
    expect(stream.reads).toEqual(["0", ">"]);
    expect(store.applied.map((e) => e.car_id)).toEqual(["RCTX 1"]);
    expect(stream.pending).toHaveLength(0);
  });

  it("moves an undecodable entry to the dead-letter stream and keeps going", async () => {
    const { stream, store, tracker, registry } = setup();
    stream.add({ event: "{not json" });
    stream.add({ event: JSON.stringify(event("RCTX 2")) });
    await tracker.runOnce();
    await tracker.runOnce();
    expect(stream.dead).toHaveLength(1);
    expect(stream.dead[0]?.reason).toBe("event is not valid JSON");
    expect(store.applied.map((e) => e.car_id)).toEqual(["RCTX 2"]);
    expect(await registry.metrics()).toContain('tracker_events_dead_lettered_total{reason="undecodable",service="tracker"} 1');
  });

  it("stops the batch on a write failure and retries from the oldest unacknowledged entry", async () => {
    const { stream, store, tracker, registry } = setup();
    stream.add({ event: JSON.stringify(event("RCTX 3")) });
    stream.add({ event: JSON.stringify(event("RCTX 4")) });
    store.failures = 1;
    await tracker.runOnce(); // empty backlog
    await tracker.runOnce(); // reads both, first write fails
    expect(store.applied).toHaveLength(0);
    expect(stream.pending).toHaveLength(2);
    await tracker.runOnce(); // re-reads the backlog in order
    expect(stream.reads).toEqual(["0", ">", "0"]);
    expect(store.applied.map((e) => e.car_id)).toEqual(["RCTX 3", "RCTX 4"]);
    expect(stream.pending).toHaveLength(0);
    expect(await registry.metrics()).toContain("tracker_events_failed_total{service=\"tracker\"} 1");
  });
});

describe("Tracker metrics", () => {
  it("exports every dead-letter reason at 0 before anything happens", async () => {
    const { registry } = setup();
    const text = await registry.metrics();
    expect(text).toContain('tracker_events_dead_lettered_total{reason="undecodable",service="tracker"} 0');
    expect(text).toContain('tracker_events_dead_lettered_total{reason="rejected",service="tracker"} 0');
    expect(text).toContain('tracker_events_processed_total{outcome="applied",service="tracker"} 0');
  });
});

describe("Tracker and events Postgres rejects", () => {
  it("moves an event Postgres rejects to the dead-letter stream and keeps going", async () => {
    const { stream, store, tracker, registry } = setup();
    store.rejectCar = "RCTX 7";
    stream.add({ event: JSON.stringify(event("RCTX 7")) });
    stream.add({ event: JSON.stringify(event("RCTX 8")) });
    await tracker.runOnce(); // empty backlog
    await tracker.runOnce(); // reads both
    expect(stream.dead).toHaveLength(1);
    expect(stream.dead[0]?.reason).toMatch(/^rejected by Postgres: 22021 /);
    expect(store.applied.map((e) => e.car_id)).toEqual(["RCTX 8"]);
    expect(stream.pending).toHaveLength(0);
    const text = await registry.metrics();
    expect(text).toContain('tracker_events_dead_lettered_total{reason="rejected",service="tracker"} 1');
    expect(text).toContain('tracker_events_failed_total{service="tracker"} 0');
  });

  it("still retries an error that is not about the data", async () => {
    const { stream, store, tracker } = setup();
    store.failures = 1;
    store.failureCode = "57P01"; // admin_shutdown: Postgres is going away
    stream.add({ event: JSON.stringify(event("RCTX 9")) });
    await tracker.runOnce();
    await tracker.runOnce();
    expect(stream.dead).toHaveLength(0);
    expect(stream.pending).toHaveLength(1);
    await tracker.runOnce();
    expect(store.applied.map((e) => e.car_id)).toEqual(["RCTX 9"]);
  });

  it("classifies SQLSTATE classes 22 and 23 as permanent", () => {
    expect(isPermanentWriteError(new CodedError("x", "22021"))).toBe(true);
    expect(isPermanentWriteError(new CodedError("x", "23505"))).toBe(true);
    expect(isPermanentWriteError(new CodedError("x", "08006"))).toBe(false);
    expect(isPermanentWriteError(new CodedError("x", "ECONNREFUSED"))).toBe(false);
    expect(isPermanentWriteError({ code: "22021" })).toBe(false);
    expect(isPermanentWriteError(new Error("no code"))).toBe(false);
  });
});

describe("decodeMessage", () => {
  it("accepts a valid event", () => {
    const e = event("RCTX 5");
    expect(decodeMessage({ id: "1-0", fields: { event: JSON.stringify(e) } })).toEqual({ ok: true, event: e });
  });

  it("rejects a missing field and a schema violation", () => {
    expect(decodeMessage({ id: "1-0", fields: {} })).toEqual({ ok: false, reason: "missing event field" });
    const bad = decodeMessage({ id: "1-0", fields: { event: JSON.stringify({ ...event("RCTX 6"), car_id: "x" }) } });
    expect(bad.ok).toBe(false);
  });
});
