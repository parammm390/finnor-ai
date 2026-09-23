import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// Unit-test runner for the CENTROPY kernel (plan v3 P1.T1).
//
// environment: "node" — deliberate, not a default. @testing-library/react@16 needs
// BOTH an @testing-library/dom@^10 peer and a DOM environment (jsdom / happy-dom).
// Neither is an authorised dependency in this plan (P1.T1 permits exactly vitest and
// @testing-library/react), so no DOM environment can be installed. Recorded under
// ## BLOCKERS in CENTROPY-FRONTEND-MAESTRO-STATE-v3.md. Until that is resolved, every
// unit test in this plan targets pure logic (kernel selectors, derivations), which is
// where the truth rules actually live.
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
    // `lib/centropy-auth.tsx` constructs the Supabase browser client at module load,
    // and that client validates its URL eagerly. Any test whose module graph reaches
    // it therefore needs these present. They are placeholders for module construction
    // only — nothing under test makes a network call, and no test asserts on them.
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
