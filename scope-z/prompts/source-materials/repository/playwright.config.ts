import { defineConfig, devices } from "@playwright/test"
import { loadEnvConfig } from "@next/env"

loadEnvConfig(process.cwd())

// CENTROPY route, interaction, and visual verification. Defaults to an isolated local Next server;
// PLAYWRIGHT_BASE_URL may point the same assertions at a deployed release.
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000"

export default defineConfig({
  testDir: "./e2e",
  // Playwright clears its output directory before a run. Keep that cleanup
  // scoped so disposable databases and durable proof outside it survive.
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? "test-results/playwright",
  fullyParallel: true,
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["html", { open: "never" }]],
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: "on-first-retry",
    video: process.env.PLAYWRIGHT_RECORD_VIDEO === "1" ? "on" : "off",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    // Thread and Canvas are sibling modes on small screens.
    { name: "tablet", use: { viewport: { width: 834, height: 1194 }, browserName: "chromium" } },
    { name: "mobile-390", use: { viewport: { width: 390, height: 844 }, browserName: "chromium" } },
    { name: "mobile-375", use: { viewport: { width: 375, height: 812 }, browserName: "chromium" } },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
})
