import { describe, expect, it } from "vitest";
import { median, round, seconds, spread } from "../../gamedays/lib/stats";

describe("game day statistics", () => {
  it("takes the middle value, or the mean of the two middle values", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("reports the median and range, skipping runs with no value", () => {
    expect(spread([130, null, 125, 140, undefined, 128])).toEqual({ n: 4, median: 129, min: 125, max: 140 });
    expect(spread([null, null])).toEqual({ n: 0, median: null, min: null, max: null });
  });

  it("measures seconds between two ISO timestamps", () => {
    expect(seconds("2026-10-21T18:00:00.000Z", "2026-10-21T18:05:10.500Z")).toBe(310.5);
  });

  it("rounds to a fixed number of digits", () => {
    expect(round(12.345, 1)).toBe(12.3);
    expect(round(null)).toBeNull();
  });
});
