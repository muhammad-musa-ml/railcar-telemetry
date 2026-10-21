import { Redis } from "ioredis";
import { env, envInt } from "../shared/config";
import { createLogger } from "../shared/logger";
import { createRegistry } from "../shared/metrics";
import { buildIngestApp } from "./app";
import { RedisEventPublisher } from "./publisher";
import { registerStreamGauges } from "./stream-stats";

async function main() {
  const logger = createLogger("ingest");
  const redis = new Redis(env("REDIS_URL", "redis://localhost:6379"), {
    // Fail a publish quickly when Redis is down instead of queueing it.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  redis.on("error", (err) => logger.warn({ err: err.message }, "redis connection error"));

  const registry = createRegistry("ingest");
  registerStreamGauges(registry, redis);

  const app = buildIngestApp({
    publisher: new RedisEventPublisher(redis),
    registry,
    logger,
    ready: async () => (await redis.ping()) === "PONG",
  });

  const close = async () => {
    await app.close();
    redis.disconnect();
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);

  await app.listen({ host: "0.0.0.0", port: envInt("PORT", 8080) });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
