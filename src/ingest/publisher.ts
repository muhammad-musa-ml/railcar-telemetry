import type { Redis } from "ioredis";
import type { LocationEvent } from "../shared/event";
import { STREAM_KEY, STREAM_MAXLEN } from "../shared/stream";
import { injectTraceContext } from "../shared/trace-context";

export interface EventPublisher {
  publish(events: LocationEvent[]): Promise<void>;
}

// Appends each event to the stream. All events of one request go in one
// pipeline, so a batch costs one round trip to Redis.
export class RedisEventPublisher implements EventPublisher {
  constructor(private readonly redis: Redis) {}

  async publish(events: LocationEvent[]): Promise<void> {
    const traceFields = Object.entries(injectTraceContext()).flat();
    const pipeline = this.redis.pipeline();
    for (const event of events) {
      pipeline.xadd(
        STREAM_KEY,
        "MAXLEN",
        "~",
        STREAM_MAXLEN,
        "*",
        "event",
        JSON.stringify(event),
        ...traceFields,
      );
    }
    const results = await pipeline.exec();
    if (results === null) {
      throw new Error("redis pipeline was discarded");
    }
    const failed = results.find(([err]) => err !== null);
    if (failed) {
      throw failed[0];
    }
  }
}
