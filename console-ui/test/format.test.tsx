import { describe, expect, it } from "vitest";
import type { Signal } from "../../src/console/api-types";
import { formatAge, formatDuration, formatTime, formatValue, noValueText } from "../src/format";

describe("formatting", () => {
  it.each([
    [0, "0 s"],
    [45.4, "45 s"],
    [60, "1 min"],
    [95, "1 min 35 s"],
    [300, "5 min"],
    [3600, "1 h"],
    [3725, "1 h 2 min"],
    [47 * 3600 + 59 * 60, "47 h 59 min"],
    [48 * 3600, "2 d"],
    [3 * 86400 + 4 * 3600 + 59, "3 d 4 h"],
    [-5, "0 s"],
  ])("writes %s seconds as %s", (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });

  it("writes values in the unit of their signal", () => {
    expect(formatValue(5000, "events")).toBe("5,000");
    expect(formatValue(0.05, "ratio")).toBe("5.0 %");
    expect(formatValue(0.1234, "ratio")).toBe("12.3 %");
    expect(formatValue(61, "seconds")).toBe("1 min 1 s");
  });

  it("says what a missing value means", () => {
    const ratio = { unit: "ratio" } as Signal;
    const age = { unit: "seconds" } as Signal;
    expect(noValueText(ratio)).toBe("no 5xx answers recorded");
    expect(noValueText(age)).toBe("no data");
  });

  it("writes times in UTC and ages against a given clock", () => {
    expect(formatTime("2026-10-24T07:55:10.123Z")).toBe("2026-10-24 07:55:10 UTC");
    expect(formatTime("not a time")).toBe("not a time");
    expect(formatAge("2026-10-24T07:50:00.000Z", new Date("2026-10-24T08:00:00.000Z"))).toBe("10 min");
  });
});
