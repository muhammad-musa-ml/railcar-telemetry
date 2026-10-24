import { describe, expect, it } from "vitest";
import type { AlertsResponse, DeadLettersResponse, PagesResponse, StatusResponse } from "../../src/console/api-types";
import { buildConsoleApp } from "../../src/console/app";
import { createRegistry } from "../../src/shared/metrics";
import { amAlert, deadLetter, FakeAlertmanager, FakeDeadLetters, FakePager, FakePrometheus, FakeQuery } from "./console-fakes";

const now = new Date("2026-10-24T08:00:00.000Z");

function setup() {
  const deps = {
    prometheus: new FakePrometheus(),
    alertmanager: new FakeAlertmanager(),
    pager: new FakePager(),
    query: new FakeQuery(),
    deadLetters: new FakeDeadLetters(),
    registry: createRegistry("console", false),
    now: () => now,
  };
  return { ...deps, app: buildConsoleApp(deps) };
}

describe("console read API", () => {
  it("serves the pipeline status", async () => {
    const { app, prometheus, deadLetters } = setup();
    prometheus.samples.set("up", [{ metric: { job: "tracker" }, value: 0 }]);
    deadLetters.entries.push(deadLetter("1761292800000-0", { car_id: "RCTX 1" }));
    const res = await app.inject({ method: "GET", url: "/api/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json<StatusResponse>();
    expect(body.services).toEqual([{ job: "tracker", up: false }]);
    expect(body.dead_letters).toBe(1);
    expect(body.generated_at).toBe(now.toISOString());
  });

  it("lists firing alerts from Alertmanager and pending ones from Prometheus, with severity and runbook", async () => {
    const { app, alertmanager, prometheus } = setup();
    alertmanager.firing = [
      amAlert("StreamBacklogHigh", "warning", "0000000000000002"),
      amAlert("ServiceDown", "critical", "0000000000000001", {
        status: { state: "suppressed", silencedBy: ["s-1"], inhibitedBy: [] },
      }),
    ];
    prometheus.pending = [
      {
        labels: { alertname: "RailcarEventsDelayed", severity: "critical" },
        annotations: { summary: "old", runbook_url: "https://example.org/runbooks/railcar-events-delayed.md" },
        state: "pending",
        activeAt: "2026-10-24T07:59:00.000Z",
      },
      // Prometheus lists firing alerts too; those come from Alertmanager instead.
      {
        labels: { alertname: "StreamBacklogHigh", severity: "warning" },
        annotations: {},
        state: "firing",
        activeAt: "2026-10-24T07:40:00.000Z",
      },
    ];
    const res = await app.inject({ method: "GET", url: "/api/alerts" });
    const body = res.json<AlertsResponse>();
    expect(body.errors).toEqual([]);
    expect(body.alerts.map((a) => [a.name, a.state, a.severity, a.silenced, a.fingerprint])).toEqual([
      ["ServiceDown", "firing", "critical", true, "0000000000000001"],
      ["StreamBacklogHigh", "firing", "warning", false, "0000000000000002"],
      ["RailcarEventsDelayed", "pending", "critical", false, null],
    ]);
    expect(body.alerts[0]?.runbook_url).toBe("https://example.org/runbooks/ServiceDown.md");
    expect(body.alerts[2]?.runbook_url).toBe("https://example.org/runbooks/railcar-events-delayed.md");
  });

  it("still lists what it can when Alertmanager is down", async () => {
    const { app, alertmanager, prometheus } = setup();
    alertmanager.down = true;
    prometheus.pending = [{ labels: { alertname: "X", severity: "warning" }, annotations: {}, state: "pending", activeAt: "2026-10-24T07:59:00.000Z" }];
    const body = (await app.inject({ method: "GET", url: "/api/alerts" })).json<AlertsResponse>();
    expect(body.alerts.map((a) => a.name)).toEqual(["X"]);
    expect(body.errors).toEqual(["alertmanager: connect ECONNREFUSED"]);
  });

  it("returns the pager's last day, newest first", async () => {
    const { app, pager } = setup();
    const record = (at: string, alertname: string) => ({
      received_at: at,
      receiver: "page",
      status: "firing",
      alertname,
      severity: "critical",
      summary: "",
      runbook_url: "",
    });
    pager.records = [record("2026-10-22T08:00:00.000Z", "Old"), record("2026-10-24T07:00:00.000Z", "A"), record("2026-10-24T07:30:00.000Z", "B")];
    const body = (await app.inject({ method: "GET", url: "/api/pages?limit=5" })).json<PagesResponse>();
    expect(body.pages.map((p) => p.alertname)).toEqual(["B", "A"]);
    expect(pager.asked).toEqual([new Date("2026-10-23T08:00:00.000Z")]);
    const one = (await app.inject({ method: "GET", url: "/api/pages?limit=1" })).json<PagesResponse>();
    expect(one.pages.map((p) => p.alertname)).toEqual(["B"]);
  });

  it("lists dead-lettered events newest first with the total count", async () => {
    const { app, deadLetters } = setup();
    deadLetters.entries = [deadLetter("1761292800000-0", { a: 1 }), deadLetter("1761292900000-0", "not json")];
    const body = (await app.inject({ method: "GET", url: "/api/dead-letters" })).json<DeadLettersResponse>();
    expect(body.count).toBe(2);
    expect(body.entries.map((e) => e.id)).toEqual(["1761292900000-0", "1761292800000-0"]);
    expect(body.entries[0]?.event).toBe("not json");
  });

  it("answers 502 naming Redis when the dead-letter stream cannot be read", async () => {
    const { app, deadLetters } = setup();
    deadLetters.down = true;
    const res = await app.inject({ method: "GET", url: "/api/dead-letters" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("redis: Connection is closed.");
  });

  it("looks a car up through the query service", async () => {
    const { app, query } = setup();
    const car = {
      car_id: "RCTX 100005",
      location: "YD03",
      reader_id: "AEI-YD03-E",
      arrived_at: "2026-10-24T06:00:00.000Z",
      last_seen_at: "2026-10-24T07:59:00.000Z",
      dwell_seconds: 7200,
    };
    query.answers.set("/v1/cars/RCTX%20100005", { status: 200, body: car });
    const res = await app.inject({ method: "GET", url: "/api/cars/RCTX%20100005" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(car);
    const missing = await app.inject({ method: "GET", url: "/api/cars/RCTX%20999999" });
    expect(missing.statusCode).toBe(404);
  });

  it("refuses a malformed car id or location without asking the query service", async () => {
    const { app, query } = setup();
    expect((await app.inject({ method: "GET", url: "/api/cars/hello" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/locations/YD%0001/cars" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/locations/YD01/cars?limit=0" })).statusCode).toBe(400);
    expect(query.paths).toEqual([]);
  });

  it("lists the cars at a location through the query service", async () => {
    const { app, query } = setup();
    query.answers.set("/v1/locations/YD03/cars?limit=50", { status: 200, body: { location: "YD03", cars: [] } });
    const res = await app.inject({ method: "GET", url: "/api/locations/YD03/cars?limit=50" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ location: "YD03", cars: [] });
  });

  it("answers 502 with the query service's reason when it is failing", async () => {
    const { app, query } = setup();
    query.down = true;
    const res = await app.inject({ method: "GET", url: "/api/cars/RCTX%20100005" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("query answered 503: position store unavailable");
  });

  it("sets headers that keep the page from being framed or sniffed, and API answers from being cached", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/api/status" });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("exposes Prometheus metrics and a health check", async () => {
    const { app } = setup();
    await app.inject({ method: "GET", url: "/api/status" });
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.body).toContain('http_server_requests_total{route="/api/status",method="GET",status_code="200",service="console"} 1');
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ status: "ok" });
  });
});
