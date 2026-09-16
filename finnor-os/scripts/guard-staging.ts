// npm run test:staging — runs the integration suite against a real staging database.
// Two deliberate refusals, both fail-closed:
//   1. STAGING=1 must be set explicitly — this is the opt-in that says "yes, I mean to
//      point at staging," not an ambient default a dev shell could have left on.
//   2. DATABASE_URL must be explicitly set in THIS invocation — no fallback to the
//      embedded-postgres dev default, so a forgotten env var can't silently run the
//      staging suite against localhost (or, worse, whatever DATABASE_URL happens to be
//      exported in the shell) and report a false "staging is fine."
// Provisioning staging itself (a separately contracted database and persistent runtime) is a human step per
// docs/staging-setup.md — this script only guards the command that exercises it once
// it exists.
import { spawnSync } from "node:child_process";
import { assertNotProductionDatabaseTarget } from "../packages/db/production-target-guard";

if (process.env.STAGING !== "1") {
  console.error("[test:staging] refusing to run: set STAGING=1 to confirm you mean to target a staging database.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("[test:staging] refusing to run: DATABASE_URL must be explicitly set to the staging Supabase connection string.");
  process.exit(1);
}
assertNotProductionDatabaseTarget(process.env.DATABASE_URL, "staging integration suite");

console.log(`[test:staging] running integration suite against ${new URL(process.env.DATABASE_URL).host}`);
const result = spawnSync("npx", ["vitest", "run", "tests/integration"], { stdio: "inherit", env: process.env });
process.exit(result.status ?? 1);
