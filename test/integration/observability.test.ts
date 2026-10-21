import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { eventually, getJson, postEvents, promQuery, read, testCarId, urls } from "./helpers";

const dashboardsDir = join(__dirname, "..", "..", "observability", "grafana", "dashboards");

interface JaegerTrace {
  spans: { operationName: string; processID: string; tags: { key: string; value: unknown }[] }[];
  processes: Record<string, { serviceName: string }>;
}

describe("metrics", () => {
  it("scrapes every service", async () => {
    const up = await eventually(async () => {
      const result = await promQuery("up");
      const jobs = Object.fromEntries(result.map((r) => [r.metric.job, r.value[1]]));
      return ["ingest", "tracker", "query", "pager", "reader-sim"].every((j) => jobs[j] === "1") ? jobs : undefined;
    }, 60_000);
    expect(up.tracker).toBe("1");
  });

  it("evaluates every dashboard query without an error", async () => {
    for (const file of readdirSync(dashboardsDir)) {
      const dashboard = JSON.parse(readFileSync(join(dashboardsDir, file), "utf8"));
      for (const panel of dashboard.panels) {
        for (const target of panel.targets ?? []) {
          await expect(promQuery(target.expr), `${file}: ${panel.title}`).resolves.toBeDefined();
        }
      }
    }
  });

  it("has data behind the main pipeline panels", async () => {
    for (const expr of [
      "sum(rate(ingest_events_accepted_total[1m]))",
      "sum(rate(tracker_events_processed_total[1m]))",
      'sum(railcar_stream_group_lag{group="tracker"})',
      "max(railcar_positions_freshness_seconds)",
    ]) {
      const result = await eventually(async () => {
        const r = await promQuery(expr);
        return r.length > 0 ? r : undefined;
      }, 60_000);
      expect(result.length, expr).toBeGreaterThan(0);
    }
  });

  it("loads the provisioned dashboards into Grafana", async () => {
    const { body } = await getJson<{ uid: string }[]>(`${urls.grafana}/api/search?type=dash-db`);
    expect(body.map((d) => d.uid).sort()).toEqual(["railcar-pipeline", "railcar-services"]);
  });
});

describe("tracing", () => {
  it("joins the ingest request and the tracker's processing into one trace", async () => {
    const carId = testCarId();
    expect((await postEvents([read(carId, "YD02", new Date())])).status).toBe(202);

    // Each service exports its spans in its own batches, so the tracker's half
    // of the trace can reach Jaeger before the ingest half. Wait for both.
    const tags = encodeURIComponent(JSON.stringify({ "railcar.car_id": carId }));
    const trace = await eventually(async () => {
      const { body } = await getJson<{ data: JaegerTrace[] }>(`${urls.jaeger}/api/traces?service=tracker&tags=${tags}&limit=1`);
      const found = body.data[0];
      const hasIngest = found?.spans.some((s) => found.processes[s.processID]?.serviceName === "ingest");
      return hasIngest ? found : undefined;
    }, 60_000, 2000);

    const services = new Set(trace.spans.map((s) => trace.processes[s.processID]?.serviceName));
    const operations = trace.spans.map((s) => s.operationName);
    expect(services).toEqual(new Set(["ingest", "tracker"]));
    expect(operations).toContain("POST /v1/events");
    expect(operations).toContain("railcar:events process");
    expect(operations.some((op) => op.startsWith("pg.query:INSERT"))).toBe(true);
  });
});
