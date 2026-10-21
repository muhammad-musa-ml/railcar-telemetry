import { describe, expect, it } from "vitest";
import { buildQueryApp } from "../../src/query/app";
import type { CarPosition, PositionReader } from "../../src/query/positions";
import { createRegistry } from "../../src/shared/metrics";

const car: CarPosition = {
  car_id: "RCTX 104233",
  location: "YD03",
  reader_id: "AEI-YD03-E",
  arrived_at: "2026-10-21T10:00:00.000Z",
  last_seen_at: "2026-10-21T13:55:00.000Z",
  dwell_seconds: 14400,
};

class FakeReader implements PositionReader {
  down = false;
  freshness: number | null = 2.5;
  async getCar(carId: string) {
    if (this.down) throw new Error("connection refused");
    return carId === car.car_id ? car : null;
  }
  async carsAt(location: string) {
    if (this.down) throw new Error("connection refused");
    return location === car.location ? [car] : [];
  }
  async freshnessSeconds() {
    if (this.down) throw new Error("connection refused");
    return this.freshness;
  }
}

function setup() {
  const positions = new FakeReader();
  const registry = createRegistry("query", false);
  return { positions, registry, app: buildQueryApp({ positions, registry }) };
}

describe("query API", () => {
  it("returns a car's position and dwell time", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/v1/cars/RCTX%20104233" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(car);
  });

  it("returns 404 for a car with no reads and 400 for a malformed id", async () => {
    const { app } = setup();
    expect((await app.inject({ method: "GET", url: "/v1/cars/RCTX%201" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/cars/hello" })).statusCode).toBe(400);
  });

  it("lists the cars at a location", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/v1/locations/YD03/cars" });
    expect(res.json()).toEqual({ location: "YD03", cars: [car] });
  });

  it("returns 503 when Postgres is unreachable", async () => {
    const { app, positions } = setup();
    positions.down = true;
    expect((await app.inject({ method: "GET", url: "/v1/cars/RCTX%20104233" })).statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/v1/locations/YD03/cars" })).statusCode).toBe(503);
  });

  it("reports freshness, and drops the sample instead of reporting an old value when the query fails", async () => {
    const { registry, positions } = setup();
    expect(await registry.metrics()).toContain(
      'railcar_positions_freshness_seconds{table="car_positions",service="query"} 2.5',
    );
    positions.down = true;
    const text = await registry.metrics();
    expect(text).not.toMatch(/railcar_positions_freshness_seconds\{/);
    // The error counter is rendered alongside the gauge, so it shows the
    // failure from the previous scrape.
    expect(await registry.metrics()).toContain('railcar_positions_freshness_errors_total{service="query"} 1');
  });
});
