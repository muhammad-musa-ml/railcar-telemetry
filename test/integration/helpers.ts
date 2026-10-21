import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { LocationEvent } from "../../src/shared/event";

export const urls = {
  ingest: process.env.INGEST_URL ?? "http://localhost:8081",
  query: process.env.QUERY_URL ?? "http://localhost:8083",
  pager: process.env.PAGER_URL ?? "http://localhost:8084",
  prometheus: process.env.PROMETHEUS_URL ?? "http://localhost:9090",
  alertmanager: process.env.ALERTMANAGER_URL ?? "http://localhost:9093",
  jaeger: process.env.JAEGER_URL ?? "http://localhost:16686",
  grafana: process.env.GRAFANA_URL ?? "http://localhost:3000",
};

// A car id no simulator car uses ("ITST" mark), unique per test run.
export function testCarId(): string {
  return `ITST ${randomInt(100000, 999999)}`;
}

export function read(carId: string, location: string, observedAt: Date): LocationEvent {
  return {
    event_id: randomUUID(),
    car_id: carId,
    reader_id: `AEI-${location}-E`,
    location,
    observed_at: observedAt.toISOString(),
  };
}

export async function postEvents(events: LocationEvent[]): Promise<Response> {
  return fetch(`${urls.ingest}/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events }),
  });
}

export async function getJson<T = unknown>(url: string): Promise<{ status: number; body: T }> {
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as T };
}

// Polls until check returns a value other than undefined, or fails after timeoutMs.
export async function eventually<T>(check: () => Promise<T | undefined>, timeoutMs = 30_000, stepMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(stepMs);
  }
  throw new Error(`condition not met within ${timeoutMs} ms${lastError ? `: ${String(lastError)}` : ""}`);
}

export async function promQuery(expr: string): Promise<{ metric: Record<string, string>; value: [number, string] }[]> {
  const { body } = await getJson<{ status: string; error?: string; data: { result: { metric: Record<string, string>; value: [number, string] }[] } }>(
    `${urls.prometheus}/api/v1/query?query=${encodeURIComponent(expr)}`,
  );
  if (body.status !== "success") {
    throw new Error(`query failed: ${expr}: ${body.error}`);
  }
  return body.data.result;
}
