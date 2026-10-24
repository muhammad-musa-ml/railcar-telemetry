import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Counter } from "prom-client";

// HTTP clients for the systems the console reads from and acts on. Each one
// is behind an interface so the routes can be tested with fakes.

export class UpstreamError extends Error {
  constructor(
    readonly upstream: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface HttpResult<T> {
  status: number;
  body: T;
}

const tracer = trace.getTracer("console");

// One JSON request to an upstream, with a client span and the W3C
// traceparent header, so a lookup's trace continues into the query service.
// The console's own HTTP server span comes from the http instrumentation;
// fetch is not covered by it, hence the span here.
export class JsonClient {
  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    private readonly errors?: Counter<"upstream">,
    private readonly timeoutMs = 3000,
  ) {}

  async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<HttpResult<T>> {
    return tracer.startActiveSpan(`${method} ${this.name}`, { kind: SpanKind.CLIENT }, async (span) => {
      const url = `${this.baseUrl}${path}`;
      span.setAttribute("http.request.method", method);
      span.setAttribute("url.full", url);
      const headers: Record<string, string> = { accept: "application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";
      propagation.inject(context.active(), headers);
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        span.setAttribute("http.response.status_code", res.status);
        const text = await res.text();
        let parsed: unknown = null;
        if (text !== "") {
          try {
            parsed = JSON.parse(text);
          } catch {
            throw new UpstreamError(this.name, `${this.name} answered ${res.status} with a body that is not JSON`, res.status);
          }
        }
        if (res.status >= 500) {
          const said = (parsed as { error?: unknown } | null)?.error;
          const detail = typeof said === "string" ? `: ${said}` : "";
          throw new UpstreamError(this.name, `${this.name} answered ${res.status}${detail}`, res.status);
        }
        return { status: res.status, body: parsed as T };
      } catch (err) {
        this.errors?.inc({ upstream: this.name });
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (err instanceof UpstreamError) throw err;
        throw new UpstreamError(this.name, `${this.name}: ${this.reason(err)}`);
      } finally {
        span.end();
      }
    });
  }

  // fetch says only "fetch failed"; the system error (ECONNREFUSED,
  // ENOTFOUND) is in its cause.
  private reason(err: unknown): string {
    if (err instanceof Error && err.name === "TimeoutError") {
      return `no answer within ${this.timeoutMs} ms`;
    }
    const text = err instanceof Error ? err.message : String(err);
    const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
    return typeof code === "string" ? `${text} (${code})` : text;
  }
}

// --- Prometheus -----------------------------------------------------------

export interface PromSample {
  metric: Record<string, string>;
  // null for NaN and infinities, which JSON cannot carry.
  value: number | null;
}

export interface PromAlertRule {
  name: string;
  query: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

export interface PromAlert {
  labels: Record<string, string>;
  annotations: Record<string, string>;
  state: string;
  activeAt: string;
}

export interface PrometheusApi {
  query(expr: string): Promise<PromSample[]>;
  alertRules(): Promise<PromAlertRule[]>;
  alerts(): Promise<PromAlert[]>;
}

interface PromEnvelope<T> {
  status: string;
  error?: string;
  data: T;
}

export function parsePromValue(raw: string): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export class PrometheusHttpApi implements PrometheusApi {
  constructor(private readonly client: JsonClient) {}

  private async get<T>(path: string): Promise<T> {
    const { status, body } = await this.client.request<PromEnvelope<T>>("GET", path);
    if (status !== 200 || body?.status !== "success") {
      throw new UpstreamError("prometheus", `prometheus: ${body?.error ?? `status ${status}`}`, status);
    }
    return body.data;
  }

  async query(expr: string): Promise<PromSample[]> {
    const data = await this.get<{ resultType: string; result: { metric: Record<string, string>; value: [number, string] }[] }>(
      `/api/v1/query?query=${encodeURIComponent(expr)}`,
    );
    if (data.resultType !== "vector") {
      throw new UpstreamError("prometheus", `prometheus: expected a vector for ${expr}, got ${data.resultType}`);
    }
    return data.result.map((r) => ({ metric: r.metric, value: parsePromValue(r.value[1]) }));
  }

  async alertRules(): Promise<PromAlertRule[]> {
    const data = await this.get<{
      groups: { rules: { name: string; query: string; labels?: Record<string, string>; annotations?: Record<string, string> }[] }[];
    }>("/api/v1/rules?type=alert");
    return data.groups.flatMap((g) =>
      g.rules.map((r) => ({ name: r.name, query: r.query, labels: r.labels ?? {}, annotations: r.annotations ?? {} })),
    );
  }

  async alerts(): Promise<PromAlert[]> {
    const data = await this.get<{ alerts: PromAlert[] }>("/api/v1/alerts");
    return data.alerts.map((a) => ({
      labels: a.labels ?? {},
      annotations: a.annotations ?? {},
      state: a.state,
      activeAt: a.activeAt,
    }));
  }
}

// --- Alertmanager ---------------------------------------------------------

export interface AmAlert {
  fingerprint: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  status: { state: string; silencedBy: string[]; inhibitedBy: string[] };
}

export interface SilenceRequest {
  matchers: { name: string; value: string; isRegex: boolean; isEqual: boolean }[];
  startsAt: string;
  endsAt: string;
  createdBy: string;
  comment: string;
}

export interface AlertmanagerApi {
  // Firing alerts, silenced or not.
  alerts(): Promise<AmAlert[]>;
  createSilence(silence: SilenceRequest): Promise<string>;
}

export class AlertmanagerHttpApi implements AlertmanagerApi {
  constructor(private readonly client: JsonClient) {}

  async alerts(): Promise<AmAlert[]> {
    const { status, body } = await this.client.request<AmAlert[]>(
      "GET",
      "/api/v2/alerts?active=true&silenced=true&inhibited=true&unprocessed=true",
    );
    if (status !== 200 || !Array.isArray(body)) {
      throw new UpstreamError("alertmanager", `alertmanager: status ${status}`, status);
    }
    return body;
  }

  async createSilence(silence: SilenceRequest): Promise<string> {
    const { status, body } = await this.client.request<{ silenceID?: string }>("POST", "/api/v2/silences", silence);
    if (status !== 200 || typeof body?.silenceID !== "string") {
      throw new UpstreamError("alertmanager", `alertmanager refused the silence: ${JSON.stringify(body)}`, status);
    }
    return body.silenceID;
  }
}

// --- pager ----------------------------------------------------------------

export interface PagerRecord {
  received_at: string;
  receiver: string;
  status: string;
  alertname: string;
  severity: string;
  summary: string;
  runbook_url: string;
}

export interface PagerApi {
  pagesSince(since: Date): Promise<PagerRecord[]>;
}

export class PagerHttpApi implements PagerApi {
  constructor(private readonly client: JsonClient) {}

  async pagesSince(since: Date): Promise<PagerRecord[]> {
    const { status, body } = await this.client.request<{ pages: PagerRecord[] }>(
      "GET",
      `/v1/pages?since=${encodeURIComponent(since.toISOString())}`,
    );
    if (status !== 200 || !Array.isArray(body?.pages)) {
      throw new UpstreamError("pager", `pager: status ${status}`, status);
    }
    return body.pages;
  }
}

// --- query service --------------------------------------------------------

export interface QueryApi {
  // The query service's own answer (status and body), passed through.
  get(path: string): Promise<HttpResult<unknown>>;
}

export class QueryHttpApi implements QueryApi {
  constructor(private readonly client: JsonClient) {}

  get(path: string): Promise<HttpResult<unknown>> {
    return this.client.request("GET", path);
  }
}
