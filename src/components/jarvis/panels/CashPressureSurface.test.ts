import { describe, expect, it } from "vitest"
import { buildAgingSummary, collectionMatchesView, collectionWorkBandLabel, deriveAgingBand, filterCollectionWork, groupCollectionWork, invoiceMatchesView, safeBusinessLabel } from "./cash-pressure-model"
import type { InvoiceResource, WorkCaseProjection } from "@/lib/jarvis-client"

const now = new Date("2026-08-08T00:00:00.000Z")

function invoice(overrides: Partial<InvoiceResource> = {}): InvoiceResource {
  return {
    id: "invoice-1",
    tenantId: "tenant-1",
    householdId: "household-1",
    amountUsd: 100,
    status: "sent",
    memo: "Service invoice",
    dueDate: "2026-08-08T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  }
}

function workCase(actionTypes: string[]): WorkCaseProjection {
  return {
    id: `case-${actionTypes.join("-")}`,
    root: { kind: "instruction", id: "instruction-1" },
    title: "Invoice follow-up",
    status: "Waiting",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    source: { kind: "typed", id: "instruction-1", channel: "typed" },
    instruction: null,
    actions: actionTypes.map((actionType, index) => ({
      id: `action-${index}`,
      actionType,
      status: "pending",
      summary: actionType,
      instructionId: "instruction-1",
      planId: null,
      dependsOn: [],
      payload: {},
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
    })),
    approvals: [],
    workflows: [],
    receipts: [],
    linkedEntities: [],
    businessEvents: [],
    calls: [],
    relatedActionIds: [],
    provenance: [],
  }
}

describe("P2.T5 Cash Pressure Field contract", () => {
  it("keeps exact due-date aging boundaries", () => {
    expect(deriveAgingBand("2026-08-09T00:00:00.000Z", now)).toBe("current")
    expect(deriveAgingBand("2026-08-07T00:00:00.000Z", now)).toBe("1-30")
    expect(deriveAgingBand("2026-07-08T00:00:00.000Z", now)).toBe("31-60")
    expect(deriveAgingBand("2026-06-08T00:00:00.000Z", now)).toBe("61-90")
    expect(deriveAgingBand("2026-05-09T00:00:00.000Z", now)).toBe("90+")
  })

  it("renders aging only when every open invoice has due date and amount truth", () => {
    const summary = buildAgingSummary([
      invoice({ id: "current", amountUsd: 100, dueDate: "2026-08-09T00:00:00.000Z" }),
      invoice({ id: "overdue", amountUsd: "250", status: "overdue", dueDate: "2026-07-08T00:00:00.000Z" }),
      invoice({ id: "paid", amountUsd: 900, status: "paid", dueDate: null }),
    ], now)
    expect(summary.eligible).toBe(true)
    expect(summary.bands.find((band) => band.key === "current")?.totalUsd).toBe(100)
    expect(summary.bands.find((band) => band.key === "31-60")?.invoiceIds).toEqual(["overdue"])

    const fallback = buildAgingSummary([invoice({ dueDate: null })], now)
    expect(fallback.eligible).toBe(false)
    expect(fallback.reason).toContain("no usable due date or amount")
  })

  it("filters Collections Work by the exact invoice-to-cash action family", () => {
    const collection = workCase(["send_payment_reminder"])
    const unrelated = workCase(["schedule_service_visit"])
    expect(filterCollectionWork([collection, unrelated]).map((item) => item.id)).toEqual([collection.id])
  })

  it("keeps decision views explicit instead of rendering the full ledger by default", () => {
    expect(invoiceMatchesView(invoice({ status: "overdue" }), "open")).toBe(true)
    expect(invoiceMatchesView(invoice({ status: "paid" }), "open")).toBe(false)
    expect(invoiceMatchesView(invoice({ status: "paid" }), "paid")).toBe(true)
    expect(invoiceMatchesView(invoice({ status: "draft" }), "all")).toBe(true)

    const active = workCase(["send_payment_reminder"])
    const completed = { ...active, status: "Completed" as const }
    const partial = { ...active, status: "Partial" as const }
    const cancelled = { ...active, status: "Cancelled" as const }
    expect(collectionMatchesView(active, "active")).toBe(true)
    expect(collectionMatchesView(completed, "active")).toBe(false)
    expect(collectionMatchesView(completed, "history")).toBe(true)
    expect(collectionMatchesView(partial, "active")).toBe(false)
    expect(collectionMatchesView(partial, "history")).toBe(true)
    expect(collectionMatchesView(cancelled, "active")).toBe(false)
    expect(collectionMatchesView(cancelled, "history")).toBe(true)
  })

  it("does not claim a collection-Work absence while its source is unavailable", () => {
    expect(collectionWorkBandLabel("loading", 0)).toBe("Reading collection Work…")
    expect(collectionWorkBandLabel("unavailable", 0)).toBe("Collection Work unavailable")
    expect(collectionWorkBandLabel("live", 0)).toBe("No collection Work linked")
    expect(collectionWorkBandLabel("live", 2)).toBe("2 collection Work")
  })

  it("groups repeated collection projections while preserving every exact record", () => {
    const first = { ...workCase(["send_payment_reminder"]), id: "case-one" }
    const second = { ...workCase(["send_payment_reminder"]), id: "case-two" }
    const paid = { ...workCase(["record_payment"]), id: "case-three", status: "Completed" as const }

    const groups = groupCollectionWork([first, second, paid])

    expect(groups).toHaveLength(2)
    expect(groups.find((group) => group.cases.some((item) => item.id === "case-one"))?.cases.map((item) => item.id)).toEqual(["case-one", "case-two"])
  })

  it("never renders data placeholders as customer-facing labels", () => {
    expect(safeBusinessLabel("Payment reminder for undefined", "Payment reminder")).toBe("Payment reminder")
    expect(safeBusinessLabel("  ", "Memo not recorded")).toBe("Memo not recorded")
    expect(safeBusinessLabel("Annual service", "Memo not recorded")).toBe("Annual service")
  })
})
