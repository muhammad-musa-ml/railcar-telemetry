import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AlertsResponse, StatusResponse } from "../../src/console/api-types";
import { compose, consoleOperator, eventually, getJson, psql, read, redisCli, testCarId, urls } from "./helpers";

const DEAD = "railcar:events:dead";

// Marks this run's rows in console_audit.
const marker = `itest-${randomUUID().slice(0, 8)}`;

async function action(path: string, body: object, token: string | null = consoleOperator.token) {
  const res = await fetch(`${urls.console}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// Parks an event in the dead-letter stream the way the runbook's manual
// step does, and returns its id there.
async function deadLetter(event: string): Promise<string> {
  const [id] = await redisCli("XADD", DEAD, "*", "source_id", "0-1", "reason", "manual", "event", event);
  if (!id) throw new Error("XADD returned no id");
  return id;
}

async function isDeadLettered(id: string): Promise<boolean> {
  return (await redisCli("XRANGE", DEAD, id, id)).length > 0;
}

// Ids in the tests below are stream ids or generated words: no quoting needed.
async function auditRows(target: string) {
  const out = await psql(
    `SELECT coalesce(operator, '-'), action, target, coalesce(reason, ''), result, coalesce(detail->>'token', '') ` +
      `FROM console_audit WHERE target = '${target}' ORDER BY id`,
  );
  return out === ""
    ? []
    : out.split("\n").map((line) => {
        const [operator, act, tgt, reason, result, token] = line.split("|");
        return { operator, action: act, target: tgt, reason, result, token };
      });
}

async function trackerUp(): Promise<boolean | undefined> {
  const { body } = await getJson<StatusResponse>(`${urls.console}/api/status`);
  return body.services?.find((s) => s.job === "tracker")?.up;
}

describe("console against the running stack", () => {
  it("serves the page and the API on one port", async () => {
    const page = await fetch(`${urls.console}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await page.text()).toContain("<title>Railcar console</title>");
    const { status, body } = await getJson<StatusResponse>(`${urls.console}/api/status`);
    expect(status).toBe(200);
    expect(body.signals.map((s) => s.rule)).toEqual([
      "RailcarEventsDelayed",
      "StreamBacklogHigh",
      "RailcarPositionsStale",
      "IngestErrorRateHigh",
      "QueryErrorRateHigh",
    ]);
    expect(body.signals.filter((s) => s.error)).toEqual([]);
  });

  it("replays a valid dead-lettered event, whose position then appears through the query API", async () => {
    const carId = testCarId();
    const id = await deadLetter(JSON.stringify(read(carId, "YD06", new Date())));
    const res = await action(`/api/dead-letters/${id}/replay`, { reason: `${marker} replay` });
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(id);
    expect(await isDeadLettered(id)).toBe(false);

    const car = await eventually(async () => {
      const { status, body } = await getJson<{ location: string }>(`${urls.console}/api/cars/${encodeURIComponent(carId)}`);
      return status === 200 ? body : undefined;
    });
    expect(car.location).toBe("YD06");
    const direct = await getJson<{ location: string }>(`${urls.query}/v1/cars/${encodeURIComponent(carId)}`);
    expect(direct.body.location).toBe("YD06");

    expect((await auditRows(id)).map((r) => [r.operator, r.action, r.reason, r.result])).toEqual([
      [consoleOperator.name, "replay", `${marker} replay`, "started"],
      [consoleOperator.name, "replay", `${marker} replay`, "ok"],
    ]);
  });

  it("refuses to replay an event that would fail again, and leaves it dead-lettered", async () => {
    // The event from docs/incidents/004-poison-event.md: a NUL in the location.
    const poison = { ...read(testCarId(), "YD04", new Date()), location: "YD04\u0000" };
    const id = await deadLetter(JSON.stringify(poison));
    const res = await action(`/api/dead-letters/${id}/replay`, {});
    expect(res.status).toBe(422);
    expect(res.body.issues).toEqual([{ path: "location", message: "must not contain control characters" }]);
    expect(await isDeadLettered(id)).toBe(true);
    expect((await auditRows(id)).map((r) => r.result)).toEqual(["started", "refused"]);

    // Discarding it takes a reason, and the audit row keeps the event.
    const discarded = await action(`/api/dead-letters/${id}/discard`, { reason: `${marker} poison` });
    expect(discarded.status).toBe(200);
    expect(await isDeadLettered(id)).toBe(false);
    const kept = await psql(`SELECT detail->'entry'->>'event' FROM console_audit WHERE target = '${id}' AND action = 'discard' AND result = 'ok'`);
    // The stored text holds the JSON escape for the NUL, never the NUL itself.
    expect(kept).toContain('"location":"YD04\\u0000"');
    expect(kept).not.toContain("\u0000");
  });

  it("silences one firing alert in Alertmanager, with the operator and the reason", async () => {
    const name = `ConsoleSilenceCheck${randomUUID().slice(0, 8)}`;
    const labels = { alertname: name, severity: "warning", job: "console-check" };
    const post = (endsAt: Date) =>
      fetch(`${urls.alertmanager}/api/v2/alerts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          { labels, annotations: { summary: "silence check", runbook_url: "https://example.org/runbook.md" }, endsAt: endsAt.toISOString() },
        ]),
      });
    expect((await post(new Date(Date.now() + 10 * 60_000))).status).toBe(200);

    let silenceId = "";
    try {
      const alert = await eventually(async () => {
        const { body } = await getJson<AlertsResponse>(`${urls.console}/api/alerts`);
        return body.alerts.find((a) => a.name === name);
      });
      expect(alert).toMatchObject({ state: "firing", severity: "warning", silenced: false, runbook_url: "https://example.org/runbook.md" });

      const res = await action(`/api/alerts/${alert.fingerprint}/silence`, { reason: `${marker} silence`, minutes: 5 });
      expect(res.status).toBe(200);
      silenceId = String(res.body.silence_id);

      const { body: silence } = await getJson<{
        status: { state: string };
        createdBy: string;
        comment: string;
        matchers: { name: string; value: string; isRegex: boolean; isEqual: boolean }[];
      }>(`${urls.alertmanager}/api/v2/silence/${silenceId}`);
      expect(silence.status.state).toBe("active");
      expect(silence.createdBy).toBe(consoleOperator.name);
      expect(silence.comment).toBe(`${marker} silence`);
      expect(silence.matchers).toEqual(
        Object.entries(labels)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([n, value]) => ({ name: n, value, isRegex: false, isEqual: true })),
      );

      await eventually(async () => {
        const { body } = await getJson<AlertsResponse>(`${urls.console}/api/alerts`);
        return body.alerts.find((a) => a.name === name)?.silenced ? true : undefined;
      });
    } finally {
      if (silenceId) await fetch(`${urls.alertmanager}/api/v2/silence/${silenceId}`, { method: "DELETE" });
      await post(new Date());
    }
  });

  it("refuses an action without a token or with a wrong one, and records both attempts", async () => {
    const target = `${Date.now()}-0`;
    const none = await action(`/api/dead-letters/${target}/discard`, { reason: `${marker} no token` }, null);
    expect(none.status).toBe(401);
    const wrong = await action(`/api/dead-letters/${target}/discard`, { reason: `${marker} wrong token` }, "not-the-operator-token");
    expect(wrong.status).toBe(401);

    expect(await auditRows(target)).toEqual([
      { operator: "-", action: "discard", target, reason: `${marker} no token`, result: "unauthorized", token: "none" },
      { operator: "-", action: "discard", target, reason: `${marker} wrong token`, result: "unauthorized", token: "not accepted" },
    ]);
  });

  it("keeps the audit trail append-only, for the table owner and for the console's own role", async () => {
    // Make sure there is a row to try to change.
    const target = `${Date.now()}-1`;
    expect((await action(`/api/dead-letters/${target}/replay`, {}, null)).status).toBe(401);
    const [row] = await auditRows(target);
    expect(row?.result).toBe("unauthorized");
    const id = await psql(`SELECT id FROM console_audit WHERE target = '${target}'`);
    const before = await psql("SELECT count(*), max(id), md5(string_agg(reason, ',' ORDER BY id)) FROM console_audit");

    for (const sql of [
      `UPDATE console_audit SET reason = 'changed' WHERE id = ${id}`,
      `DELETE FROM console_audit WHERE id = ${id}`,
      "TRUNCATE console_audit",
    ]) {
      await expect(psql(sql, "railcar"), sql).rejects.toThrow(/console_audit is append-only/);
      await expect(psql(sql, "railcar_console"), sql).rejects.toThrow(/permission denied for table console_audit/);
    }
    expect(await psql("SELECT count(*), max(id), md5(string_agg(reason, ',' ORDER BY id)) FROM console_audit")).toBe(before);
  });

  // Last, because it stops a service the other tests need.
  it("reports the tracker down after `docker compose stop tracker`", async () => {
    expect(await trackerUp()).toBe(true);
    try {
      await compose("stop", "tracker");
      const down = await eventually(async () => {
        const { body } = await getJson<StatusResponse>(`${urls.console}/api/status`);
        return body.services?.find((s) => s.job === "tracker")?.up === false ? body : undefined;
      }, 60_000, 1000);
      expect(down.services?.find((s) => s.job === "ingest")?.up).toBe(true);
    } finally {
      await compose("start", "tracker");
    }
    await eventually(async () => ((await trackerUp()) ? true : undefined), 90_000, 1000);
  }, 240_000);
});
