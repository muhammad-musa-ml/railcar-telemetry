import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

// Thin clients for everything a drill touches: docker compose, Redis (via
// redis-cli in its container), toxiproxy, Prometheus, Alertmanager and the
// pager. All URLs point at the ports docker-compose.yml publishes.

const run = promisify(execFile);

export const repoRoot = resolve(__dirname, "..", "..");

export const urls = {
  ingest: process.env.INGEST_URL ?? "http://localhost:8081",
  query: process.env.QUERY_URL ?? "http://localhost:8083",
  pager: process.env.PAGER_URL ?? "http://localhost:8084",
  prometheus: process.env.PROMETHEUS_URL ?? "http://localhost:9090",
  alertmanager: process.env.ALERTMANAGER_URL ?? "http://localhost:9093",
  toxiproxy: process.env.TOXIPROXY_URL ?? "http://localhost:8474",
};

export async function compose(...args: string[]): Promise<string> {
  const { stdout } = await run("docker", ["compose", ...args], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export async function redisCli(...args: string[]): Promise<string[]> {
  const out = await compose("exec", "-T", "redis", "redis-cli", ...args);
  return out.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}

export async function serviceStates(): Promise<Record<string, string>> {
  const out = await compose("ps", "-a", "--format", "json");
  const states: Record<string, string> = {};
  for (const line of out.split("\n")) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line) as { Service: string; State: string };
    states[entry.Service] = entry.State;
  }
  return states;
}

export async function imageId(service: string): Promise<string> {
  const id = (await compose("ps", "-q", service)).trim();
  if (id === "") return "";
  const { stdout } = await run("docker", ["inspect", "--format", "{{.Image}}", id]);
  return stdout.trim();
}

export async function gitCommit(): Promise<string> {
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
  return stdout.trim();
}

export function fileSha256(relativePath: string): string {
  return createHash("sha256").update(readFileSync(join(repoRoot, relativePath))).digest("hex");
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${url} -> ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

// --- pager -------------------------------------------------------------------

export interface Page {
  received_at: string;
  receiver: string;
  status: string;
  alertname: string;
  severity: string;
  fingerprint: string;
  starts_at: string;
}

export interface Marker {
  received_at: string;
  label: string;
  details: Record<string, unknown>;
}

export const pager = {
  mark: (label: string, details: Record<string, unknown> = {}) =>
    json<Marker>(`${urls.pager}/v1/markers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label, details }),
    }),
  pages: async (since: string) =>
    (await json<{ pages: Page[] }>(`${urls.pager}/v1/pages?since=${encodeURIComponent(since)}`)).pages,
};

// --- Prometheus and Alertmanager -------------------------------------------

interface PromVector {
  metric: Record<string, string>;
  value: [number, string];
}

interface PromMatrix {
  metric: Record<string, string>;
  values: [number, string][];
}

export const prometheus = {
  async query(expr: string, time?: string): Promise<PromVector[]> {
    const params = new URLSearchParams({ query: expr });
    if (time) params.set("time", time);
    const body = await json<{ data: { result: PromVector[] } }>(`${urls.prometheus}/api/v1/query?${params}`);
    return body.data.result;
  },
  async scalar(expr: string, time?: string): Promise<number | null> {
    const result = await prometheus.query(expr, time);
    const value = result[0]?.value[1];
    return value === undefined ? null : Number(value);
  },
  async range(expr: string, start: string, end: string, step = "5s"): Promise<PromMatrix[]> {
    const params = new URLSearchParams({ query: expr, start, end, step });
    const body = await json<{ data: { result: PromMatrix[] } }>(`${urls.prometheus}/api/v1/query_range?${params}`);
    return body.data.result;
  },
  async loadedAlertRules(): Promise<{ name: string; for_seconds: number; query: string }[]> {
    const body = await json<{ data: { groups: { rules: { name: string; duration: number; query: string }[] }[] } }>(
      `${urls.prometheus}/api/v1/rules?type=alert`,
    );
    return body.data.groups.flatMap((g) => g.rules.map((r) => ({ name: r.name, for_seconds: r.duration, query: r.query })));
  },
};

export const alertmanager = {
  activeAlerts: async () =>
    json<{ labels: Record<string, string> }[]>(`${urls.alertmanager}/api/v2/alerts?active=true&silenced=false&inhibited=false`),
};

// --- toxiproxy ---------------------------------------------------------------

export const toxiproxy = {
  async addLatency(ms: number): Promise<void> {
    await json(`${urls.toxiproxy}/proxies/postgres/toxics`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "gameday_latency", type: "latency", stream: "downstream", toxicity: 1, attributes: { latency: ms, jitter: 0 } }),
    });
  },
  async toxics(): Promise<{ name: string }[]> {
    return json(`${urls.toxiproxy}/proxies/postgres/toxics`);
  },
  async removeAll(): Promise<void> {
    for (const toxic of await toxiproxy.toxics()) {
      const res = await fetch(`${urls.toxiproxy}/proxies/postgres/toxics/${toxic.name}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(`could not remove toxic ${toxic.name}`);
    }
  },
};
