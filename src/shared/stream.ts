// Names and encoding for the Redis stream that connects ingest and tracker.

export const STREAM_KEY = "railcar:events";
export const DEAD_LETTER_KEY = "railcar:events:dead";
export const TRACKER_GROUP = "tracker";

// Approximate cap on the stream length. At the simulator's default rate of
// 25 events/s this keeps a little over two hours of events.
export const STREAM_MAXLEN = 200_000;

export interface StreamMessage {
  id: string;
  fields: Record<string, string>;
}

// Redis returns stream entries as [id, [field, value, field, value, ...]].
export function toStreamMessage(raw: [string, string[]]): StreamMessage {
  const [id, flat] = raw;
  const fields: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) {
    fields[flat[i] as string] = flat[i + 1] as string;
  }
  return { id, fields };
}

// Entries for one stream from an XREADGROUP reply. Over RESP2 the reply is
// [[key, entries], ...]; over RESP3 it is a map, which ioredis hands back
// flattened as [key, entries, key, entries, ...]. Both shapes are accepted.
export function entriesFromXread(reply: unknown, key: string): StreamMessage[] {
  if (!Array.isArray(reply) || reply.length === 0) {
    return [];
  }
  const pairs: [unknown, unknown][] = [];
  if (typeof reply[0] === "string") {
    for (let i = 0; i + 1 < reply.length; i += 2) {
      pairs.push([reply[i], reply[i + 1]]);
    }
  } else {
    for (const pair of reply as unknown[][]) {
      pairs.push([pair[0], pair[1]]);
    }
  }
  const match = pairs.find(([name]) => name === key);
  if (!match || !Array.isArray(match[1])) {
    return [];
  }
  return (match[1] as [string, string[]][]).map(toStreamMessage);
}

// Stream IDs are "<milliseconds>-<sequence>", where the milliseconds are the
// Redis server time when the entry was added.
export function streamIdMillis(id: string): number {
  const ms = Number(id.split("-")[0]);
  if (!Number.isFinite(ms)) {
    throw new Error(`not a stream id: ${id}`);
  }
  return ms;
}
