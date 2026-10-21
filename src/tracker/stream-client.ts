import type { Redis } from "ioredis";
import { DEAD_LETTER_KEY, STREAM_KEY, toStreamMessage, type StreamMessage } from "../shared/stream";

export interface StreamClient {
  ensureGroup(): Promise<void>;
  // "0" re-reads this consumer's delivered-but-unacknowledged entries,
  // ">" reads entries the group has not seen yet.
  read(from: "0" | ">", count: number, blockMs: number): Promise<StreamMessage[]>;
  ack(id: string): Promise<void>;
  deadLetter(message: StreamMessage, reason: string): Promise<void>;
}

export class RedisStreamClient implements StreamClient {
  constructor(
    private readonly redis: Redis,
    private readonly group: string,
    private readonly consumer: string,
  ) {}

  async ensureGroup(): Promise<void> {
    try {
      // Start from the beginning of the stream so events published before
      // the tracker's first start are not skipped.
      await this.redis.xgroup("CREATE", STREAM_KEY, this.group, "0", "MKSTREAM");
    } catch (err) {
      if (!(err instanceof Error && err.message.includes("BUSYGROUP"))) {
        throw err;
      }
    }
  }

  async read(from: "0" | ">", count: number, blockMs: number): Promise<StreamMessage[]> {
    const args: (string | number)[] = ["GROUP", this.group, this.consumer, "COUNT", count];
    if (from === ">" && blockMs > 0) {
      args.push("BLOCK", blockMs);
    }
    args.push("STREAMS", STREAM_KEY, from);
    const reply = (await this.redis.call("XREADGROUP", args)) as [string, [string, string[]][]][] | null;
    if (!reply || reply.length === 0) {
      return [];
    }
    const entries = reply[0]?.[1] ?? [];
    return entries.map(toStreamMessage);
  }

  async ack(id: string): Promise<void> {
    await this.redis.xack(STREAM_KEY, this.group, id);
  }

  async deadLetter(message: StreamMessage, reason: string): Promise<void> {
    const results = await this.redis
      .multi()
      .xadd(DEAD_LETTER_KEY, "*", "source_id", message.id, "reason", reason, "event", message.fields.event ?? "")
      .xack(STREAM_KEY, this.group, message.id)
      .exec();
    const failed = results?.find(([err]) => err !== null);
    if (failed) {
      throw failed[0];
    }
  }
}
