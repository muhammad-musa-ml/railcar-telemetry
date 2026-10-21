import { defineConfig } from "vitest/config";

// Integration tests run against the stack started by `docker compose up`.
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 90_000,
    fileParallelism: false,
  },
});
