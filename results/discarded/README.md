# Discarded runs

Runs kept for the record but left out of `runs.csv` and the summary, with the
reason.

## postgres-stop-baseline-01.json

The first `postgres-stop` run showed a peak backlog of 2,591 entries over
389 seconds, about 7 events/s instead of the simulator's 25. The simulator
sent reads and lookups from one loop that skipped a second whenever the
previous second's requests were still running. With Postgres down, each
lookup waited for its 5-second timeout, so most seconds were skipped and the
simulated readers stopped reporting too. Real readers do not depend on the
query API.

I stopped the round, gave reads and lookups separate loops
(`src/sim/main.ts`), and started the `postgres-stop` baseline again. The five
`tracker-stop` baseline runs were kept: during those runs the query API
answered normally, so the simulator never skipped a second. Checked in
Prometheus on 2026-10-21:

| query | evaluated at (UTC) | result |
|---|---|---|
| `sum(increase(sim_ticks_skipped_total[32m]))` | 19:00:30 (covers the five tracker-stop runs) | 0 |
| `sum(increase(sim_events_sent_total[32m]))` | 19:00:30 | 48,022 (25.0/s) |
| `sum(increase(sim_ticks_skipped_total[6m]))` | 19:06:50 (inside the discarded run) | 270 |
