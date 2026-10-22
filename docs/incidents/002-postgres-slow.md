# 002: Slow Postgres, no page for 20 minutes

**Drill:** `postgres-latency` · **Runs:** `baseline-01` to `05`, then `new-alerts-01` to `05` after the fix
**Format:** blameless.

## Summary

toxiproxy added 100 ms to every response from Postgres. Nothing failed: every
write and every lookup succeeded, only more slowly. The tracker writes one
event per round trip, so its throughput fell from the arrival rate of 25
events/s to about 9.5 events/s, and a backlog grew by roughly 15 events every
second.

In none of the 5 runs did anything page within the 20-minute observation
window. One ticket, `StreamBacklogHigh`, arrived after a median of 928.7 s
(924.4 to 932.2 s). A read posted during the slowdown took up to 754.9 s
(median of the 5 runs) to show up in the query API, while the freshness
metric said positions were never more than 0.6 s old.

## Impact (5 runs, median and range)

| measure | value | source |
|---|---|---|
| pages within 20 minutes | 0 of 5 runs | `results/summary.json`, postgres-latency / baseline |
| time to ticket (StreamBacklogHigh) | 928.7 s (924.4-932.2) | `ttd_ticket_s` |
| tracker throughput during the fault | about 9.5 events/s, against 25 arriving | `processed_per_s` series in each run |
| worst delay seen by the canary | 754.9 s (754.3-755.1) | `max_canary_delay_s` |
| highest freshness value reported | 0.2 s (0.1-0.6) | `peak_freshness_s` |
| peak backlog | 19,230 entries (19,201-19,263) | `peak_backlog` |
| lookup p95 (histogram, 5-minute window), peak during the fault | 243 ms in every run, against 5 to 6 ms before it | `results/evidence/postgres-latency-baseline-lookup-p95.json` |
| time to recover after removing the latency | 37.4 s (36.5-38.8) | `ttr_s` |

## Timeline (run `baseline-04`, seconds after injection)

| t (s) | source | what happened |
|---|---|---|
| 0.0 | marker | toxiproxy latency toxic added (100 ms, downstream) |
| 60 | Prometheus | tracker at 9.44 events/s, backlog 920, freshness 0.05 s |
| 60.3 | canary | a read posted now became visible 102.1 s later |
| 300 | Prometheus | backlog 4,773, freshness 0.09 s |
| 315 | Prometheus | `StreamBacklogHigh` pending (backlog over 5,000) |
| 600 | Prometheus | backlog 9,588, freshness 0.10 s |
| 600.2 | canary | a read posted now became visible 608.3 s later |
| 915 | Prometheus | `StreamBacklogHigh` firing |
| 928.7 | pager | ticket: StreamBacklogHigh |
| 1200.5 | marker | end of the 20-minute window: toxic removed |
| 1237.7 | canary | a read posted at 1200.5 s is visible: caught up |
| 1258.4 | pager | StreamBacklogHigh resolved |

## Root cause

The fault was the drill. Nobody was told because every signal I had was
built around a tracker that stops. A tracker that slows down got past all of
them:

- **Freshness looked perfect.** `railcar_positions_freshness_seconds` is the
  time since the last write to `car_positions`. A slow tracker still writes
  about ten rows a second, so freshness stayed under a second while the rows
  it was writing were minutes old.
- **No errors.** Every write succeeded, so `TrackerProcessingErrors` had
  nothing to count.
- **Lookups stayed under the latency threshold.** Each lookup is one query.
  The p95 computed from the histogram rose from about 5 ms to 243 ms (it
  interpolates inside the 100-250 ms bucket), still well below the 500 ms in
  `QueryLatencyHigh`.
- **The backlog alert was slow, and only a ticket.** `StreamBacklogHigh`
  needs 5,000 waiting entries (reached after about 5 minutes here) and then
  10 more minutes.

## What went well

- The tracker kept working and lost nothing. Once the latency was removed it
  drained about 19,000 events in under 40 s.
- The *Railcar pipeline* dashboard showed the problem to anyone who looked:
  processed 9.5/s against accepted 25/s, and a steadily climbing backlog.

## What went badly

- No page at all. Of the four faults I tried, a slow dependency was the one
  my alerts did not cover.
- The freshness stat on the dashboard stayed green the whole time.

## Follow-ups

| # | action | status |
|---|---|---|
| 1 | Page on the age of the oldest unacknowledged event, `RailcarEventsDelayed` (see [001](001-tracker-stopped.md)). | done |
| 2 | Show that age next to freshness on the dashboard, so the difference is visible. | done |
| 3 | Write events in batches (one multi-row upsert per read of up to 100 events) so a slow round trip costs less throughput. | not done: a change to how the tracker writes, which would also change what this drill measures; it is the next thing to try |

## Measured after the change (5 runs each, median and range)

| | before (`baseline`) | after (`new-alerts`) |
|---|---|---|
| runs that paged | 0 of 5 within 20 min | 5 of 5 |
| time to page | none | 173.7 s (173.6-174.1), RailcarEventsDelayed |
| worst delay seen by the canary | 754.9 s (754.3-755.1) | 108.9 s (108.7-110.7) |
| peak backlog | 19,230 (19,201-19,263) | 2,779 (2,775-2,796) |
| time to recover after removing the latency | 37.4 s (36.5-38.8) | 5.6 s (5.5-6.1) |

The page takes longer here than for a stopped tracker (about 139 s) because
the tracker is still processing, so the oldest event ages at about 0.6 s per
second instead of 1 s per second: in run `new-alerts-02` it was 17.8 s old
at 30 s, 36.7 s at 60 s and 74.7 s at 120 s, the rule went pending at 100 s
and fired at 160 s.
