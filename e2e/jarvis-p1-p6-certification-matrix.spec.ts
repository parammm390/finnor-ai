import { expect, test } from "@playwright/test"
import { JARVIS_P1_P6_CERTIFICATION_MATRIX } from "./jarvis-p1-p6-certification-matrix"

test.describe("JARVIS P1–P6 executable certification matrix", () => {
  test("every user-facing contract has normal, failure, refresh, and result evidence", () => {
    expect(JARVIS_P1_P6_CERTIFICATION_MATRIX.length).toBeGreaterThanOrEqual(10)
    for (const row of JARVIS_P1_P6_CERTIFICATION_MATRIX) {
      expect(row.id).toMatch(/^[a-z0-9-]+$/)
      expect(row.route).not.toBe("")
      expect(row.backendPrimitive).not.toBe("")
      expect(row.expectedDurableState).not.toBe("")
      expect(row.expectedUiState).not.toBe("")
      expect(row.normalJourney).toMatch(/\.(spec|test)\./)
      expect(row.failureJourney).toMatch(/\.(spec|test)\./)
      expect(row.refreshJourney).toMatch(/\.(spec|test)\./)
      expect(["pass", "blocked-by-deployment", "scoped-skip"]).toContain(row.result)
      expect(row.outcomeEvidence.provesRequestedOutcome).toBe(row.result === "pass")
      expect(row.outcomeEvidence.kind).not.toBe("fixture")
    }
    expect(new Set(JARVIS_P1_P6_CERTIFICATION_MATRIX.map((row) => row.id)).size).toBe(JARVIS_P1_P6_CERTIFICATION_MATRIX.length)
  })
})
