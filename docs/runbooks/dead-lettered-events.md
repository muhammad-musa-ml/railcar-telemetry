# DeadLetteredEvents

**Severity:** warning (ticket)
**Fires when:** `tracker_events_dead_lettered_total` increased in the last 15
minutes.

## What it means

The tracker moved one or more events to the Redis stream
`railcar:events:dead` instead of writing them, because retrying them would
never succeed. Those car reads are missing from `car_positions`. Each
dead-lettered entry carries the original stream id, a reason and the raw
event.

This does not need someone at night: the pipeline keeps running. It needs
someone to find out where the bad events came from.

## Check

```
docker compose exec redis redis-cli XLEN railcar:events:dead
docker compose exec redis redis-cli XREVRANGE railcar:events:dead + - COUNT 10
```

Look at the `reason` field and the `event` payload, and at the metric's
`reason` label:

- `undecodable`: the entry is not JSON or fails the event schema. Ingest
  validates every batch, so it came from something that wrote to Redis
  directly.
- `rejected`: Postgres refused it with a data error; the reason field starts
  with `rejected by Postgres:` and the SQLSTATE code. It passed the schema,
  so the schema is missing a check.

Entries parked by hand (reason `manual`) do not count in the metric.

## Fix

- Find the producer and fix it.
- If the data can be corrected, fix the JSON and post it through the ingest
  API (`POST /v1/events`) so it goes through validation. Do not write it
  straight back into the stream.
- Once handled, trim what was reviewed:
  `docker compose exec redis redis-cli XTRIM railcar:events:dead MAXLEN 0`.

## After

If the cause was a gap in ingest validation, add the check there and a unit
test for it.
