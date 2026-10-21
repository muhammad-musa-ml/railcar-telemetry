import { describe, expect, it } from "vitest";
import { Fleet, yardCode } from "../../src/sim/fleet";
import { locationEventSchema } from "../../src/shared/event";

describe("Fleet", () => {
  const now = new Date("2026-10-21T12:00:00.000Z");

  it("produces events that pass the ingest schema", () => {
    const fleet = new Fleet({ cars: 50, yards: 4, seed: 1 });
    for (const e of fleet.nextReads(200, now)) {
      expect(locationEventSchema.safeParse(e).success).toBe(true);
    }
  });

  it("is deterministic for a seed, apart from event ids", () => {
    const strip = (f: Fleet) => f.nextReads(20, now).map(({ event_id: _id, ...rest }) => rest);
    expect(strip(new Fleet({ cars: 10, yards: 3, seed: 9 }))).toEqual(strip(new Fleet({ cars: 10, yards: 3, seed: 9 })));
  });

  it("moves a car to the next yard after its reads at a yard run out", () => {
    const fleet = new Fleet({ cars: 1, yards: 3, seed: 3 });
    const reads = fleet.nextReads(200, now).map((e) => e.location);
    const moves = reads.filter((loc, i) => i > 0 && loc !== reads[i - 1]);
    expect(moves.length).toBeGreaterThan(3);
    for (let i = 1; i < reads.length; i++) {
      if (reads[i] !== reads[i - 1]) {
        const from = Number(reads[i - 1]!.slice(2)) - 1;
        expect(reads[i]).toBe(yardCode((from + 1) % 3));
      }
    }
  });
});
