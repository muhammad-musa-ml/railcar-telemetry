import { describe, expect, it } from "vitest";
import { buildConsoleApp } from "../../src/console/app";
import { OperatorTokens } from "../../src/console/auth";
import { RateLimiter } from "../../src/console/rate-limit";
import { createRegistry } from "../../src/shared/metrics";
import {
  amAlert,
  deadLetter,
  FakeAlertmanager,
  FakeAudit,
  FakeDeadLetters,
  FakePager,
  FakePrometheus,
  FakeQuery,
} from "./console-fakes";

const TOKEN = "alice-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };
const now = new Date("2026-10-24T08:00:00.000Z");

const goodEvent = {
  event_id: "8d6f3a52-63a0-4bd4-8f43-1f2a5d3c9e11",
  car_id: "RCTX 100042",
  reader_id: "AEI-YD04-E",
  location: "YD04",
  observed_at: "2026-10-24T07:58:00.000Z",
};
// The event from docs/incidents/004-poison-event.md: a NUL in the location.
const poisonEvent = { ...goodEvent, location: "YD\u000004" };

function setup(limit = 100) {
  const deps = {
    prometheus: new FakePrometheus(),
    alertmanager: new FakeAlertmanager(),
    pager: new FakePager(),
    query: new FakeQuery(),
    deadLetters: new FakeDeadLetters(),
    audit: new FakeAudit(),
    operators: OperatorTokens.parse(`alice:${TOKEN}`),
    rateLimiter: new RateLimiter(limit, 60_000, () => now.getTime()),
    registry: createRegistry("console", false),
    now: () => now,
  };
  deps.deadLetters.entries = [
    deadLetter("1761292800000-0", JSON.stringify(poisonEvent)),
    deadLetter("1761292860000-0", JSON.stringify(goodEvent), "manual"),
  ];
  return { ...deps, app: buildConsoleApp(deps) };
}

describe("console actions: authorisation", () => {
  it("refuses an action without a token, and records the attempt", async () => {
    const { app, audit, deadLetters } = setup();
    const res = await app.inject({ method: "POST", url: "/api/dead-letters/1761292860000-0/replay", payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
    expect(deadLetters.replayed).toEqual([]);
    expect(audit.rows).toEqual([
      expect.objectContaining({ operator: null, action: "replay", target: "1761292860000-0", result: "unauthorized" }),
    ]);
  });

  it("refuses a wrong token, and records the attempt", async () => {
    const { app, audit, deadLetters } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/dead-letters/1761292860000-0/discard",
      headers: { authorization: "Bearer alice-token-012345678X" },
      payload: { reason: "testing" },
    });
    expect(res.statusCode).toBe(401);
    expect(deadLetters.entries).toHaveLength(2);
    expect(audit.rows.map((r) => [r.action, r.result, r.operator, r.reason])).toEqual([["discard", "unauthorized", null, "testing"]]);
  });

  it("acts on the right token and records the operator's name", async () => {
    const { app, audit } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/dead-letters/1761292860000-0/discard",
      headers: auth,
      payload: { reason: "duplicate of a read we already have" },
    });
    expect(res.statusCode).toBe(200);
    expect(audit.rows.map((r) => [r.result, r.operator])).toEqual([
      ["started", "alice"],
      ["ok", "alice"],
    ]);
  });

  it("never returns the token from a read endpoint", async () => {
    const { app, alertmanager } = setup();
    alertmanager.firing = [amAlert("ServiceDown", "critical", "0123456789abcdef")];
    for (const url of ["/api/status", "/api/alerts", "/api/pages", "/api/dead-letters", "/api/cars/RCTX%20100042", "/metrics", "/healthz"]) {
      const res = await app.inject({ method: "GET", url, headers: auth });
      expect(res.body, url).not.toContain(TOKEN);
      expect(JSON.stringify(res.headers), url).not.toContain(TOKEN);
    }
  });
});

describe("console actions: input validation", () => {
  it.each([
    ["a dead-letter id that is not a stream id", "/api/dead-letters/1-0;FLUSHALL/discard", { reason: "valid reason" }],
    ["a discard without a reason", "/api/dead-letters/1761292860000-0/discard", {}],
    ["a reason with control characters", "/api/dead-letters/1761292860000-0/discard", { reason: "bad\u0000reason" }],
    ["a reason that is too long", "/api/dead-letters/1761292860000-0/discard", { reason: "x".repeat(501) }],
    ["a reason of only spaces", "/api/dead-letters/1761292860000-0/discard", { reason: "    " }],
    ["a reason shorter than 3 characters", "/api/dead-letters/1761292860000-0/discard", { reason: "ok" }],
    ["a silence without a duration", "/api/alerts/0123456789abcdef/silence", { reason: "deploying" }],
    ["a silence longer than 12 hours", "/api/alerts/0123456789abcdef/silence", { reason: "deploying", minutes: 721 }],
    ["a silence of no time", "/api/alerts/0123456789abcdef/silence", { reason: "deploying", minutes: 0 }],
    ["a silence of part of a minute", "/api/alerts/0123456789abcdef/silence", { reason: "deploying", minutes: 1.5 }],
    ["an alert id that is not a fingerprint", "/api/alerts/ServiceDown/silence", { reason: "deploying", minutes: 30 }],
    ["a replay with a field it does not take", "/api/dead-letters/1761292860000-0/replay", { reason: "valid reason", force: true }],
    ["a discard with a field it does not take", "/api/dead-letters/1761292860000-0/discard", { reason: "valid reason", force: true }],
    ["a silence with a field it does not take", "/api/alerts/0123456789abcdef/silence", { reason: "deploying", minutes: 30, matchers: [] }],
    ["a body that is not JSON", "/api/dead-letters/1761292860000-0/discard", "reason=oops"],
  ])("refuses %s with 400 and records it", async (_case, url, payload) => {
    const { app, audit, deadLetters, alertmanager } = setup();
    const res = await app.inject({
      method: "POST",
      url,
      headers: { ...auth, "content-type": "application/json" },
      payload: typeof payload === "string" ? payload : JSON.stringify(payload),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues.length).toBeGreaterThan(0);
    expect(deadLetters.entries).toHaveLength(2);
    expect(alertmanager.silences).toEqual([]);
    expect(audit.rows).toEqual([expect.objectContaining({ operator: "alice", result: "invalid" })]);
    // What the caller sent reaches the audit row escaped and bounded.
    const row = audit.rows[0]!;
    for (const text of [row.target, row.reason ?? ""]) {
      expect(text).not.toMatch(/\p{Cc}/u);
      expect(text.length).toBeLessThanOrEqual(500);
    }
  });
});

describe("console actions: replay", () => {
  it("re-validates against the current schema and refuses an event that would fail again", async () => {
    const { app, audit, deadLetters } = setup();
    const res = await app.inject({ method: "POST", url: "/api/dead-letters/1761292800000-0/replay", headers: auth, payload: {} });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      error: "this event fails the current event schema, so it would be dead-lettered again",
      issues: [{ path: "location", message: "must not contain control characters" }],
    });
    // Still dead-lettered, nothing written to the event stream.
    expect(deadLetters.entries.map((e) => e.id)).toContain("1761292800000-0");
    expect(deadLetters.replayed).toEqual([]);
    expect(audit.rows.map((r) => r.result)).toEqual(["started", "refused"]);
    expect(audit.rows[1]?.detail).toMatchObject({ issues: [{ path: "location", message: "must not contain control characters" }] });
  });

  it("refuses an entry that is not JSON at all", async () => {
    const { app, deadLetters } = setup();
    deadLetters.entries.push(deadLetter("1761292900000-0", "{not json"));
    const res = await app.inject({ method: "POST", url: "/api/dead-letters/1761292900000-0/replay", headers: auth, payload: {} });
    expect(res.statusCode).toBe(422);
    expect(res.json().issues).toEqual([{ path: "", message: "the stored event is not valid JSON" }]);
  });

  it("puts a valid event back into railcar:events unchanged and removes the dead-letter entry", async () => {
    const { app, audit, deadLetters } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/dead-letters/1761292860000-0/replay",
      headers: auth,
      payload: { reason: "parked by hand during the drill" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ replayed: "1761292860000-0", stream_id: "1761300000000-0" });
    expect(deadLetters.replayed.map((r) => r.event)).toEqual([JSON.stringify(goodEvent)]);
    expect(deadLetters.entries.map((e) => e.id)).toEqual(["1761292800000-0"]);
    expect(audit.rows.map((r) => [r.action, r.target, r.result, r.reason])).toEqual([
      ["replay", "1761292860000-0", "started", "parked by hand during the drill"],
      ["replay", "1761292860000-0", "ok", "parked by hand during the drill"],
    ]);
    expect(audit.rows[1]?.detail).toMatchObject({ stream_id: "1761300000000-0", dead_letter_reason: "manual" });
  });

  it("answers 404 for an entry that is gone, for example replayed by someone else", async () => {
    const { app, audit } = setup();
    const res = await app.inject({ method: "POST", url: "/api/dead-letters/1761292999999-0/replay", headers: auth, payload: {} });
    expect(res.statusCode).toBe(404);
    expect(audit.rows.map((r) => r.result)).toEqual(["started", "not_found"]);
  });

  it("does not act when the audit row cannot be written first", async () => {
    const { app, audit, deadLetters } = setup();
    audit.down = true;
    const res = await app.inject({ method: "POST", url: "/api/dead-letters/1761292860000-0/replay", headers: auth, payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/audit/);
    expect(deadLetters.replayed).toEqual([]);
    expect(deadLetters.entries).toHaveLength(2);
  });

  it("answers 502 and records a failure when Redis is down", async () => {
    const { app, audit, deadLetters } = setup();
    deadLetters.down = true;
    const res = await app.inject({ method: "POST", url: "/api/dead-letters/1761292860000-0/replay", headers: auth, payload: {} });
    expect(res.statusCode).toBe(502);
    expect(audit.rows.map((r) => r.result)).toEqual(["started", "failed"]);
  });
});

describe("console actions: discard", () => {
  it("removes the entry and keeps a copy of it in the audit record", async () => {
    const { app, audit, deadLetters } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/dead-letters/1761292800000-0/discard",
      headers: auth,
      payload: { reason: "poison event from the drill" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ discarded: "1761292800000-0" });
    expect(deadLetters.entries.map((e) => e.id)).toEqual(["1761292860000-0"]);
    const done = audit.rows[1]!;
    expect(done).toMatchObject({ result: "ok", reason: "poison event from the drill" });
    // Escaped, because Postgres cannot store the NUL itself.
    expect(JSON.stringify(done.detail)).toContain("\\\\u0000");
    expect(JSON.stringify(done.detail)).not.toContain("\u0000");
    expect(done.detail).toMatchObject({ entry: { source_id: "1761292800000-7", reason: expect.stringContaining("control characters") } });
  });
});

describe("console actions: silence", () => {
  it("silences exactly one firing alert for the requested time", async () => {
    const { app, audit, alertmanager } = setup();
    alertmanager.firing = [amAlert("ServiceDown", "critical", "0123456789abcdef")];
    const res = await app.inject({
      method: "POST",
      url: "/api/alerts/0123456789abcdef/silence",
      headers: auth,
      payload: { reason: "tracker redeploy", minutes: 30 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ silence_id: "silence-1", ends_at: "2026-10-24T08:30:00.000Z" });
    expect(alertmanager.silences).toEqual([
      {
        matchers: [
          { name: "alertname", value: "ServiceDown", isRegex: false, isEqual: true },
          { name: "job", value: "tracker", isRegex: false, isEqual: true },
          { name: "severity", value: "critical", isRegex: false, isEqual: true },
        ],
        startsAt: "2026-10-24T08:00:00.000Z",
        endsAt: "2026-10-24T08:30:00.000Z",
        createdBy: "alice",
        comment: "tracker redeploy",
      },
    ]);
    expect(audit.rows.map((r) => [r.action, r.target, r.result])).toEqual([
      ["silence", "0123456789abcdef", "started"],
      ["silence", "0123456789abcdef", "ok"],
    ]);
  });

  it("refuses an alert that is already silenced, and one that is not firing", async () => {
    const { app, alertmanager } = setup();
    alertmanager.firing = [
      amAlert("ServiceDown", "critical", "0123456789abcdef", { status: { state: "suppressed", silencedBy: ["x"], inhibitedBy: [] } }),
    ];
    const silenced = await app.inject({
      method: "POST",
      url: "/api/alerts/0123456789abcdef/silence",
      headers: auth,
      payload: { reason: "again", minutes: 30 },
    });
    expect(silenced.statusCode).toBe(409);
    const missing = await app.inject({
      method: "POST",
      url: "/api/alerts/fedcba9876543210/silence",
      headers: auth,
      payload: { reason: "gone", minutes: 30 },
    });
    expect(missing.statusCode).toBe(404);
    expect(alertmanager.silences).toEqual([]);
  });
});

describe("console actions: rate limit", () => {
  it("refuses attempts over the limit with 429, before checking the token, and records them", async () => {
    const { app, audit } = setup(2);
    const attempt = () =>
      app.inject({ method: "POST", url: "/api/dead-letters/1761292999999-0/discard", headers: { authorization: "Bearer guess" }, payload: { reason: "x1y" } });
    expect((await attempt()).statusCode).toBe(401);
    expect((await attempt()).statusCode).toBe(401);
    const limited = await attempt();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(audit.rows.map((r) => r.result)).toEqual(["unauthorized", "unauthorized", "rate_limited"]);
  });

  it("does not limit reads", async () => {
    const { app } = setup(1);
    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: "GET", url: "/api/dead-letters" })).statusCode).toBe(200);
    }
  });
});

describe("console actions: metrics", () => {
  it("counts actions by result", async () => {
    const { app, registry } = setup();
    await app.inject({ method: "POST", url: "/api/dead-letters/1761292800000-0/replay", headers: auth, payload: {} });
    await app.inject({ method: "POST", url: "/api/dead-letters/1761292800000-0/replay", payload: {} });
    const text = await registry.metrics();
    expect(text).toContain('console_actions_total{action="replay",result="refused",service="console"} 1');
    expect(text).toContain('console_actions_total{action="replay",result="unauthorized",service="console"} 1');
  });
});
