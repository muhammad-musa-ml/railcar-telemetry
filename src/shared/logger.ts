import { trace } from "@opentelemetry/api";
import pino from "pino";

// JSON logs on stdout. When a span is active, its trace and span ids are
// added so a log line can be matched to its trace.
export function createLogger(service: string) {
  return pino({
    level: process.env.LOG_LEVEL ?? "info",
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin() {
      const span = trace.getActiveSpan();
      if (!span) {
        return {};
      }
      const ctx = span.spanContext();
      return { trace_id: ctx.traceId, span_id: ctx.spanId };
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
