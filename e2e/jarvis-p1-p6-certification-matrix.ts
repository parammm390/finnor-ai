export type CertificationResult = "pass" | "blocked-by-deployment" | "scoped-skip"
export type CertificationOutcomeEvidence = {
  kind: "catalog-only"
  provesRequestedOutcome: false
  reason: string
}

export type JarvisCertificationRow = {
  id: string
  feature: string
  route: string
  backendPrimitive: string
  expectedDurableState: string
  expectedUiState: string
  normalJourney: string
  failureJourney: string
  refreshJourney: string
  result: CertificationResult
  outcomeEvidence: CertificationOutcomeEvidence
}

/**
 * One executable inventory for the user-facing P1–P6 contract. Each row names
 * the durable seam and points at the Playwright journey that must prove the
 * three required modes. This catalog is not itself live outcome evidence: its
 * rows are deliberately downgraded below, so fixture/structural coverage can
 * never certify a useless product.
 */
const JARVIS_P1_P6_CERTIFICATION_CATALOG = [
  {
    id: "command-loop",
    feature: "Command rail and adaptive Home",
    route: "/jarvis",
    backendPrimitive: "POST /instructions → Work → instruction_events → canonical projections",
    expectedDurableState: "One Work aggregate with legal received/planning/awaiting_approval/executing/terminal transitions",
    expectedUiState: "Heard, bounded progress, approval/control, and truthful completed/partial/failed/cancelled outcome",
    normalJourney: "e2e/jarvis-authenticated.spec.ts :: adaptive workspace exposes the real command surface",
    failureJourney: "e2e/jarvis-network-hygiene.spec.ts :: proxy/auth failures remain bounded and source-labelled",
    refreshJourney: "e2e/jarvis-p3-restore-after-refresh.spec.ts :: restored durable instruction state",
    result: "pass",
  },
  {
    id: "work-projection",
    feature: "Work projection and inspector continuity",
    route: "/jarvis/work",
    backendPrimitive: "GET /read-models/work-cases + exact Work/action/receipt edges",
    expectedDurableState: "Canonical Work status agrees with action, workflow, approval, receipt, and recovery state",
    expectedUiState: "Counts and case rows are source-aware; no false zero, success, or Needs-you state",
    normalJourney: "e2e/jarvis-authenticated.spec.ts :: live durable Work projection",
    failureJourney: "e2e/jarvis-p3-continuity-fixtures.spec.ts :: bounded empty/error projection without stale island",
    refreshJourney: "e2e/jarvis-p3-refresh-fixtures.spec.ts :: receipt spine survives refresh",
    result: "pass",
  },
  {
    id: "customers",
    feature: "Customer / Household 360",
    route: "/jarvis/customers",
    backendPrimitive: "GET /resources/households + GET /read-models/household-360",
    expectedDurableState: "Exact household identity and related Work/customer edges",
    expectedUiState: "Customer facts, links, and empty sections are independently source-labelled",
    normalJourney: "e2e/jarvis-authenticated.spec.ts :: Customer → Money continuity",
    failureJourney: "e2e/jarvis-network-hygiene.spec.ts :: private reads fail closed without fabricated metrics",
    refreshJourney: "e2e/jarvis-authenticated.spec.ts :: re-navigation reconstructs the same session projection",
    result: "pass",
  },
  {
    id: "money",
    feature: "Money / cash pressure",
    route: "/jarvis/money",
    backendPrimitive: "GET /read-models/cash-collections + GET /resources/invoices",
    expectedDurableState: "Invoice/payment facts remain independent of optional Work correlation",
    expectedUiState: "Cash facts render as Reading/Unavailable/Not recorded only when the source says so",
    normalJourney: "e2e/jarvis-authenticated.spec.ts :: Customer → Money continuity",
    failureJourney: "e2e/jarvis-network-hygiene.spec.ts :: independent source failure does not erase other facts",
    refreshJourney: "e2e/jarvis-authenticated.spec.ts :: same authenticated session reopens Money",
    result: "pass",
  },
  {
    id: "schedule",
    feature: "Schedule / dispatch map",
    route: "/jarvis/schedule",
    backendPrimitive: "GET /dispatch/map + optional Work enrichment",
    expectedDurableState: "Canonical appointment/service-visit identity with exact technician/household edges",
    expectedUiState: "Map and unassigned/empty states remain usable when optional enrichment is absent",
    normalJourney: "e2e/jarvis-authenticated.spec.ts :: all six Business World lenses",
    failureJourney: "e2e/jarvis-p5-route-scene-fixtures.spec.ts :: zero-stop route is an honest empty state",
    refreshJourney: "e2e/jarvis-p3-live-restore-responsive.spec.ts :: restored projection retains source labels",
    result: "pass",
  },
  {
    id: "agents",
    feature: "Agents / provider and capability fleet",
    route: "/jarvis/agents",
    backendPrimitive: "GET /integrations/status + GET /read-models/work-cases",
    expectedDurableState: "Exact action/persona/call/Work edges; provider health never becomes agent readiness",
    expectedUiState: "Verified, unavailable, loading, or not-read are distinct; no invented calls or Work",
    normalJourney: "e2e/jarvis-p3-t2-agent-fleet.spec.ts + e2e/jarvis-p3-t3-agent-causality.spec.ts",
    failureJourney: "e2e/jarvis-p3-t3-agent-causality.spec.ts :: signed-out source-bound empty lanes",
    refreshJourney: "e2e/jarvis-p3-t5-golden-frames.spec.ts :: responsive fleet snapshots",
    result: "pass",
  },
  {
    id: "business-world",
    feature: "Business World lenses",
    route: "/jarvis/{customers,schedule,money,work,agents}",
    backendPrimitive: "GET /business-world?scene={customer|schedule|money|work|inventory|computer}",
    expectedDurableState: "Canonical object/relationship source with bounded limits and provenance",
    expectedUiState: "Each lens renders the shared projection contract without raw JSON or cross-lens stale state",
    normalJourney: "e2e/jarvis-authenticated.spec.ts :: all six Business World lenses",
    failureJourney: "e2e/jarvis-network-hygiene.spec.ts :: route admission/auth boundary",
    refreshJourney: "e2e/jarvis-authenticated.spec.ts :: each lens reopened under one session",
    result: "pass",
  },
  {
    id: "controls-and-recovery",
    feature: "Approval, rejection, cancellation, retry, and continuation controls",
    route: "/jarvis",
    backendPrimitive: "POST /actions/{id}/approve|reject + POST /instructions/{id}/cancel + retry/continue Work fencing",
    expectedDurableState: "Work transition fence serializes terminal state and blocks late external effects",
    expectedUiState: "Stopping is bounded; canonical cancellation/recovery dominates late answers and never claims success",
    normalJourney: "finnor-os/tests/unit/instruction-cancel-route.test.ts + e2e/jarvis-p4-t4-certification.spec.ts",
    failureJourney: "finnor-os/tests/unit/single-action-runtime-bridge.test.ts :: cancellation blocks late command",
    refreshJourney: "e2e/jarvis-p3-restore-after-refresh.spec.ts :: terminal/awaiting state reconstructs",
    result: "pass",
  },
  {
    id: "history-and-continuity",
    feature: "History, open previous Work, and follow-up continuity",
    route: "/jarvis",
    backendPrimitive: "GET /threads + GET /threads/{id} + continuation POST bound to existing Work",
    expectedDurableState: "Conversation thread, instruction, and Work IDs remain causally attached",
    expectedUiState: "History/open/continue never inherit stale state and preserve terminal truth",
    normalJourney: "e2e/jarvis-p3-history-fixtures.spec.ts + e2e/jarvis-p3-continuity-fixtures.spec.ts",
    failureJourney: "src/components/jarvis/kernel/work-continuity.test.ts :: invalid continuation is rejected",
    refreshJourney: "e2e/jarvis-p3-restore-after-refresh.spec.ts :: active pointer restores exact Work",
    result: "blocked-by-deployment",
  },
  {
    id: "realtime-degradation",
    feature: "Instruction/operational realtime with polling fallback",
    route: "/api/jarvis/operational-stream",
    backendPrimitive: "Authenticated SSE + operational-deltas cursor replay + projection refetch",
    expectedDurableState: "Canonical reads remain correct when SSE is absent, delayed, duplicated, or reordered",
    expectedUiState: "Connecting/polling/unavailable is visible and bounded; controls remain usable",
    normalJourney: "e2e/jarvis-operational-events-route.spec.ts + src/components/jarvis/lib/operational-delta.test.ts",
    failureJourney: "src/components/jarvis/kernel/instruction-trace-poll.test.ts :: bounded reconnect/unavailable ladder",
    refreshJourney: "src/components/jarvis/lib/business-projection-cache.test.ts :: invalidation/refetch reconstruction",
    result: "pass",
  },
  {
    id: "workspace-config",
    feature: "Tenant workspace configuration",
    route: "/jarvis",
    backendPrimitive: "GET/PUT /workspace-config",
    expectedDurableState: "Tenant presentation config persists atomically and is authz-scoped",
    expectedUiState: "Navigation, terminology, voice, brand, and inspector update together",
    normalJourney: "e2e/jarvis-workspace-config.spec.ts",
    failureJourney: "e2e/jarvis-network-hygiene.spec.ts :: auth/proxy fail-closed boundary",
    refreshJourney: "e2e/jarvis-workspace-config.spec.ts :: persisted config is re-read after save",
    result: "pass",
  },
] as const

export const JARVIS_P1_P6_CERTIFICATION_MATRIX: readonly JarvisCertificationRow[] = JARVIS_P1_P6_CERTIFICATION_CATALOG.map((row) => ({
  ...row,
  // A static journey pointer is not a completed Work/outcome assertion. A
  // future runner must replace this with a live receipt-bound result before a
  // row may become PASS.
  result: row.result === "pass" ? "scoped-skip" : row.result,
  outcomeEvidence: {
    kind: "catalog-only",
    provesRequestedOutcome: false,
    reason: "journey catalog only; no live Work terminal outcome is bound",
  },
}))
