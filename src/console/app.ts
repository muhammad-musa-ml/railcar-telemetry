import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { Counter, type Registry } from "prom-client";
import { z } from "zod";
import { CAR_ID_PATTERN, locationEventSchema } from "../shared/event";
import type { Logger } from "../shared/logger";
import { instrumentHttp } from "../shared/metrics";
import { injectTraceContext } from "../shared/trace-context";
import type { AlertsResponse, ConsoleAlert, DeadLettersResponse, PagesResponse } from "./api-types";
import { auditText, type AuditAction, type AuditEntry, type AuditLog, type AuditResult } from "./audit";
import { bearerToken, type OperatorTokens } from "./auth";
import { checkReplayable, type DeadLetterStore } from "./dead-letters";
import type { RateLimiter } from "./rate-limit";
import { readStatus } from "./status";
import { UpstreamError, type AlertmanagerApi, type PagerApi, type PrometheusApi, type QueryApi } from "./upstreams";

export interface ConsoleDeps {
  prometheus: PrometheusApi;
  alertmanager: AlertmanagerApi;
  pager: PagerApi;
  query: QueryApi;
  deadLetters: DeadLetterStore;
  audit: AuditLog;
  operators: OperatorTokens;
  rateLimiter: RateLimiter;
  registry: Registry;
  logger?: Logger;
  now?: () => Date;
}

const PAGES_WINDOW_MS = 24 * 3600 * 1000;

const limitSchema = (fallback: number, max: number) => z.coerce.number().int().min(1).max(max).default(fallback);

const carParams = z.object({ carId: z.string().regex(CAR_ID_PATTERN, "car id must look like 'RCTX 104233'") });
const locationParams = z.object({ location: locationEventSchema.shape.location });

// --- action inputs ----------------------------------------------------------

const NO_CONTROL_CHARACTERS = /^[^\p{Cc}]*$/u;
export const MAX_SILENCE_MINUTES = 12 * 60;

const deadLetterId = z.string().regex(/^\d{1,20}-\d{1,20}$/, "must be a stream id such as 1761292800000-0");
const reasonText = z
  .string()
  .trim()
  .min(3, "give a reason of at least 3 characters")
  .max(500)
  .regex(NO_CONTROL_CHARACTERS, "must not contain control characters");

const replayInput = z.object({
  params: z.object({ id: deadLetterId }),
  body: z.object({ reason: reasonText.optional() }).strict(),
});
const discardInput = z.object({
  params: z.object({ id: deadLetterId }),
  body: z.object({ reason: reasonText }).strict(),
});
const silenceInput = z.object({
  params: z.object({ fingerprint: z.string().regex(/^[0-9a-f]{16}$/, "must be an Alertmanager fingerprint") }),
  body: z
    .object({
      reason: reasonText,
      minutes: z.number().int().min(1).max(MAX_SILENCE_MINUTES, `a silence may last at most ${MAX_SILENCE_MINUTES} minutes`),
    })
    .strict(),
});

interface Outcome {
  status: number;
  body: unknown;
  result: AuditResult;
  detail?: Record<string, unknown>;
}

interface ActionSpec<S extends z.ZodType<{ params: object; body: { reason?: string } }>> {
  action: AuditAction;
  target: (params: Record<string, string>) => string;
  input: S;
  perform: (input: z.infer<S>, operator: string) => Promise<Outcome>;
}

// Action bodies are read as text and parsed inside the handler, so that a
// body that is not JSON is refused and recorded like any other invalid
// input, instead of being turned away by Fastify before the audit sees it.
function parseBody(raw: unknown): { ok: true; value: unknown } | { ok: false } {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: {} };
  if (typeof raw !== "string") return { ok: true, value: raw };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

function rawReason(body: unknown): string | null {
  const reason = (body as { reason?: unknown } | null)?.reason;
  return reason === undefined ? null : auditText(reason, 500);
}

function issuesOf(error: z.ZodError) {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

function badRequest(reply: FastifyReply, message: string, error: z.ZodError) {
  return reply.code(400).send({ error: message, issues: issuesOf(error) });
}

function upstreamFailure(reply: FastifyReply, err: unknown, upstream: string) {
  const text = err instanceof Error ? err.message : String(err);
  const named = err instanceof UpstreamError || text.startsWith(`${upstream}:`) ? text : `${upstream}: ${text}`;
  return reply.code(502).send({ error: named });
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1 };

function compareAlerts(a: ConsoleAlert, b: ConsoleAlert): number {
  return (
    Number(a.state === "pending") - Number(b.state === "pending") ||
    (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2) ||
    a.since.localeCompare(b.since) ||
    a.name.localeCompare(b.name)
  );
}

export function buildConsoleApp(deps: ConsoleDeps): FastifyInstance {
  const now = deps.now ?? (() => new Date());
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  instrumentHttp(app, deps.registry);

  // The page and its scripts come from this service only, and nothing may
  // frame it. API answers change every few seconds and are never cached.
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header(
      "content-security-policy",
      "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    if (request.url.startsWith("/api/")) {
      reply.header("cache-control", "no-store");
    }
    return payload;
  });

  app.get("/api/status", async () => readStatus({ prometheus: deps.prometheus, deadLetters: deps.deadLetters }, now()));

  app.get("/api/alerts", async (): Promise<AlertsResponse> => {
    const errors: string[] = [];
    const [firing, pending] = await Promise.all([
      deps.alertmanager.alerts().catch((err: unknown) => {
        errors.push(err instanceof Error ? err.message : String(err));
        return [];
      }),
      deps.prometheus.alerts().catch((err: unknown) => {
        errors.push(err instanceof Error ? err.message : String(err));
        return [];
      }),
    ]);
    const alerts: ConsoleAlert[] = [
      ...firing.map(
        (a): ConsoleAlert => ({
          fingerprint: a.fingerprint,
          name: a.labels.alertname ?? "unknown",
          state: "firing",
          silenced: a.status.silencedBy.length > 0,
          severity: a.labels.severity ?? "none",
          summary: a.annotations.summary ?? "",
          runbook_url: a.annotations.runbook_url ?? null,
          since: a.startsAt,
          labels: a.labels,
        }),
      ),
      // Alertmanager only knows alerts that fire; pending ones are still
      // waiting out their `for` window in Prometheus.
      ...pending
        .filter((a) => a.state === "pending")
        .map(
          (a): ConsoleAlert => ({
            fingerprint: null,
            name: a.labels.alertname ?? "unknown",
            state: "pending",
            silenced: false,
            severity: a.labels.severity ?? "none",
            summary: a.annotations.summary ?? "",
            runbook_url: a.annotations.runbook_url ?? null,
            since: a.activeAt,
            labels: a.labels,
          }),
        ),
    ];
    return { alerts: alerts.sort(compareAlerts), errors };
  });

  app.get<{ Querystring: { limit?: string } }>("/api/pages", async (request, reply) => {
    const limit = limitSchema(20, 200).safeParse(request.query.limit);
    if (!limit.success) return badRequest(reply, "invalid limit", limit.error);
    try {
      const records = await deps.pager.pagesSince(new Date(now().getTime() - PAGES_WINDOW_MS));
      const pages = records
        .slice()
        .sort((a, b) => b.received_at.localeCompare(a.received_at))
        .slice(0, limit.data)
        .map(({ received_at, receiver, status, alertname, severity, summary, runbook_url }) => ({
          received_at,
          receiver,
          status,
          alertname,
          severity,
          summary,
          runbook_url,
        }));
      return { pages } satisfies PagesResponse;
    } catch (err) {
      return upstreamFailure(reply, err, "pager");
    }
  });

  app.get<{ Querystring: { limit?: string } }>("/api/dead-letters", async (request, reply) => {
    const limit = limitSchema(100, 500).safeParse(request.query.limit);
    if (!limit.success) return badRequest(reply, "invalid limit", limit.error);
    try {
      const [count, entries] = await Promise.all([deps.deadLetters.count(), deps.deadLetters.list(limit.data)]);
      return { count, entries } satisfies DeadLettersResponse;
    } catch (err) {
      return upstreamFailure(reply, err, "redis");
    }
  });

  // Lookups are passed to the query service, which already answers 400, 404
  // and 503 the way the browser needs.
  app.get<{ Params: { carId: string } }>("/api/cars/:carId", async (request, reply) => {
    const params = carParams.safeParse(request.params);
    if (!params.success) return badRequest(reply, "invalid car id", params.error);
    try {
      const { status, body } = await deps.query.get(`/v1/cars/${encodeURIComponent(params.data.carId)}`);
      return reply.code(status).send(body);
    } catch (err) {
      return upstreamFailure(reply, err, "query");
    }
  });

  app.get<{ Params: { location: string }; Querystring: { limit?: string } }>(
    "/api/locations/:location/cars",
    async (request, reply) => {
      const params = locationParams.safeParse(request.params);
      if (!params.success) return badRequest(reply, "invalid location", params.error);
      const limit = limitSchema(100, 500).safeParse(request.query.limit);
      if (!limit.success) return badRequest(reply, "invalid limit", limit.error);
      try {
        const path = `/v1/locations/${encodeURIComponent(params.data.location)}/cars?limit=${limit.data}`;
        const { status, body } = await deps.query.get(path);
        return reply.code(status).send(body);
      } catch (err) {
        return upstreamFailure(reply, err, "query");
      }
    },
  );

  registerActions(app, deps, now);

  app.get("/healthz", async () => ({ status: "ok" }));

  return app;
}

// --- actions ------------------------------------------------------------------

function registerActions(app: FastifyInstance, deps: ConsoleDeps, now: () => Date): void {
  const actions = new Counter({
    name: "console_actions_total",
    help: "Operator actions attempted through the console, by action and result",
    labelNames: ["action", "result"],
    registers: [deps.registry],
  });
  const auditFailures = new Counter({
    name: "console_audit_write_failures_total",
    help: "Audit rows the console could not write to Postgres",
    registers: [deps.registry],
  });

  // Rows for attempts that were stopped before anything happened. If one
  // cannot be written the attempt is still refused; the failure is logged
  // and counted.
  async function record(entry: AuditEntry): Promise<boolean> {
    try {
      await deps.audit.record(entry);
      return true;
    } catch (err) {
      auditFailures.inc();
      deps.logger?.error({ err, request_id: entry.requestId, result: entry.result }, "could not write the audit row");
      return false;
    }
  }

  function route<S extends z.ZodType<{ params: object; body: { reason?: string } }>>(url: string, spec: ActionSpec<S>) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const params = request.params as Record<string, string>;
      const body = parseBody(request.body);
      const base = {
        requestId: randomUUID(),
        client: request.ip,
        action: spec.action,
        target: auditText(spec.target(params)),
        reason: body.ok ? rawReason(body.value) : null,
      };
      const finish = (result: AuditResult) => actions.inc({ action: spec.action, result });

      // 1. Rate limit, before the token is even looked at, so guessing
      //    tokens is as slow as everything else.
      const decision = deps.rateLimiter.take(request.ip);
      if (!decision.allowed) {
        await record({ ...base, operator: null, result: "rate_limited", detail: { route: url } });
        finish("rate_limited");
        return reply
          .code(429)
          .header("retry-after", String(decision.retryAfterSeconds))
          .send({ error: `too many actions from this client; try again in ${decision.retryAfterSeconds} s` });
      }

      // 2. Operator token.
      const operator = deps.operators.identify(bearerToken(request.headers.authorization));
      if (operator === null) {
        const presented = request.headers.authorization === undefined ? "none" : "not accepted";
        await record({ ...base, operator: null, result: "unauthorized", detail: { route: url, token: presented } });
        finish("unauthorized");
        return reply
          .code(401)
          .header("www-authenticate", "Bearer")
          .send({ error: "this action needs an operator token: Authorization: Bearer <token>" });
      }

      // 3. Input.
      let input: z.infer<S> | null = null;
      let issues = [{ path: "body", message: "the body is not valid JSON" }];
      if (body.ok) {
        const parsed = spec.input.safeParse({ params, body: body.value });
        if (parsed.success) input = parsed.data;
        else issues = issuesOf(parsed.error);
      }
      if (input === null) {
        await record({ ...base, operator, result: "invalid", detail: { route: url, issues } });
        finish("invalid");
        return reply.code(400).send({ error: "invalid input", issues });
      }
      const reason = input.body.reason ?? null;

      // 4. Write-ahead audit row. No row, no action.
      try {
        await deps.audit.record({ ...base, operator, reason, result: "started", detail: { route: url } });
      } catch (err) {
        auditFailures.inc();
        deps.logger?.error({ err, request_id: base.requestId }, "audit log unavailable; action not carried out");
        finish("failed");
        return reply.code(503).send({ error: "the audit log is unavailable, so the action was not carried out" });
      }

      // 5. The action, and the row with its outcome.
      let outcome: Outcome;
      try {
        outcome = await spec.perform(input, operator);
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        deps.logger?.error({ err, request_id: base.requestId }, `${spec.action} failed`);
        outcome = { status: 502, body: { error: text }, result: "failed", detail: { error: text } };
      }
      await record({ ...base, operator, reason, result: outcome.result, detail: outcome.detail ?? {} });
      finish(outcome.result);
      return reply.code(outcome.status).send(outcome.body);
    };
  }

  // Action bodies are parsed by the handler (see parseBody), in this scope only.
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "string" }, (_request, payload, done) => done(null, payload));

    scope.post(
      "/api/dead-letters/:id/replay",
      route("/api/dead-letters/:id/replay", {
        action: "replay",
        target: (p) => p.id ?? "",
        input: replayInput,
        perform: async ({ params }) => {
          const entry = await deps.deadLetters.get(params.id);
          if (!entry) {
            return { status: 404, body: { error: "no dead-lettered event with this id" }, result: "not_found" };
          }
          const check = checkReplayable(entry.event);
          if (!check.ok) {
            return {
              status: 422,
              body: { error: "this event fails the current event schema, so it would be dead-lettered again", issues: check.issues },
              result: "refused",
              detail: { issues: check.issues, dead_letter_reason: entry.reason },
            };
          }
          // The tracker continues this request's trace, as it does for ingest.
          const streamId = await deps.deadLetters.replay(entry.id, entry.event, injectTraceContext());
          if (streamId === null) {
            return { status: 404, body: { error: "no dead-lettered event with this id" }, result: "not_found" };
          }
          return {
            status: 200,
            body: { replayed: entry.id, stream_id: streamId },
            result: "ok",
            detail: { stream_id: streamId, source_id: entry.source_id, dead_letter_reason: entry.reason },
          };
        },
      }),
    );

    scope.post(
      "/api/dead-letters/:id/discard",
      route("/api/dead-letters/:id/discard", {
        action: "discard",
        target: (p) => p.id ?? "",
        input: discardInput,
        perform: async ({ params }) => {
          const entry = await deps.deadLetters.get(params.id);
          if (!entry || !(await deps.deadLetters.discard(entry.id))) {
            return { status: 404, body: { error: "no dead-lettered event with this id" }, result: "not_found" };
          }
          // The audit row keeps the whole entry, so a discard can be undone by hand.
          return {
            status: 200,
            body: { discarded: entry.id },
            result: "ok",
            detail: { entry: { source_id: entry.source_id, reason: entry.reason, event: entry.event, dead_lettered_at: entry.dead_lettered_at } },
          };
        },
      }),
    );

    scope.post(
      "/api/alerts/:fingerprint/silence",
      route("/api/alerts/:fingerprint/silence", {
        action: "silence",
        target: (p) => p.fingerprint ?? "",
        input: silenceInput,
        perform: async ({ params, body }, operator) => {
          const alert = (await deps.alertmanager.alerts()).find((a) => a.fingerprint === params.fingerprint);
          if (!alert) {
            return { status: 404, body: { error: "no firing alert has this fingerprint" }, result: "not_found" };
          }
          if (alert.status.state !== "active") {
            return {
              status: 409,
              body: { error: "this alert is already silenced or inhibited" },
              result: "refused",
              detail: { state: alert.status.state, silenced_by: alert.status.silencedBy },
            };
          }
          // Equality on every label of this alert, so the silence covers this
          // alert and nothing else.
          const matchers = Object.entries(alert.labels)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, value]) => ({ name, value, isRegex: false, isEqual: true }));
          const startsAt = now();
          const endsAt = new Date(startsAt.getTime() + body.minutes * 60_000);
          const silenceId = await deps.alertmanager.createSilence({
            matchers,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
            createdBy: operator,
            comment: body.reason,
          });
          return {
            status: 200,
            body: { silence_id: silenceId, ends_at: endsAt.toISOString() },
            result: "ok",
            detail: { silence_id: silenceId, alertname: alert.labels.alertname ?? "", minutes: body.minutes, ends_at: endsAt.toISOString() },
          };
        },
      }),
    );
  });
}
