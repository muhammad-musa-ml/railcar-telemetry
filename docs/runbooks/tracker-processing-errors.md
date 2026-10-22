# TrackerProcessingErrors

**Severity:** warning (ticket)
**Fires when:** `tracker_events_failed_total` has increased within every
1-minute window for 2 minutes.

## What it means

The tracker is failing to write events to Postgres or to acknowledge them in
Redis. A failed event is not acknowledged. The tracker backs off (up to 5
seconds) and retries from its oldest unacknowledged entry, so events are not
lost, but nothing after the failing entry is processed while it keeps failing.

## Check

1. Read the error:
   ```
   docker compose logs --tail 50 tracker
   ```
   - `ECONNREFUSED`, `Connection terminated`, timeouts: Postgres is down or
     unreachable. Go to step 2.
   - An error about the data itself: the tracker moves events with Postgres
     errors in SQLSTATE classes 22 and 23 (for example
     `invalid byte sequence for encoding "UTF8"`, code 22021) to the
     dead-letter stream by itself and does not count them here
     ([incident 004](../incidents/004-poison-event.md)). If some other error
     keeps failing on the same `stream_id`, one event is stuck. Go to "Stuck
     event" below.
2. Is Postgres up? `docker compose ps postgres` and
   `docker compose exec postgres pg_isready -U railcar`.

## Fix

**Postgres down:** start it (`docker compose start postgres`). The tracker
reconnects on its own and works through the backlog.

**Stuck event:** find the oldest unacknowledged entry, copy it to the
dead-letter stream and acknowledge it so the tracker moves on.

```
# the oldest pending entry for the tracker group
docker compose exec redis redis-cli XPENDING railcar:events tracker - + 1
# look at it (replace <id>)
docker compose exec redis redis-cli XRANGE railcar:events <id> <id>
# park it, then acknowledge it
docker compose exec redis redis-cli XADD railcar:events:dead '*' source_id <id> reason manual event '<event json>'
docker compose exec redis redis-cli XACK railcar:events tracker <id>
```

## After

Failed attempts should stop and processed events should jump while the
backlog drains. Open a ticket for any event that was parked by hand, with
the error message from the log.
