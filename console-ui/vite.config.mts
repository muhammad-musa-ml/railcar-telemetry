import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The console's page. `npm run build:ui` writes it to dist/console-ui, which
// the console service serves; `npm run test:ui` runs the component tests.
// `npx vite --config console-ui/vite.config.mts` serves it for development,
// passing /api to a console running on port 8085.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: "../dist/console-ui",
    emptyOutDir: true,
    // The page's scripts all come from this service (see the CSP in
    // src/console/app.ts), so no inline polyfill.
    modulePreload: { polyfill: false },
  },
  server: {
    proxy: { "/api": "http://localhost:8085" },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.tsx"],
    setupFiles: ["test/setup.ts"],
    // Vitest replaces CSS with an empty string unless told otherwise; the
    // contrast test reads the real stylesheet.
    css: { include: [/styles\.css/] },
  },
});
