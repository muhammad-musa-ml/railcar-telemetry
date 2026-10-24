import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readStatus, SIGNALS, splitAlertExpr } from "../../src/console/status";
import type { PrometheusApi, PromAlert, PromAlertRule, PromSample } from "../../src/console/upstreams";

const rulesFile = join(__dirname, "..", "..", "observability", "prometheus", "rules", "railcar.rules.yml");

// The alert rules as written in the repository, in the shape Prometheus
// serves them from /api/v1/rules.
function repositoryRules(): PromAlertRule[] {
  const doc = parse(readFileSync(rulesFile, "utf8")) as {
    groups: { rules: { alert?: string; expr: string; labels?: Record<string, string>; annotations?: Record<string, string> }[] }[];
  };
  return doc.groups
    .flatMap((g) => g.rules)
    .filter((r) => r.alert !== undefined)
    .map((r) => ({ name: r.alert!, query: r.expr, labels: r.labels ?? {}, annotations: r.annotations ?? {} }));
}

class FakePrometheus implements PrometheusApi {
  rules = repositoryRules();
  samples = new Map<string, PromSample[]>();
  down = false;
  queries: string[] = [];

  async query(expr: string) {
    if (this.down) throw new Error("connect ECONNREFUSED");
    this.queries.push(expr);
    return this.samples.get(expr) ?? [];
  }
  async alertRules() {
    if (this.down) throw new Error("connect ECONNREFUSED");
    return this.rules;
  }
  async alerts(): Promise<PromAlert[]> {
    return [];
  }
}

const now = new Date("2026-10-24T08:00:00.000Z");

function lhsOf(rule: string): string {
  const found = repositoryRules().find((r) => r.name === rule);
  const cond = found ? splitAlertExpr(found.query) : null;
  if (!cond) throw new Error(`no condition for ${rule}`);
  return cond.lhs;
}

describe("splitAlertExpr", () => {
  it("splits each rule the console shows into the measured value and its threshold", () => {
    const rules = repositoryRules();
    const expected: Record<string, [string, number]> = {
      RailcarEventsDelayed: [">", 60],
      StreamBacklogHigh: [">", 5000],
      RailcarPositionsStale: [">", 300],
      IngestErrorRateHigh: [">", 0.05],
      QueryErrorRateHigh: [">", 0.05],
    };
    expect(SIGNALS.map((s) => s.rule).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, [op, threshold]] of Object.entries(expected)) {
      const rule = rules.find((r) => r.name === name);
      expect(rule, name).toBeDefined();
      const cond = splitAlertExpr(rule!.query);
      expect(cond, name).toEqual({ lhs: expect.any(String), comparison: op, threshold });
      // What is left is the measured expression, without the comparison.
      expect(cond!.lhs).not.toMatch(/>\s*[\d.]+\s*$/);
      expect(rule!.query.replace(/\s+/g, " ")).toContain(cond!.lhs.replace(/\s+/g, " "));
    }
  });

  it("splits the one-line form Prometheus serves", () => {
    expect(
      splitAlertExpr(
        'sum(rate(http_server_requests_total{job="ingest",route="/v1/events",status_code=~"5.."}[1m])) / sum(rate(http_server_requests_total{job="ingest",route="/v1/events"}[1m])) > 0.05',
      ),
    ).toEqual({
      lhs: 'sum(rate(http_server_requests_total{job="ingest",route="/v1/events",status_code=~"5.."}[1m])) / sum(rate(http_server_requests_total{job="ingest",route="/v1/events"}[1m]))',
      comparison: ">",
      threshold: 0.05,
    });
    expect(splitAlertExpr('up{job=~"ingest|tracker|query"} == 0')).toEqual({
      lhs: 'up{job=~"ingest|tracker|query"}',
      comparison: "==",
      threshold: 0,
    });
  });

  it("returns null for an expression with no comparison against a number", () => {
    expect(splitAlertExpr("sum(rate(tracker_events_failed_total[1m]))")).toBeNull();
    expect(splitAlertExpr("a > b")).toBeNull();
    expect(splitAlertExpr("(x > 5)")).toBeNull();
  });
});

describe("readStatus", () => {
  it("reports every scrape target as up or down", async () => {
    const prometheus = new FakePrometheus();
    prometheus.samples.set("up", [
      { metric: { job: "tracker", instance: "tracker:8080" }, value: 0 },
      { metric: { job: "ingest", instance: "ingest:8080" }, value: 1 },
      { metric: { job: "query", instance: "query:8080" }, value: 1 },
    ]);
    const status = await readStatus({ prometheus, deadLetters: { count: async () => 3 } }, now);
    expect(status.services).toEqual([
      { job: "ingest", up: true },
      { job: "query", up: true },
      { job: "tracker", up: false },
    ]);
    expect(status.dead_letters).toBe(3);
    expect(status.generated_at).toBe(now.toISOString());
    expect(status.errors).toEqual([]);
  });

  it("queries each rule's own expression and compares it with the rule's threshold", async () => {
    const prometheus = new FakePrometheus();
    prometheus.samples.set(lhsOf("RailcarEventsDelayed"), [{ metric: {}, value: 75.5 }]);
    prometheus.samples.set(lhsOf("StreamBacklogHigh"), [{ metric: {}, value: 1200 }]);
    prometheus.samples.set(lhsOf("RailcarPositionsStale"), [{ metric: {}, value: 0.4 }]);
    // No traffic: 0/0 is NaN in Prometheus, which the client turns into null.
    prometheus.samples.set(lhsOf("IngestErrorRateHigh"), [{ metric: {}, value: null }]);
    const status = await readStatus({ prometheus, deadLetters: { count: async () => 0 } }, now);

    const byRule = Object.fromEntries(status.signals.map((s) => [s.rule, s]));
    expect(byRule.RailcarEventsDelayed).toMatchObject({
      key: "oldest_unacked_age",
      unit: "seconds",
      value: 75.5,
      comparison: ">",
      threshold: 60,
      breaching: true,
      runbook_url: "https://github.com/muhammad-musa-ml/railcar-telemetry/blob/main/docs/runbooks/railcar-events-delayed.md",
    });
    expect(byRule.StreamBacklogHigh).toMatchObject({ value: 1200, threshold: 5000, breaching: false });
    expect(byRule.RailcarPositionsStale).toMatchObject({ value: 0.4, threshold: 300, breaching: false });
    expect(byRule.IngestErrorRateHigh).toMatchObject({ value: null, threshold: 0.05, breaching: false });
    // A query with no samples at all is "no data" too, not zero.
    expect(byRule.QueryErrorRateHigh).toMatchObject({ value: null, breaching: false });
    expect(prometheus.queries).toContain(lhsOf("QueryErrorRateHigh"));
  });

  it("takes the largest sample when an expression returns several series", async () => {
    const prometheus = new FakePrometheus();
    prometheus.samples.set(lhsOf("RailcarEventsDelayed"), [
      { metric: { group: "a" }, value: 2 },
      { metric: { group: "b" }, value: 90 },
    ]);
    const status = await readStatus({ prometheus, deadLetters: { count: async () => 0 } }, now);
    expect(status.signals.find((s) => s.rule === "RailcarEventsDelayed")).toMatchObject({ value: 90, breaching: true });
  });

  it("says which rule is missing instead of inventing an expression for it", async () => {
    const prometheus = new FakePrometheus();
    prometheus.rules = prometheus.rules.filter((r) => r.name !== "StreamBacklogHigh");
    const status = await readStatus({ prometheus, deadLetters: { count: async () => 0 } }, now);
    const backlog = status.signals.find((s) => s.rule === "StreamBacklogHigh");
    expect(backlog).toMatchObject({ value: null, threshold: null, breaching: false });
    expect(backlog?.error).toMatch(/not loaded/);
  });

  it("still answers when Prometheus and Redis are down, and says so", async () => {
    const prometheus = new FakePrometheus();
    prometheus.down = true;
    const status = await readStatus(
      {
        prometheus,
        deadLetters: {
          count: async () => {
            throw new Error("Connection is closed.");
          },
        },
      },
      now,
    );
    expect(status.services).toBeNull();
    expect(status.dead_letters).toBeNull();
    expect(status.signals).toHaveLength(SIGNALS.length);
    expect(status.signals.every((s) => s.value === null && s.error !== undefined)).toBe(true);
    expect(status.errors).toEqual([
      "prometheus: connect ECONNREFUSED",
      "redis: Connection is closed.",
    ]);
  });
});
