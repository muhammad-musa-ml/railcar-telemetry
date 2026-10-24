import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AlertmanagerHttpApi,
  JsonClient,
  PrometheusHttpApi,
  UpstreamError,
  type SilenceRequest,
} from "../../src/console/upstreams";

afterEach(() => {
  vi.unstubAllGlobals();
});

function answer(status: number, body: unknown) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
}

describe("Prometheus client", () => {
  it("returns samples, with NaN as null", async () => {
    const fetch = answer(200, {
      status: "success",
      data: {
        resultType: "vector",
        result: [
          { metric: { job: "ingest" }, value: [1761292800, "1"] },
          { metric: {}, value: [1761292800, "NaN"] },
        ],
      },
    });
    vi.stubGlobal("fetch", fetch);
    const api = new PrometheusHttpApi(new JsonClient("prometheus", "http://prometheus:9090"));
    expect(await api.query('max(x{group="tracker"}) / 2')).toEqual([
      { metric: { job: "ingest" }, value: 1 },
      { metric: {}, value: null },
    ]);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `http://prometheus:9090/api/v1/query?query=${encodeURIComponent('max(x{group="tracker"}) / 2')}`,
    );
  });

  it("raises the error Prometheus reports", async () => {
    vi.stubGlobal("fetch", answer(400, { status: "error", errorType: "bad_data", error: "parse error" }));
    const api = new PrometheusHttpApi(new JsonClient("prometheus", "http://prometheus:9090"));
    await expect(api.query("sum(")).rejects.toThrow("prometheus: parse error");
  });
});

describe("JSON client", () => {
  it("names the upstream when it cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const err = await new JsonClient("pager", "http://pager:8080").request("GET", "/v1/pages").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect((err as UpstreamError).message).toBe("pager: fetch failed");
  });

  it("gives up after its timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );
    const client = new JsonClient("alertmanager", "http://alertmanager:9093", undefined, 20);
    await expect(client.request("GET", "/api/v2/alerts")).rejects.toThrow("alertmanager: no answer within 20 ms");
  });

  it("passes 4xx answers back and turns 5xx answers into errors that keep the upstream's reason", async () => {
    vi.stubGlobal("fetch", answer(404, { error: "no reads for this car" }));
    const client = new JsonClient("query", "http://query:8080");
    expect(await client.request("GET", "/v1/cars/RCTX%201")).toEqual({ status: 404, body: { error: "no reads for this car" } });
    vi.stubGlobal("fetch", answer(503, { error: "position store unavailable" }));
    await expect(client.request("GET", "/v1/cars/RCTX%201")).rejects.toThrow("query answered 503: position store unavailable");
  });
});

describe("Alertmanager client", () => {
  it("posts a silence and returns its id", async () => {
    const fetch = answer(200, { silenceID: "4f6e" });
    vi.stubGlobal("fetch", fetch);
    const silence: SilenceRequest = {
      matchers: [{ name: "alertname", value: "ServiceDown", isRegex: false, isEqual: true }],
      startsAt: "2026-10-24T08:00:00.000Z",
      endsAt: "2026-10-24T09:00:00.000Z",
      createdBy: "operator",
      comment: "tracker redeploy",
    };
    const api = new AlertmanagerHttpApi(new JsonClient("alertmanager", "http://alertmanager:9093"));
    expect(await api.createSilence(silence)).toBe("4f6e");
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://alertmanager:9093/api/v2/silences");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(silence);
  });
});
