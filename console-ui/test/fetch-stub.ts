import { vi } from "vitest";

// A stand-in for the console API: answers "METHOD path" from a table and
// records every request the page makes.

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Answer {
  status: number;
  body?: unknown;
}

export type Route = Answer | ((call: Call) => Answer);

export function stubFetch(routes: Record<string, Route>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      const call: Call = {
        method,
        url,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      calls.push(call);
      const route = routes[`${method} ${url}`];
      const answer = route === undefined ? { status: 500, body: { error: `no stub for ${method} ${url}` } } : typeof route === "function" ? route(call) : route;
      return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return {
    calls,
    posts: () => calls.filter((c) => c.method === "POST"),
  };
}
