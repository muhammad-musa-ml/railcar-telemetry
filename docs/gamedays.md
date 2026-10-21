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
| `poison-event` | one event whose `location` contains a NUL character is written straight into the stream (valid JSON, passes the schema, rejected by Postgres) | the runbook's stuck-event steps: copy the oldest pending entry to `railcar:events:dead` and acknowledge it, if it is the poison event |

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

## What the numbers depend on

- Prometheus scrapes and evaluates rules every 5 seconds; Alertmanager waits
  10 seconds (`group_wait`) before the first notification of a group.
- The simulator sends 25 reads/s and 5 lookups/s.
- Everything ran on one Windows 11 machine under Docker Desktop, with other
  unrelated containers running. Each run's JSON records the git commit, hashes
  of the alert rules and the tracker source, and the alert rules Prometheus
  had loaded, so a run can be tied to the configuration it tested.
