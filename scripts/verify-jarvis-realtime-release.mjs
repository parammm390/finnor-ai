// Read-only release preflight for the Jarvis instruction realtime contract.
// This intentionally does not import deployment clients, open a database
// connection, execute SQL, or call an admin/migration endpoint.

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const failures = []

function file(path) {
  try {
    return readFileSync(resolve(root, path), "utf8")
  } catch {
    failures.push(`missing or unreadable file: ${path}`)
    return ""
  }
}

function includes(path, source, fragment) {
  if (!source.includes(fragment)) failures.push(`${path} is missing required contract: ${fragment}`)
}

const migration = file("finnor-os/packages/db/migrations/0062_instruction_lifecycle.sql")
const bundle = file("finnor-os/packages/db/migrations-bundle.ts")
const instructionRoute = file("finnor-os/apps/api/app/api/instructions/[id]/route.ts")
const eventsRoute = file("finnor-os/apps/api/app/api/instructions/[id]/events/route.ts")
const streamRoute = file("finnor-os/apps/api/app/api/stream/route.ts")
const proxyRoute = file("src/app/api/jarvis/[...path]/route.ts")
const relayRoute = file("src/app/api/jarvis/stream/route.ts")
const openapiSource = file("finnor-os/openapi.json")
const deltaMigration = file("finnor-os/packages/db/migrations/0092_phase2_live_business_world.sql")
const tenantGateway = file("finnor-os/apps/worker/src/sse/gateway.ts")
const tenantRelay = file("src/app/api/jarvis/operational-stream/route.ts")
const tenantReducer = file("src/components/jarvis/lib/operational-delta.ts")

includes("0062_instruction_lifecycle.sql", migration, "CREATE TABLE IF NOT EXISTS finnor_os.instruction_sessions")
includes("0062_instruction_lifecycle.sql", migration, "CREATE TABLE IF NOT EXISTS finnor_os.instruction_events")
includes("0062_instruction_lifecycle.sql", migration, "ALTER TABLE finnor_os.domain_actions ADD COLUMN IF NOT EXISTS instruction_id")
includes("migrations-bundle.ts", bundle, "0062_instruction_lifecycle.sql")
includes("instructions/[id]/route.ts", instructionRoute, "export async function GET")
includes("instructions/[id]/events/route.ts", eventsRoute, "after")
includes("instructions/[id]/events/route.ts", eventsRoute, "Instruction not found")
includes("stream/route.ts", streamRoute, "text/event-stream")
includes("stream/route.ts", streamRoute, "instructionId")
includes("jarvis/[...path]/route.ts", proxyRoute, 'a === "instructions"')
includes("jarvis/[...path]/route.ts", proxyRoute, 'a === "events"')
includes("jarvis/[...path]/route.ts", proxyRoute, 'a === "business-world" || a === "operational-deltas"')
includes("jarvis/stream/route.ts", relayRoute, "upstream.body")
includes("jarvis/stream/route.ts", relayRoute, "text/event-stream")
includes("0092_phase2_live_business_world.sql", deltaMigration, "CREATE TABLE IF NOT EXISTS finnor_os.operational_deltas")
includes("0092_phase2_live_business_world.sql", deltaMigration, "FORCE ROW LEVEL SECURITY")
includes("0092_phase2_live_business_world.sql", deltaMigration, "purge_operational_deltas")
includes("worker/sse/gateway.ts", tenantGateway, "readOperationalDeltas")
includes("worker/sse/gateway.ts", tenantGateway, "last-event-id")
includes("jarvis/operational-stream/route.ts", tenantRelay, "upstream.body")
includes("operational-delta.ts", tenantReducer, "reduceOperationalDelta")

try {
  const openapi = JSON.parse(openapiSource)
  for (const path of ["/api/instructions/{id}", "/api/instructions/{id}/events", "/api/stream"]) {
    if (!openapi.paths?.[path]?.get) failures.push(`openapi.json is missing GET ${path}`)
  }
  for (const path of ["/api/business-world", "/api/operational-deltas"]) {
    if (!openapi.paths?.[path]?.get) failures.push(`openapi.json is missing GET ${path}`)
  }
} catch {
  failures.push("openapi.json is not valid JSON")
}

if (failures.length > 0) {
  console.error("Jarvis realtime release preflight: FAIL")
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log("Jarvis realtime release preflight: PASS (read-only; no database or deployment calls made)")
}
