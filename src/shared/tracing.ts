// Loaded with `node --require` before any service code, so the http, pg and
// ioredis modules are patched before they are first required.
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { NodeSDK } from "@opentelemetry/sdk-node";

const QUIET_PATHS = new Set(["/metrics", "/healthz", "/readyz"]);

if (process.env.OTEL_SDK_DISABLED !== "true") {
  const sdk = new NodeSDK({
    // OTEL_SERVICE_NAME and OTEL_EXPORTER_OTLP_ENDPOINT come from the environment.
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({
        // Scrapes and health checks every few seconds would bury real traces.
        ignoreIncomingRequestHook: (req) => QUIET_PATHS.has((req.url ?? "").split("?")[0] ?? ""),
      }),
      // Only record database and Redis calls that belong to a request or an
      // event, not the tracker's idle polling.
      new PgInstrumentation({ requireParentSpan: true }),
      new IORedisInstrumentation({ requireParentSpan: true }),
    ],
  });
  sdk.start();

  const shutdown = () => {
    sdk.shutdown().catch(() => undefined);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
