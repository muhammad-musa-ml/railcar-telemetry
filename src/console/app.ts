import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { Registry } from "prom-client";
import { z } from "zod";
import { CAR_ID_PATTERN, locationEventSchema } from "../shared/event";
import type { Logger } from "../shared/logger";
import { instrumentHttp } from "../shared/metrics";
import type { AlertsResponse, ConsoleAlert, DeadLettersResponse, PagesResponse } from "./api-types";
import type { DeadLetterStore } from "./dead-letters";
import { readStatus } from "./status";
import { UpstreamError, type AlertmanagerApi, type PagerApi, type PrometheusApi, type QueryApi } from "./upstreams";

export interface ConsoleDeps {
  prometheus: PrometheusApi;
  alertmanager: AlertmanagerApi;
  pager: PagerApi;
  query: QueryApi;
  deadLetters: DeadLetterStore;
  registry: Registry;
  logger?: Logger;
  now?: () => Date;
}

const PAGES_WINDOW_MS = 24 * 3600 * 1000;

const limitSchema = (fallback: number, max: number) => z.coerce.number().int().min(1).max(max).default(fallback);

const carParams = z.object({ carId: z.string().regex(CAR_ID_PATTERN, "car id must look like 'RCTX 104233'") });
const locationParams = z.object({ location: locationEventSchema.shape.location });

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

  app.get("/healthz", async () => ({ status: "ok" }));

  return app;
}
