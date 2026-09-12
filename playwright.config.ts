import { defineConfig, devices } from "@playwright/test"

// Phase 8 route and surface verification. Defaults to an isolated local Next server;
// PLAYWRIGHT_BASE_URL may point the same assertions at a deployed release.
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000"

export default defineConfig({
  testDir: "./e2e",
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
    // The exact four-surface PE shell must remain usable at the 375px breakpoint.
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
