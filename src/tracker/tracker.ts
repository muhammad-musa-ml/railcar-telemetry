import { setTimeout as sleep } from "node:timers/promises";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { Counter, Gauge, Histogram, type Registry } from "prom-client";
import { locationEventSchema, type LocationEvent } from "../shared/event";
import type { Logger } from "../shared/logger";
import { LATENCY_BUCKETS } from "../shared/metrics";
import { STREAM_KEY, streamIdMillis, type StreamMessage } from "../shared/stream";
import { extractTraceContext } from "../shared/trace-context";
import type { PositionStore } from "./positions";
import type { StreamClient } from "./stream-client";

export interface TrackerOptions {
  batchSize: number;
  blockMs: number;
  minBackoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  batchSize: 100,
  blockMs: 2000,
  minBackoffMs: 250,
  maxBackoffMs: 5000,
};

type Decoded = { ok: true; event: LocationEvent } | { ok: false; reason: string };

// An entry that cannot be decoded will never succeed, so it goes to the
// dead-letter stream instead of being retried.
export function decodeMessage(message: StreamMessage): Decoded {
  const raw = message.fields.event;
  if (raw === undefined) {
    return { ok: false, reason: "missing event field" };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "event is not valid JSON" };
  }
  const parsed = locationEventSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: `event failed validation: ${parsed.error.issues[0]?.message ?? "unknown"}` };
  }
  return { ok: true, event: parsed.data };
}

const OUTCOMES = ["applied", "stale"] as const;
const DEAD_LETTER_REASONS = ["undecodable", "rejected"] as const;

function createTrackerMetrics(registry: Registry) {
  const metrics = {
    processed: new Counter({
      name: "tracker_events_processed_total",
      help: "Events written to Postgres and acknowledged, by outcome (applied, or stale when a newer read was already stored)",
      labelNames: ["outcome"],
      registers: [registry],
    }),
    failed: new Counter({
      name: "tracker_events_failed_total",
      help: "Attempts to process an event that failed and will be retried",
      registers: [registry],
    }),
    deadLettered: new Counter({
      name: "tracker_events_dead_lettered_total",
      help: "Events moved to the dead-letter stream, by reason",
      labelNames: ["reason"],
      registers: [registry],
    }),
    processingSeconds: new Histogram({
      name: "tracker_event_processing_seconds",
      help: "Time to write one event to Postgres and acknowledge it",
      buckets: LATENCY_BUCKETS,
      registers: [registry],
    }),
    queueSeconds: new Histogram({
      name: "tracker_event_queue_seconds",
      help: "Time from an event entering the stream to the tracker finishing it",
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600],
      registers: [registry],
    }),
    lastProcessed: new Gauge({
      name: "tracker_last_processed_timestamp_seconds",
      help: "Unix time when the tracker last finished an event",
      registers: [registry],
    }),
  };
  // Export every label value at 0 from start-up. A labelled counter that
  // first appears with the value 1 shows no increase() in Prometheus, so the
  // first dead letter after a tracker start never reached DeadLetteredEvents
  // (docs/incidents/004-poison-event.md).
  for (const outcome of OUTCOMES) metrics.processed.inc({ outcome }, 0);
  for (const reason of DEAD_LETTER_REASONS) metrics.deadLettered.inc({ reason }, 0);
  return metrics;
}

export class Tracker {
  private readonly metrics;
  private readonly tracer = trace.getTracer("tracker");
  private checkBacklog = true;
  private backoffMs: number;
  private stopped = false;

  constructor(
    private readonly stream: StreamClient,
    private readonly store: PositionStore,
    registry: Registry,
    private readonly logger: Logger,
    private readonly options: TrackerOptions = DEFAULT_TRACKER_OPTIONS,
  ) {
    this.metrics = createTrackerMetrics(registry);
    this.backoffMs = options.minBackoffMs;
  }

  stop(): void {
    this.stopped = true;
  }

  async run(): Promise<void> {
    await this.stream.ensureGroup();
    while (!this.stopped) {
      try {
        await this.runOnce();
      } catch (err) {
        this.logger.error({ err }, "reading from the stream failed");
        this.checkBacklog = true;
        await this.backOff();
      }
    }
  }

  // One read and the processing of what it returned. On startup, and after
  // any failure, the tracker first re-reads its own unacknowledged entries
  // ("0") so events are retried in stream order before new ones are read.
  async runOnce(): Promise<void> {
    const from = this.checkBacklog ? "0" : ">";
    const messages = await this.stream.read(from, this.options.batchSize, this.options.blockMs);
    if (from === "0" && messages.length === 0) {
      this.checkBacklog = false;
      return;
    }
    for (const message of messages) {
      const ok = await this.handle(message);
      if (!ok) {
        this.checkBacklog = true;
        await this.backOff();
        return;
      }
    }
    this.backoffMs = this.options.minBackoffMs;
  }

  private async backOff(): Promise<void> {
    await sleep(this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, this.options.maxBackoffMs);
  }

  // Returns false when the event should be retried later.
  private async handle(message: StreamMessage): Promise<boolean> {
    const decoded = decodeMessage(message);
    if (!decoded.ok) {
      await this.stream.deadLetter(message, decoded.reason);
      this.metrics.deadLettered.inc({ reason: "undecodable" });
      this.logger.warn({ stream_id: message.id, reason: decoded.reason }, "event moved to dead-letter stream");
      return true;
    }
    const event = decoded.event;
    const parent = extractTraceContext(message.fields);
    return this.tracer.startActiveSpan(
      `${STREAM_KEY} process`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          "messaging.system": "redis",
          "messaging.destination.name": STREAM_KEY,
          "messaging.message.id": message.id,
          "railcar.car_id": event.car_id,
          "railcar.location": event.location,
        },
      },
      parent,
      async (span) => {
        const end = this.metrics.processingSeconds.startTimer();
        try {
          const outcome = await this.store.apply(event);
          await this.stream.ack(message.id);
          end();
          this.metrics.processed.inc({ outcome });
          this.metrics.queueSeconds.observe(Math.max(0, Date.now() - streamIdMillis(message.id)) / 1000);
          this.metrics.lastProcessed.set(Date.now() / 1000);
          return true;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          if (isPermanentWriteError(err)) {
            return this.deadLetterRejected(message, err);
          }
          this.metrics.failed.inc();
          this.logger.error({ err, stream_id: message.id, car_id: event.car_id }, "processing event failed, will retry");
          return false;
        } finally {
          span.end();
        }
      },
    );
  }

  // Postgres will never accept this event, so retrying it would only block
  // the events behind it (docs/incidents/004-poison-event.md).
  private async deadLetterRejected(message: StreamMessage, err: PostgresError): Promise<boolean> {
    try {
      await this.stream.deadLetter(message, `rejected by Postgres: ${err.code} ${err.message}`);
    } catch (dlqErr) {
      this.metrics.failed.inc();
      this.logger.error({ err: dlqErr, stream_id: message.id }, "could not move a rejected event to the dead-letter stream, will retry");
      return false;
    }
    this.metrics.deadLettered.inc({ reason: "rejected" });
    this.logger.warn({ stream_id: message.id, code: err.code, reason: err.message }, "Postgres rejected the event; moved to dead-letter stream");
    return true;
  }
}

type PostgresError = Error & { code: string };

// Postgres says why a statement failed with an SQLSTATE code. Class 22
// (data exception, such as a NUL character in text) and class 23 (integrity
// constraint violation) are about the event itself: retrying it fails the
// same way every time. Anything else, such as a refused connection, a
// timeout or a server shutting down, is treated as temporary and retried.
export function isPermanentWriteError(err: unknown): err is PostgresError {
  const code = (err as { code?: unknown } | null)?.code;
  return err instanceof Error && typeof code === "string" && /^(22|23)[0-9A-Z]{3}$/.test(code);
}
