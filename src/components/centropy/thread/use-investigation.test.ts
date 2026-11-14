import { describe, expect, it } from "vitest"
import { olderPageFailureState, refreshFailureState, type InvestigationState } from "./use-investigation"

const THREAD = "10000000-0000-4000-8000-000000000001"
const OTHER_THREAD = "10000000-0000-4000-8000-000000000004"
const SCOPE = "employee:session:thread"
const NOW = "2026-11-14T00:00:00.000Z"

function state(): InvestigationState {
  return {
    forThreadId: THREAD,
    forScope: SCOPE,
    status: "ready",
    error: null,
    olderLoading: true,
    olderError: null,
    hasOlder: true,
    loaded: {
      thread: {
        id: THREAD,
        title: "Current verified Investigation",
        summary: null,
        revision: 2,
        activeWorkId: "10000000-0000-4000-8000-000000000002",
        activeObjectiveLoopId: null,
        lastActivityAt: NOW,
        createdAt: NOW,
        summaryThroughSequence: 0,
        activeReferences: [],
        unresolvedReferences: [],
        outcomeRefs: [],
      },
      messages: [{
        id: "10000000-0000-4000-8000-000000000003",
        threadId: THREAD,
        sequence: 101,
        role: "user",
        channel: "text",
        originalText: "Continue my original Work",
        instructionId: null,
        workId: "10000000-0000-4000-8000-000000000002",
        workInputId: null,
        resolutionSnapshot: null,
        resolutionProvenance: [],
        companyTruthSnapshot: null,
        outcomeRefs: [],
        createdAt: NOW,
      }],
    },
  }
}

describe("Investigation earlier-history recovery", () => {
  it("preserves loaded messages, Work identity, scope and retry affordance on transient fetch failure", () => {
    const original = state()
    const after = olderPageFailureState(original, THREAD, SCOPE, new Error("Network interrupted"))
    expect(after.loaded).toBe(original.loaded)
    expect(after.loaded?.thread.activeWorkId).toBe(original.loaded?.thread.activeWorkId)
    expect(after.loaded?.messages.map(message => message.originalText)).toEqual(["Continue my original Work"])
    expect(after).toMatchObject({ status: "ready", olderLoading: false, hasOlder: true, olderError: "Network interrupted", error: null })
  })

  it.each([429, 500, 503])("keeps existing Work visible for retryable HTTP %s", status => {
    const original = state()
    const after = olderPageFailureState(original, THREAD, SCOPE, { status })
    expect(after.loaded).toBe(original.loaded)
    expect(after).toMatchObject({ status: "ready", olderLoading: false, hasOlder: true, error: null })
    expect(after.olderError).toBe("Older turns unavailable")
  })

  it.each([401, 403, 404])("purges cached private content on access denial %s", status => {
    const original = state()
    const after = olderPageFailureState(original, THREAD, SCOPE, { status })
    expect(after.loaded).toBeNull()
    expect(after.hasOlder).toBe(false)
    expect(after).toMatchObject({ status: "error", olderLoading: false, error: "Investigation access is no longer available" })
  })

  it("cannot overwrite another thread's state when an old request fails late", () => {
    const original = state()
    expect(olderPageFailureState(original, OTHER_THREAD, SCOPE, new Error("late error"))).toBe(original)
    expect(olderPageFailureState(original, THREAD, "different-session", new Error("late error"))).toBe(original)
  })
})

describe("Investigation latest-page refresh recovery", () => {
  it("preserves the original Work and loaded messages after a network interruption", () => {
    const previous = { ...state(), olderLoading: false }
    const after = refreshFailureState(previous, THREAD, SCOPE, new Error("Network interrupted"))
    expect(after.loaded).toBe(previous.loaded)
    expect(after.loaded?.thread.activeWorkId).toBe(previous.loaded?.thread.activeWorkId)
    expect(after.loaded?.messages[0]?.originalText).toBe("Continue my original Work")
    expect(after).toMatchObject({ status: "ready", error: "Network interrupted", hasOlder: true, olderLoading: false })
  })

  it.each([429, 500, 503])("does not erase loaded Work on retryable HTTP %s", status => {
    const previous = { ...state(), olderLoading: false }
    const after = refreshFailureState(previous, THREAD, SCOPE, { status })
    expect(after.loaded).toBe(previous.loaded)
    expect(after).toMatchObject({ status: "ready", error: "Investigation refresh unavailable" })
  })

  it.each([401, 403, 404])("purges cached private Work and messages after HTTP %s", status => {
    const after = refreshFailureState(state(), THREAD, SCOPE, { status })
    expect(after.loaded).toBeNull()
    expect(after.hasOlder).toBe(false)
    expect(after).toMatchObject({ status: "error", error: "Investigation access is no longer available" })
  })

  it("does not leak another thread's messages into a newly selected Investigation", () => {
    const after = refreshFailureState(state(), OTHER_THREAD, "other-employee:session", new Error("Unavailable"))
    expect(after.loaded).toBeNull()
    expect(after.forThreadId).toBe(OTHER_THREAD)
    expect(after).toMatchObject({ status: "error", hasOlder: false })
  })
})
