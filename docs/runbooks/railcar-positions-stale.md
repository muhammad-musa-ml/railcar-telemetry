# RailcarPositionsStale

**Severity:** critical (pages)
**Fires when:** `railcar_positions_freshness_seconds` is over 300 for 5 minutes.

## What it means

No row of `car_positions` has been updated for more than 5 minutes. The
metric is measured by the query service from Postgres
(`now() - max(updated_at)`), so it reflects what API users see. Every lookup
is returning a location that is at least that old.

If the query service cannot reach Postgres the metric disappears instead of
growing, and this alert cannot fire; `QueryErrorRateHigh` covers that case.

## Check

1. Is the tracker up? `docker compose ps tracker`. If not, follow
   [service-down](service-down.md).
2. Is it failing to write? *Railcar pipeline* dashboard, "Events in and out":
   a flat "processed" line with a rising "failed attempts" line means writes
   are failing. Follow [tracker-processing-errors](tracker-processing-errors.md).
3. Are events arriving at all? If "accepted by ingest" is also flat, the
   problem is upstream (readers or ingest), not the tracker. Check
   `docker compose logs --tail 50 ingest reader-sim`.

## Fix

Fix whichever of the above is the cause. Once the tracker writes again,
freshness drops to a few seconds within one scrape.

## After

Note how long positions were stale; that is the customer-facing impact.
