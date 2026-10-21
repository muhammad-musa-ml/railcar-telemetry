# QueryLatencyHigh

**Severity:** warning (ticket)
**Fires when:** p95 latency of the query API's `/v1/...` routes is over 500 ms
for 10 minutes.

## What it means

Lookups still succeed but are slow. Each lookup is one indexed query on
`car_positions`, normally a few milliseconds, so a p95 over 500 ms points at
Postgres or the network path to it, not at the query service.

## Check

1. *Railcar services* dashboard, "Latency p95 by route": is it every route or
   one? One route with a slow plan suggests a missing index.
2. Open a slow trace in Jaeger (http://localhost:16686, service `query`).
   If almost all of the span time is in `pg.query`, the time is spent in
   Postgres or on the way to it.
3. Check for faults on the proxy and for slow statements:
   ```
   curl -s localhost:8474/proxies/postgres/toxics
   docker compose exec postgres psql -U railcar -d railcar -c "select pid, now() - query_start as running, query from pg_stat_activity where state <> 'idle' order by running desc limit 5"
   ```

## Fix

Remove whatever is slowing Postgres down (a stuck statement can be ended with
`select pg_cancel_backend(<pid>)`). If the tracker is affected too, its backlog
will be growing; see [stream-backlog-high](stream-backlog-high.md).
