import { Redis } from "ioredis";
import { Pool } from "pg";
import { Counter } from "prom-client";
import { env, envInt } from "../shared/config";
import { createLogger } from "../shared/logger";
import { createRegistry } from "../shared/metrics";
import { buildConsoleApp } from "./app";
import { PgAuditLog } from "./audit";
import { OperatorTokens } from "./auth";
import { RedisDeadLetterStore } from "./dead-letters";
import { RateLimiter } from "./rate-limit";
import { AlertmanagerHttpApi, JsonClient, PagerHttpApi, PrometheusHttpApi, QueryHttpApi } from "./upstreams";

async function main() {
  const logger = createLogger("console");
  const registry = createRegistry("console");

  // Refuse to start without operators rather than run with actions that
  // nobody can authorise. The tokens are never logged.
  const operators = OperatorTokens.parse(env("CONSOLE_OPERATOR_TOKENS"));

  // The audit trail. The console's database role may only insert into
  // console_audit (db/migrations/001_console_audit.sql).
  const pool = new Pool({
    connectionString: env("DATABASE_URL", "postgres://railcar_console:console-local-only@localhost:5432/railcar"),
    max: 2,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
  });
  pool.on("error", (err) => logger.warn({ err: err.message }, "idle postgres client error"));

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
    audit: new PgAuditLog(pool),
    operators,
    rateLimiter: new RateLimiter(envInt("CONSOLE_ACTIONS_PER_MINUTE", 30), 60_000),
    registry,
    logger,
  });

  const close = async () => {
    await app.close();
    await pool.end();
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
