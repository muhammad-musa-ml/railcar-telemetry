import Fastify, { type FastifyInstance } from "fastify";
import { Counter, type Registry } from "prom-client";
import { eventBatchSchema } from "../shared/event";
import type { Logger } from "../shared/logger";
import { instrumentHttp } from "../shared/metrics";
import type { EventPublisher } from "./publisher";

export interface IngestDeps {
  publisher: EventPublisher;
  registry: Registry;
  logger?: Logger;
  ready?: () => Promise<boolean>;
}

export function buildIngestApp(deps: IngestDeps): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  instrumentHttp(app, deps.registry);

  const accepted = new Counter({
    name: "ingest_events_accepted_total",
    help: "Location events accepted and published to the stream",
    registers: [deps.registry],
  });
  const rejected = new Counter({
    name: "ingest_batches_rejected_total",
    help: "Event batches rejected, by reason",
    labelNames: ["reason"],
    registers: [deps.registry],
  });

  // A reader posts the tags it read as one batch. The batch is accepted or
  // rejected as a whole, so the reader can retry it without sending a
  // partial duplicate.
  app.post("/v1/events", async (request, reply) => {
    const parsed = eventBatchSchema.safeParse(request.body);
    if (!parsed.success) {
      rejected.inc({ reason: "invalid" });
      return reply.code(400).send({
        error: "invalid event batch",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    try {
      await deps.publisher.publish(parsed.data.events);
    } catch (err) {
      rejected.inc({ reason: "unavailable" });
      deps.logger?.error({ err }, "publishing to the stream failed");
      return reply.code(503).send({ error: "event stream unavailable, retry later" });
    }
    accepted.inc(parsed.data.events.length);
    return reply.code(202).send({ accepted: parsed.data.events.length });
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    const ok = deps.ready ? await deps.ready().catch(() => false) : true;
    return reply.code(ok ? 200 : 503).send({ status: ok ? "ready" : "not ready" });
  });

  return app;
}
