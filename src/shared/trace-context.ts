import { context, propagation, ROOT_CONTEXT, type Context } from "@opentelemetry/api";

// Trace context travels inside each stream entry as a W3C traceparent field,
// so the tracker's span joins the trace of the HTTP request that published it.

export function injectTraceContext(ctx: Context = context.active()): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  return carrier;
}

export function extractTraceContext(fields: Record<string, string>): Context {
  return propagation.extract(ROOT_CONTEXT, fields);
}
