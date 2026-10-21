import { Pool } from "pg";
import { env, envInt } from "../shared/config";
import { createLogger } from "../shared/logger";
import { createRegistry } from "../shared/metrics";
import { buildQueryApp } from "./app";
import { PgPositionReader } from "./positions";

async function main() {
  const logger = createLogger("query");
  const pool = new Pool({
    connectionString: env("DATABASE_URL", "postgres://railcar:railcar@localhost:5432/railcar"),
    max: 8,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
  });
  pool.on("error", (err) => logger.warn({ err: err.message }, "idle postgres client error"));

  const app = buildQueryApp({
    positions: new PgPositionReader(pool),
    registry: createRegistry("query"),
    logger,
  });

  const close = async () => {
    await app.close();
    await pool.end();
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);

  await app.listen({ host: "0.0.0.0", port: envInt("PORT", 8080) });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
