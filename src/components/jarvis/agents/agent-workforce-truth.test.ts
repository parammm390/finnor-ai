import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

describe("JARVIS governed workforce truth", () => {
  const root = process.cwd()
  const surface = readFileSync(join(root, "src/components/jarvis/agents/AgentFleetSurface.tsx"), "utf8")

  it("has no static fleet authority and reads the source-backed workforce projection", () => {
    expect(existsSync(join(root, "src/components/jarvis/agents/agent-fleet.ts"))).toBe(false)
    expect(surface).not.toContain("AGENT_FLEET")
    expect(surface).toContain("businessProjections.workforceStatus()")
    expect(surface).toContain('data-source="api:read-models/workforce-status"')
  })

  it("renders every explicit source-backed status without a health claim", () => {
    for (const status of ["unconfigured", "idle", "working", "waiting", "blocked", "failed", "unavailable"]) {
      expect(surface).toContain(status)
    }
    expect(surface).not.toMatch(/Five real calling agents|Fifty-nine registered actions|integrationsProjection|voiceAssistants/)
    expect(surface).toContain("no inferred health")
  })
})
