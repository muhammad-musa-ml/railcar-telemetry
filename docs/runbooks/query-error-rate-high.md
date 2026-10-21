# QueryErrorRateHigh

**Severity:** critical (pages)
**Fires when:** more than 5% of `/v1/...` requests to the query API in the
last minute returned 5xx, for 2 minutes.

## What it means

Position lookups are failing. The query API returns 503 when Postgres does
not answer, so this usually means Postgres is down or unreachable. When that
is the cause, the tracker cannot write either, and the backlog is growing.

## Check

```
docker compose logs --tail 50 query
docker compose ps postgres toxiproxy
docker compose exec postgres pg_isready -U railcar
```

The services connect to Postgres through toxiproxy. If Postgres is healthy
but the services cannot reach it, check the proxy:

```
curl -s localhost:8474/proxies/postgres
```

`"enabled": false` or a toxic in the list means the path to Postgres is
broken, not Postgres itself.

## Fix

- Postgres stopped: `docker compose start postgres`.
- Proxy disabled or a toxic left behind:
  `curl -s -X POST localhost:8474/proxies/postgres -d '{"enabled":true}'` and
  delete the toxic with `curl -s -X DELETE localhost:8474/proxies/postgres/toxics/<name>`.

## After

Confirm the tracker's backlog drains (see
[stream-backlog-high](stream-backlog-high.md)); a Postgres outage affects both
reads and writes.
