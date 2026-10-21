# RailcarEventsDelayed

**Severity:** critical (pages)
**Fires when:** the oldest event the tracker has not acknowledged has been in
the stream for more than 60 seconds, for 1 minute.

## What it means

`railcar_stream_oldest_unacked_age_seconds` is computed by ingest from Redis
on every scrape: the stream id of the oldest entry that the `tracker` group
has not finished (the oldest pending entry, or else the first undelivered
one), compared with the Redis clock. Normally it is around a second. Over 60
seconds means positions served by the query API are at least that far behind
the readers, whatever the reason:

- the tracker is stopped or crash-looping;
- the tracker is running but stuck retrying one event;
- the tracker is running but writing slower than events arrive (slow Postgres);
- Postgres is down, so every write fails.

This alert was added after the first game days
([incident 001](../incidents/001-tracker-stopped.md)): each of these faults
used to page late or not at all.

## Check

Open the *Railcar pipeline* dashboard and look at "Events in and out" and
"Tracker write time":

| what you see | likely cause | go to |
|---|---|---|
| processed is zero, no failed attempts, tracker target down | tracker stopped | [service-down](service-down.md) |
| processed is zero, failed attempts every few seconds | one event or Postgres failing | [tracker-processing-errors](tracker-processing-errors.md) |
| processed above zero but below accepted, write time p99 far above normal | slow Postgres | [stream-backlog-high](stream-backlog-high.md) |

```
docker compose ps tracker postgres
docker compose logs --tail 30 tracker
```

## Fix

Follow the linked runbook for the cause. Once the tracker is writing at full
speed it drains the backlog at several hundred events per second; the alert
resolves when the oldest waiting event is younger than 60 seconds again.

## After

Record how old the oldest event got (the dashboard's "Oldest unprocessed
event" panel); that is how stale the query API was at worst.
