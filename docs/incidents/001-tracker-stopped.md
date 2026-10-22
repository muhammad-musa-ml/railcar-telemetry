# 001: Tracker stopped, paged after 5 minutes

**Drill:** `tracker-stop` · **Runs:** `baseline-01` to `05`, then `new-alerts-01` to `05` after the fix
**Format:** blameless; the "fault" was injected on purpose, the detection gaps were real.

## Summary

With the tracker container stopped, events kept arriving in the Redis stream
but nothing wrote them to Postgres. The first page came from `ServiceDown`
after a median of 319.4 s (316.1 to 324.7 s over 5 runs). By then every
position in the query API was more than 5 minutes old and about 8,200 events
were waiting. Restarting the tracker cleared the backlog in about 20 s.

The 5-minute delay was a choice I had made without measuring it: the only
critical alert that looks at a stopped consumer had a `for: 5m` window, and
the other two signals were slower still. The fix was a new alert on the age
of the oldest unprocessed event.

## Impact (5 runs, median and range)

| measure | value | source |
|---|---|---|
| time to page | 319.4 s (316.1-324.7) | `results/summary.json`, tracker-stop / baseline |
| worst delay seen by the canary | 321.4 s (317.7-326.6) | `max_canary_delay_s` |
| peak backlog | 8,184 entries (8,058-8,312) | `peak_backlog` |
| time to recover after restart | 19.9 s (19.0-23.1) | `ttr_s` |
| events lost | none | the tracker resumed from the consumer group's position |

## Timeline (run `baseline-02`, seconds after injection)

Sources: pager log markers and notifications (`results/runs/tracker-stop/baseline-02.json`,
`results/pager/pages.jsonl`), Prometheus `ALERTS` and series at 5 s resolution.

| t (s) | source | what happened |
|---|---|---|
| 0.0 | marker | `docker compose stop tracker` |
| 10 | Prometheus | `ServiceDown` pending (tracker scrape failing) |
| 60 | Prometheus | backlog 1,426, positions 57 s old |
| 205 | Prometheus | `StreamBacklogHigh` pending (backlog over 5,000) |
| 305 | Prometheus | `RailcarPositionsStale` pending (positions over 300 s old) |
| 310 | Prometheus | `ServiceDown` firing |
| 319.4 | pager | **page: ServiceDown** |
| 320.3 | marker | `docker compose start tracker` |
| 330 | Prometheus | freshness back to 0.001 s, backlog still 7,305 |
| 340.0 | canary | a read posted at 320.3 s is visible: caught up |
| 349.4 | pager | ServiceDown resolved |

## Root cause

The tracker is the only consumer of the stream. While it was stopped, nothing
moved events from Redis to Postgres. That part is the drill.

Why it took over five minutes to page:

- `ServiceDown` (`up == 0` for 5 minutes) was the only critical alert that
  noticed. I had given all three services the same 5-minute window, which is
  reasonable for avoiding pages during a restart, but it means a stopped
  consumer goes unnoticed for 5 minutes.
- `RailcarPositionsStale` needs positions to be over 300 s old and stay there
  for 5 minutes: 10 minutes in total.
- `StreamBacklogHigh` needs over 5,000 waiting entries for 10 minutes, and
  it only opens a ticket. At 25 events/s the backlog crosses 5,000 after
  about 205 s.
- No metric said how far behind the data was. The backlog metric counts
  entries, which depends on the traffic rate, and the freshness metric
  measures the time since the last write.

## What went well

- No events were lost. Redis kept them and the restarted tracker continued
  from the group's last delivered entry.
- After the restart the tracker processed between 323 and 360 events/s
  (30 s average, peak per run), so the backlog was gone in about 20 s.
- The `service-down` runbook named the right command.

## What went badly

- Five minutes of stale positions before anyone was told.
- The freshness metric dropped to almost 0 as soon as the tracker wrote its
  first backlogged event (at 330 s), while 7,305 older events were still
  waiting. Because it only measures when the tracker last wrote, it called
  the data current about 10 s before it was.

## Follow-ups

| # | action | status |
|---|---|---|
| 1 | Measure the age of the oldest event the tracker has not acknowledged, from the stream ids, on the ingest side so it works with the tracker down (`railcar_stream_oldest_unacked_age_seconds`). | done |
| 2 | Page on it: `RailcarEventsDelayed`, over 60 s for 1 minute, critical. Unit tests in `observability/prometheus/tests/`. | done |
| 3 | Show the oldest-event age next to freshness on the pipeline dashboard. | done |
| 4 | Keep `ServiceDown` at 5 minutes, so a restart during a deploy does not page; a stopped tracker is now caught by item 2. | decided |

## Choosing the threshold

Before each run the harness waits 30 s with the stack healthy. In those
windows of the 20 `new-alerts` runs, the oldest unacknowledged event was 0 s
old at almost every 5-second scrape and never older than 0.067 s
(`oldest_unacked_age_before_injection_s` in `results/summary.json`); a
canary read took 0.35 to 0.52 s to get through the whole pipeline. A 60 s
threshold is far above that noise, and with `for: 1m` a stopped tracker pages
about two minutes in. I did not try other values; a lower threshold would page sooner,
at the cost of paging on short pauses such as a tracker restart during a
deploy.

## Measured after the change (5 runs each, median and range)

The `new-alerts` runs used the same drill and harness, with the new metric
and rule deployed (commits `041af38` and `bea2354`).

| | before (`baseline`) | after (`new-alerts`) |
|---|---|---|
| time to page | 319.4 s (316.1-324.7) | 138.9 s (138.6-141.2) |
| alert that paged first | ServiceDown, 5 of 5 | RailcarEventsDelayed, 5 of 5 |
| worst delay seen by the canary | 321.4 s (317.7-326.6) | 140.3 s (139.9-142.9) |
| peak backlog | 8,184 (8,058-8,312) | 3,517 (3,517-3,569) |
| time to recover after restart | 19.9 s (19.0-23.1) | 10.7 s (10.4-10.9) |

Recovery got faster too, but only because the backlog was smaller when the
tracker restarted: the fix did not change how the tracker drains.

In run `new-alerts-04` the oldest event's age climbed by about 30 s every
30 s (27.7 s at 30 s, 57.7 s at 60 s, 117.6 s at 120 s), the rule went
pending at 65 s, fired at 125 s, and the page arrived at 138.9 s.
