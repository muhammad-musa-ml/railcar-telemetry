import type { DeadLetter } from "../../src/console/api-types";
import type { DeadLetterStore } from "../../src/console/dead-letters";
import {
  UpstreamError,
  type AlertmanagerApi,
  type AmAlert,
  type HttpResult,
  type PagerApi,
  type PagerRecord,
  type PrometheusApi,
  type PromAlert,
  type PromAlertRule,
  type PromSample,
  type QueryApi,
  type SilenceRequest,
} from "../../src/console/upstreams";

// In-memory stand-ins for the systems the console talks to.

export class FakePrometheus implements PrometheusApi {
  samples = new Map<string, PromSample[]>();
  rules: PromAlertRule[] = [];
  pending: PromAlert[] = [];
  down = false;

  async query(expr: string) {
    if (this.down) throw new UpstreamError("prometheus", "prometheus: connect ECONNREFUSED");
    return this.samples.get(expr) ?? [];
  }
  async alertRules() {
    if (this.down) throw new UpstreamError("prometheus", "prometheus: connect ECONNREFUSED");
    return this.rules;
  }
  async alerts() {
    if (this.down) throw new UpstreamError("prometheus", "prometheus: connect ECONNREFUSED");
    return this.pending;
  }
}

export class FakeAlertmanager implements AlertmanagerApi {
  firing: AmAlert[] = [];
  silences: SilenceRequest[] = [];
  down = false;

  async alerts() {
    if (this.down) throw new UpstreamError("alertmanager", "alertmanager: connect ECONNREFUSED");
    return this.firing;
  }
  async createSilence(silence: SilenceRequest) {
    if (this.down) throw new UpstreamError("alertmanager", "alertmanager: connect ECONNREFUSED");
    this.silences.push(silence);
    return `silence-${this.silences.length}`;
  }
}

export class FakePager implements PagerApi {
  records: PagerRecord[] = [];
  asked: Date[] = [];

  async pagesSince(since: Date) {
    this.asked.push(since);
    return this.records.filter((r) => Date.parse(r.received_at) >= since.getTime());
  }
}

export class FakeQuery implements QueryApi {
  answers = new Map<string, HttpResult<unknown>>();
  paths: string[] = [];
  down = false;

  async get(path: string) {
    this.paths.push(path);
    if (this.down) throw new UpstreamError("query", "query answered 503: position store unavailable", 503);
    return this.answers.get(path) ?? { status: 404, body: { error: "no reads for this car" } };
  }
}

export class FakeDeadLetters implements DeadLetterStore {
  // Oldest first, like the stream.
  entries: DeadLetter[] = [];
  down = false;

  async count() {
    if (this.down) throw new Error("Connection is closed.");
    return this.entries.length;
  }
  async list(limit: number) {
    if (this.down) throw new Error("Connection is closed.");
    return [...this.entries].reverse().slice(0, limit);
  }
}

export function deadLetter(id: string, event: unknown, reason = "event failed validation: must not contain control characters"): DeadLetter {
  return {
    id,
    source_id: id.replace(/-\d+$/, "-7"),
    reason,
    event: typeof event === "string" ? event : JSON.stringify(event),
    dead_lettered_at: new Date(Number(id.split("-")[0])).toISOString(),
  };
}

export function amAlert(name: string, severity: string, fingerprint: string, extra: Partial<AmAlert> = {}): AmAlert {
  return {
    fingerprint,
    labels: { alertname: name, severity, job: "tracker" },
    annotations: { summary: `${name} summary`, runbook_url: `https://example.org/runbooks/${name}.md` },
    startsAt: "2026-10-24T07:50:00.000Z",
    endsAt: "2026-10-24T08:10:00.000Z",
    status: { state: "active", silencedBy: [], inhibitedBy: [] },
    ...extra,
  };
}
