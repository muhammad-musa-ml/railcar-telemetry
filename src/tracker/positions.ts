import type { Pool } from "pg";
import type { LocationEvent } from "../shared/event";

export type ApplyOutcome = "applied" | "stale";

export interface PositionStore {
  apply(event: LocationEvent): Promise<ApplyOutcome>;
}

// One statement per event. The WHERE clause drops an event that is older
// than (or the same as) the newest read already stored, so a redelivered or
// out-of-order event cannot move a car backwards. arrived_at only changes
// when the car shows up at a different location.
export const UPSERT_POSITION_SQL = `
INSERT INTO car_positions (car_id, location, reader_id, arrived_at, last_seen_at, last_event_id, updated_at)
VALUES ($1, $2, $3, $4, $4, $5, now())
ON CONFLICT (car_id) DO UPDATE SET
  location      = EXCLUDED.location,
  reader_id     = EXCLUDED.reader_id,
  arrived_at    = CASE WHEN car_positions.location = EXCLUDED.location
                       THEN car_positions.arrived_at
                       ELSE EXCLUDED.arrived_at END,
  last_seen_at  = EXCLUDED.last_seen_at,
  last_event_id = EXCLUDED.last_event_id,
  updated_at    = now()
WHERE car_positions.last_seen_at < EXCLUDED.last_seen_at`;

export class PgPositionStore implements PositionStore {
  constructor(private readonly pool: Pool) {}

  async apply(event: LocationEvent): Promise<ApplyOutcome> {
    const result = await this.pool.query(UPSERT_POSITION_SQL, [
      event.car_id,
      event.location,
      event.reader_id,
      event.observed_at,
      event.event_id,
    ]);
    return result.rowCount === 1 ? "applied" : "stale";
  }
}
