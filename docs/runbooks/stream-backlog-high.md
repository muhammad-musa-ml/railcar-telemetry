# StreamBacklogHigh

**Severity:** warning (ticket)
**Fires when:** undelivered plus unacknowledged entries for the `tracker`
group stay over 5000 for 10 minutes.

## What it means

The tracker is reading events more slowly than ingest is adding them, or not
at all. At the default 25 events/s, 5000 entries is about 3 minutes of
traffic. The stream is capped at roughly 200,000 entries (`MAXLEN ~`); if the
backlog reaches the cap, the oldest unread events are trimmed and lost.

## Check

1. Is the tracker running and processing anything? *Railcar pipeline*
   dashboard, "Events in and out". If processed is zero, see
   [service-down](service-down.md) or
   [tracker-processing-errors](tracker-processing-errors.md).
2. If it is processing, but slower than events arrive, look at "Tracker write
   time". A p99 that has jumped from a few milliseconds to hundreds means
   Postgres is slow. Check Postgres and the network path to it:
   ```
   docker compose exec postgres psql -U railcar -d railcar -c "select now()"
   curl -s localhost:8474/proxies/postgres/toxics
   ```
   (The second command lists toxiproxy faults; it should print `[]` outside a
   game day.)
3. Check the backlog directly:
   ```
   docker compose exec redis redis-cli XINFO GROUPS railcar:events
   ```

## Fix

- Slow Postgres: find and fix the cause (long-running queries, locks, disk).
- Tracker stopped or failing: see the linked runbooks.
- If the backlog is close to the 200,000 cap and cannot be drained soon,
  raise the cap before events are trimmed (`STREAM_MAXLEN` in
  `src/shared/stream.ts`) and redeploy ingest.

## After

Watch the backlog fall. The tracker drains it far faster than the arrival
rate once the cause is fixed.
