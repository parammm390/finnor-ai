import { defineConfig, devices } from "@playwright/test"

// An isolated server, never a deployed app or an existing signed-in server.
const baseURL = "http://127.0.0.1:3013"
process.env.PLAYWRIGHT_BASE_URL = baseURL
process.env.FINNOR_OUTCOMES_FIXTURE = "1"

export default defineConfig({
  testDir: "./e2e",
  testMatch: "centropy-conversation-outcomes.spec.ts",
  outputDir: "test-results/conversation-outcomes",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  expect: { timeout: 10_000 },
  use: { baseURL, serviceWorkers: "block", trace: "on", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-390", use: { viewport: { width: 390, height: 844 }, browserName: "chromium" } },
  ],
  webServer: {
    command: "npm run dev -- --hostname 127.0.0.1 --port 3013",
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://outcomes-fixture.invalid",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "isolated-public-fixture",
      NEXT_PUBLIC_FINNOR_AUTH_PROVIDER: "supabase",
    },
  },
})
