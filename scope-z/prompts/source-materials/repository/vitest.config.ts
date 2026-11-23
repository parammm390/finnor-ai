import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Unit-test runner for the Centropy product kernel (plan v3 P1.T1).
//
// environment: "node" is deliberate. The unit suite covers pure logic; browser
// interaction and DOM behavior are exercised by the Playwright end-to-end suite.
//
// e2e/ is excluded: those are Playwright specs and are run by `npm run test:e2e`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules/**", "e2e/**", ".next/**", "finnor-os/**"],
    // The plan fixes the script string as exactly `vitest run`, and also requires it to
    // exit 0 before any test exists (P1.T1). That lives here rather than as a CLI flag.
    passWithNoTests: true,
    // Keep stable placeholders for tests that load Supabase configuration. The unit
    // suite does not make network calls.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key-not-a-real-credential",
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // tsconfig.json sets `"jsx": "preserve"` because Next does its own JSX transform.
  // Vitest has no Next pipeline, so it must be told to actually transform JSX —
  // otherwise importing any `.tsx` in a module graph fails to parse. Only matters
  // for transitively-imported components; the tests themselves are pure TS.
  oxc: {
    jsx: { runtime: "automatic" },
  },
})
