import type { Pool } from "pg";

export interface CarPosition {
  car_id: string;
  location: string;
  reader_id: string;
  arrived_at: string;
  last_seen_at: string;
  // Seconds since the car was first read at its current location.
  dwell_seconds: number;
}

export interface PositionReader {
  getCar(carId: string): Promise<CarPosition | null>;
  carsAt(location: string, limit: number): Promise<CarPosition[]>;
  // Seconds since the tracker last wrote any row, or null for an empty table.
  freshnessSeconds(): Promise<number | null>;
}

const SELECT_COLUMNS = `
  car_id, location, reader_id, arrived_at, last_seen_at,
  EXTRACT(EPOCH FROM (now() - arrived_at))::float8 AS dwell_seconds`;

interface Row {
  car_id: string;
  location: string;
  reader_id: string;
  arrived_at: Date;
  last_seen_at: Date;
  dwell_seconds: number;
}

function toPosition(row: Row): CarPosition {
  return {
    car_id: row.car_id,
    location: row.location,
    reader_id: row.reader_id,
    arrived_at: row.arrived_at.toISOString(),
    last_seen_at: row.last_seen_at.toISOString(),
    dwell_seconds: Math.round(row.dwell_seconds),
  };
}

export class PgPositionReader implements PositionReader {
  constructor(private readonly pool: Pool) {}

  async getCar(carId: string): Promise<CarPosition | null> {
    const result = await this.pool.query<Row>(`SELECT ${SELECT_COLUMNS} FROM car_positions WHERE car_id = $1`, [carId]);
    const row = result.rows[0];
    return row ? toPosition(row) : null;
  }

  async carsAt(location: string, limit: number): Promise<CarPosition[]> {
    const result = await this.pool.query<Row>(
      `SELECT ${SELECT_COLUMNS} FROM car_positions WHERE location = $1 ORDER BY arrived_at ASC LIMIT $2`,
      [location, limit],
    );
    return result.rows.map(toPosition);
  }

  async freshnessSeconds(): Promise<number | null> {
    const result = await this.pool.query<{ age: number | null }>(
      "SELECT EXTRACT(EPOCH FROM (now() - max(updated_at)))::float8 AS age FROM car_positions",
    );
    return result.rows[0]?.age ?? null;
  }
}
