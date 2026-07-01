import { defineConfig } from "@playwright/test";

// E2E for the web frontend (docs/ui-handoff.md). The app under test is the dev
// harness (src/dev/harness.ts): full UI over a seeded in-memory DB, no hardware.
// Playwright boots ONE harness; each test resets state via POST /__dev/reset.
const PORT = Number(process.env.E2E_PORT ?? 4123);
const BASE = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./test/e2e",
  // .e2e.ts (not .spec/.test) so Bun's own test runner never collects these.
  testMatch: "**/*.e2e.ts",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false, // single shared harness → run serially for isolation
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["line"]] : "line",
  use: {
    baseURL: BASE,
    headless: true,
    browserName: "chromium",
    trace: process.env.CI ? "retain-on-failure" : "off",
  },
  webServer: {
    command: "bun run src/dev/harness.ts",
    env: { HTTP_PORT: String(PORT), SEED: "1" },
    url: `${BASE}/api/queue`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
