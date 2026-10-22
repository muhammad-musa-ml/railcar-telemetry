# 003: Postgres stopped; the page came late and the proxy looked outside

**Drill:** `postgres-stop` · **Runs:** `baseline-01` to `05`, then `new-alerts-01` to `05` after the fixes
**Format:** blameless.

## Summary

With Postgres stopped, the tracker could not write and the query API answered
every lookup with 503. The first page, `QueryErrorRateHigh`, came after a
median of 376.0 s (361.0 to 381.3 s over 5 runs). A ticket,
`TrackerProcessingErrors`, came about a minute earlier. After Postgres was
started again it took a median of 35.7 s (25.4 to 41.6 s) until the pipeline
had caught up.

Reading the toxiproxy logs afterwards showed something I had not expected:
while the Postgres container was stopped, its name no longer resolved inside
Docker, the lookup fell through to the host's DNS, and toxiproxy connected to
a machine outside the compose network on port 5432. It kept doing so for up
to 18 s after Postgres was back.

## Impact (5 runs, median and range)

| measure | value | source |
|---|---|---|
| time to page | 376.0 s (361.0-381.3) | `results/summary.json`, postgres-stop / baseline |
| time to ticket | 320.5 s (319.7-325.2) | `ttd_ticket_s` |
| worst delay seen by the canary | 382.1 s (381.3-401.9) | `max_canary_delay_s` |
| peak backlog | 9,741 entries (9,741-10,251) | `peak_backlog` |
| failed lookups seen by the simulator | 475.7 to 506.2 per run | `sim_failed_lookups` in each run file |
| time to recover after `docker compose start postgres` | 35.7 s (25.4-41.6) | `ttr_s` |
| connection attempts toxiproxy sent outside the compose network | 15 to 19 per run | `results/evidence/postgres-stop-baseline-upstream.json` |

## Timeline (run `baseline-02`, seconds after injection)

| t (s) | source | what happened |
|---|---|---|
| 0.0 | marker | `docker compose stop postgres` |
| 15 | Prometheus | `TrackerProcessingErrors` pending |
| 30 | Prometheus | query API returning 503 at about 1.5 per second; tracker processing 0 events/s |
| 65 | Prometheus | `QueryErrorRateHigh` pending |
| 310 | Prometheus | `TrackerProcessingErrors` firing |
| 325.2 | pager | ticket: TrackerProcessingErrors |
| 365 | Prometheus | `QueryErrorRateHigh` firing |
| 376.0 | pager | **page: QueryErrorRateHigh** |
| 376.2 | marker | `docker compose start postgres` |
| 411.8 | canary | a read posted at 376.2 s is visible: caught up |
| 645.9 | pager | QueryErrorRateHigh resolved |
| 715.0 | pager | TrackerProcessingErrors resolved |

## Root cause

Stopping Postgres was the drill. Three things made it worse than it had to
be.

**The error-ratio alert was slow to start.** `QueryErrorRateHigh` divides
5xx responses by all responses over a 5-minute window. When Postgres went
away, the window still held 5 minutes of successful lookups, so even with
every new lookup failing the ratio only passed 5% after about a minute. Then
the `for: 5m` window started. Lookups also slowed to about 1.5 per second,
which fits each one waiting out the query service's 3-second connection
timeout, so the failures piled up slowly.

**The alerts outlived the outage.** The same 5-minute windows kept
`QueryErrorRateHigh` firing for 234.1 s after the pipeline had caught up
(resolved at 645.9 s, caught up at 411.8 s) and `TrackerProcessingErrors`
for 303.2 s. Over the 5 runs that was 3.8 to 4.1 minutes and 4.6 to 5.1
minutes. Someone on call would have seen alerts still firing well after the
fix.

**The database name fell through to the host's DNS.** toxiproxy's upstream
was the service name `postgres`. While the container was stopped, Docker's
DNS had no record for it and passed the query on to the host's resolver,
which answered with a real address outside the compose network (most likely
by adding the host network's DNS suffix to the bare name). A throwaway
`alpine` container running `nslookup postgres` on a fresh Docker network got
an outside address in the same way, on a normal and on an `internal`
network (`gamedays/dns-check.sh`, output in `results/evidence/dns-check.txt`).
toxiproxy then connected there; the connections were refused. In every run,
all or all but one of the failed upstream connections went outside. This
also slowed recovery: the outside answer was still being used 1 to 18 s
after Postgres reported it was ready, and the two longest recoveries (40.1
and 41.1 s after Postgres was ready) are the two runs where it lasted 17 and
18 s. A Postgres client
following that answer could have sent its user name to an unknown server.

## What went well

- Events were not lost: ingest kept accepting reads into Redis, the tracker
  kept every failed event unacknowledged and wrote all of them once Postgres
  was back.
- The tracker's retry and backoff needed no restart.

## What went badly

- Over six minutes to the first page while every lookup failed.
- Alerts kept firing for minutes after recovery.
- Connections to an address outside the compose network.
- `RailcarPositionsStale` could not help: the freshness metric is computed
  from Postgres, so it disappears when Postgres is down.

## Follow-ups

| # | action | status |
|---|---|---|
| 1 | `RailcarEventsDelayed` (see [001](001-tracker-stopped.md)) also covers this case: the oldest unacknowledged event keeps ageing while every write fails. | done |
| 2 | Give Postgres a fixed address on its own internal network and point toxiproxy at the address, so no lookup can leave the compose network. | done |
| 3 | Compute the error ratios (`QueryErrorRateHigh`, `IngestErrorRateHigh`) and `TrackerProcessingErrors` over 1 minute instead of 5, with `for: 2m`, so they start sooner and stop soon after recovery. | done |

## Measured after the changes (5 runs each, median and range)

All three follow-ups were deployed for the `new-alerts` runs.

| | before (`baseline`) | after (`new-alerts`) |
|---|---|---|
| time to page | 376.0 s (361.0-381.3), QueryErrorRateHigh | 139.6 s (136.7-140.4), RailcarEventsDelayed |
| time to ticket (TrackerProcessingErrors) | 320.5 s (319.7-325.2) | 144.6 s (141.7-145.4) |
| worst delay seen by the canary | 382.1 s (381.3-401.9) | 141.8 s (140.9-141.9) |
| peak backlog | 9,741 (9,741-10,251) | 3,569 (3,544-3,621) |
| time to recover after starting Postgres | 35.7 s (25.4-41.6) | 10.9 s (9.4-13.7) |
| recovered after Postgres reported ready | 24.9 to 41.1 s | 9.0 to 13.2 s |
| connection attempts sent outside the compose network | 15 to 19 per run | 0 in every run |
| QueryErrorRateHigh resolved, after recovery | 234.1 s (227.2-243.4) | 58.7 s (56.7-59.8)* |
| TrackerProcessingErrors resolved, after recovery | 282.9 s (277.1-303.2) | 53.5 s (50.9-54.6) |

\* In one `new-alerts` run `QueryErrorRateHigh` first fired after the pipeline
had already recovered, so that run is not counted here.

Sources: `results/summary.json` (postgres-stop / baseline and new-alerts),
`results/evidence/postgres-stop-baseline-upstream.json`,
`results/evidence/postgres-stop-new-alerts-upstream.json`,
`results/evidence/alerts-resolved-after-recovery.json`.

With the fixed address, every failed connection toxiproxy logged went to
Postgres's own address (263 to 277 per run, against 15 to 19 before). The
pipeline had caught up 9.0 to 13.2 s after Postgres reported ready. Recovery
was also faster because the backlog was smaller: with the page at about
140 s instead of 376 s, about 3,600 events had queued instead of 9,700.
