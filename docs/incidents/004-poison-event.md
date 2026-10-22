# 004: One bad event stopped the tracker for ten minutes

**Drill:** `poison-event` · **Runs:** `baseline-01` to `05`, `new-alerts-01` to `05`, then `dead-letter-01` to `05` after the tracker fix
**Format:** blameless.

## Summary

One event whose `location` contained a NUL character was written straight
into the stream. It is valid JSON and it passed the event schema of the time,
but Postgres refuses to store a NUL in a text column (`invalid byte sequence
for encoding "UTF8": 0x00`, SQLSTATE 22021). The tracker treated the error like any other
failed write: it kept the event unacknowledged and retried it every 5
seconds, and because it always retries from its oldest unacknowledged entry,
nothing behind the bad event was processed. The whole pipeline stopped.

A ticket (`TrackerProcessingErrors`) came after a median of 318.2 s; the
first page (`RailcarPositionsStale`) after 617.9 s (615.2 to 620.4 s over 5
runs). Parking the event by hand, as the runbook says, got the pipeline
caught up 35.3 s later (32.7 to 37.9 s).

## Impact (5 runs, median and range)

| measure | value | source |
|---|---|---|
| time to page | 617.9 s (615.2-620.4) | `results/summary.json`, poison-event / baseline |
| time to ticket | 318.2 s (315.5-320.6) | `ttd_ticket_s` |
| events processed while stuck | 0 | `processed_per_s` series in each run |
| failed write attempts | 125.2 (124.4-127.3) | `failed_attempts` |
| worst delay seen by the canary | 623.1 s (617.9-623.2) | `max_canary_delay_s` |
| peak backlog | 15,811 entries (15,759-15,886) | `peak_backlog` |
| time to recover after parking the event | 35.3 s (32.7-37.9) | `ttr_s` |

## Timeline (run `baseline-04`, seconds after injection)

| t (s) | source | what happened |
|---|---|---|
| 0.0 | marker | event with a NUL in `location` added with `XADD` |
| 5 | Prometheus | `TrackerProcessingErrors` pending; tracker retrying every 5 s, processing nothing |
| 60 | Prometheus | backlog 1,403, positions 57 s old |
| 205 | Prometheus | `StreamBacklogHigh` pending |
| 305 | Prometheus | `TrackerProcessingErrors` firing; `RailcarPositionsStale` pending |
| 318.2 | pager | ticket: TrackerProcessingErrors |
| 600 | Prometheus | backlog 15,172, positions 597 s old |
| 605 | Prometheus | `RailcarPositionsStale` firing |
| 617.9 | pager | **page: RailcarPositionsStale** |
| 618.4 | marker | runbook step: copy the oldest pending entry to `railcar:events:dead`, acknowledge it |
| 630 | Prometheus | freshness back to 0.001 s |
| 647.9 | pager | RailcarPositionsStale resolved |
| 656.4 | canary | a read posted at 618.4 s is visible: caught up |
| 947.7 | pager | TrackerProcessingErrors resolved |

`StreamBacklogHigh` was pending from 205 s but never fired: with `for: 10m`
it would have needed 805 s.

## Root cause

The tracker had two kinds of failure handling:

- an event it could not **decode** went to the dead-letter stream;
- any **write** error was treated as temporary: leave the event
  unacknowledged, back off, and retry from the oldest unacknowledged entry,
  to keep the events of each car in order.

The second rule is right for a Postgres outage and wrong for an event that
Postgres will never accept. Nothing distinguished the two. The event schema
allowed control characters in `location`, so the bad event looked valid all
the way to the database.

In the drill the event bypassed ingest (it was written with `XADD`, as a
backfill script or a second producer would). Ingest's validation had the same
gap, so the same event posted to `POST /v1/events` would have been accepted.

## What went well

- No event was lost. Every event behind the bad one stayed in the stream and
  was written once the bad one was parked.
- The runbook's stuck-event steps worked as written and took about 2 s to run.

## What went badly

- Ten minutes of no processing at all before the page.
- The ticket after five minutes said "failing to write events", which was
  true but read like a database problem.
- Parking the event by hand left no trace in `tracker_events_dead_lettered_total`,
  so `DeadLetteredEvents` never fired for it.
- `RailcarPositionsStale` resolved before the pipeline had caught up: a
  median of 5.4 s before, 3.6 to 8.5 s over the 5 runs
  (`results/evidence/alerts-resolved-after-recovery.json`). Freshness drops
  to zero with the first backlogged write.

## Follow-ups

| # | action | status |
|---|---|---|
| 1 | `RailcarEventsDelayed` (see [001](001-tracker-stopped.md)): a stuck event is the oldest unacknowledged entry, so its age climbs at one second per second. | done |
| 2 | Tracker: a Postgres error in SQLSTATE class 22 (data exception) or 23 (integrity constraint violation) moves the event to the dead-letter stream with the error as the reason, and processing continues. Connection errors and timeouts are still retried. | done |
| 3 | Event schema: reject control characters in `reader_id` and `location`, so ingest refuses such a batch with 400. | done |
| 4 | Dead-letter any event after N failed attempts, whatever the error. | rejected: during a Postgres outage every event fails, so this would dead-letter good events (see [003](003-postgres-stopped.md)) |
| 5 | Export the dead-letter counter at 0 for every reason from start-up (found in the `dead-letter` runs, below). | done |

## Measured after the changes (5 runs each, median and range)

Two rounds after the baseline: `new-alerts` with follow-up 1 only (the
tracker unchanged, so it still stalled), then `dead-letter` with item 2 as
well. Item 3 was deployed after these runs.

| | `baseline` | `new-alerts` | `dead-letter` |
|---|---|---|---|
| runs that paged | 5 of 5 | 5 of 5 | 0 of 5 (5-minute window) |
| time to page | 617.9 s (615.2-620.4) | 137.3 s (131.9-137.9) | none: nothing was stuck |
| first ticket | 318.2 s (315.5-320.6), TrackerProcessingErrors | 137.3 s (131.9-137.9), TrackerProcessingErrors | 19.6 s (16.8-20.8), DeadLetteredEvents, in 4 of 5 runs |
| worst delay seen by the canary | 623.1 s (617.9-623.2) | 141.8 s (136.6-141.9) | 0.5 s (0.5-0.6) |
| peak backlog | 15,811 (15,759-15,886) | 3,596 (3,468-3,646) | 0 |
| failed write attempts | 125.2 (124.4-127.3) | 29.2 (29.2-30.4) | 0 |
| caught up after the runbook step | 35.3 s (32.7-37.9) | 13.0 s (12.3-13.7) | the step found nothing stuck in 5 of 5 |

Source: `results/summary.json` (poison-event, all three labels). For
comparison, a canary read took 0.43 s (0.38-0.53) in the 30 s before
injection in the `dead-letter` runs.

With the tracker change, the bad event went to the dead-letter stream on the
first attempt, with the reason `rejected by Postgres: 22021 ...`; its
dead-letter entry was written 4 to 38 ms after the event itself in the 5 runs
(`results/evidence/dead-letter-entries.json`). The events behind it were
written as if nothing had happened.

After item 3 was deployed, the same event no longer reaches Postgres: the
tracker decodes events with the same schema as ingest, and in the single
check below it was dead-lettered with the reason `event failed validation:
must not contain control characters` (same file). The SQLSTATE rule stays as
the second line of defence for data errors the schema does not know about.

### The missing ticket in run `dead-letter-01`

In the first `dead-letter` run no ticket arrived at all; in runs 2 to 5 it
came after 16.8 to 20.8 s. The tracker had just been restarted with the new
code, and `tracker_events_dead_lettered_total{reason="rejected"}` did not
exist until the first dead letter created it, with the value 1. Prometheus'
`increase()` needs two samples of a series to see an increase, so a series
that starts at 1 shows none, and `DeadLetteredEvents` never fired. From run 2
on, the series already existed and went from 1 to 2.

The rule's promtool test had not caught this because I fed it a series that
started at 0. The tracker now exports every reason at 0 from start-up, and a
second promtool case shows that a series first appearing at 1 does not fire.
A single check after that change (restart the tracker, wait 30 s, write one
bad event; `results/evidence/first-dead-letter-after-restart.json`) got the
ticket 23.7 s after the event was written. I ran that check once; there is
no drill round behind that number.
