import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

describe("CENTROPY governed workforce truth", () => {
  const root = process.cwd()
  const surface = readFileSync(join(root, "src/components/centropy/agents/AgentFleetSurface.tsx"), "utf8")

  it("has no static fleet authority and reads the source-backed workforce projection", () => {
    expect(existsSync(join(root, "src/components/centropy/agents/agent-fleet.ts"))).toBe(false)
    expect(surface).not.toContain("AGENT_FLEET")
    expect(surface).toContain("usePeProductData")
    expect(surface).toContain("profileById.has(worker.id)")
    expect(surface).toContain("rootWorkIds.has(worker.latestAssignment.workId)")
  })

  it("never substitutes static agents or inferred health for P7 truth", () => {
    expect(surface).not.toMatch(/Five real calling agents|Fifty-nine registered actions|integrationsProjection|voiceAssistants/)
    expect(surface).toContain("UNKNOWN")
    expect(surface).toContain("No static persona, decorative agent, or tenant-wide worker was substituted")
  })
})
