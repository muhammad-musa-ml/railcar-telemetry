# Design notes

## What the services do

```
reader-sim ──POST /v1/events──> ingest ──XADD──> Redis stream ──XREADGROUP──> tracker ──upsert──> Postgres
                                                 railcar:events                                     │
reader-sim ──GET /v1/cars/:id──────────────────────────────────────────────────────> query ─────────┘
```

- **ingest** validates batches of tag reads (one batch per reader post, up to
  500 reads, accepted or rejected as a whole) and appends each read to the
  stream `railcar:events`.
- **tracker** is the only member of the consumer group `tracker`. For each
  read it upserts the car's row in `car_positions`, then acknowledges the
  entry.
- **query** serves a car's latest position and dwell time, and the cars at a
  location.
- **pager** stands in for a paging service: Alertmanager posts to it and it
  records every notification with the time it arrived.
- **reader-sim** sends 25 synthetic reads per second for 2,000 made-up cars
  moving around 24 made-up yards, and 5 lookups per second.

All five run from one Node.js image; the compose file chooses the entry point.
They share one TypeScript package (`src/shared` holds the event schema,
stream names, metrics and tracing setup), but each runs in its own container
with its own health check, metrics endpoint and failure modes.

## Transport: Redis Streams

I chose Redis Streams over Kafka/Redpanda and NATS JetStream.

What I needed from the transport:

1. **At-least-once delivery with redelivery after a crash.** A consumer group
   gives each entry to the tracker once, and the entry stays in the group's
   pending list until the tracker acknowledges it. If the tracker dies
   between reading and acknowledging, it re-reads its pending entries on
   start-up (it uses a fixed consumer name, `tracker-1`, for this reason).
2. **A backlog number that does not depend on the consumer being alive.**
   `XINFO GROUPS` reports, per group, how many entries have not been
   delivered (`lag`, Redis 7+) and how many are delivered but not
   acknowledged (`pending`). Ingest reads these on every scrape, so the
   backlog is still measured when the tracker is down.
3. **Small and quick to start.** One container with no JVM and nothing else
   to coordinate. The whole stack has to come up with one
   `docker compose up` on a laptop.

Redis stream ids are `<milliseconds>-<sequence>`, where the milliseconds are
the Redis server time when the entry was added. That made a later metric,
the age of the oldest unprocessed event, a cheap computation (see
[incident 001](incidents/001-tracker-stopped.md)).

What I gave up, compared with Kafka or Redpanda:

- **No partitions.** One consumer handles everything. At 25 reads/s the
  tracker uses a small fraction of its capacity, so this is not a limit for
  this project. Adding consumers to the group would work, but then two reads
  of the same car could be applied out of order; the upsert's
  `WHERE last_seen_at < new.last_seen_at` clause keeps the newest read in
  that case.
- **Retention by length.** Ingest trims the stream to about
  200,000 entries (`XADD ... MAXLEN ~`), a little over two hours at the
  simulator's rate. If the tracker is down for longer than that, the oldest
  unread events are trimmed before they are processed.
- **Durability depends on Redis persistence.** The compose file runs Redis
  with the append-only file on and the default `fsync everysec`, so a Redis
  crash can lose up to about a second of acknowledged writes.

NATS JetStream would have covered points 1 and 3 as well, with built-in
redelivery limits. I picked Redis because I already knew its data model and
because point 2 is a single command.

## Writing positions

`car_positions` has one row per car. The tracker writes each read with one
`INSERT ... ON CONFLICT (car_id) DO UPDATE ... WHERE car_positions.last_seen_at < EXCLUDED.last_seen_at`:

- a read older than (or equal to) the stored one changes nothing, so a
  redelivered or out-of-order read cannot move a car backwards;
- `arrived_at` is kept while the car is read at the same location and reset
  when it shows up somewhere else. Dwell time is `now() - arrived_at`,
  computed by the query service with the database clock.

All timestamps are `timestamptz` in UTC. Reads carry the reader's
`observed_at`; `updated_at` is the database time of the write.

## Fault injection seams

The tracker and the query service reach Postgres through toxiproxy
(`toxiproxy:15432`), so a game day can add latency or cut the connection
without touching Postgres. The other faults use the Docker API (stopping a
container) or Redis (writing an entry directly into the stream).

Postgres sits alone on an internal network (`db`, 10.203.17.0/29) with a
fixed address, and toxiproxy dials that address instead of the name
`postgres`. With the name, a stopped Postgres container made the lookup fall
through to the host's DNS ([incident 003](incidents/003-postgres-stopped.md)).
If that subnet clashes with a network on your machine, change it in
`docker-compose.yml` and `docker/toxiproxy.json` together.

## Observability

- **Metrics:** every service exposes `/metrics` (prom-client). HTTP request
  counts and latency histograms are labelled by route template, never by raw
  URL, so car ids do not become label values. Prometheus scrapes every 5
  seconds and evaluates rules every 5 seconds.
- **Freshness** (`railcar_positions_freshness_seconds`) is measured by the
  query service from Postgres: seconds since the newest write to
  `car_positions`. A tracker that writes old events slowly still keeps it
  near zero ([incident 002](incidents/002-postgres-slow.md)).
- **Oldest unprocessed event** (`railcar_stream_oldest_unacked_age_seconds`)
  is measured by ingest from Redis on every scrape: the time since the oldest
  entry the tracker group has not acknowledged was added, using the stream
  id's timestamp and the Redis clock. This is what `RailcarEventsDelayed`
  pages on.
- **Traces:** OpenTelemetry instrumentation for http, pg and ioredis, sent
  over OTLP to an OTel Collector and from there to Jaeger. Ingest writes the
  W3C `traceparent` into each stream entry and the tracker continues that
  trace, so one trace covers the reader's POST, the `XADD`, the tracker's
  processing and the `INSERT`.
- **Logs:** JSON on stdout (pino) with `trace_id` and `span_id` when a span
  is active.
