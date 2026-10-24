import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { CarPosition, LocationCarsResponse } from "../../src/console/api-types";
import { Lookup } from "../src/views/Lookup";
import { stubFetch } from "./fetch-stub";

const car: CarPosition = {
  car_id: "RCTX 100042",
  location: "YD04",
  reader_id: "AEI-YD04-E",
  arrived_at: "2026-10-24T06:58:00.000Z",
  last_seen_at: "2026-10-24T07:58:00.000Z",
  dwell_seconds: 3725,
};

describe("lookup view", () => {
  it("finds a car's position and dwell time, accepting the id in any case and spacing", async () => {
    const api = stubFetch({ "GET /api/cars/RCTX%20100042": { status: 200, body: car } });
    const user = userEvent.setup();
    render(<Lookup />);
    await user.type(screen.getByLabelText("Car id"), "  rctx   100042 ");
    await user.click(screen.getByRole("button", { name: "Find car" }));
    const facts = await screen.findByLabelText("Position of RCTX 100042");
    expect(facts.textContent).toContain("YD04");
    expect(facts.textContent).toContain("1 h 2 min");
    expect(facts.textContent).toContain("2026-10-24 06:58:00 UTC");
    expect(facts.textContent).toContain("2026-10-24 07:58:00 UTC by AEI-YD04-E");
    expect(api.calls.map((c) => c.url)).toEqual(["/api/cars/RCTX%20100042"]);
  });

  it("says when a car has no position", async () => {
    stubFetch({ "GET /api/cars/RCTX%20999999": { status: 404, body: { error: "no reads for this car" } } });
    const user = userEvent.setup();
    render(<Lookup />);
    await user.type(screen.getByLabelText("Car id"), "RCTX 999999");
    await user.click(screen.getByRole("button", { name: "Find car" }));
    expect((await screen.findByRole("alert")).textContent).toBe("RCTX 999999: no reads for this car");
  });

  it("lists the cars at a location, longest dwell first", async () => {
    const body: LocationCarsResponse = {
      location: "YD04",
      cars: [car, { ...car, car_id: "RCTX 100043", dwell_seconds: 125, arrived_at: "2026-10-24T07:56:00.000Z" }],
    };
    stubFetch({ "GET /api/locations/YD04/cars?limit=100": { status: 200, body } });
    const user = userEvent.setup();
    render(<Lookup />);
    await user.type(screen.getByLabelText("Location"), "YD04");
    await user.click(screen.getByRole("button", { name: "List cars" }));
    const table = await screen.findByRole("table", { name: "2 cars at YD04, longest dwell first" });
    const rows = table.querySelectorAll("tbody tr");
    expect([...rows].map((r) => r.querySelector("th")?.textContent)).toEqual(["RCTX 100042", "RCTX 100043"]);
    expect(rows[1]!.textContent).toContain("2 min 5 s");
  });

  it("says when no car is at a location", async () => {
    stubFetch({ "GET /api/locations/YD09/cars?limit=100": { status: 200, body: { location: "YD09", cars: [] } } });
    const user = userEvent.setup();
    render(<Lookup />);
    await user.type(screen.getByLabelText("Location"), "YD09");
    await user.click(screen.getByRole("button", { name: "List cars" }));
    expect(await screen.findByText("No cars were last read at YD09.")).toBeTruthy();
  });
});
