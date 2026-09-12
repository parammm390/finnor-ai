import { describe, expect, it } from "vitest"
import { MOBILE_SURFACES, SURFACES, withOperationalContext } from "./OperationalSurfaceNav"
import type { PeOperatingContext } from "../pe/contracts"

describe("Phase 8 Private Equity surface dock", () => {
  const context: PeOperatingContext = { root: { entityType: "pe_deal", entityId: "11111111-1111-4111-8111-111111111111" }, selectedObject: null, workId: "work-1" }

  it("keeps exactly the four Workspace V3 surfaces", () => {
    expect(SURFACES.map((surface) => surface.key)).toEqual(["home", "deals", "work", "agents"])
  })

  it("keeps the same four surfaces on mobile", () => {
    expect(MOBILE_SURFACES.map((surface) => surface.key)).toEqual(["home", "deals", "work", "agents"])
  })

  it("carries only the typed PE root and durable Work context", () => {
    const href = withOperationalContext("/jarvis/deals#graph", context)
    const url = new URL(href, "https://finnor.test")
    expect(JSON.parse(url.searchParams.get("root")!)).toEqual(context.root)
    expect(url.searchParams.get("workId")).toBe("work-1")
    expect(href).not.toContain("household")
    expect(url.hash).toBe("#graph")
  })
})
