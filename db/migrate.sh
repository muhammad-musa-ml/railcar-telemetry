#!/usr/bin/env sh
# Applies db/migrations/*.sql in name order. Run by the db-migrate service in
# docker-compose.yml on every `docker compose up`, so the files must be safe
# to run more than once. db/init.sql still creates the tables the pipeline
# uses when the Postgres volume is first initialised.
set -eu

dir="${MIGRATIONS_DIR:-/migrations}"

# Postgres is reached through toxiproxy, which may not be listening yet.
tries=0
until pg_isready -q; do
  tries=$((tries + 1))
  if [ "$tries" -ge 30 ]; then
    echo "postgres is not reachable at ${PGHOST:-localhost}:${PGPORT:-5432}" >&2
    exit 1
  fi
  sleep 1
done

# Keep the "does not exist, skipping" notices of a first run out of the log.
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

for file in "$dir"/*.sql; do
  echo "applying $(basename "$file")"
  psql -v ON_ERROR_STOP=1 -q -v console_password="$CONSOLE_DB_PASSWORD" -f "$file"
done
