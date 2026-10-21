-- Latest known position of every railcar, written by the tracker.
CREATE TABLE IF NOT EXISTS car_positions (
  car_id        text PRIMARY KEY,
  location      text NOT NULL,
  reader_id     text NOT NULL,
  -- First read at the current location. Dwell time is measured from here.
  arrived_at    timestamptz NOT NULL,
  -- Most recent read of this car, at any reader of the current location.
  last_seen_at  timestamptz NOT NULL,
  last_event_id uuid NOT NULL,
  -- When the tracker last changed this row (database clock).
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS car_positions_location_idx ON car_positions (location);
CREATE INDEX IF NOT EXISTS car_positions_updated_at_idx ON car_positions (updated_at);
