import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConsoleApp } from "../../src/console/app";
import { OperatorTokens } from "../../src/console/auth";
import { RateLimiter } from "../../src/console/rate-limit";
import { createRegistry } from "../../src/shared/metrics";
import { FakeAlertmanager, FakeAudit, FakeDeadLetters, FakePager, FakePrometheus, FakeQuery } from "./console-fakes";

// A stand-in for the built console-ui: an index page and one hashed asset.
const UI_DIR = join(__dirname, "fixtures", "console-ui");

function setup(uiDir?: string) {
  return buildConsoleApp({
    prometheus: new FakePrometheus(),
    alertmanager: new FakeAlertmanager(),
    pager: new FakePager(),
    query: new FakeQuery(),
    deadLetters: new FakeDeadLetters(),
    audit: new FakeAudit(),
    operators: OperatorTokens.parse("alice:alice-token-0123456789"),
    rateLimiter: new RateLimiter(10, 60_000),
    registry: createRegistry("console", false),
    uiDir,
  });
}

describe("console page", () => {
  it("serves the built page at / with the security headers, and never caches it", async () => {
    const res = await setup(UI_DIR).inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.body).toContain("fixture console page");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("serves hashed assets with a long cache lifetime", async () => {
    const res = await setup(UI_DIR).inject({ method: "GET", url: "/assets/app-0f1e2d3c.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  });

  it("serves nothing outside the page's folder", async () => {
    const app = setup(UI_DIR);
    for (const url of ["/../console-fakes.ts", "/%2e%2e/console-fakes.ts", "/assets/../../console-fakes.ts", "/package.json"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain("FakePrometheus");
    }
  });

  it("keeps API answers JSON, including the 404 for an unknown API path", async () => {
    const app = setup(UI_DIR);
    const missing = await app.inject({ method: "GET", url: "/api/nothing-here" });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).toMatch(/^application\/json/);
    expect(missing.headers["cache-control"]).toBe("no-store");
    const status = await app.inject({ method: "GET", url: "/api/status" });
    expect(status.statusCode).toBe(200);
    expect(status.headers["content-type"]).toMatch(/^application\/json/);
  });

  it("serves the API alone when no page was built", async () => {
    const app = setup(undefined);
    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });
});
