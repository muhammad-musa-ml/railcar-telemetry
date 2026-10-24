# The operations console

Before the console, someone on call had to look in five places: Prometheus,
Alertmanager, Grafana, the pager's log and `redis-cli`. The dead-letter
runbook fixed things with Redis commands typed by hand. The console puts
the state of the pipeline on one screen and gives the runbooks three
actions: replay a dead-lettered event, discard one, and silence a firing
alert. Every action needs an operator token and is recorded.

```
browser --> console (:8085) --> Prometheus     up, alert rules, pending alerts
                    |       --> Alertmanager   firing alerts, silences
                    |       --> pager          pages and tickets
                    |       --> query          car and location lookups
                    |       --> Redis          railcar:events:dead, replay into railcar:events
                    +-------> Postgres         console_audit (insert only)
```

The code is in `src/console/` (the service) and `console-ui/` (the page).

## What it serves

| route | what it returns |
|---|---|
| `GET /` | the page: Overview, Dead letters, Car and location lookup |
| `GET /api/status` | each scrape job up or down, five pipeline signals with their alert thresholds, the dead-letter count |
| `GET /api/alerts` | firing alerts from Alertmanager and pending ones from Prometheus, with severity and `runbook_url` |
| `GET /api/pages?limit=` | pages and tickets the pager received in the last 24 hours (default 20, at most 200) |
| `GET /api/dead-letters?limit=` | the newest entries of `railcar:events:dead` with their stored reason and event (default 100, at most 500) |
| `GET /api/cars/:carId`, `GET /api/locations/:location/cars` | passed to the query service |
| `POST /api/dead-letters/:id/replay` | body `{"reason"?}` |
| `POST /api/dead-letters/:id/discard` | body `{"reason"}` |
| `POST /api/alerts/:fingerprint/silence` | body `{"reason", "minutes"}`, 1 to 720 minutes |
| `GET /metrics`, `GET /healthz` | like the other services |

The read routes need no token and return no secret: not the operator
tokens, not the database password. Every answer under `/api/` is sent with
`cache-control: no-store`.

## Decisions

### A service between the browser and the backends

The page could have called Prometheus and Alertmanager directly, but:

- Redis does not speak HTTP, so dead letters need a server anyway.
- Alertmanager and Prometheus have no authentication in this stack. A page
  that could create silences directly would let anything that can reach
  Alertmanager do the same, with no record of who did it. The token check,
  the rate limit, input validation and the audit record all have to sit
  somewhere the browser cannot skip.
- The page talks to one origin only, so its content security policy can be
  `default-src 'self'`, and nothing may frame it.
- The overview's numbers come from the alert rules themselves. The console
  reads each rule from Prometheus (`/api/v1/rules`), splits off the final
  comparison (`... > 60`) and queries the expression before it. The page
  never holds a copy of a threshold, so it cannot disagree with the alerts.
  If a rule is changed so that it no longer ends in a comparison with a
  number, the signal shows an error instead of a guess.

What it costs: one more service that can fail. When the console is down,
everything it shows is still in Prometheus, Alertmanager, Grafana and the
pager, and the runbooks keep the commands it replaces as a fallback. It
gives Prometheus, Alertmanager, the pager and the query service 3 seconds
to answer, and shows which source did not answer instead of failing the
whole screen.

Pending alerts come from Prometheus, because Alertmanager only ever sees
alerts that fire.

### Replay re-validates the event

The tracker decodes every entry with the event schema in
`src/shared/event.ts`, and an entry that fails is dead-lettered again.
Before incident 004's fix, an event Postgres could not store stopped the
tracker altogether ([incident 004](incidents/004-poison-event.md)). So the
console checks a stored event against the schema as it is now, and refuses
one that would fail, with the schema's errors and HTTP 422. The entry stays
where it is.

Checking against the current schema rather than the one at the time also
means an entry dead-lettered by a bug that has since been fixed can go back
once the fix is deployed.

The schema is not the database. An event that passes the schema can still
be refused by Postgres for a check the schema does not have. Replaying one
does not stop the tracker: it moves Postgres data errors (SQLSTATE classes
22 and 23) to the dead-letter stream by itself, so the event comes back
there with a `rejected by Postgres:` reason.

A replay runs as one Lua script in Redis: it adds the event to
`railcar:events` and only then deletes the dead-letter entry, so no other
client sees the event in both streams or in neither. The new entry carries
a `traceparent`, so the tracker's work on it joins the console request's
trace in Jaeger.

### What the operator token does and does not give you

Tokens are configured as `name:token` pairs in `CONSOLE_OPERATOR_TOKENS`
(each token at least 16 characters). An action needs
`Authorization: Bearer <token>`. The console compares SHA-256 digests with
`timingSafeEqual` against every configured token, so the time taken does
not depend on how much of a guess was right or which entry matched. The
audit record names the operator the token belongs to.

What it does not give you:

- **No identity beyond the token.** Anyone holding a token acts as that
  operator. There is no single sign-on, no second factor and no expiry; a
  token is changed by changing the environment and restarting the console.
- **No roles.** Every operator can do every action.
- **No transport security.** The stack serves plain HTTP on localhost. Over
  a network the token would travel in clear text.
- **No protection for reads.** Whoever can reach port 8085 sees the state of
  the pipeline and the stored events.
- **A limit, not a lock-out.** Actions are limited per client address (30 a
  minute by default, `CONSOLE_ACTIONS_PER_MINUTE`), counted before the token
  is checked, so guessing tokens is as slow as anything else. The counts are
  kept in memory and start over when the console restarts.

The page keeps the token in the tab's memory only. It is not written to
storage and is sent only with actions.

### The audit trail lives in Postgres

`db/migrations/001_console_audit.sql` creates `console_audit`, applied by
`db/migrate.sh`, which the `db-migrate` service runs on every
`docker compose up` before the console starts. Each row has the time (the
database clock), the operator, the client address, the action, the target,
the reason, the result and a JSON detail.

- A trigger refuses `UPDATE`, `DELETE` and `TRUNCATE` on the table for every
  role, the table owner included.
- The console connects as its own role, `railcar_console`, which may only
  insert into this table. It cannot read its own trail, or `car_positions`.
- Before an action is carried out, the console writes a `started` row; the
  outcome follows in a second row with the same request id. If the
  `started` row cannot be written, the action is not carried out (HTTP
  503). The price: while Postgres is down, nobody can act through the
  console, and the runbook commands are the way.
- Attempts stopped before anything is tried (no or wrong token, invalid
  input, over the rate limit) get one row each. If Postgres is down at that
  moment, the attempt is still refused, and the missing row is logged and
  counted in `console_audit_write_failures_total`. A replay refused by the
  schema check has its `started` row and a `refused` one.
- A discard keeps the whole entry (event, reason, source id) in the row, so
  it can be put back by hand.
- Control characters in anything stored are written as `\uXXXX`, because
  Postgres refuses a NUL in text and in `jsonb`, and the events this table
  describes include exactly that.

Append-only here protects against mistakes and against the console itself,
not against the database's owner: the `railcar` role can still drop the
trigger or the table. The trail shares the Postgres volume with
`car_positions`, so `docker compose down -v` deletes it too.

To read it:

```
docker compose exec postgres psql -U railcar -d railcar \
  -c "SELECT at, operator, action, target, reason, result FROM console_audit ORDER BY id DESC LIMIT 20"
```

## The page

`console-ui/` is React and TypeScript, built with Vite to `dist/console-ui`
(`npm run build:ui`; the Docker image does this in its build stage). There
is no component library and no client-side router: three views behind hash
links, each refreshing every 5 seconds. When a refresh fails, the last
answer stays on screen with the error next to it. Replay and discard go
through a confirm step, discard needs a reason, and a refused replay shows
the schema's errors. Form controls are labelled, focus moves to the view's
title after switching views, and `console-ui/test/contrast.test.tsx` checks
the text and background colour pairs the stylesheet uses against WCAG AA
(4.5:1).

## Settings

| variable | default | |
|---|---|---|
| `CONSOLE_OPERATOR_TOKENS` | none in the service; the compose file has a placeholder | `name:token[,name:token]`; the console does not start without it |
| `CONSOLE_ACTIONS_PER_MINUTE` | 30 | actions per client address per minute |
| `DATABASE_URL` | localhost | the `railcar_console` role; in the compose file, through toxiproxy |
| `REDIS_URL`, `PROMETHEUS_URL`, `ALERTMANAGER_URL`, `PAGER_URL`, `QUERY_URL` | localhost | where to reach each backend |
| `CONSOLE_UI_DIR` | `dist/console-ui` next to the service | without a built page the console serves the API alone |

## Metrics

Besides the HTTP request counts and latencies every service has:
`console_actions_total{action,result}`, `console_audit_write_failures_total`
and `console_upstream_errors_total{upstream}`. Prometheus scrapes the
console as the job `console`. No alert rule watches it; `ServiceDown` still
covers ingest, tracker and query only.
