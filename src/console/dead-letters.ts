import type { Redis } from "ioredis";
import { DEAD_LETTER_KEY, streamIdMillis, toStreamMessage, type StreamMessage } from "../shared/stream";
import type { DeadLetter } from "./api-types";

// The dead-letter stream railcar:events:dead, written by the tracker (and
// by hand, with the reason "manual", by the stuck-event runbook step).

export interface DeadLetterStore {
  count(): Promise<number>;
  // Newest first.
  list(limit: number): Promise<DeadLetter[]>;
}

export function toDeadLetter(message: StreamMessage): DeadLetter {
  return {
    id: message.id,
    source_id: message.fields.source_id ?? "",
    reason: message.fields.reason ?? "",
    event: message.fields.event ?? "",
    dead_lettered_at: new Date(streamIdMillis(message.id)).toISOString(),
  };
}

export class RedisDeadLetterStore implements DeadLetterStore {
  constructor(private readonly redis: Redis) {}

  count(): Promise<number> {
    return this.redis.xlen(DEAD_LETTER_KEY);
  }

  async list(limit: number): Promise<DeadLetter[]> {
    const raw = (await this.redis.xrevrange(DEAD_LETTER_KEY, "+", "-", "COUNT", limit)) as [string, string[]][];
    return raw.map((entry) => toDeadLetter(toStreamMessage(entry)));
  }
}
