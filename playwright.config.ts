import { defineConfig, devices } from "@playwright/test"

// Phase 7 MAESTRO PACK §7.10 — run against local/staging in CI, per the pack's own
// wording. Defaults to spinning up `next dev` locally (no external dependency needed
// to run these); set PLAYWRIGHT_BASE_URL to point at a deployed staging/prod URL
// instead (skips the local webServer).
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000"

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // A single `next start` process serving many concurrent Playwright workers at
  // once (this repo's default local run: 2 projects x full parallelism) measurably
  // slows first render under that combined load — real finding, not a test bug:
  // running just one project passed reliably, running the whole suite together
  // started missing the default 5s expect timeout. Fewer workers keeps the server
  // from being the bottleneck; a slightly longer expect timeout absorbs the rest.
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["html", { open: "never" }]],
  // Baselines were deliberately reviewed and committed on macOS. Linux CI must
  // compare to that same reviewed set rather than treating every snapshot as new.
  // The per-view visual tolerances in the spec continue to catch real regressions.
  snapshotPathTemplate: process.env.CI ? "{testDir}/{testFilePath}-snapshots/{arg}-{projectName}-darwin{ext}" : undefined,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: "on-first-retry",
    video: process.env.PLAYWRIGHT_RECORD_VIDEO === "1" ? "on" : "off",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    // Phase 7 §7.9/§7.10: the technician visit-report flow must work at 375px.
    // Chromium, not the iPhone SE preset's default WebKit engine — keeps this
    // runnable without a second ~200MB browser download; the viewport is what matters.
    { name: "mobile-375", use: { viewport: { width: 375, height: 812 }, browserName: "chromium" } },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000",
        // The deterministic Thread fixtures are test-only and the route is
        // deliberately fail-closed unless this build-time public flag is present.
        // Supply it only to Playwright's local server so every fixture test exercises
        // the labeled harness rather than receiving the intended 404.
        env: { ...process.env, NEXT_PUBLIC_JARVIS_NEXT: "1", NEXT_PUBLIC_JARVIS_TEST_MODE: "1" },
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
})
