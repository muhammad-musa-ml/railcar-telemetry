// The console's audit trail: one row per action attempt in the Postgres
// table console_audit (db/migrations/001_console_audit.sql), which refuses
// UPDATE, DELETE and TRUNCATE. This module only ever inserts.

export type AuditAction = "replay" | "discard" | "silence";

export type AuditResult =
  // Written before an action is carried out; the outcome follows in a second
  // row with the same request id.
  | "started"
  | "ok"
  | "refused"
  | "not_found"
  | "failed"
  // Attempts stopped before anything was tried.
  | "unauthorized"
  | "invalid"
  | "rate_limited";

export interface AuditEntry {
  requestId: string;
  // null when no valid token was presented.
  operator: string | null;
  client: string;
  action: AuditAction;
  target: string;
  reason: string | null;
  result: AuditResult;
  detail: Record<string, unknown>;
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

export const INSERT_AUDIT_SQL =
  "INSERT INTO console_audit (request_id, operator, client, action, target, reason, result, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)";

// Postgres refuses NUL in text and in jsonb, and the events this table has
// to describe include exactly that (docs/incidents/004-poison-event.md).
// Control characters are therefore stored as visible \uXXXX escapes.
export function escapeControl(text: string): string {
  return text.replace(/\p{Cc}/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function escapeDeep(value: unknown): unknown {
  if (typeof value === "string") return escapeControl(value);
  if (Array.isArray(value)) return value.map(escapeDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [escapeControl(k), escapeDeep(v)]));
  }
  return value;
}

// Text that came from the caller and failed validation: escaped and cut to
// a bounded length before it is stored.
export function auditText(value: unknown, max = 200): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return escapeControl(text).slice(0, max);
}

export interface Queryable {
  query(sql: string, params: unknown[]): Promise<unknown>;
}

export class PgAuditLog implements AuditLog {
  constructor(private readonly pool: Queryable) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.pool.query(INSERT_AUDIT_SQL, [
      entry.requestId,
      entry.operator === null ? null : escapeControl(entry.operator),
      escapeControl(entry.client),
      entry.action,
      escapeControl(entry.target),
      entry.reason === null ? null : escapeControl(entry.reason),
      entry.result,
      JSON.stringify(escapeDeep(entry.detail)),
    ]);
  }
}
