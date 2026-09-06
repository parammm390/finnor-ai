import { describe, expect, it } from "vitest"
import { MOBILE_SURFACES, SURFACES, withHouseholdContext, withOperationalContext } from "./OperationalSurfaceNav"

describe("P2.T6 operational surface dock", () => {
  it("keeps the six canonical surfaces and exact household return context", () => {
    expect(SURFACES.map((surface) => surface.key)).toEqual(["home", "work", "customers", "schedule", "money", "agents"])
    expect(withHouseholdContext("/jarvis/work", { id: "hh-1", label: "Household hh-1" })).toBe("/jarvis/work?householdId=hh-1")
    expect(withHouseholdContext("/jarvis/money", { id: "hh/1", label: "Household" })).toBe("/jarvis/money?householdId=hh%2F1")
    expect(withHouseholdContext("/jarvis", { id: "hh-1", label: "Household hh-1" })).toBe("/jarvis?householdId=hh-1")
  })

  it("keeps the four-item mobile rail with More for secondary surfaces", () => {
    expect(MOBILE_SURFACES.map((surface) => surface.key)).toEqual(["home", "work", "schedule", "money"])
  })

  it("carries durable Work and household context through the existing surface routes", () => {
    expect(withOperationalContext("/jarvis/money", { id: "hh/1", label: "Household" }, "work:1")).toBe("/jarvis/money?householdId=hh%2F1&workCaseId=work%3A1")
    expect(withOperationalContext("/jarvis#jarvis-diagnostics", undefined, "work-1")).toBe("/jarvis?workCaseId=work-1#jarvis-diagnostics")
  })
})
