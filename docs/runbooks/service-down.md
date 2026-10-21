# ServiceDown

**Severity:** critical (pages)
**Fires when:** `up == 0` for the `ingest`, `tracker` or `query` job for 5 minutes.

## What it means

Prometheus has not been able to scrape the service for 5 minutes. Either the
container is stopped, it is restarting in a loop, or the process is alive but
not answering HTTP.

- **ingest down:** readers get connection errors and their tag reads are not
  stored. The simulator counts these as `sim_events_sent_total{result="failed"}`.
- **tracker down:** events keep arriving in the Redis stream but nothing writes
  them to Postgres. Positions go stale and the backlog grows by the event rate
  (25 events/s with the default simulator).
- **query down:** position lookups fail.

## Check

1. Which job? The alert's `job` label says. The *Railcar services* dashboard
   panel "Scrape targets up" shows when it dropped.
2. Is the container running?
   ```
   docker compose ps <job>
   docker compose logs --tail 100 <job>
   ```
   A restart loop shows up as `Restarting` in `ps` and a repeated start-up
   line in the logs.
3. For the tracker, look at the backlog on the *Railcar pipeline* dashboard.
   The backlog tells you how long catch-up will take once it is back.

## Fix

- Stopped container: `docker compose start <job>`.
- Crash loop: read the last error in the logs before restarting it again. If
  it started after a deploy, roll back to the previous image.
- Hung process (container running, no answer on `/healthz`):
  `docker compose restart <job>`.

## After

- Tracker: watch the backlog drain to near zero and positions freshness drop
  back under a few seconds. A restarted tracker first re-reads the entries it
  had read but not acknowledged, then continues with new ones.
- Write down when it went down and when it came back for the incident record.
