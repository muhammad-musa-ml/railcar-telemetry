import { describe, expect, it } from "vitest";
import { parseXinfoGroups } from "../../src/ingest/stream-stats";
import { entriesFromXread, streamIdMillis, toStreamMessage } from "../../src/shared/stream";

describe("stream helpers", () => {
  it("turns a raw stream entry into a field map", () => {
    const msg = toStreamMessage(["1729519331250-3", ["event", "{}", "traceparent", "00-abc-def-01"]]);
    expect(msg).toEqual({ id: "1729519331250-3", fields: { event: "{}", traceparent: "00-abc-def-01" } });
  });

  it("reads XREADGROUP replies in both the RESP2 and the flattened RESP3 shape", () => {
    const entries = [["1-0", ["event", "a"]], ["2-0", ["event", "b"]]];
    const expected = [
      { id: "1-0", fields: { event: "a" } },
      { id: "2-0", fields: { event: "b" } },
    ];
    expect(entriesFromXread([["railcar:events", entries]], "railcar:events")).toEqual(expected);
    expect(entriesFromXread(["railcar:events", entries], "railcar:events")).toEqual(expected);
    expect(entriesFromXread(["other", entries], "railcar:events")).toEqual([]);
    expect(entriesFromXread(null, "railcar:events")).toEqual([]);
  });

  it("reads the millisecond part of a stream id", () => {
    expect(streamIdMillis("1729519331250-3")).toBe(1729519331250);
    expect(() => streamIdMillis("garbage")).toThrow();
  });

  it("parses XINFO GROUPS output, keeping a null lag as null", () => {
    const raw = [
      ["name", "tracker", "consumers", 1, "pending", 4, "last-delivered-id", "1729519331250-0", "entries-read", 90, "lag", 7],
      ["name", "audit", "consumers", 0, "pending", 0, "last-delivered-id", "0-0", "entries-read", null, "lag", null],
    ];
    expect(parseXinfoGroups(raw)).toEqual([
      { name: "tracker", pending: 4, lastDeliveredId: "1729519331250-0", lag: 7 },
      { name: "audit", pending: 0, lastDeliveredId: "0-0", lag: null },
    ]);
  });
});
