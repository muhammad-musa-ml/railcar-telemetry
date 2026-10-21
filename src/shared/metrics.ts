import type { FastifyInstance } from "fastify";
import { collectDefaultMetrics, Counter, Histogram, Registry } from "prom-client";

// Latency buckets in seconds, from 5 ms to 5 s.
export const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

export function createRegistry(service: string, withDefaults = true): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  if (withDefaults) {
    collectDefaultMetrics({ register: registry });
  }
  return registry;
}

// Request count and latency for every route, labelled by the route template
// (not the raw URL) so that car ids do not become label values.
export function instrumentHttp(app: FastifyInstance, registry: Registry): void {
  const requests = new Counter({
    name: "http_server_requests_total",
    help: "HTTP requests handled, by route, method and status code",
    labelNames: ["route", "method", "status_code"],
    registers: [registry],
  });
  const duration = new Histogram({
    name: "http_server_request_duration_seconds",
    help: "HTTP request duration in seconds, by route and method",
    labelNames: ["route", "method"],
    buckets: LATENCY_BUCKETS,
    registers: [registry],
  });

  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions.url ?? "unmatched";
    const labels = { route, method: request.method };
    requests.inc({ ...labels, status_code: String(reply.statusCode) });
    duration.observe(labels, reply.elapsedTime / 1000);
  });

  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });
}
