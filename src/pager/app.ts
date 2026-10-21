import Fastify, { type FastifyInstance } from "fastify";
import { Counter, type Registry } from "prom-client";
import { z } from "zod";
import { instrumentHttp } from "../shared/metrics";
import type { JsonlLog } from "./store";

// Stands in for an on-call paging service. Alertmanager posts its webhook
// here; every alert in every notification is recorded with the time it
// arrived.

export interface PageRecord {
  received_at: string;
  receiver: string;
  status: string;
  alertname: string;
  severity: string;
  fingerprint: string;
  starts_at: string;
  ends_at: string;
  summary: string;
  runbook_url: string;
}

// Drill scripts post markers (fault injected, fault removed, recovered) so
// that every timestamp in a drill comes from this one clock.
export interface MarkerRecord {
  received_at: string;
  label: string;
  details: Record<string, unknown>;
}

const webhookSchema = z.object({
  receiver: z.string(),
  status: z.string(),
  alerts: z.array(
    z.object({
      status: z.string(),
      labels: z.record(z.string(), z.string()),
      annotations: z.record(z.string(), z.string()).default({}),
      startsAt: z.string(),
      endsAt: z.string(),
      fingerprint: z.string(),
    }),
  ),
});

const markerSchema = z.object({
  label: z.string().min(1).max(64),
  details: z.record(z.string(), z.unknown()).default({}),
});

export interface PagerDeps {
  pages: JsonlLog<PageRecord>;
  markers: JsonlLog<MarkerRecord>;
  registry: Registry;
  now?: () => Date;
}

export function buildPagerApp(deps: PagerDeps): FastifyInstance {
  const now = deps.now ?? (() => new Date());
  const app = Fastify({ logger: false });
  instrumentHttp(app, deps.registry);

  const notifications = new Counter({
    name: "pager_notifications_total",
    help: "Alerts received from Alertmanager, by receiver, status and alert name",
    labelNames: ["receiver", "status", "alertname"],
    registers: [deps.registry],
  });

  app.post<{ Params: { receiver: string } }>("/v1/alertmanager/:receiver", async (request, reply) => {
    const receivedAt = now().toISOString();
    const parsed = webhookSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "not an Alertmanager webhook payload" });
    }
    for (const alert of parsed.data.alerts) {
      const record: PageRecord = {
        received_at: receivedAt,
        receiver: request.params.receiver,
        status: alert.status,
        alertname: alert.labels.alertname ?? "unknown",
        severity: alert.labels.severity ?? "none",
        fingerprint: alert.fingerprint,
        starts_at: alert.startsAt,
        ends_at: alert.endsAt,
        summary: alert.annotations.summary ?? "",
        runbook_url: alert.annotations.runbook_url ?? "",
      };
      deps.pages.append(record);
      notifications.inc({ receiver: record.receiver, status: record.status, alertname: record.alertname });
    }
    return { recorded: parsed.data.alerts.length };
  });

  app.get<{ Querystring: { since?: string; receiver?: string } }>("/v1/pages", async (request) => {
    const pages = deps.pages.since(request.query.since);
    const receiver = request.query.receiver;
    return { pages: receiver ? pages.filter((p) => p.receiver === receiver) : pages };
  });

  app.post("/v1/markers", async (request, reply) => {
    const parsed = markerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "marker needs a label" });
    }
    const record: MarkerRecord = { received_at: now().toISOString(), ...parsed.data };
    deps.markers.append(record);
    return record;
  });

  app.get<{ Querystring: { since?: string } }>("/v1/markers", async (request) => ({
    markers: deps.markers.since(request.query.since),
  }));

  app.get("/v1/now", async () => ({ now: now().toISOString() }));
  app.get("/healthz", async () => ({ status: "ok" }));

  return app;
}
