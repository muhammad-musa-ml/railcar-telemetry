import type { Redis } from "ioredis";
import { locationEventSchema } from "../shared/event";
import { DEAD_LETTER_KEY, STREAM_KEY, STREAM_MAXLEN, streamIdMillis, toStreamMessage, type StreamMessage } from "../shared/stream";
import type { DeadLetter } from "./api-types";

// The dead-letter stream railcar:events:dead, written by the tracker (and
// by hand, with the reason "manual", by the stuck-event runbook step).

export interface DeadLetterStore {
  count(): Promise<number>;
  // Newest first.
  list(limit: number): Promise<DeadLetter[]>;
  get(id: string): Promise<DeadLetter | null>;
  // Appends `event` (with the extra fields) to railcar:events and removes the
  // dead-letter entry, in one step. Returns the new stream id, or null when
  // the entry no longer exists.
  replay(id: string, event: string, fields: Record<string, string>): Promise<string | null>;
  // Returns false when the entry no longer exists.
  discard(id: string): Promise<boolean>;
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

export type ReplayCheck = { ok: true } | { ok: false; issues: { path: string; message: string }[] };

// Whether the tracker would accept this event today. The tracker decodes
// each entry with the same schema (src/tracker/tracker.ts, decodeMessage),
// so an event that fails here would only be dead-lettered again.
export function checkReplayable(raw: string): ReplayCheck {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, issues: [{ path: "", message: "the stored event is not valid JSON" }] };
  }
  const parsed = locationEventSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  }
  return { ok: true };
}

// Runs inside Redis, so no other client sees the event in both streams or in
// neither. The new entry is added before the old one is removed: if XADD
// fails, nothing has been deleted.
// KEYS[1] dead-letter stream, KEYS[2] event stream
// ARGV[1] dead-letter id, ARGV[2] MAXLEN for the event stream, ARGV[3..] field/value pairs
const REPLAY_SCRIPT = `
if #redis.call('XRANGE', KEYS[1], ARGV[1], ARGV[1]) == 0 then
  return false
end
local id = redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[2], '*', unpack(ARGV, 3))
redis.call('XDEL', KEYS[1], ARGV[1])
return id
`;

export class RedisDeadLetterStore implements DeadLetterStore {
  constructor(private readonly redis: Redis) {}

  count(): Promise<number> {
    return this.redis.xlen(DEAD_LETTER_KEY);
  }

  async list(limit: number): Promise<DeadLetter[]> {
    const raw = (await this.redis.xrevrange(DEAD_LETTER_KEY, "+", "-", "COUNT", limit)) as [string, string[]][];
    return raw.map((entry) => toDeadLetter(toStreamMessage(entry)));
  }

  async get(id: string): Promise<DeadLetter | null> {
    const raw = (await this.redis.xrange(DEAD_LETTER_KEY, id, id)) as [string, string[]][];
    return raw[0] ? toDeadLetter(toStreamMessage(raw[0])) : null;
  }

  async replay(id: string, event: string, fields: Record<string, string>): Promise<string | null> {
    const pairs = ["event", event, ...Object.entries(fields).flat()];
    const result = await this.redis.eval(REPLAY_SCRIPT, 2, DEAD_LETTER_KEY, STREAM_KEY, id, String(STREAM_MAXLEN), ...pairs);
    return typeof result === "string" ? result : null;
  }

  async discard(id: string): Promise<boolean> {
    return (await this.redis.xdel(DEAD_LETTER_KEY, id)) === 1;
  }
}
