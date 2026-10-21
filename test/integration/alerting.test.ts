import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PageRecord } from "../../src/pager/app";
import { eventually, getJson, promQuery, urls } from "./helpers";

describe("alerting", () => {
  it("loads every alert rule into Prometheus", async () => {
    const { body } = await getJson<{ data: { groups: { rules: { name: string; health: string }[] }[] } }>(
      `${urls.prometheus}/api/v1/rules?type=alert`,
    );
    const rules = body.data.groups.flatMap((g) => g.rules);
    expect(rules.length).toBeGreaterThanOrEqual(8);
    expect(rules.filter((r) => r.health !== "ok")).toEqual([]);
  });

  it("has no alert firing on a healthy stack", async () => {
    expect(await promQuery('ALERTS{alertstate="firing"}')).toEqual([]);
  });

  it("routes critical alerts to the page receiver and warnings to the ticket receiver", async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const name = `RoutingCheck${randomUUID().slice(0, 8)}`;
    const endsAt = new Date(Date.now() + 60_000).toISOString();
    const res = await fetch(`${urls.alertmanager}/api/v2/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { labels: { alertname: name, severity: "critical", job: "check" }, annotations: { summary: "routing check" }, endsAt },
        { labels: { alertname: name, severity: "warning", job: "check-warn" }, annotations: { summary: "routing check" }, endsAt },
      ]),
    });
    expect(res.status).toBe(200);

    const pages = await eventually(async () => {
      const { body } = await getJson<{ pages: PageRecord[] }>(`${urls.pager}/v1/pages?since=${since}`);
      const mine = body.pages.filter((p) => p.alertname === name);
      return mine.length >= 2 ? mine : undefined;
    }, 60_000, 1000);

    const bySeverity = Object.fromEntries(pages.map((p) => [p.severity, p.receiver]));
    expect(bySeverity).toEqual({ critical: "page", warning: "ticket" });
    for (const p of pages) {
      expect(p.status).toBe("firing");
      expect(Date.parse(p.received_at)).not.toBeNaN();
    }
  });
});
