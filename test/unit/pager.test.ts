import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPagerApp, type MarkerRecord, type PageRecord } from "../../src/pager/app";
import { JsonlLog } from "../../src/pager/store";
import { createRegistry } from "../../src/shared/metrics";

const webhook = {
  version: "4",
  receiver: "page",
  status: "firing",
  groupKey: "{}:{alertname=\"ServiceDown\"}",
  alerts: [
    {
      status: "firing",
      labels: { alertname: "ServiceDown", severity: "critical", job: "tracker" },
      annotations: { summary: "tracker is down", runbook_url: "https://example.org/runbooks/service-down.md" },
      startsAt: "2026-10-21T12:00:00Z",
      endsAt: "0001-01-01T00:00:00Z",
      fingerprint: "a1b2c3",
    },
  ],
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pager-"));
  dirs.push(dir);
  let clock = Date.parse("2026-10-21T12:01:00.000Z");
  const app = buildPagerApp({
    pages: new JsonlLog<PageRecord>(join(dir, "pages.jsonl")),
    markers: new JsonlLog<MarkerRecord>(join(dir, "markers.jsonl")),
    registry: createRegistry("pager", false),
    now: () => new Date((clock += 1000)),
  });
  return { app, dir };
}

describe("pager", () => {
  it("records each alert of a webhook with the time it arrived", async () => {
    const { app, dir } = setup();
    const res = await app.inject({ method: "POST", url: "/v1/alertmanager/page", payload: webhook });
    expect(res.json()).toEqual({ recorded: 1 });
    const pages = (await app.inject({ method: "GET", url: "/v1/pages" })).json().pages;
    expect(pages).toEqual([
      {
        received_at: "2026-10-21T12:01:01.000Z",
        receiver: "page",
        status: "firing",
        alertname: "ServiceDown",
        severity: "critical",
        fingerprint: "a1b2c3",
        starts_at: "2026-10-21T12:00:00Z",
        ends_at: "0001-01-01T00:00:00Z",
        summary: "tracker is down",
        runbook_url: "https://example.org/runbooks/service-down.md",
      },
    ]);
    // Written to disk as one JSON line per alert.
    const lines = readFileSync(join(dir, "pages.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("filters pages by time and receiver", async () => {
    const { app } = setup();
    await app.inject({ method: "POST", url: "/v1/alertmanager/page", payload: webhook });
    await app.inject({ method: "POST", url: "/v1/alertmanager/ticket", payload: webhook });
    const later = await app.inject({ method: "GET", url: "/v1/pages?since=2026-10-21T12:01:02.000Z" });
    expect(later.json().pages.map((p: PageRecord) => p.receiver)).toEqual(["ticket"]);
    const tickets = await app.inject({ method: "GET", url: "/v1/pages?receiver=page" });
    expect(tickets.json().pages).toHaveLength(1);
  });

  it("rejects a body that is not a webhook", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "POST", url: "/v1/alertmanager/page", payload: { hello: 1 } });
    expect(res.statusCode).toBe(400);
  });

  it("returns 500 and keeps nothing in memory when the log file cannot be written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pager-"));
    dirs.push(dir);
    const pagesPath = join(dir, "pages.jsonl");
    const app = buildPagerApp({
      pages: new JsonlLog<PageRecord>(pagesPath),
      markers: new JsonlLog<MarkerRecord>(join(dir, "markers.jsonl")),
      registry: createRegistry("pager", false),
    });
    // Put a directory where the log file should be, so the append fails.
    mkdirSync(pagesPath);
    const res = await app.inject({ method: "POST", url: "/v1/alertmanager/page", payload: webhook });
    expect(res.statusCode).toBe(500);
    expect((await app.inject({ method: "GET", url: "/v1/pages" })).json().pages).toEqual([]);
  });

  it("stamps drill markers with its own clock and reloads them after a restart", async () => {
    const { app, dir } = setup();
    const res = await app.inject({ method: "POST", url: "/v1/markers", payload: { label: "inject", details: { drill: "x" } } });
    expect(res.json().received_at).toBe("2026-10-21T12:01:01.000Z");
    const reloaded = new JsonlLog<MarkerRecord>(join(dir, "markers.jsonl"));
    expect(reloaded.since().map((m) => m.label)).toEqual(["inject"]);
  });
});
