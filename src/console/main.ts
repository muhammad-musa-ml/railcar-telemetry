import { Redis } from "ioredis";
import { Counter } from "prom-client";
import { env, envInt } from "../shared/config";
import { createLogger } from "../shared/logger";
import { createRegistry } from "../shared/metrics";
import { buildConsoleApp } from "./app";
import { RedisDeadLetterStore } from "./dead-letters";
import { AlertmanagerHttpApi, JsonClient, PagerHttpApi, PrometheusHttpApi, QueryHttpApi } from "./upstreams";

async function main() {
  const logger = createLogger("console");
  const registry = createRegistry("console");

  const upstreamErrors = new Counter({
    name: "console_upstream_errors_total",
    help: "Requests from the console to Prometheus, Alertmanager, the pager or the query service that failed",
    labelNames: ["upstream"],
    registers: [registry],
  });
  const client = (name: string, url: string) => new JsonClient(name, url, upstreamErrors);

  const redis = new Redis(env("REDIS_URL", "redis://localhost:6379"), {
    // Answer the browser quickly when Redis is down instead of queueing.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  redis.on("error", (err) => logger.warn({ err: err.message }, "redis connection error"));

  const app = buildConsoleApp({
    prometheus: new PrometheusHttpApi(client("prometheus", env("PROMETHEUS_URL", "http://localhost:9090"))),
    alertmanager: new AlertmanagerHttpApi(client("alertmanager", env("ALERTMANAGER_URL", "http://localhost:9093"))),
    pager: new PagerHttpApi(client("pager", env("PAGER_URL", "http://localhost:8084"))),
    query: new QueryHttpApi(client("query", env("QUERY_URL", "http://localhost:8083"))),
    deadLetters: new RedisDeadLetterStore(redis),
    registry,
    logger,
  });

  const close = async () => {
    await app.close();
    redis.disconnect();
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);

  await app.listen({ host: "0.0.0.0", port: envInt("PORT", 8080) });
  logger.info("console listening");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
