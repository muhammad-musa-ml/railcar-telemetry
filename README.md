# railcar-telemetry

Small Node.js services that track where railcars are, plus everything needed
to run them on call: Prometheus metrics, OpenTelemetry traces, Grafana
dashboards, alert rules with unit tests, a local pager, a runbook for every
alert, an operations console, fault-injection drills, and a written
retrospective for each drill.

I built it to practise the operational side of running services: choosing
what to alert on, measuring how long an alert takes to reach someone, and
changing the alerts and the code based on what a drill shows.

**All data is synthetic.** The cars (reporting mark `RCTX`), trackside
readers and yards are invented by a simulator. Nothing here comes from a real
railroad.

## What it does

A railcar carries an RFID tag; trackside readers at yards report each tag
they read. Here a simulator plays the readers:

```
reader-sim ─POST /v1/events─> ingest ─XADD─> Redis stream ─XREADGROUP─> tracker ─upsert─> Postgres
                                             railcar:events                                   │
reader-sim ─GET /v1/cars/:id──────────────────────────────────────────────────────> query ────┘
```

| service | what it does | port |
|---|---|---|
| ingest | validates batches of tag reads and appends them to a Redis stream | 8081 |
| tracker | consumes the stream and keeps each car's latest location and arrival time in Postgres | 8082 (metrics only) |
| query | returns a car's position and dwell time, or the cars at a yard | 8083 |
| pager | stands in for a paging service; records every alert notification with its arrival time | 8084 |
| console | one screen for the pipeline, alerts, pages and dead letters, with the operator actions the runbooks need ([below](#operations-console)) | 8085 |
| reader-sim | 25 tag reads/s for 2,000 made-up cars over 24 made-up yards, plus 5 lookups/s | |

Observability around them:

| component | port | |
|---|---|---|
| Grafana | 3000 | dashboards *Railcar pipeline* and *Railcar services*, provisioned from `observability/grafana/` |
| Prometheus | 9090 | scrapes every service every 5 s; alert rules in `observability/prometheus/rules/` |
| Alertmanager | 9093 | critical alerts go to the pager's `page` receiver, warnings to `ticket` |
| Jaeger | 16686 | traces from ingest and tracker, through the OpenTelemetry Collector |
| toxiproxy | 8474 | sits between the services and Postgres so drills can add latency |

Why Redis Streams, how positions are written, and how traces cross the
stream: [docs/design.md](docs/design.md).

## Running it

Needs Docker with Compose. Node.js 22 is only needed for the tests and the
drills.

```
docker compose up -d --build --wait
```

Then:

```
curl -s "localhost:8083/v1/cars/RCTX%20100005"
curl -s "localhost:8083/v1/locations/YD03/cars?limit=5"
```

Grafana is at http://localhost:3000 (anonymous read access), Jaeger at
http://localhost:16686, the pager's log at http://localhost:8084/v1/pages,
and the operations console at http://localhost:8085.

## Operations console

Running the stack on call meant visiting Prometheus, Alertmanager, Grafana,
the pager's log and `redis-cli` separately, and the dead-letter runbook
fixed things with Redis commands typed by hand. The console is one page for
all of it, served by its own service on port 8085:

- **Overview:** which scrape jobs are up, the pipeline numbers the alert
  rules watch (oldest unprocessed event, stream backlog, time since the last
  position write, the two 5xx ratios) next to each rule's threshold, firing
  and pending alerts with their runbook links, pages and tickets from the
  last 24 hours, and how many events are dead-lettered.
- **Dead letters:** the entries in `railcar:events:dead` with their reason
  and the stored event. **Replay** puts an event back into `railcar:events`
  after checking it against the current event schema, and refuses one that
  would be dead-lettered again. **Discard** removes one, with a reason.
- **Lookup:** a car's position and dwell time, and the cars at a location.

A firing alert can also be **silenced** from the overview, for 1 to 720
minutes, with a reason. Every action needs an operator token and writes a
row to `console_audit` in Postgres, which refuses `UPDATE`, `DELETE` and
`TRUNCATE`; refused and unauthorised attempts are recorded too.

It starts with the rest of the stack. Operator tokens come from the
environment as `name:token` pairs, each token at least 16 characters:

```
CONSOLE_OPERATOR_TOKENS="alice:<long random token>,bob:<another one>" docker compose up -d --wait
```

Without the variable, `docker-compose.yml` sets up one operator, `operator`,
with the placeholder token `local-only-not-a-secret`, which is fine for this
local stack and nothing else. Paste a token into the page's *Operator token*
field; it stays in that browser tab's memory. The audit trail:

```
docker compose exec postgres psql -U railcar -d railcar -c "SELECT at, operator, action, target, result FROM console_audit ORDER BY id DESC LIMIT 20"
```

Why there is a service between the browser and Prometheus, Alertmanager and
Redis, why replay re-validates, and what token auth does not give you:
[docs/console.md](docs/console.md).

## Tests

```
npm ci
npm run lint
npm run typecheck
npm test                    # unit tests
npm run test:ui             # the console page's component tests
npm run build:ui            # builds the console page to dist/console-ui
npm run check:alerting      # promtool check config, promtool test rules, amtool check-config
npm run test:integration    # needs the compose stack running
npx playwright install chromium
npm run test:e2e            # browser test of the console page; needs the stack too
```

The integration tests post reads and check they come out of the query API,
check that every dashboard query evaluates, that one trace covers both the
ingest request and the tracker's write, and that Alertmanager routes a
critical alert to the `page` receiver and a warning to `ticket`. For the
console they check that the status shows the tracker down after
`docker compose stop tracker`, that a valid dead-lettered event replays and
its position appears through the query API, that an invalid one is refused
and stays dead-lettered, that a silence reaches Alertmanager, that an action
without a token is refused and recorded, and that `console_audit` refuses
`UPDATE`, `DELETE` and `TRUNCATE`. The browser test opens the console in
Chromium and replays a dead-lettered event from the page. If you set your
own `CONSOLE_OPERATOR_TOKENS`, give the tests one of them in
`CONSOLE_OPERATOR_NAME` and `CONSOLE_OPERATOR_TOKEN`.

`.github/workflows/ci.yml` runs the same commands on GitHub Actions; the
integration job starts the stack with `docker compose up` first and runs the
browser test after the integration tests. The drills are not part of CI:
one round of all four took over an hour here.

## Alerts and runbooks

Rules: [`observability/prometheus/rules/railcar.rules.yml`](observability/prometheus/rules/railcar.rules.yml),
tested with `promtool test rules` in
[`observability/prometheus/tests/`](observability/prometheus/tests/). Every
alert's `runbook_url` points at its runbook, and a unit test checks that each
alert has one.

| alert | fires when | goes to | runbook |
|---|---|---|---|
| RailcarEventsDelayed | the oldest event the tracker has not acknowledged is over 60 s old, for 1 min | page | [railcar-events-delayed](docs/runbooks/railcar-events-delayed.md) |
| ServiceDown | ingest, tracker or query fails every scrape for 5 min | page | [service-down](docs/runbooks/service-down.md) |
| RailcarPositionsStale | no position written for over 300 s, for 5 min | page | [railcar-positions-stale](docs/runbooks/railcar-positions-stale.md) |
| IngestErrorRateHigh | over 5% of event batches got 5xx in the last minute, for 2 min | page | [ingest-error-rate-high](docs/runbooks/ingest-error-rate-high.md) |
| QueryErrorRateHigh | over 5% of lookups got 5xx in the last minute, for 2 min | page | [query-error-rate-high](docs/runbooks/query-error-rate-high.md) |
| QueryLatencyHigh | lookup p95 over 500 ms for 10 min | ticket | [query-latency-high](docs/runbooks/query-latency-high.md) |
| StreamBacklogHigh | over 5,000 events waiting for 10 min | ticket | [stream-backlog-high](docs/runbooks/stream-backlog-high.md) |
| TrackerProcessingErrors | the tracker failed writes in every minute for 2 min | ticket | [tracker-processing-errors](docs/runbooks/tracker-processing-errors.md) |
| DeadLetteredEvents | any event moved to the dead-letter stream in the last 15 min | ticket | [dead-lettered-events](docs/runbooks/dead-lettered-events.md) |

The first row, and the 1-minute windows in rows 4, 5 and 8, came out of the
game days below.

## Game days

Four drills inject a real fault into the running stack, wait for the page,
apply the runbook's fix and time everything. Each drill ran 5 times with the
first alert rules (`baseline`) and 5 times after the changes the
retrospectives called for (`new-alerts`); the poison event ran 5 more times
after a tracker fix (`dead-letter`). Every run is a JSON file in
`results/runs/<drill>/`, and `results/summary.json` holds the medians and
ranges below.

Median of 5 runs, with the range (min-max) in brackets:

| drill | rules | time to page | worst delay a lookup saw | time to recover after the fix |
|---|---|---|---|---|
| tracker stopped | baseline | 319.4 s (316.1-324.7), ServiceDown | 321.4 s (317.7-326.6) | 19.9 s (19.0-23.1) |
| | new-alerts | 138.9 s (138.6-141.2), RailcarEventsDelayed | 140.3 s (139.9-142.9) | 10.7 s (10.4-10.9) |
| Postgres 100 ms slower | baseline | no page within 20 min in 5 of 5 runs | 754.9 s (754.3-755.1) | 37.4 s (36.5-38.8) |
| | new-alerts | 173.7 s (173.6-174.1), RailcarEventsDelayed | 108.9 s (108.7-110.7) | 5.6 s (5.5-6.1) |
| Postgres stopped | baseline | 376.0 s (361.0-381.3), QueryErrorRateHigh | 382.1 s (381.3-401.9) | 35.7 s (25.4-41.6) |
| | new-alerts | 139.6 s (136.7-140.4), RailcarEventsDelayed | 141.8 s (140.9-141.9) | 10.9 s (9.4-13.7) |
| poison event | baseline | 617.9 s (615.2-620.4), RailcarPositionsStale | 623.1 s (617.9-623.2) | 35.3 s (32.7-37.9) |
| | new-alerts | 137.3 s (131.9-137.9), RailcarEventsDelayed | 141.8 s (136.6-141.9) | 13.0 s (12.3-13.7) |
| | new-alerts + tracker fix | no page (nothing was stuck) | 0.5 s (0.5-0.6) | nothing to fix |

How these were measured ([docs/gamedays.md](docs/gamedays.md) has the
details):

- **time to page**: from a marker the harness writes to the pager just
  before injecting the fault, to the first critical notification the pager
  receives from Alertmanager. Both timestamps come from the pager's clock.
- **worst delay a lookup saw**: throughout each run the harness posts a
  canary read every 2 s and polls the query API until it appears; this is the
  longest post-to-visible time among reads posted during the incident.
  Normally it is under 0.6 s.
- **time to recover**: from the moment the harness applies the fix to the
  moment a canary read posted at that moment is visible.

The harness acts the instant the page arrives, so these times leave out a
person waking up and reading the page. Prometheus scrapes and evaluates every
5 s, and the simulator sends 25 reads/s. All runs were on one Windows 11
machine under Docker Desktop.

What the drills found, and what changed (one blameless retrospective each):

- [001: Tracker stopped](docs/incidents/001-tracker-stopped.md): the only
  alert that noticed was a 5-minute `ServiceDown`. Added a metric for the age
  of the oldest unprocessed event, computed from Redis stream ids on the
  ingest side, and `RailcarEventsDelayed` on top of it.
- [002: Slow Postgres](docs/incidents/002-postgres-slow.md): nothing paged
  in 20 minutes, and the freshness metric stayed under a second while reads
  took over 12 minutes to show up. The same new alert pages in under 3
  minutes.
- [003: Postgres stopped](docs/incidents/003-postgres-stopped.md): error
  ratios over 5-minute windows started late and kept firing for 4 to 5
  minutes after recovery; and while Postgres was stopped, its name resolved
  through the host's DNS to a machine outside the stack. Shortened the
  windows and gave Postgres a fixed address on an internal network.
- [004: Poison event](docs/incidents/004-poison-event.md): one event Postgres
  could not store stopped the tracker completely. The tracker now
  dead-letters events with Postgres data errors, the schema rejects control
  characters, and a counter initialisation bug that hid the first dead letter
  from its alert is fixed.

## Repository layout

```
src/              services (ingest, tracker, query, pager, sim, console) and shared code
console-ui/       the console's page (React, Vite) and its component tests
db/               schema (init.sql) and migrations (the console's audit table)
docker/           toxiproxy configuration
observability/    Prometheus, Alertmanager, Grafana, OTel Collector configuration
scripts/          promtool and amtool checks
gamedays/         drill harness, summary and evidence scripts
results/          every drill run (JSON), runs.csv, summary, pager log, evidence
docs/             design notes, game days, runbooks, incident retrospectives
test/             unit, integration and browser tests
```
