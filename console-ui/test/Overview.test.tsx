import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AlertsResponse, PagesResponse, StatusResponse } from "../../src/console/api-types";
import { Overview } from "../src/views/Overview";
import { stubFetch } from "./fetch-stub";

const TOKEN = "test-operator-token-0001";

const status: StatusResponse = {
  generated_at: "2026-10-24T08:00:00.000Z",
  services: [
    { job: "ingest", up: true },
    { job: "tracker", up: false },
  ],
  signals: [
    {
      key: "oldest_unacked_age",
      label: "Oldest unprocessed event",
      unit: "seconds",
      rule: "RailcarEventsDelayed",
      value: 95,
      comparison: ">",
      threshold: 60,
      breaching: true,
      runbook_url: "https://example.org/runbooks/railcar-events-delayed.md",
    },
    {
      key: "ingest_error_ratio",
      label: "Ingest 5xx ratio",
      unit: "ratio",
      rule: "IngestErrorRateHigh",
      value: null,
      comparison: ">",
      threshold: 0.05,
      breaching: false,
      runbook_url: "https://example.org/runbooks/ingest-error-rate-high.md",
    },
  ],
  dead_letters: 3,
  errors: [],
};

const alerts: AlertsResponse = {
  alerts: [
    {
      fingerprint: "0123456789abcdef",
      name: "ServiceDown",
      state: "firing",
      silenced: false,
      severity: "critical",
      summary: "tracker has failed every scrape for 5 minutes",
      runbook_url: "https://example.org/runbooks/service-down.md",
      since: "2026-10-24T07:50:00.000Z",
      labels: { alertname: "ServiceDown", job: "tracker", severity: "critical" },
    },
    {
      fingerprint: null,
      name: "StreamBacklogHigh",
      state: "pending",
      silenced: false,
      severity: "warning",
      summary: "6000 events are waiting for the tracker",
      runbook_url: "https://example.org/runbooks/stream-backlog-high.md",
      since: "2026-10-24T07:58:00.000Z",
      labels: { alertname: "StreamBacklogHigh", severity: "warning" },
    },
  ],
  errors: [],
};

const pages: PagesResponse = {
  pages: [
    {
      received_at: "2026-10-24T07:55:10.000Z",
      receiver: "page",
      status: "firing",
      alertname: "ServiceDown",
      severity: "critical",
      summary: "tracker has failed every scrape for 5 minutes",
      runbook_url: "https://example.org/runbooks/service-down.md",
    },
  ],
};

function stubOverview(extra: Parameters<typeof stubFetch>[0] = {}) {
  return stubFetch({
    "GET /api/status": { status: 200, body: status },
    "GET /api/alerts": { status: 200, body: alerts },
    "GET /api/pages?limit=10": { status: 200, body: pages },
    ...extra,
  });
}

describe("overview", () => {
  it("shows each service as up or down", async () => {
    stubOverview();
    render(<Overview token="" />);
    const tracker = (await screen.findByText("tracker")).closest("li")!;
    expect(tracker.textContent).toContain("down");
    expect(screen.getByText("ingest").closest("li")!.textContent).toContain("up");
  });

  it("shows the pipeline signals against their alert thresholds, with the rule's runbook", async () => {
    stubOverview();
    render(<Overview token="" />);
    const row = (await screen.findByRole("rowheader", { name: "Oldest unprocessed event" })).closest("tr")!;
    const [now, threshold] = [...row.querySelectorAll("td")].map((td) => td.textContent);
    expect(now).toBe("1 min 35 sover the alert threshold");
    expect(threshold).toBe("> 1 min");
    expect(within(row).getByText("over the alert threshold")).toBeTruthy();
    expect(within(row).getByRole("link", { name: "RailcarEventsDelayed" }).getAttribute("href")).toBe(
      "https://example.org/runbooks/railcar-events-delayed.md",
    );
    const ratio = screen.getByRole("rowheader", { name: "Ingest 5xx ratio" }).closest("tr")!;
    expect(ratio.textContent).toContain("no 5xx answers recorded");
    expect(ratio.textContent).toContain("> 5.0 %");
    expect(ratio.textContent).not.toContain("over the alert threshold");
  });

  it("shows the dead-letter count with a way to the dead-letter view", async () => {
    stubOverview();
    render(<Overview token="" />);
    const row = (await screen.findByRole("rowheader", { name: "Dead-lettered events" })).closest("tr")!;
    expect(row.textContent).toContain("3");
    expect(within(row).getByRole("link", { name: "Review dead letters" }).getAttribute("href")).toBe("#/dead-letters");
  });

  it("lists firing and pending alerts with severity and runbook links", async () => {
    stubOverview();
    render(<Overview token="" />);
    const link = await screen.findByRole("link", { name: "Runbook for ServiceDown" });
    expect(link.getAttribute("href")).toBe("https://example.org/runbooks/service-down.md");
    const firing = link.closest("li")!;
    expect(firing.textContent).toContain("critical");
    expect(firing.textContent).toContain("firing for 10 min");
    expect(firing.textContent).not.toContain("10 min 0 s");
    const pending = screen.getByRole("link", { name: "Runbook for StreamBacklogHigh" }).closest("li")!;
    expect(pending.textContent).toContain("pending");
    // A pending alert has no fingerprint in Alertmanager, so it cannot be silenced yet.
    expect(within(pending).queryByRole("button", { name: /silence/i })).toBeNull();
  });

  it("lists recent pages and tickets", async () => {
    stubOverview();
    render(<Overview token="" />);
    const cell = await screen.findByText("2026-10-24 07:55:10 UTC");
    const row = cell.closest("tr")!;
    expect(row.textContent).toContain("ServiceDown");
    expect(row.textContent).toContain("page");
  });

  it("silences a firing alert with the operator's token, reason and duration", async () => {
    const api = stubOverview({
      "POST /api/alerts/0123456789abcdef/silence": { status: 200, body: { silence_id: "s-1", ends_at: "2026-10-24T08:30:00.000Z" } },
    });
    const user = userEvent.setup();
    render(<Overview token={TOKEN} />);
    await user.click(await screen.findByRole("button", { name: "Silence..." }));
    await user.type(screen.getByLabelText("Reason"), "tracker redeploy");
    const minutes = screen.getByLabelText("Minutes (1 to 720)");
    await user.clear(minutes);
    await user.type(minutes, "30");
    await user.click(screen.getByRole("button", { name: "Silence ServiceDown" }));

    expect(await screen.findByText("Silenced ServiceDown until 2026-10-24 08:30:00 UTC.")).toBeTruthy();
    expect(api.posts()).toEqual([
      expect.objectContaining({
        url: "/api/alerts/0123456789abcdef/silence",
        headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }),
        body: { reason: "tracker redeploy", minutes: 30 },
      }),
    ]);
  });

  it("asks for the token instead of sending a silence without one", async () => {
    const api = stubOverview();
    const user = userEvent.setup();
    render(<Overview token="" />);
    await user.click(await screen.findByRole("button", { name: "Silence..." }));
    await user.type(screen.getByLabelText("Reason"), "tracker redeploy");
    await user.click(screen.getByRole("button", { name: "Silence ServiceDown" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Enter your operator token");
    expect(api.posts()).toEqual([]);
  });

  it("keeps the form and says why when a silence is refused", async () => {
    stubOverview({
      "POST /api/alerts/0123456789abcdef/silence": { status: 401, body: { error: "this action needs an operator token" } },
    });
    const user = userEvent.setup();
    render(<Overview token="wrong-token-0000000000" />);
    await user.click(await screen.findByRole("button", { name: "Silence..." }));
    await user.type(screen.getByLabelText("Reason"), "tracker redeploy");
    await user.click(screen.getByRole("button", { name: "Silence ServiceDown" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The operator token was not accepted.");
    expect((screen.getByLabelText("Reason") as HTMLInputElement).value).toBe("tracker redeploy");
  });

  it("says what failed when the console cannot reach its sources, and when there is nothing to show", async () => {
    stubFetch({
      "GET /api/status": { status: 502, body: { error: "prometheus: connect ECONNREFUSED" } },
      "GET /api/alerts": { status: 200, body: { alerts: [], errors: [] } },
      "GET /api/pages?limit=10": { status: 200, body: { pages: [] } },
    });
    render(<Overview token="" />);
    expect(await screen.findByText(/Could not load the pipeline status: prometheus: connect ECONNREFUSED/)).toBeTruthy();
    expect(await screen.findByText("No alerts are firing or pending.")).toBeTruthy();
    expect(await screen.findByText("Nothing was paged or ticketed in the last 24 hours.")).toBeTruthy();
  });
});
