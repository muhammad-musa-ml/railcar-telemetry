import type { ServiceStatus, Signal, SignalUnit, StatusResponse } from "./api-types";
import type { PrometheusApi, PromAlertRule } from "./upstreams";

// The pipeline numbers on the overview are computed with the expressions of
// the alert rules that watch them, read from Prometheus at request time. The
// console never holds its own copy of a threshold, so the screen and the
// alerts cannot disagree about what "too old" or "too many" means.

export const SIGNALS: readonly { rule: string; key: string; label: string; unit: SignalUnit }[] = [
  { rule: "RailcarEventsDelayed", key: "oldest_unacked_age", label: "Oldest unprocessed event", unit: "seconds" },
  { rule: "StreamBacklogHigh", key: "stream_backlog", label: "Stream backlog", unit: "events" },
  { rule: "RailcarPositionsStale", key: "positions_freshness", label: "Time since last position write", unit: "seconds" },
  { rule: "IngestErrorRateHigh", key: "ingest_error_ratio", label: "Ingest 5xx ratio", unit: "ratio" },
  { rule: "QueryErrorRateHigh", key: "query_error_ratio", label: "Lookup 5xx ratio", unit: "ratio" },
];

export interface RuleCondition {
  lhs: string;
  comparison: string;
  threshold: number;
}

// "<expression> > 60" -> { lhs: "<expression>", comparison: ">", threshold: 60 }.
// Comparisons bind more loosely than arithmetic in PromQL, so a comparison
// with a number at the very end of a rule applies to everything before it.
// Anything else (no comparison, a comparison inside parentheses, two
// expressions compared) is not split.
const TRAILING_COMPARISON = /^([\s\S]*?\S)\s*(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*$/;

export function splitAlertExpr(expr: string): RuleCondition | null {
  const match = TRAILING_COMPARISON.exec(expr);
  if (!match) return null;
  return { lhs: match[1]!.trim(), comparison: match[2]!, threshold: Number(match[3]) };
}

export function holds(value: number, comparison: string, threshold: number): boolean {
  switch (comparison) {
    case ">":
      return value > threshold;
    case ">=":
      return value >= threshold;
    case "<":
      return value < threshold;
    case "<=":
      return value <= threshold;
    case "==":
      return value === threshold;
    case "!=":
      return value !== threshold;
    default:
      return false;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Upstream errors already name their upstream ("prometheus: ..."); others
// get the name added.
function describe(upstream: string, err: unknown): string {
  const text = message(err);
  return text.startsWith(`${upstream}:`) || text.startsWith(`${upstream} `) ? text : `${upstream}: ${text}`;
}

export interface StatusSources {
  prometheus: PrometheusApi;
  deadLetters: { count(): Promise<number> };
}

async function readServices(prometheus: PrometheusApi): Promise<ServiceStatus[]> {
  const samples = await prometheus.query("up");
  const byJob = new Map<string, boolean>();
  for (const sample of samples) {
    const job = sample.metric.job ?? "unknown";
    // A job with several targets counts as up only if every target is.
    byJob.set(job, (byJob.get(job) ?? true) && sample.value === 1);
  }
  return [...byJob.entries()].map(([job, up]) => ({ job, up })).sort((a, b) => a.job.localeCompare(b.job));
}

async function readSignal(
  prometheus: PrometheusApi,
  rules: PromAlertRule[] | Error,
  spec: (typeof SIGNALS)[number],
): Promise<Signal> {
  const signal: Signal = {
    key: spec.key,
    label: spec.label,
    unit: spec.unit,
    rule: spec.rule,
    value: null,
    comparison: null,
    threshold: null,
    breaching: false,
    runbook_url: null,
  };
  if (rules instanceof Error) {
    return { ...signal, error: "alert rules could not be read from Prometheus" };
  }
  const rule = rules.find((r) => r.name === spec.rule);
  if (!rule) {
    return { ...signal, error: `alert rule ${spec.rule} is not loaded in Prometheus` };
  }
  signal.runbook_url = rule.annotations.runbook_url ?? null;
  const condition = splitAlertExpr(rule.query);
  if (!condition) {
    return { ...signal, error: `alert rule ${spec.rule} does not end in a comparison with a number` };
  }
  signal.comparison = condition.comparison;
  signal.threshold = condition.threshold;
  try {
    const values = (await prometheus.query(condition.lhs)).map((s) => s.value).filter((v): v is number => v !== null);
    if (values.length > 0) {
      signal.value = Math.max(...values);
      signal.breaching = holds(signal.value, condition.comparison, condition.threshold);
    }
  } catch (err) {
    signal.error = message(err);
  }
  return signal;
}

export async function readStatus(sources: StatusSources, now: Date): Promise<StatusResponse> {
  const errors = new Set<string>();
  const [services, rules, deadLetters] = await Promise.all([
    readServices(sources.prometheus).catch((err: unknown) => {
      errors.add(describe("prometheus", err));
      return null;
    }),
    sources.prometheus.alertRules().catch((err: unknown) => {
      errors.add(describe("prometheus", err));
      return err instanceof Error ? err : new Error(message(err));
    }),
    sources.deadLetters.count().catch((err: unknown) => {
      errors.add(describe("redis", err));
      return null;
    }),
  ]);
  const signals = await Promise.all(SIGNALS.map((spec) => readSignal(sources.prometheus, rules, spec)));
  return {
    generated_at: now.toISOString(),
    services,
    signals,
    dead_letters: deadLetters,
    errors: [...errors],
  };
}
