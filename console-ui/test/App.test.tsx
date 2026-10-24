import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";
import { stubFetch } from "./fetch-stub";

function stubApi() {
  return stubFetch({
    "GET /api/status": {
      status: 200,
      body: { generated_at: "2026-10-24T08:00:00.000Z", services: [], signals: [], dead_letters: 0, errors: [] },
    },
    "GET /api/alerts": { status: 200, body: { alerts: [], errors: [] } },
    "GET /api/pages?limit=10": { status: 200, body: { pages: [] } },
    "GET /api/dead-letters?limit=100": { status: 200, body: { count: 0, entries: [] } },
  });
}

describe("console page", () => {
  it("opens on the overview, with the current view marked in the navigation", async () => {
    stubApi();
    render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: "Railcar console" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Overview" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Views" });
    expect(nav.querySelector('[aria-current="page"]')?.textContent).toBe("Overview");
    await screen.findByText("No alerts are firing or pending.");
  });

  it("takes the operator token in a labelled password field", () => {
    stubApi();
    render(<App />);
    const field = screen.getByLabelText("Operator token") as HTMLInputElement;
    expect(field.type).toBe("password");
    expect(field.getAttribute("autocomplete")).toBe("off");
    expect(field.getAttribute("aria-describedby")).toBe("token-help");
  });

  it("moves to another view from the keyboard and puts focus on its title", async () => {
    stubApi();
    const user = userEvent.setup();
    render(<App />);
    const link = screen.getByRole("link", { name: "Dead letters" });
    link.focus();
    await user.keyboard("{Enter}");
    const title = await screen.findByRole("heading", { level: 2, name: "Dead letters" });
    await waitFor(() => expect(document.activeElement).toBe(title));
    expect(await screen.findByText("The dead-letter stream is empty.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Dead letters" }).getAttribute("aria-current")).toBe("page");
  });
});
