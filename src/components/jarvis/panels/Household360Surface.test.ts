import { describe, expect, it } from "vitest"
import { HOUSEHOLD_BANDS, householdDisplayName, summarizeHousehold } from "./household360-model"
import type { Household360Projection, WorkCaseProjection } from "@/lib/jarvis-client"

const household: Household360Projection = {
  household: { id: "hh-1", address: "1 Traversal Ave", contactInfo: {}, marketingConsent: true, createdAt: "2026-08-01T00:00:00.000Z" },
  contacts: [{ id: "contact-1", name: "Pat Owner", role: "primary", methods: [{ methodType: "phone", value: "+1555", consent: true }] }],
  equipment: [{ id: "equipment-1", type: "water_softener", model: "A-100", installDate: "2026-01-01T00:00:00.000Z", source: "finnor" }],
  leads: [],
  opportunities: [],
  quotes: [],
  invoices: [{ id: "invoice-1", status: "sent", amountUsd: 2500, memo: null, createdAt: "2026-08-01T00:00:00.000Z", dueDate: "2026-09-01T00:00:00.000Z", payments: [{ amountUsd: 500, method: "card", status: "succeeded", receivedAt: "2026-08-02T00:00:00.000Z" }] }],
  workOrders: [{ id: "work-order-1", type: "install", status: "scheduled", technicianId: null, depositAmountUsd: null, createdAt: "2026-08-01T00:00:00.000Z", scheduledAt: "2026-08-20T15:00:00.000Z", completedAt: null }],
  serviceVisits: [{ id: "visit-1", type: "maintenance", technicianId: null, scheduledAt: "2026-08-20T15:00:00.000Z", completedAt: null, notes: null }, { id: "visit-0", type: "maintenance", technicianId: null, scheduledAt: "2026-01-01T15:00:00.000Z", completedAt: "2026-01-02T15:00:00.000Z", notes: null }],
  appointments: [],
  conversations: [],
  calls: [],
  documents: [],
  legacyCommunications: [],
  timeline: [],
  queryMs: 2,
}

const workCase: WorkCaseProjection = {
  id: "case-1",
  root: { kind: "instruction", id: "instruction-1" },
  title: "Schedule install",
  status: "Working",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  source: { kind: "typed", id: "instruction-1", channel: "typed" },
  instruction: null,
  actions: [],
  approvals: [],
  workflows: [],
  receipts: [],
  linkedEntities: [{ entityType: "household", entityId: "hh-1", via: "action.payload.householdId" }],
  businessEvents: [],
  calls: [],
  relatedActionIds: [],
  provenance: [],
}

describe("P2.T3 Household 360 contract", () => {
  it("keeps the three continuous operational bands", () => {
    expect(HOUSEHOLD_BANDS).toEqual(["IDENTITY", "SERVICE & EQUIPMENT", "CURRENT BUSINESS STATE"])
  })

  it("uses the exact primary contact and linked Work case for summary facts", () => {
    const summary = summarizeHousehold(household, [workCase], new Date("2026-08-08T00:00:00.000Z"))
    expect(householdDisplayName(household.household, household.contacts)).toBe("Pat Owner")
    expect(summary.equipment).toBe("Water Softener · A-100")
    expect(summary.lastService).toBe("2026-01-02T15:00:00.000Z")
    expect(summary.nextServiceId).toBe("visit-1")
    expect(summary.openWorkCount).toBe(1)
    expect(summary.openBalanceUsd).toBe(2000)
    expect(summary.alert).toBe("No alert recorded")
  })

  it("falls back to direct household work orders when the Work projection is unavailable", () => {
    expect(summarizeHousehold(household, null, new Date("2026-08-08T00:00:00.000Z")).openWorkCount).toBe(1)
  })
})
