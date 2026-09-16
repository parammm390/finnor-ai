import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { readProtectedEnv, sanitizeVercelBuildEnvironment } from "./protected-env.mjs"

test("Vercel build environment retains public/config values and removes live credentials", () => {
  const directory = mkdtempSync(join(tmpdir(), "finnor-build-env-"))
  const path = join(directory, ".env.production.local")
  try {
    writeFileSync(path, [
      "NEXT_PUBLIC_SUPABASE_URL=https://public.example.invalid",
      "SUPABASE_URL=https://public-server.example.invalid",
      "PORTAL_ROLE=app",
      "DATABASE_URL=postgres://secret",
      "MIGRATIONS_DATABASE_URL=postgres://owner-secret",
      "SUPABASE_SERVICE_ROLE_KEY=private",
      "AWS_ACCESS_KEY_ID=private",
      "AWS_SECRET_ACCESS_KEY=private",
      "GROQ_API_KEY=private",
      "AXIOM_TOKEN=private",
      "CANARY_SIGNING_KEY=private",
      "CANARY_PASSWORD=private",
    ].join("\n"))
    const result = sanitizeVercelBuildEnvironment(path, { FINNOR_COMMIT_SHA: "a".repeat(40) })
    const parsed = readProtectedEnv(path)
    assert.equal(result.retained, 4)
    assert.equal(result.removed, 9)
    assert.deepEqual(Object.keys(parsed).sort(), ["FINNOR_COMMIT_SHA", "NEXT_PUBLIC_SUPABASE_URL", "PORTAL_ROLE", "SUPABASE_URL"])
    assert.doesNotMatch(readFileSync(path, "utf8"), /private|postgres:\/\/secret|owner-secret/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("unexpected release values cannot be smuggled into the build allowlist", () => {
  const directory = mkdtempSync(join(tmpdir(), "finnor-build-env-"))
  const path = join(directory, ".env.production.local")
  try {
    writeFileSync(path, "NEXT_PUBLIC_OK=1\n")
    assert.throws(() => sanitizeVercelBuildEnvironment(path, { VERCEL_TOKEN: "secret" }), /not allowlisted/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
