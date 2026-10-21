import Fastify from "fastify";
import { Redis } from "ioredis";
import { Pool } from "pg";
import { env, envInt } from "../shared/config";
import { createLogger } from "../shared/logger";
import { createRegistry, instrumentHttp } from "../shared/metrics";
import { TRACKER_GROUP } from "../shared/stream";
import { PgPositionStore } from "./positions";
import { RedisStreamClient } from "./stream-client";
import { Tracker } from "./tracker";

async function main() {
  const logger = createLogger("tracker");
  const redis = new Redis(env("REDIS_URL", "redis://localhost:6379"));
  redis.on("error", (err) => logger.warn({ err: err.message }, "redis connection error"));

  const pool = new Pool({
    connectionString: env("DATABASE_URL", "postgres://railcar:railcar@localhost:5432/railcar"),
    max: 4,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  });
  // An idle client loses its connection when Postgres goes away. Without a
  // listener that error would crash the process.
  pool.on("error", (err) => logger.warn({ err: err.message }, "idle postgres client error"));

  const registry = createRegistry("tracker");
  // A fixed consumer name lets a restarted tracker pick up the entries it
  // had read but not acknowledged before it stopped.
  const consumer = env("TRACKER_CONSUMER", "tracker-1");
  const tracker = new Tracker(new RedisStreamClient(redis, TRACKER_GROUP, consumer), new PgPositionStore(pool), registry, logger);

  // The tracker has no API, only a port for metrics and health checks.
  const http = Fastify({ logger: false });
  instrumentHttp(http, registry);
  http.get("/healthz", async () => ({ status: "ok" }));
  await http.listen({ host: "0.0.0.0", port: envInt("PORT", 8080) });

  const done = tracker.run();
  const stop = async () => {
    tracker.stop();
    await done.catch(() => undefined);
    await http.close();
    await pool.end();
    redis.disconnect();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  logger.info({ consumer }, "tracker started");
  await done;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
