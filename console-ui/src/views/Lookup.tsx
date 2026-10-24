import { useState, type FormEvent } from "react";
import type { CarPosition, LocationCarsResponse } from "../../../src/console/api-types";
import { formatDuration, formatTime } from "../format";
import { usePolling } from "../usePolling";
import { REFRESH_MS } from "./Overview";

// "rctx  104233 " -> "RCTX 104233", the form car ids are stored in.
function normaliseCarId(text: string): string {
  return text.trim().toUpperCase().split(/\s+/).join(" ");
}

function CarLookup() {
  const [input, setInput] = useState("");
  const [carId, setCarId] = useState<string | null>(null);
  const car = usePolling<CarPosition>(carId === null ? null : `/api/cars/${encodeURIComponent(carId)}`, REFRESH_MS);

  function submit(event: FormEvent) {
    event.preventDefault();
    const id = normaliseCarId(input);
    if (id !== "") setCarId(id);
  }

  return (
    <section aria-labelledby="car-heading">
      <h3 id="car-heading">Where is a car?</h3>
      <form className="inline-form" onSubmit={submit}>
        <label htmlFor="car-id">Car id</label>
        <input id="car-id" value={input} onChange={(e) => setInput(e.target.value)} placeholder="RCTX 104233" required />
        <button type="submit" className="button-primary">
          Find car
        </button>
      </form>
      {car.loading && <p className="muted">Looking up {carId}...</p>}
      {car.error && (
        <p className="notice notice-error" role="alert">
          {carId}: {car.error}
        </p>
      )}
      {car.data && (
        <dl className="facts result" aria-label={`Position of ${car.data.car_id}`}>
          <dt>Car</dt>
          <dd>{car.data.car_id}</dd>
          <dt>Location</dt>
          <dd>{car.data.location}</dd>
          <dt>Dwell time</dt>
          <dd>{formatDuration(car.data.dwell_seconds)}</dd>
          <dt>Arrived</dt>
          <dd>{formatTime(car.data.arrived_at)}</dd>
          <dt>Last read</dt>
          <dd>
            {formatTime(car.data.last_seen_at)} by {car.data.reader_id}
          </dd>
        </dl>
      )}
    </section>
  );
}

function LocationLookup() {
  const [input, setInput] = useState("");
  const [location, setLocation] = useState<string | null>(null);
  const result = usePolling<LocationCarsResponse>(
    location === null ? null : `/api/locations/${encodeURIComponent(location)}/cars?limit=100`,
    REFRESH_MS,
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    const code = input.trim();
    if (code !== "") setLocation(code);
  }

  return (
    <section aria-labelledby="location-heading">
      <h3 id="location-heading">Which cars are at a location?</h3>
      <form className="inline-form" onSubmit={submit}>
        <label htmlFor="location">Location</label>
        <input id="location" value={input} onChange={(e) => setInput(e.target.value)} placeholder="YD04" required />
        <button type="submit" className="button-primary">
          List cars
        </button>
      </form>
      {result.loading && <p className="muted">Looking up {location}...</p>}
      {result.error && (
        <p className="notice notice-error" role="alert">
          {location}: {result.error}
        </p>
      )}
      {result.data && result.data.cars.length === 0 && <p className="muted">No cars were last read at {result.data.location}.</p>}
      {result.data && result.data.cars.length > 0 && (
        <div className="table-wrap">
          <table>
            <caption>
              {result.data.cars.length} cars at {result.data.location}, longest dwell first
            </caption>
            <thead>
              <tr>
                <th scope="col">Car</th>
                <th scope="col">Dwell time</th>
                <th scope="col">Arrived</th>
                <th scope="col">Last read</th>
              </tr>
            </thead>
            <tbody>
              {result.data.cars.map((c) => (
                <tr key={c.car_id}>
                  <th scope="row">{c.car_id}</th>
                  <td>{formatDuration(c.dwell_seconds)}</td>
                  <td>{formatTime(c.arrived_at)}</td>
                  <td>
                    {formatTime(c.last_seen_at)} by {c.reader_id}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function Lookup() {
  return (
    <>
      <CarLookup />
      <LocationLookup />
    </>
  );
}
