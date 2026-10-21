import { describe, expect, it } from "vitest";
import type { CarPosition } from "../../src/query/positions";
import { eventually, getJson, postEvents, read, testCarId, urls } from "./helpers";

async function position(carId: string) {
  return getJson<CarPosition>(`${urls.query}/v1/cars/${encodeURIComponent(carId)}`);
}

describe("ingest -> stream -> tracker -> Postgres -> query", () => {
  it("makes a posted read visible through the query API", async () => {
    const carId = testCarId();
    const seen = new Date();
    const res = await postEvents([read(carId, "YD05", seen)]);
    expect(res.status).toBe(202);

    const car = await eventually(async () => {
      const { status, body } = await position(carId);
      return status === 200 ? body : undefined;
    });
    expect(car.location).toBe("YD05");
    expect(car.last_seen_at).toBe(seen.toISOString());
    expect(car.arrived_at).toBe(seen.toISOString());
  });

  it("keeps the arrival time while the car stays put and resets it when the car moves", async () => {
    const carId = testCarId();
    const t0 = new Date(Date.now() - 3_600_000);
    const t1 = new Date(t0.getTime() + 600_000);
    const t2 = new Date(t0.getTime() + 1_200_000);

    await postEvents([read(carId, "YD07", t0)]);
    await eventually(async () => ((await position(carId)).status === 200 ? true : undefined));

    await postEvents([read(carId, "YD07", t1)]);
    const stayed = await eventually(async () => {
      const { body } = await position(carId);
      return body.last_seen_at === t1.toISOString() ? body : undefined;
    });
    expect(stayed.arrived_at).toBe(t0.toISOString());
    // Dwell is measured from the first read at this yard, about an hour ago.
    expect(stayed.dwell_seconds).toBeGreaterThanOrEqual(3600);

    await postEvents([read(carId, "YD08", t2)]);
    const moved = await eventually(async () => {
      const { body } = await position(carId);
      return body.location === "YD08" ? body : undefined;
    });
    expect(moved.arrived_at).toBe(t2.toISOString());
  });

  it("ignores a read that is older than the stored one", async () => {
    const carId = testCarId();
    const newer = new Date();
    const older = new Date(newer.getTime() - 60_000);
    await postEvents([read(carId, "YD10", newer)]);
    await eventually(async () => ((await position(carId)).status === 200 ? true : undefined));

    // The older read sits behind a marker read for another car; once the
    // marker is visible, the older read has been processed too.
    const marker = testCarId();
    await postEvents([read(carId, "YD11", older), read(marker, "YD01", new Date())]);
    await eventually(async () => ((await position(marker)).status === 200 ? true : undefined));

    const { body } = await position(carId);
    expect(body.location).toBe("YD10");
    expect(body.last_seen_at).toBe(newer.toISOString());
  });

  it("rejects an invalid batch with 400 and the failing field", async () => {
    const bad = { ...read(testCarId(), "YD01", new Date()), observed_at: "yesterday" };
    const res = await fetch(`${urls.ingest}/v1/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [bad] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: { path: string }[] };
    expect(body.issues[0]?.path).toBe("events.0.observed_at");
  });

  it("lists the cars at a location", async () => {
    const carId = testCarId();
    await postEvents([read(carId, "YD24", new Date())]);
    const listed = await eventually(async () => {
      const { body } = await getJson<{ cars: CarPosition[] }>(`${urls.query}/v1/locations/YD24/cars?limit=500`);
      return body.cars.find((c) => c.car_id === carId);
    });
    expect(listed.location).toBe("YD24");
  });
});
