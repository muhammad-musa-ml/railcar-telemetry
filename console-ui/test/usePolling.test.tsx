import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { usePolling } from "../src/usePolling";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function Probe({ path, intervalMs = 60_000 }: { path: string | null; intervalMs?: number }) {
  const polled = usePolling<{ name: string }>(path, intervalMs);
  return (
    <>
      <p data-testid="data">{polled.loading ? "loading" : (polled.data?.name ?? "none")}</p>
      <p data-testid="error">{polled.error ?? "none"}</p>
    </>
  );
}

const text = (id: string) => screen.getByTestId(id).textContent;

describe("usePolling", () => {
  it("drops an answer for a path it no longer shows, even when it arrives last", async () => {
    let answerA: (res: Response) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url === "/a" ? new Promise<Response>((resolve) => (answerA = resolve)) : Promise.resolve(json({ name: "b" })),
      ),
    );
    const { rerender } = render(<Probe path="/a" />);
    rerender(<Probe path="/b" />);
    await screen.findByText("b");

    // The answer for /a comes in after the one for /b.
    await act(async () => {
      answerA(json({ name: "a" }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(text("data")).toBe("b");
  });

  it("keeps the last answer on screen when a refresh fails, and says why", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        return calls === 1 ? json({ name: "first" }) : json({ error: "prometheus: connect ECONNREFUSED" }, 502);
      }),
    );
    render(<Probe path="/status" intervalMs={10} />);
    await screen.findByText("prometheus: connect ECONNREFUSED");
    expect(text("data")).toBe("first");
  });

  it("asks nothing while there is no path", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(<Probe path={null} />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(text("data")).toBe("none");
  });
});
