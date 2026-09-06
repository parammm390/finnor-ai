import { describe, expect, it } from "vitest"
import { deriveWorkspaceProgress, splitResearchNarrative } from "./presentation"

describe("adaptive workspace presentation", () => {
  it("projects real instruction states into a compact progressive lifecycle", () => {
    const planning = deriveWorkspaceProgress({
      state: "planning",
      actionCount: 2,
      expectedActionCount: 3,
      contextCount: 4,
      hasCanonicalQuery: false,
      hasExternalEvidence: false,
      transportPosture: "healthy",
    })

    expect(planning.activeStage).toBe("planning")
    expect(planning.detail).toContain("2 of 3 actions")
    expect(planning.steps.find((step) => step.key === "accepted")?.status).toBe("complete")
    expect(planning.steps.find((step) => step.key === "planning")?.status).toBe("active")
    expect(planning.steps.find((step) => step.key === "completed")?.status).toBe("pending")
  })

  it("does not infer completion when the live trace is offline", () => {
    const failed = deriveWorkspaceProgress({
      state: "failed",
      actionCount: 1,
      expectedActionCount: 1,
      contextCount: 0,
      hasCanonicalQuery: false,
      hasExternalEvidence: false,
      transportPosture: "offline",
    })

    expect(failed.activeStage).toBe("recovery")
    expect(failed.detail).toContain("completion is not inferred")
    expect(failed.steps.find((step) => step.key === "completed")?.status).toBe("not-applicable")
  })

  it("shows real canonical query and external-research progress from trace events", () => {
    const canonical = deriveWorkspaceProgress({
      state: "understanding",
      actionCount: 0,
      expectedActionCount: null,
      contextCount: 1,
      hasCanonicalQuery: false,
      hasExternalEvidence: false,
      progress: { stage: "querying_business", sourceKind: "CANONICAL" },
    })
    expect(canonical.activeStage).toBe("query")
    expect(canonical.activeLabel).toBe("Querying canonical business records")
    expect(canonical.detail).toContain("Zero results will only be shown after the query completes")

    const research = deriveWorkspaceProgress({
      state: "executing",
      actionCount: 1,
      expectedActionCount: 1,
      contextCount: 3,
      hasCanonicalQuery: false,
      hasExternalEvidence: true,
      progress: { stage: "researching_verified_external_sources", sourceKind: "WEB" },
    })
    expect(research.activeStage).toBe("executing")
    expect(research.activeLabel).toBe("Researching verified external sources")
    expect(research.detail).toContain("actual candidates")
  })

  it("breaks a long research answer into readable narrative blocks without changing its words", () => {
    const blocks = splitResearchNarrative("First finding. Second finding with more evidence. Third finding.")
    expect(blocks).toEqual(["First finding. Second finding with more evidence. Third finding."])

    const long = splitResearchNarrative([
      "One finding is grounded in the verified company record.",
      "Two findings are grounded in the verified company record.",
      "Three findings are grounded in the verified company record.",
      "Four findings are grounded in the verified company record.",
      "Five findings are grounded in the verified company record.",
      "Six findings are grounded in the verified company record.",
      "Seven findings are grounded in the verified company record.",
      "Eight findings are grounded in the verified company record.",
      "Nine findings are grounded in the verified company record.",
      "Ten findings are grounded in the verified company record.",
    ].join(" "))
    expect(long.length).toBeGreaterThan(1)
    expect(long.join(" ")).toContain("Seven findings are")
  })
})
