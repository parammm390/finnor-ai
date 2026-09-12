import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

describe("JARVIS governed workforce truth", () => {
  const root = process.cwd()
  const surface = readFileSync(join(root, "src/components/jarvis/agents/AgentFleetSurface.tsx"), "utf8")

  it("has no static fleet authority and reads the source-backed workforce projection", () => {
    expect(existsSync(join(root, "src/components/jarvis/agents/agent-fleet.ts"))).toBe(false)
    expect(surface).not.toContain("AGENT_FLEET")
    expect(surface).toContain("useWorkforceStatus")
    expect(surface).toContain("profileIds.has(worker.id)")
    expect(surface).toContain("assignmentNodes.has(assignment.id)")
  })

  it("never substitutes static agents or inferred health for P7 truth", () => {
    expect(surface).not.toMatch(/Five real calling agents|Fifty-nine registered actions|integrationsProjection|voiceAssistants/)
    expect(surface).toContain("No workforce state inferred")
    expect(surface).toContain("No decorative or static agent persona is shown")
  })
})
