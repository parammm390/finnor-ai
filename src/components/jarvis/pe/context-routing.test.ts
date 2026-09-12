import { describe, expect, it } from "vitest"
import { contextForInspection, inspectionHref, inspectionSurface, readInspectionTarget, readPeOperatingContext, withPeOperatingContext } from "./context-routing"
import type { CompanyBrainObjectRef, InspectionTarget, PeOperatingContext, PeWorldRootRef } from "./contracts"

const root: PeWorldRootRef = { entityType: "pe_deal", entityId: "11111111-1111-4111-8111-111111111111" }
const deal: CompanyBrainObjectRef = { namespace: "private_equity", owner: "@finnor/private-equity", type: "pe_deal", id: root.entityId }
const context: PeOperatingContext = { root, selectedObject: deal, workId: null }

describe("Private Equity operating context routing", () => {
  it("round-trips the exact typed context without a household parser", () => {
    const href = withPeOperatingContext("/jarvis/deals#graph", context)
    const params = new URL(href, "https://finnor.test").searchParams
    expect(readPeOperatingContext(params)).toEqual(context)
    expect(href).not.toContain("household")
  })

  it("routes each typed inspection target through one registry", () => {
    const assignment: InspectionTarget = { kind: "assignment", assignmentId: "assignment-1", workId: "work-1" }
    expect(inspectionSurface(assignment)).toBe("/jarvis/agents")
    expect(contextForInspection(context, assignment)).toMatchObject({ root, workId: "work-1" })
    const href = inspectionHref(context, assignment, { namespace: "workforce", owner: "@finnor/db", type: "agent_assignment", id: "11111111-1111-4111-8111-111111111112" })!
    const params = new URL(href, "https://finnor.test").searchParams
    expect(readInspectionTarget(params)).toEqual(assignment)
    expect(readPeOperatingContext(params).workId).toBe("work-1")
  })

  it("fails closed for malformed context and inspection JSON", () => {
    const params = new URLSearchParams({ root: JSON.stringify({ entityType: "household", entityId: "x" }), inspect: JSON.stringify({ kind: "work" }) })
    expect(readPeOperatingContext(params)).toEqual({ root: null, selectedObject: null, workId: null })
    expect(readInspectionTarget(params)).toBeNull()
  })
})
