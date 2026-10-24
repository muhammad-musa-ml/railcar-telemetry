import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { DeadLetter, DeadLettersResponse } from "../../src/console/api-types";
import { DeadLetters } from "../src/views/DeadLetters";
import { stubFetch } from "./fetch-stub";

const TOKEN = "test-operator-token-0001";
const LIST = "GET /api/dead-letters?limit=100";

const poison: DeadLetter = {
  id: "1761292860000-0",
  source_id: "1761292859000-0",
  reason: "event failed validation: location: must not contain control characters",
  event: JSON.stringify({ car_id: "RCTX 100001", location: "YD04\u0000" }),
  dead_lettered_at: "2026-10-24T08:01:00.000Z",
};
const parked: DeadLetter = {
  id: "1761292800000-0",
  source_id: "1761292799000-0",
  reason: "manual",
  event: JSON.stringify({ car_id: "RCTX 100042", location: "YD04" }),
  dead_lettered_at: "2026-10-24T08:00:00.000Z",
};

function list(entries: DeadLetter[], count = entries.length): { status: number; body: DeadLettersResponse } {
  return { status: 200, body: { count, entries } };
}

function entryFor(id: string): HTMLElement {
  return screen.getByText(id, { selector: "dd code" }).closest("li")!;
}

describe("dead-letter view", () => {
  it("lists the entries newest first with their reason and the stored event", async () => {
    stubFetch({ [LIST]: list([poison, parked], 140) });
    render(<DeadLetters token="" />);
    expect(await screen.findByText("140 entries, showing the newest 2.")).toBeTruthy();
    const items = screen.getAllByRole("listitem").filter((li) => li.classList.contains("dead-letter"));
    // The first fact of each entry is its id.
    expect(items.map((li) => li.querySelector("dd code")?.textContent)).toEqual([poison.id, parked.id]);
    expect(items[0]!.textContent).toContain("must not contain control characters");
    expect(items[0]!.textContent).toContain('"location":"YD04\\u0000"');
    expect(items[1]!.textContent).toContain("manual");
  });

  it("says so when the stream is empty", async () => {
    stubFetch({ [LIST]: list([]) });
    render(<DeadLetters token="" />);
    expect(await screen.findByText("The dead-letter stream is empty.")).toBeTruthy();
  });

  it("shows why the dead-letter stream could not be read", async () => {
    stubFetch({ [LIST]: { status: 502, body: { error: "redis: Connection is closed." } } });
    render(<DeadLetters token="" />);
    expect((await screen.findByRole("alert")).textContent).toContain("redis: Connection is closed.");
  });

  it("asks for confirmation before replaying, and shows the refusal when the event would fail again", async () => {
    const api = stubFetch({
      [LIST]: list([poison, parked]),
      [`POST /api/dead-letters/${poison.id}/replay`]: {
        status: 422,
        body: {
          error: "this event fails the current event schema, so it would be dead-lettered again",
          issues: [{ path: "location", message: "must not contain control characters" }],
        },
      },
    });
    const user = userEvent.setup();
    render(<DeadLetters token={TOKEN} />);
    await user.click(await screen.findByRole("button", { name: `Replay ${poison.id}...` }));
    // Opening the confirm step sends nothing.
    expect(api.posts()).toEqual([]);
    const entry = entryFor(poison.id);
    expect(entry.textContent).toContain("checked against the current event schema first");

    await user.click(within(entry).getByRole("button", { name: "Confirm replay" }));
    const refusal = await within(entry).findByRole("alert");
    expect(refusal.textContent).toContain("Replay refused: this event fails the current event schema, so it would be dead-lettered again");
    expect(refusal.textContent).toContain("location: must not contain control characters");
    expect(refusal.textContent).toContain("The event is still in the dead-letter stream.");
    // Replaying again would only be refused again, so the confirm step closes.
    expect(within(entry).queryByRole("button", { name: "Confirm replay" })).toBeNull();
    expect(within(entry).getByRole("button", { name: `Discard ${poison.id}...` })).toBeTruthy();
    expect(api.posts()).toEqual([
      expect.objectContaining({
        url: `/api/dead-letters/${poison.id}/replay`,
        headers: expect.objectContaining({ authorization: `Bearer ${TOKEN}` }),
        body: {},
      }),
    ]);
  });

  it("replays a valid event, reports where it went and reloads the list", async () => {
    let replayed = false;
    const api = stubFetch({
      [LIST]: () => (replayed ? list([poison]) : list([poison, parked])),
      [`POST /api/dead-letters/${parked.id}/replay`]: () => {
        replayed = true;
        return { status: 200, body: { replayed: parked.id, stream_id: "1761300000000-0" } };
      },
    });
    const user = userEvent.setup();
    render(<DeadLetters token={TOKEN} />);
    await user.click(await screen.findByRole("button", { name: `Replay ${parked.id}...` }));
    await user.type(within(entryFor(parked.id)).getByLabelText("Reason (optional)"), "parked during the drill");
    await user.click(within(entryFor(parked.id)).getByRole("button", { name: "Confirm replay" }));

    expect(await screen.findByText(`Replayed ${parked.id}. It is back in railcar:events as 1761300000000-0.`)).toBeTruthy();
    await screen.findByText("1 entry.");
    expect(screen.queryByText(parked.id, { selector: "dd code" })).toBeNull();
    expect(api.posts()[0]?.body).toEqual({ reason: "parked during the drill" });
  });

  it("discards an entry only with a reason, after a confirm step that can be cancelled", async () => {
    const api = stubFetch({
      [LIST]: list([poison, parked]),
      [`POST /api/dead-letters/${poison.id}/discard`]: { status: 200, body: { discarded: poison.id } },
    });
    const user = userEvent.setup();
    render(<DeadLetters token={TOKEN} />);
    await user.click(await screen.findByRole("button", { name: `Discard ${poison.id}...` }));
    await user.click(within(entryFor(poison.id)).getByRole("button", { name: "Cancel" }));
    expect(within(entryFor(poison.id)).queryByRole("button", { name: "Confirm discard" })).toBeNull();

    await user.click(screen.getByRole("button", { name: `Discard ${poison.id}...` }));
    const reason = within(entryFor(poison.id)).getByLabelText("Reason (required)");
    expect(reason.hasAttribute("required")).toBe(true);
    await user.type(reason, "poison event from the drill");
    await user.click(within(entryFor(poison.id)).getByRole("button", { name: "Confirm discard" }));
    expect(await screen.findByText(`Discarded ${poison.id}.`)).toBeTruthy();
    expect(api.posts()).toEqual([
      expect.objectContaining({ url: `/api/dead-letters/${poison.id}/discard`, body: { reason: "poison event from the drill" } }),
    ]);
  });

  it("asks for the token instead of sending an action without one", async () => {
    const api = stubFetch({ [LIST]: list([parked]) });
    const user = userEvent.setup();
    render(<DeadLetters token="" />);
    await user.click(await screen.findByRole("button", { name: `Replay ${parked.id}...` }));
    await user.click(screen.getByRole("button", { name: "Confirm replay" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Enter your operator token");
    expect(api.posts()).toEqual([]);
  });

  it("keeps the typed reason when the token is refused", async () => {
    stubFetch({
      [LIST]: list([parked]),
      [`POST /api/dead-letters/${parked.id}/discard`]: { status: 401, body: { error: "this action needs an operator token" } },
    });
    const user = userEvent.setup();
    render(<DeadLetters token="wrong-token-0000000000" />);
    await user.click(await screen.findByRole("button", { name: `Discard ${parked.id}...` }));
    await user.type(screen.getByLabelText("Reason (required)"), "duplicate read");
    await user.click(screen.getByRole("button", { name: "Confirm discard" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The operator token was not accepted.");
    expect((screen.getByLabelText("Reason (required)") as HTMLInputElement).value).toBe("duplicate read");
  });
});
