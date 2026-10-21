import { join } from "node:path";
import { env, envInt } from "../shared/config";
import { createLogger } from "../shared/logger";
import { createRegistry } from "../shared/metrics";
import { buildPagerApp, type MarkerRecord, type PageRecord } from "./app";
import { JsonlLog } from "./store";

async function main() {
  const logger = createLogger("pager");
  const dataDir = env("PAGER_DATA_DIR", "./pager-data");
  const app = buildPagerApp({
    pages: new JsonlLog<PageRecord>(join(dataDir, "pages.jsonl")),
    markers: new JsonlLog<MarkerRecord>(join(dataDir, "markers.jsonl")),
    registry: createRegistry("pager"),
  });
  process.once("SIGTERM", () => void app.close());
  process.once("SIGINT", () => void app.close());
  await app.listen({ host: "0.0.0.0", port: envInt("PORT", 8080) });
  logger.info({ dataDir }, "pager listening");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
