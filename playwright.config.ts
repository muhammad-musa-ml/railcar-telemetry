import { defineConfig, devices } from "@playwright/test";

// The browser test drives the console page served by the running compose
// stack (`docker compose up`), in Chromium.
export default defineConfig({
  testDir: "test/e2e",
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.CONSOLE_URL ?? "http://localhost:8085",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
