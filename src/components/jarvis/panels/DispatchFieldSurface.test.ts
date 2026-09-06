import { describe, expect, it } from "vitest"
import { dispatchSourceState, dispatchStopMatchesFocus, exactWorkCaseForStop, shiftIsoDate, workEntityIds } from "./dispatch-field-model"
import type { Stop } from "./DispatchMap"
import type { WorkCaseProjection } from "@/lib/jarvis-client"

const stop: Stop = {
  visitId: "visit-1",
  sourceKind: "service_visit",
  technicianId: "tech-1",
  technicianName: "Tech One",
  householdId: "household-1",
  address: "1 Traversal Ave",
  latitude: 42,
  longitude: -92,
  type: "maintenance",
  scheduledAt: "2026-08-08T15:00:00.000Z",
  notes: null,
  optimized: { sequence: 1 },
}

function workCase(visitId: string, entities: WorkCaseProjection["linkedEntities"] = []): WorkCaseProjection {
  return {
    id: `case-${visitId}`,
    root: { kind: "instruction", id: "instruction-1" },
    title: "Dispatch visit",
    status: "Working",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    source: { kind: "typed", id: "instruction-1", channel: "typed" },
    instruction: null,
    actions: [],
    approvals: [],
    workflows: [],
    receipts: [],
    linkedEntities: [{ entityType: "service_visit", entityId: visitId, via: "action.payload.serviceVisitId" }, ...entities],
    businessEvents: [],
    calls: [],
    relatedActionIds: [],
    provenance: [],
  }
}

describe("P2.T4 Dispatch Field continuity contract", () => {
  it("keeps loading distinct from source unavailability", () => {
    expect(dispatchSourceState({ data: null, loading: true, error: null })).toBe("loading")
    expect(dispatchSourceState({ data: null, loading: false, error: "network" })).toBe("unavailable")
    expect(dispatchSourceState({ data: { stops: [] }, loading: false, error: null })).toBe("live")
  })
  it("matches a Work case only by the exact visit/service-visit ID", () => {
    const sameHouseholdDifferentVisit = { ...workCase("visit-2"), linkedEntities: [{ entityType: "household", entityId: stop.householdId, via: "action.payload.householdId" }] }
    expect(exactWorkCaseForStop(stop, [sameHouseholdDifferentVisit])).toBeNull()
    expect(exactWorkCaseForStop(stop, [workCase(stop.visitId)])?.id).toBe("case-visit-1")
  })

  it("matches canonical appointments only through the appointment namespace", () => {
    const appointmentStop = { ...stop, visitId: "appointment-1", sourceKind: "appointment" as const }
    const visitOnly = workCase("appointment-1")
    const appointmentCase = workCase("different-visit", [{ entityType: "appointment", entityId: "appointment-1", via: "action.result.appointmentId" }])
    expect(exactWorkCaseForStop(appointmentStop, [visitOnly])).toBeNull()
    expect(exactWorkCaseForStop(appointmentStop, [appointmentCase])?.id).toBe("case-different-visit")
  })

  it("keeps job and appointment IDs exact when the Work case carries them", () => {
    const linked = workCase(stop.visitId, [
      { entityType: "work_order", entityId: "work-order-1", via: "action.payload.workOrderId" },
      { entityType: "appointment", entityId: "appointment-1", via: "action.payload.appointmentId" },
    ])
    expect(workEntityIds(linked, "work_order")).toEqual(["work-order-1"])
    expect(workEntityIds(linked, "appointment")).toEqual(["appointment-1"])
  })

  it("marks a route stop only when every incoming focus identifier matches exactly", () => {
    const linked = workCase(stop.visitId, [
      { entityType: "work_order", entityId: "work-order-1", via: "action.payload.workOrderId" },
      { entityType: "appointment", entityId: "appointment-1", via: "action.payload.appointmentId" },
    ])
    expect(dispatchStopMatchesFocus(stop, linked, { householdId: "household-1", visitId: "visit-1", serviceVisitId: null, workOrderId: "work-order-1", appointmentId: "appointment-1" })).toBe(true)
    expect(dispatchStopMatchesFocus(stop, linked, { householdId: "household-1", visitId: "visit-2", serviceVisitId: null, workOrderId: "work-order-1", appointmentId: "appointment-1" })).toBe(false)
  })

  it("moves the quiet-day control across month boundaries deterministically", () => {
    expect(shiftIsoDate("2026-08-01", -1)).toBe("2026-07-31")
    expect(shiftIsoDate("2026-12-31", 1)).toBe("2027-01-01")
    expect(shiftIsoDate("not-a-date", 1)).toBe("not-a-date")
  })
})
