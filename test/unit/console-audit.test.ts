import { describe, expect, it } from "vitest";
import { auditText, INSERT_AUDIT_SQL, PgAuditLog, type AuditEntry } from "../../src/console/audit";

class FakePool {
  calls: { sql: string; params: unknown[] }[] = [];
  async query(sql: string, params: unknown[]) {
    this.calls.push({ sql, params });
    return { rowCount: 1 };
  }
}

const entry: AuditEntry = {
  requestId: "6f1d1c9e-3c35-4a35-9b8e-2f0c1f9a4b10",
  operator: "alice",
  client: "172.18.0.1",
  action: "discard",
  target: "1761292800000-0",
  reason: "bad reader firmware",
  result: "ok",
  detail: { entry: { source_id: "1761292799000-0", event: '{"location":"YD\\u000001"}' } },
};

describe("audit log", () => {
  it("inserts one row with every field in its column", async () => {
    const pool = new FakePool();
    await new PgAuditLog(pool).record(entry);
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]?.sql).toBe(INSERT_AUDIT_SQL);
    expect(INSERT_AUDIT_SQL).toMatch(/^INSERT INTO console_audit \(request_id, operator, client, action, target, reason, result, detail\)/);
    expect(pool.calls[0]?.params).toEqual([
      entry.requestId,
      "alice",
      "172.18.0.1",
      "discard",
      "1761292800000-0",
      "bad reader firmware",
      "ok",
      JSON.stringify(entry.detail),
    ]);
  });

  it("only ever inserts: the statement can change nothing already written", () => {
    expect(INSERT_AUDIT_SQL).not.toMatch(/\b(UPDATE|DELETE|ON CONFLICT|TRUNCATE)\b/i);
  });

  it("stores control characters as visible escapes, because Postgres text and jsonb refuse NUL", async () => {
    const pool = new FakePool();
    await new PgAuditLog(pool).record({
      ...entry,
      target: "1-0\u0000",
      reason: null,
      detail: { event: "YD\u0000\u001b01", nested: ["\u0007"] },
    });
    const params = pool.calls[0]!.params;
    expect(params[4]).toBe("1-0\\u0000");
    expect(params[5]).toBeNull();
    expect(params[7]).toBe(JSON.stringify({ event: "YD\\u0000\\u001b01", nested: ["\\u0007"] }));
    expect(String(params[7])).not.toContain("\u0000");
  });

  it("cuts untrusted text to a bounded length", () => {
    expect(auditText("x".repeat(500))).toHaveLength(200);
    expect(auditText(undefined)).toBe("");
    expect(auditText({ id: 1 })).toBe('{"id":1}');
  });
});
