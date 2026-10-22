# Game days

Each drill injects one real fault into the running stack, waits for the
on-call page, applies the fix from the runbook, and measures how long
everything took. The harness is `gamedays/run.ts`; every run is written to
`results/runs/<drill>/<label>-NN.json` and appended to `results/runs.csv`.
`gamedays/summarize.ts` turns the runs into `results/summary.md` and
`results/summary.json`.

## The drills

| drill | fault | fix applied when paged |
|---|---|---|
| `tracker-stop` | `docker compose stop tracker` | `docker compose start tracker` |
| `postgres-latency` | toxiproxy adds 100 ms to every Postgres response | remove the toxic |
| `postgres-stop` | `docker compose stop postgres` | `docker compose start postgres` |
| `poison-event` | one event whose `location` contains a NUL character is written straight into the stream (valid JSON that passed the event schema during all three rounds, and that Postgres rejects) | the runbook's stuck-event steps: copy the oldest pending entry to `railcar:events:dead` and acknowledge it, if it is the poison event |

Since the schema change that followed [incident 004](incidents/004-poison-event.md),
the tracker's decode step rejects the poison event before it reaches
Postgres, so running `poison-event` now exercises that path instead of the
SQLSTATE rule.

## Running them

```
docker compose up -d --build --wait
npx tsx gamedays/run.ts tracker-stop --runs 5 --label baseline
npx tsx gamedays/run.ts postgres-latency --runs 5 --label baseline --window-min 20
npx tsx gamedays/summarize.ts
```

`--label` names the configuration under test, so runs before and after a
change can be compared. `--window-min` is how long the harness waits for a
page before it applies the fix anyway (default 20 minutes).

Leave the stack otherwise idle while a drill runs. The harness puts the stack
back to normal before each run (starts every service, removes any toxic) and
waits until no alert is pending or firing, the backlog is under 200 entries
and positions are less than 30 seconds old.

## What is measured

All alert and fault times are marks in the pager's own log: the harness posts
a marker to the pager (`POST /v1/markers`) right before it injects the fault,
and Alertmanager's notifications land in the same log. So injection time and
page time come from the same clock.

- **time to page**: from the `inject-start` marker to the first notification
  on the `page` receiver (a critical alert). Runs with no page inside the
  observation window have no time to page; the summary counts them
  separately.
- **time to ticket**: the same, for the first notification on the `ticket`
  receiver (a warning).
- **time to recover**: from the moment the harness starts the fix to the
  moment a canary read, posted at that same moment, is visible through the
  query API. The canary read has to go through ingest, the stream, the
  tracker and Postgres, so it only shows up once the backlog in front of it
  has been processed. This is measured with the clock of the machine running
  the harness, at both ends.
- **impact**: from injection to the same recovery point.
- **max canary delay**: throughout each run the harness posts a canary read
  every 2 seconds and records how long each takes to become visible. The
  largest delay among reads posted between injection and recovery is the
  worst delay a user of the query API would have seen.
- **peak backlog**, **peak freshness**, **failed attempts**: Prometheus
  queries over the window from injection to recovery.

The harness applies the fix the moment it sees the page. Real response time
(someone waking up, reading the page, opening the runbook) is not included,
so time to recover here is the system's part only.

## Rounds

Each round ran every drill 5 times in a row with one configuration, named
by its `--label`:

| label | configuration | runs |
|---|---|---|
| `baseline` | the first alert rules and tracker, as built before any drill | 20 (5 per drill) |
| `new-alerts` | `RailcarEventsDelayed` added; 1-minute windows for the error-ratio alerts and `TrackerProcessingErrors`; Postgres on a fixed address | 20 (5 per drill) |
| `dead-letter` | as `new-alerts`, plus the tracker dead-letters events that Postgres rejects | 5 (poison-event only), 5-minute observation window |

One extra `postgres-stop` run, made before the baseline was complete, is kept
in `results/discarded/` with the reason it was set aside.

## Evidence beyond the run files

Some retrospective findings come from container logs or from Prometheus
rather than from the harness. Scripts in `gamedays/` copy what is needed into
`results/` while the logs still exist:

- `upstream-evidence.ts`: from the toxiproxy and Postgres logs, where
  toxiproxy tried to connect while Postgres was stopped
  (`results/evidence/postgres-stop-*-upstream.json`). It refuses to write if
  the logs no longer reach back to the runs.
- `lookup-latency-evidence.ts`: the query API's p95 before and during the
  latency drill (`results/evidence/postgres-latency-*-lookup-p95.json`).
- `export-pager-log.ts`: the pager's full log of notifications and markers
  (`results/pager/`).
- `resolve-times.ts`: from that log, how long each alert kept firing after
  the pipeline had recovered (`results/evidence/alerts-resolved-after-recovery.json`).
- `first-dead-letter-check.ts`: a one-off check (no drill round) that the first
  dead letter after a tracker restart opens a ticket
  (`results/evidence/first-dead-letter-after-restart.json`).

`results/evidence/dead-letter-entries.json` was read from the dead-letter
stream with `redis-cli XRANGE railcar:events:dead - +`, and
`results/evidence/poison-event-tracker-error.json` is the first tracker log
line of the first poison run.

In the `dead-letter` round nothing was stuck, so the harness applied its
(empty) fix at the end of the 5-minute window. The "impact" column of
`results/summary.md` for that round is therefore just the window length; the
canary delay is the meaningful number there.

## What the numbers depend on

- Prometheus scrapes and evaluates rules every 5 seconds; Alertmanager waits
  10 seconds (`group_wait`) before the first notification of a group.
- The simulator sends 25 reads/s and 5 lookups/s.
- Everything ran on one Windows 11 machine under Docker Desktop, with other
  unrelated containers running. Each run's JSON records the git commit, hashes
  of the alert rules and the tracker source, and the alert rules Prometheus
  had loaded, so a run can be tied to the configuration it tested.
