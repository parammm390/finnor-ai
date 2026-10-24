import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

/** Registration metadata only. It does not execute or authorize a capability.
 * Keep provider credentials and tenant/database configuration out of the child.
 * Ordinary Node networking is denied there; this is not an OS sandbox. */
export function readCanonicalPlanner() {
  const backend = resolve(import.meta.dirname, "../../finnor-os")
  const result = execFileSync(process.execPath, [
    "--max-old-space-size=1024", resolve(import.meta.dirname, "read-canonical-planner.mjs"),
  ], {
    cwd: backend, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV === "test" ? "test" : "production", TSX_DISABLE_CACHE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const snapshot = JSON.parse(result)
  if (!Array.isArray(snapshot.entries) || !snapshot.entries.length ||
    !Array.isArray(snapshot.humanOnly) || !Array.isArray(snapshot.privateEquityActions) ||
    !snapshot.plugins || typeof snapshot.verticalKey !== "string")
    throw new Error("Invalid canonical planner registration snapshot")
  const identities = snapshot.entries.map(entry => entry.capability)
  if (identities.some(name => typeof name !== "string" || !name) || new Set(identities).size !== identities.length)
    throw new Error("Invalid or duplicate canonical planner identities")
  return snapshot
}
