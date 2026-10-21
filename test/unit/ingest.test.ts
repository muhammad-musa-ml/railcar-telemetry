import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildIngestApp } from "../../src/ingest/app";
import type { EventPublisher } from "../../src/ingest/publisher";
import type { LocationEvent } from "../../src/shared/event";
import { createRegistry } from "../../src/shared/metrics";

class FakePublisher implements EventPublisher {
  published: LocationEvent[] = [];
  failWith: Error | null = null;
  async publish(events: LocationEvent[]): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.published.push(...events);
  }
}

function event(overrides: Partial<LocationEvent> = {}): LocationEvent {
  return {
    event_id: randomUUID(),
    car_id: "RCTX 104233",
    reader_id: "AEI-YD03-E",
    location: "YD03",
    observed_at: "2026-10-21T14:02:11.250Z",
    ...overrides,
  };
}

function setup() {
  const publisher = new FakePublisher();
  const registry = createRegistry("ingest", false);
  const app = buildIngestApp({ publisher, registry });
  return { app, publisher, registry };
}

describe("POST /v1/events", () => {
  it("accepts a valid batch and publishes every event", async () => {
    const { app, publisher } = setup();
    const events = [event(), event({ car_id: "RCTX 2" })];
    const res = await app.inject({ method: "POST", url: "/v1/events", payload: { events } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 2 });
    expect(publisher.published).toEqual(events);
  });

  it("rejects the whole batch when one event is invalid", async () => {
    const { app, publisher } = setup();
    const events = [event(), event({ car_id: "not a car" })];
    const res = await app.inject({ method: "POST", url: "/v1/events", payload: { events } });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].path).toBe("events.1.car_id");
    expect(publisher.published).toHaveLength(0);
  });

  it("rejects a timestamp without a time zone", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/v1/events",
      payload: { events: [event({ observed_at: "2026-10-21T14:02:11" })] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an empty batch and a batch over 500 events", async () => {
    const { app } = setup();
    const empty = await app.inject({ method: "POST", url: "/v1/events", payload: { events: [] } });
    expect(empty.statusCode).toBe(400);
    const big = Array.from({ length: 501 }, () => event());
    const tooBig = await app.inject({ method: "POST", url: "/v1/events", payload: { events: big } });
    expect(tooBig.statusCode).toBe(400);
  });

  it("returns 503 when the stream is unavailable", async () => {
    const { app, publisher } = setup();
    publisher.failWith = new Error("connection refused");
    const res = await app.inject({ method: "POST", url: "/v1/events", payload: { events: [event()] } });
    expect(res.statusCode).toBe(503);
  });

  it("counts requests by route template and status", async () => {
    const { app, registry } = setup();
    await app.inject({ method: "POST", url: "/v1/events", payload: { events: [event()] } });
    await app.inject({ method: "POST", url: "/v1/events", payload: { events: [] } });
    const text = await registry.metrics();
    expect(text).toContain('http_server_requests_total{route="/v1/events",method="POST",status_code="202",service="ingest"} 1');
    expect(text).toContain('http_server_requests_total{route="/v1/events",method="POST",status_code="400",service="ingest"} 1');
    expect(text).toContain("ingest_events_accepted_total{service=\"ingest\"} 1");
  });
});
