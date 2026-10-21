# IngestErrorRateHigh

**Severity:** critical (pages)
**Fires when:** more than 5% of `POST /v1/events` requests in the last
minute returned 5xx, for 2 minutes.

## What it means

Readers are posting batches and getting errors. Ingest returns 503 when it
cannot append to the Redis stream, so this nearly always means Redis is down
or refusing writes. Readers are expected to retry; reads that are not retried
are lost.

400 responses (invalid batches) do not count here. They show up on the
*Railcar services* dashboard and in `ingest_batches_rejected_total{reason="invalid"}`.

## Check

```
docker compose logs --tail 50 ingest
docker compose ps redis
docker compose exec redis redis-cli INFO memory | grep used_memory_human
docker compose exec redis redis-cli INFO persistence | grep aof_last_write_status
```

## Fix

- Redis down: `docker compose start redis`. Ingest reconnects on its own.
- Redis out of memory or failing to write its append-only file: free disk or
  memory first, then restart Redis.

## After

Check `sim_events_sent_total{result="failed"}` for how many reads were
refused while it was failing.
