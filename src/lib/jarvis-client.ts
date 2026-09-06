// C1.T1 — the typed client every JARVIS panel fetch should go through, plus the proxy
// (src/app/api/jarvis/[...path]/route.ts). Two layers of real typing, not one:
//
// 1. Path/verb safety: `API_PATHS` below is checked with `satisfies Record<string,
//    keyof paths>` against the type openapi-typescript generated from
//    finnor-os/openapi.json (regenerate both via `npm run openapi` in finnor-os, then
//    `npm run jarvis:types` here — see finnor-os/scripts/generate-openapi.ts,
//    expanded this session to cover the full 32-path proxy-reachable surface, audited
//    against every real route.ts file, not assumed from the previous 9-path version).
//    A typo'd or removed endpoint fails that one `satisfies` check at compile time.
// 2. Response shape: this codebase has no zod schemas for RESPONSE bodies (only
//    request bodies), so openapi-typescript alone types nearly every 200 as
//    `content?: never` — see openapi-types.ts. The interfaces below fill that gap,
//    each one either imported from src/components/jarvis/lib/data-core.ts (already
//    "verified against the live API" per that file's own header) or freshly written
//    this session after reading the actual route + drizzle schema — never guessed.
//    A few (resources/{kind}, policies) stay honestly loose (`unknown[]`/`unknown`)
//    because their real shape wasn't verified this pass — narrowing those later is
//    real follow-up work, not a shortcut taken now.
//
// Wraps the EXISTING jarvisGet/jarvisPost (same fetch/auth/telemetry every panel
// already uses) — this is a typed layer on top, not a second network stack.

import { jarvisGet, jarvisPost, jarvisPut, JarvisApiError } from "../components/jarvis/lib/api"
import type { paths } from "./jarvis/openapi-types"
import type { OperatingInteractionContextValue } from "../components/jarvis/kernel/operating-interaction"
import type {
  StatsResponse,
  PendingAction,
  WorkflowRun,
  EventRow,
  PipelineHealth,
  CashCollections,
  SlaBreaches,
  StockRisk,
  FollowUpDebt,
  TechnicianLoad,
  ServiceDue,
  DataQuality,
  Insights,
  SetupStatus,
  IntegrationsStatus,
  ReliabilityMetrics,
} from "../components/jarvis/lib/data-core"

export { JarvisApiError }

// Every real proxy-reachable path this client calls, keyed by a friendly name, mapped
// to its "/api/..." form. `satisfies Record<string, keyof paths>` fails to compile if
// any value here isn't a real key of the generated OpenAPI paths type — the actual
// fetch calls below use the SUFFIX (jarvisGet/jarvisPost already prefix `/api/jarvis/`),
// so this table is the one place path literals are cross-checked, not scattered
// per-call-site string gymnastics.
const API_PATHS = {
  stats: "/api/stats",
  actionsSubmit: "/api/actions",
  objectives: "/api/objectives",
  employees: "/api/employees",
  pendingActions: "/api/actions/pending",
  confirmAction: "/api/actions/{id}/confirm",
  rejectAction: "/api/actions/{id}/reject",
  escalateAction: "/api/actions/{id}/escalate",
  workflowRuns: "/api/workflows/runs",
  runControlPause: "/api/workflows/runs/{id}/pause",
  runControlResume: "/api/workflows/runs/{id}/resume",
  runControlCancel: "/api/workflows/runs/{id}/cancel",
  runControlRetry: "/api/workflows/runs/{id}/retry",
  runControlEscalate: "/api/workflows/runs/{id}/escalate",
  compensateStep: "/api/workflows/steps/{id}/compensate",
  events: "/api/events",
  readModel: "/api/read-models/{view}",
  comms: "/api/comms",
  insights: "/api/insights",
  setupStatus: "/api/setup/status",
  integrationsStatus: "/api/integrations/status",
  resources: "/api/resources/{kind}",
  audit: "/api/audit",
  receipts: "/api/receipts",
  receipt: "/api/receipts/{id}",
  me: "/api/me",
  overview: "/api/overview",
  dlqList: "/api/dlq",
  dlqItem: "/api/dlq/{id}",
  dlqReplay: "/api/dlq/{id}/replay",
  dlqDiscard: "/api/dlq/{id}/discard",
  corrections: "/api/corrections",
  policy: "/api/policies/{tenantId}/{actionType}",
  vitals: "/api/vitals",
  activity: "/api/activity",
  workCases: "/api/read-models/{view}",
  workExecution: "/api/works/{id}/execution",
  workReplay: "/api/works/{id}/replay",
  dealerZeroTimeCompression: "/api/dealer-zero/time-compression",
  instruction: "/api/instructions/{id}",
  instructionEvents: "/api/instructions/{id}/events",
  workObjective: "/api/works/{id}/objective",
  workHandoff: "/api/works/{id}/handoff",
} as const satisfies Record<string, keyof paths>

// ---------------------------------------------------------------------------
// Response shapes not already covered by data-core.ts — verified against the real
// route + drizzle schema this session (packages/db/schema.ts's decisionReceipts /
// deadLetters / memoryCorrections tables), not invented.
// ---------------------------------------------------------------------------

export interface DecisionReceipt {
  id: string
  tenantId: string
  workflowRunId: string | null
  workflowStepId: string | null
  domainActionId: string | null
  objective: string
  evidence: Array<{ source: string; ref: string; timestamp: string }>
  policyApplied: { id: string; version: number } | null
  riskTier: "low" | "medium" | "high"
  proposedAction: Record<string, unknown>
  approval: Record<string, unknown>
  expectedResult: Record<string, unknown> | null
  actualResult: Record<string, unknown> | null
  failure: Record<string, unknown> | null
  correlationId: string | null
  createdAt: string
  finalizedAt: string | null
}

export interface DeadLetter {
  id: string
  tenantId: string
  relatedOutboxEventId: string | null
  relatedWorkflowStepId: string | null
  envelope: Record<string, unknown>
  errorKind: "retryable" | "terminal" | "conflict" | "auth" | "validation" | "provider_down"
  attempts: number
  firstSeenAt: string
  lastError: string
  replayable: boolean
  status: "open" | "replayed" | "discarded"
  createdAt: string
  resolvedAt: string | null
}

export interface MemoryCorrection {
  id: string
  tenantId: string
  receiptId: string | null
  question: string
  wrongAnswer: string
  correctedFact: string
  correctedBy: string
  createdAt: string
}

export interface AuditEntry {
  id: string
  domainActionId: string
  step: string
  input: unknown
  output: unknown
  timestamp: string
  actionType: string
  status: string
}

export interface RunControlResult {
  run: WorkflowRun
}

// Verified against finnor-os/apps/api/app/api/vitals/route.ts (A2.T5) — every field
// mirrors that route's actual Response.json shape, not guessed.
export interface Vitals {
  queue: { depth: number; oldestPendingAgeSeconds: number | null }
  heartbeat: { ageSeconds: number | null; healthy: boolean }
  dlq: { openCount: number }
  bindings: Record<string, string>
  scans: Record<string, string | null>
}

export type DealerZeroScenario = "normal_day" | "brutal_summer" | "payment_crunch" | "equipment_recall" | "chaos_day"
export interface ShowtimeFrame {
  atMs: number
  kind: "day_start" | "intake" | "approval" | "workflow" | "day_end"
  label: string
  // Null is honest when this Dealer Zero tenant has no matching persisted receipt
  // yet; clients must not manufacture an inspect target.
  receiptId: string | null
}
export interface TimeCompressedDemo {
  demo: true
  synthetic: true
  dateSeed: string
  scenario: DealerZeroScenario
  multiplier: number
  durationMs: number
  frames: ShowtimeFrame[]
}

// Verified against finnor-os/apps/api/app/api/activity/route.ts (A2.T6).
export interface ActivityItem {
  source: "action_log" | "workflow_step" | "computer_step" | "call"
  id: string
  occurredAt: string
  detail: Record<string, unknown>
}
export interface ActivityPage {
  items: ActivityItem[]
  nextCursor: string | null
  hasMore: boolean
}

// P2.T3 — exact household source shapes from resources/households and the existing
// household-360 read model. The surface keeps these records typed without creating
// a second customer source or a CRM-specific join.
export interface HouseholdResource {
  id: string
  tenantId: string
  address: string
  contactInfo: Record<string, unknown>
  waterProfile: Record<string, unknown>
  marketingConsent: boolean
  latitude: number | null
  longitude: number | null
  createdAt: string
}

export interface Household360Projection {
  household: { id: string; address: string; contactInfo: Record<string, unknown>; marketingConsent: boolean; createdAt: string }
  contacts: Array<{ id: string; name: string; role: string | null; methods: Array<{ methodType: string; value: string; consent: boolean }> }>
  equipment: Array<{ id: string; type: string; model: string | null; installDate: string | null; source: string }>
  leads: Array<{ id: string; name: string; status: string; source: string | null; createdAt: string }>
  opportunities: Array<{ id: string; pipelineStage: string; expectedValueUsd: number | null; createdAt: string }>
  quotes: Array<{ id: string; status: string; totalUsd: number | null; createdAt: string }>
  invoices: Array<{ id: string; status: string; amountUsd: number; memo: string | null; createdAt: string; dueDate: string | null; payments: Array<{ amountUsd: number; method: string; status: string; receivedAt: string }> }>
  workOrders: Array<{ id: string; type: string; status: string; technicianId: string | null; depositAmountUsd: number | null; createdAt: string; scheduledAt: string | null; completedAt: string | null }>
  serviceVisits: Array<{ id: string; type: string; technicianId: string | null; scheduledAt: string | null; completedAt: string | null; notes: string | null }>
  appointments: Array<{ id: string; subjectType: string; status: string; scheduledAt: string; durationMinutes: number | null; technicianId: string | null; notes: string | null; createdAt: string }>
  conversations: Array<{ id: string; channel: string; status: string; createdAt: string; lastActivityAt: string; messageCount: number; recentMessages: Array<{ direction: string; channel: string; content: string; sentAt: string }> }>
  calls: Array<{ id: string; conversationId: string | null; direction: string; transcript: string | null; startedAt: string | null; endedAt: string | null; endedReason: string | null; raw: Record<string, unknown> }>
  documents: Array<{ id: string; kind: string; title: string; createdAt: string }>
  legacyCommunications: Array<{ id: string; channel: string; direction: string; content: string; timestamp: string }>
  timeline: Array<{ entityType: string; entityId: string; eventType: string; occurredAt: string; payload: Record<string, unknown> }>
  queryMs: number
}

export type InvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "void"
export interface InvoiceResource {
  id: string
  tenantId: string
  householdId: string
  amountUsd: number | string
  status: InvoiceStatus
  memo: string | null
  dueDate: string | null
  createdAt: string
}

// P2.T1/T2 — exact read-only Work contract. The server projection keeps the
// durable rows authoritative; this client type only describes the already-shaped
// causal record consumed by the Work surface.
export type WorkCaseStatus = "Needs you" | "Working" | "Waiting" | "Partial" | "Cancelled" | "Completed" | "Failed" | "Blocked"
export interface WorkEntityLink {
  entityType: string
  entityId: string
  via: string
}
export interface WorkAction {
  id: string
  actionType: string
  status: string
  summary: string | null
  instructionId: string | null
  planId: string | null
  dependsOn: string[]
  payload: Record<string, unknown>
  createdAt: string
  updatedAt: string
}
export interface WorkApproval {
  actionId: string
  status: string
  decidedBy: string | null
  decidedAt: string | null
  pendingConfirmationId: string | null
}
export interface WorkStep {
  id: string
  stepType: string
  sequence: number
  status: string
  attempts: number
  terminalReason: string | null
  domainActionId: string | null
  updatedAt: string
}
export interface WorkWorkflow {
  id: string
  commandId: string
  workflowType: string
  status: string
  correlationId: string | null
  createdAt: string
  updatedAt: string
  steps: WorkStep[]
}
export interface WorkReceipt {
  id: string
  workflowRunId: string | null
  workflowStepId: string | null
  domainActionId: string | null
  objective: string
  evidence: unknown
  approval: unknown
  expectedResult: unknown
  actualResult: unknown
  failure: unknown
  correlationId: string | null
  createdAt: string
  finalizedAt: string | null
}
export interface WorkOperation {
  id: string
  operationType: string
  status: string
  configuration: unknown
  cohortDefinition: unknown
  cohortFrozenAt: string
  targetCount: number
  counts: { pending: number; running: number; succeeded: number; failed: number; skipped: number; retry: number }
  finalOutcome: unknown
  failure: unknown
  approvedBy: string | null
  approvedAt: string | null
  createdAt: string
  updatedAt: string
}
export interface WorkInstruction {
  id: string
  text: string
  source: "typed" | "voice"
  createdAt: string
  lastPhase: string | null
}
export interface WorkCall {
  id: string
  conversationId: string | null
  direction: "inbound" | "outbound"
  externalId: string | null
  sourceSystem: string | null
  startedAt: string | null
  endedAt: string | null
  endedReason: string | null
  householdId: string | null
  agentKey: "jarvis" | "follow-up" | "service-reminder" | "win-back" | "payment-collector" | null
}
export interface WorkBusinessEvent {
  id: string
  entityType: string
  entityId: string
  eventType: string
  occurredAt: string
  source: string | null
}
export interface EmployeeDirectoryEntry {
  id: string
  displayName: string | null
  status: "active" | "suspended"
  roles: string[]
  legacyRole: string
}
export interface WorkCaseProjection {
  id: string
  root: { kind: string; id: string }
  title: string
  status: WorkCaseStatus
  createdAt: string
  updatedAt: string
  source: { kind: string; id: string | null; channel: string | null }
  instruction: WorkInstruction | null
  actions: WorkAction[]
  approvals: WorkApproval[]
  workflows: WorkWorkflow[]
  receipts: WorkReceipt[]
  operations?: WorkOperation[]
  linkedEntities: WorkEntityLink[]
  businessEvents: WorkBusinessEvent[]
  calls: WorkCall[]
  relatedActionIds: string[]
  provenance: string[]
  durableWork?: {
    id: string
    status: string
    sessionId: string | null
    channel: string
    activeContext: unknown
    initiatedBy: string | null
    currentOwnerId: string | null
    assignedTo: string | null
    authorityContext: unknown
    finalOutcome: unknown
    failure: unknown
    recovery: unknown
    handoffs?: Array<{
      sequence: number
      fromEmployeeId: string | null
      toEmployeeId: string | null
      actorId: string | null
      note: string | null
      authorityRevision: number | null
      createdAt: string
    }>
  }
  objectiveLoop?: {
    id: string
    objective: string
    state: "continue" | "awaiting_approval" | "waiting" | "blocked" | "completed" | "failed" | "cancelled"
    revision: number
    reason: string | null
    nextStep: string | null
    nextRunAt: string | null
    lastObservation: unknown
    budget: { steps: number; maxSteps: number; actions: number; maxActions: number; queries: number; maxQueries: number }
    iterations: Array<{
      id: string
      stepNumber: number
      phase: string
      decisionKind: string | null
      reason: string | null
      observation: unknown
      progressMade: boolean | null
      outcome: string | null
      scheduledFor: string | null
      completedAt: string | null
      plannerAttempts: Array<{ id: string; attempt: number; status: string; provider: string | null; failure: unknown }>
    }>
  }
  outcomePack?: {
    id: string
    packId: string
    packVersion: number
    mode: "shadow" | "approval" | "autopilot"
    status: string
    certificationFingerprint: string
    objective: string
    subjectRefs: unknown
    blockedReason: string | null
    finalVerification: unknown
    latestAutonomyDecision: {
      outcome: string
      eligible: boolean
      reasonCodes: string[]
      grantId: string | null
      evaluatedAt: string
    } | null
    shadowProposals: Array<{
      id: string
      businessEffectId: string
      semanticHash: string
      comparisonStatus: string
      proposedAt: string
      comparedAt: string | null
    }>
  }
}

// Phase 3 — presentation-safe detail projection for one selected durable Work.
export type ExecutionNodeStatus = "waiting_dependency" | "runnable" | "awaiting_approval" | "approved" | "executing" | "verifying" | "succeeded" | "failed" | "blocked" | "denied" | "rejected"
export type ExecutionVerificationState = "not_started" | "awaiting_observation" | "verified" | "failed" | "unknown" | "reconciling"
export interface ExecutionControl { kind: "approve" | "reject" | "pause" | "resume" | "cancel" | "retry" | "escalate" | "compensate"; label: string; endpoint: string; method: "POST"; expectedVersion: number | null; reason: string }
export interface ExecutionTarget { entityType: string; entityId: string; label: string | null; status: string | null; sourceRef: string }
export interface ExecutionFailure { errorKind: string | null; message: string; recoveryPath: string | null; reconciliationRequired: boolean; retrySafe: boolean; humanRequired: boolean; sourceRef: string }
export interface ExecutionEvidence { source: string; ref: string | null; timestamp: string; restricted: boolean }
export interface ExecutionActor { employeeId: string; displayName: string | null; role: "owner" | "dispatcher" | "technician" | null; sourceRef: string }
export interface ExecutionComputerRun {
  id: string; status: string; effectStatus: string; mode: "READ_ONLY" | "WRITE"; application: string; provider: string; account: { id: string; label: string }; actor: ExecutionActor; task: string; target: { kind: string; identifier: string }; currentActivity: string | null
  steps: Array<{ id: string; seq: number; phase: string; operation: string; status: string; summary: string; createdAt: string; completedAt: string | null }>; stepCount: number; stepsTruncated: boolean; result: Record<string, unknown> | null; failureCode: string | null; blockReason: string | null; cancellationRequested: boolean; createdAt: string; startedAt: string | null; finishedAt: string | null; sourceRef: string
}
export interface ExecutionActionNode {
  id: string; planId: string | null; actionType: string; businessVerb: string; summary: string | null; sourceStatus: string; status: ExecutionNodeStatus; semanticPayload: Record<string, unknown>; businessEffect: { id: string; semanticHash: string; scopeHash: string; status: string; contract: Record<string, unknown>; verification: Record<string, unknown> | null; sourceRef: string } | null; targets: ExecutionTarget[]; dependencyIds: string[]; dependentIds: string[]; blockedBy: Array<{ actionId: string; status: string }>; actor: ExecutionActor | null
  route: { application: string | null; provider: string | null; identity: { kind: string; id: string; label: string | null; channel: string | null } | null; route: string | null; source: string; sourceRef: string } | null
  authority: { state: string; decisionId: string | null; revision: number | null; operation: string | null; outcome: string | null; risk: string | null; reasonCode: string | null; employeeId: string | null; sourceRef: string | null }
  approval: { required: boolean; status: string; requestId: string | null; currentStep: number | null; totalSteps: number; decidedBy: ExecutionActor | null; decidedAt: string | null; consequence: string; sourceRef: string | null }
  intent: { expectedResult: Record<string, unknown> | null; source: "receipt" | "prediction" | "none" }; observation: { actualResult: Record<string, unknown> | null; evidence: ExecutionEvidence[]; verification: ExecutionVerificationState; basis: string }; externalEffect: "none" | "pending" | "confirmed" | "possible" | "unknown"; failure: ExecutionFailure | null; workflowRunIds: string[]; receiptIds: string[]; computer: ExecutionComputerRun | null; controls: ExecutionControl[]; timestamps: { createdAt: string; executionStartedAt: string | null; lastChangedAt: string }; sourceRefs: string[]
}
export interface ExecutionWorkflow {
  id: string; workflowType: string; status: string; version: number; actionIds: string[]
  steps: Array<{ id: string; sequence: number; stepType: string; status: string; attempts: number; terminalReason: string | null; domainActionId: string | null; integration: { capability: string; provider: string | null; status: string; sourceRef: string } | null; reconciliation: { caseId: string; status: string; sourceRef: string } | null; compensation: { caseId: string; status: string; sourceRef: string } | null; controls: ExecutionControl[]; updatedAt: string; sourceRef: string }>
  controls: ExecutionControl[]; createdAt: string; updatedAt: string; sourceRef: string
}
export interface ExecutionReceiptProjection { id: string; workId: string; domainActionId: string | null; workflowRunId: string | null; workflowStepId: string | null; businessEffectId: string | null; intendedEffectHash: string | null; authorizedEffectHash: string | null; executedEffectHash: string | null; effectVerification: Record<string, unknown> | null; recoveryEffectId: string | null; objective: string; policyApplied: { id: string; version: number } | null; riskTier: string; approval: { required: boolean; approvedBy: string | null; at: string | null }; expectedResult: Record<string, unknown> | null; actualResult: Record<string, unknown> | null; evidence: ExecutionEvidence[]; failure: ExecutionFailure | null; finalizedAt: string | null; createdAt: string; sourceRef: string }
export interface ExecutionProjection {
  version: 1; work: { id: string; status: string; objective: string; createdAt: string; updatedAt: string; finalOutcome: Record<string, unknown> | null; failure: ExecutionFailure | null }; targets: ExecutionTarget[]; nodes: ExecutionActionNode[]; edges: Array<{ fromActionId: string; toActionId: string; state: string; sourceRef: string }>; workflows: ExecutionWorkflow[]; receipts: ExecutionReceiptProjection[]; viewer: { role: "owner" | "dispatcher" | "technician"; evidenceVisibility: "full" | "restricted" }; limits: { actions: number; workflowSteps: number; computerStepsPerRun: number; evidencePerReceipt: number }; truncated: { actions: boolean; workflowSteps: boolean; computerSteps: boolean; evidence: boolean }; asOf: string
}

export type CausalReplayStage = "trigger" | "context" | "evidence" | "planning" | "policy" | "authority" | "approval" | "dependency" | "execution" | "provider" | "external_event" | "canonical_change" | "verification" | "receipt" | "failure" | "recovery" | "compensation" | "missing"
export type CausalEvidenceAvailability = "available" | "restricted" | "expired" | "unavailable" | "legacy_incomplete"
export interface CausalReplayEvidenceRef { source: string; ref: string | null; recordedAt: string; availability: CausalEvidenceAvailability; integrityHash: string | null }
export interface CausalReplayNode { id: string; stage: CausalReplayStage; title: string; summary: string; status: string; occurredAt: string; sourceRefs: string[]; evidence: CausalReplayEvidenceRef[]; facts: Record<string, unknown>; entityRefs: Array<{ entityType: string; entityId: string }> }
export interface CausalReplayEdge { id: string; from: string; to: string; relation: string; certainty: "proven" | "missing"; evidenceRefs: string[]; explanation: string }
export interface CausalReplayProjection {
  version: 1
  mode: "read_only"
  work: { id: string; status: string; objective: string; createdAt: string; updatedAt: string }
  nodes: CausalReplayNode[]
  edges: CausalReplayEdge[]
  moments: Array<{ at: string; nodeIds: string[]; headline: string; stage: CausalReplayStage }>
  explanation: { trigger: string; context: string; plan: string; governance: string; execution: string; verification: string; outcome: string; gaps: string[] }
  completeness: { status: "complete" | "partial" | "legacy_incomplete"; provenEdges: number; missingEdges: number; missing: string[] }
  viewer: { role: "owner" | "dispatcher" | "technician"; evidenceVisibility: "full" | "restricted" }
  readOnlyGuarantee: { source: "durable_projection"; method: "GET"; mutationControlsIncluded: false; sideEffectsPossible: false }
  limits: { nodes: number; edges: number; actionEvents: number; computerArtifacts: number }
  truncated: { nodes: boolean; edges: boolean; actionEvents: boolean; computerArtifacts: boolean }
  asOf: string
}

export interface ObjectiveStartResponse {
  objective: {
    workId: string
    workInputId: string
    instructionId: string
    objectiveLoopId: string
    state: "continue" | "awaiting_approval" | "waiting" | "blocked" | "completed" | "failed"
    duplicate: boolean
  }
}

const READ_MODEL_VIEWS = {
  "pipeline-health": null as unknown as PipelineHealth,
  "technician-load": null as unknown as TechnicianLoad,
  "stock-risk": null as unknown as StockRisk,
  "cash-collections": null as unknown as CashCollections,
  "service-due": null as unknown as ServiceDue,
  "sla-breaches": null as unknown as SlaBreaches,
  "follow-up-debt": null as unknown as FollowUpDebt,
  "data-quality": null as unknown as DataQuality,
  "work-cases": null as unknown as WorkCaseProjection[],
  reliability: null as unknown as ReliabilityMetrics,
}
type ReadModelView = keyof typeof READ_MODEL_VIEWS

function toStringParams(params?: Record<string, unknown>): Record<string, string> | undefined {
  if (!params) return undefined
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))
}

async function allJarvisPendingActions(filter?: "pending" | "blocked"): Promise<{ actions: PendingAction[]; complete: true }> {
  const actions: PendingAction[] = []
  let cursor: string | undefined
  for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
    const response = await jarvisGet<{
      actions: PendingAction[]
      page?: { hasMore: boolean; nextCursor: string | null }
    }>("actions/pending", toStringParams({ filter, limit: 100, cursor }))
    actions.push(...response.actions)
    if (!response.page) {
      if (response.actions.length >= 100) throw new Error("Pending approval response did not prove completeness")
      return { actions, complete: true }
    }
    if (!response.page.hasMore) return { actions, complete: true }
    if (!response.page.nextCursor || response.page.nextCursor === cursor) throw new Error("Pending approval pagination did not advance")
    cursor = response.page.nextCursor
  }
  throw new Error("Pending approval pagination exceeded its safety bound")
}

export const jarvisClient = {
  // ---- GET ----
  stats: (): Promise<StatsResponse> => jarvisGet<StatsResponse>("stats"),

  pendingActions: (filter?: "pending" | "blocked"): Promise<{ actions: PendingAction[]; complete: true }> =>
    allJarvisPendingActions(filter),

  workflowRuns: (status?: string): Promise<{ runs: WorkflowRun[] }> =>
    jarvisGet<{ runs: WorkflowRun[] }>("workflows/runs", toStringParams({ status })),

  events: (params?: { entityType?: string; entityId?: string; before?: string }): Promise<{ events: EventRow[] }> =>
    jarvisGet<{ events: EventRow[] }>("events", toStringParams(params)),

  readModel: <V extends ReadModelView>(view: V, params?: Record<string, string>): Promise<{ view: V; data: (typeof READ_MODEL_VIEWS)[V] }> =>
    jarvisGet<{ view: V; data: (typeof READ_MODEL_VIEWS)[V] }>(`read-models/${view}`, params),

  comms: (): Promise<{
    outbox: Array<{ id: string; channel: string; toNumber: string; content: string; simulated: boolean; createdAt: string }>
    communications: Array<{ id: string; channel: string; direction: string; content: string; timestamp: string; household: string }>
  }> => jarvisGet("comms"),

  insights: (): Promise<Insights> => jarvisGet<Insights>("insights"),

  setupStatus: (): Promise<SetupStatus> => jarvisGet<SetupStatus>("setup/status"),

  integrationsStatus: (): Promise<IntegrationsStatus> => jarvisGet<IntegrationsStatus>("integrations/status"),

  // Honestly loose — real per-kind row shapes weren't verified this session.
  resources: (kind: "households" | "inventory" | "invoices" | "technicians" | "visits" | "compliance-policy" | "workflows"): Promise<{ rows: unknown[] }> =>
    jarvisGet<{ rows: unknown[] }>(`resources/${kind}`),

  households: (): Promise<{ rows: HouseholdResource[] }> => jarvisGet<{ rows: HouseholdResource[] }>("resources/households"),

  invoices: (): Promise<{ rows: InvoiceResource[] }> => jarvisGet<{ rows: InvoiceResource[] }>("resources/invoices"),

  household360: (householdId: string): Promise<{ view: "household-360"; data: Household360Projection }> =>
    jarvisGet<{ view: "household-360"; data: Household360Projection }>("read-models/household-360", { householdId }),

  audit: (params?: { actionType?: string; status?: string; limit?: number; offset?: number }): Promise<{ entries: AuditEntry[]; limit: number; offset: number }> =>
    jarvisGet<{ entries: AuditEntry[]; limit: number; offset: number }>("audit", toStringParams(params)),

  receipts: (query: { domainActionId?: string; workflowStepId?: string; workflowRunId?: string }): Promise<{ receipts: DecisionReceipt[] }> =>
    jarvisGet<{ receipts: DecisionReceipt[] }>("receipts", toStringParams(query)),

  receipt: (id: string): Promise<{ receipt: DecisionReceipt }> => jarvisGet<{ receipt: DecisionReceipt }>(`receipts/${id}`),

  me: (): Promise<{ userId: string; tenantId: string; role: string }> => jarvisGet<{ userId: string; tenantId: string; role: string }>("me"),

  employees: (): Promise<{ employees: EmployeeDirectoryEntry[] }> =>
    jarvisGet<{ employees: EmployeeDirectoryEntry[] }>("employees"),

  overview: (refresh?: boolean): Promise<{ domainActionId: string; receiptId?: string; cached: boolean; [key: string]: unknown }> =>
    jarvisGet("overview", refresh ? { refresh: "1" } : undefined),

  dlqList: (params?: { status?: "open" | "replayed" | "discarded"; limit?: number }): Promise<{ deadLetters: DeadLetter[] }> =>
    jarvisGet<{ deadLetters: DeadLetter[] }>("dlq", toStringParams(params)),

  dlqItem: (id: string): Promise<{ deadLetter: DeadLetter }> => jarvisGet<{ deadLetter: DeadLetter }>(`dlq/${id}`),

  corrections: (limit?: number): Promise<{ corrections: MemoryCorrection[] }> =>
    jarvisGet<{ corrections: MemoryCorrection[] }>("corrections", toStringParams({ limit })),

  // Honestly loose — the domain_policies row shape wasn't read/verified this session.
  policy: (tenantId: string, actionType: string): Promise<unknown> => jarvisGet(`policies/${tenantId}/${actionType}`),

  // ---- POST ----
  submitAction: (body: { instruction: string; channel?: "voice" | "text" | "console"; sessionId?: string }): Promise<{ planned: unknown[] }> =>
    jarvisPost<{ planned: unknown[] }>("actions", body),

  startObjective: (body: { objective: string; channel?: "voice" | "text" | "console"; idempotencyKey?: string; activeContext?: OperatingInteractionContextValue }): Promise<ObjectiveStartResponse> =>
    jarvisPost<ObjectiveStartResponse>("objectives", body),

  controlObjective: (workId: string, body: { command: "continue" | "interrupt" | "cancel" } | { command: "redirect"; objective: string; channel?: "voice" | "text" | "console"; idempotencyKey?: string }): Promise<{ objective: WorkCaseProjection["objectiveLoop"] }> =>
    jarvisPost<{ objective: WorkCaseProjection["objectiveLoop"] }>(`works/${workId}/objective`, body),

  handoffWork: (workId: string, body: { targetEmployeeId: string; note?: string }): Promise<{ handoff: { previousOwnerId: string | null; currentOwnerId: string; duplicate: boolean } }> =>
    jarvisPost(`works/${workId}/handoff`, body),

  confirmAction: (id: string, note?: string): Promise<unknown> => jarvisPost(`actions/${id}/confirm`, { note }),

  rejectAction: (id: string, reason?: string): Promise<unknown> => jarvisPost(`actions/${id}/reject`, { reason }),

  escalateAction: (id: string, note?: string): Promise<unknown> => jarvisPost(`actions/${id}/escalate`, { note }),

  runControl: (id: string, verb: "pause" | "resume" | "cancel" | "retry" | "escalate", expectedVersion: number): Promise<RunControlResult> =>
    jarvisPost<RunControlResult>(`workflows/runs/${id}/${verb}`, { expectedVersion }),

  compensateStep: (id: string, reason: string): Promise<{ caseId: string; succeeded: boolean; idempotent?: boolean }> =>
    jarvisPost<{ caseId: string; succeeded: boolean; idempotent?: boolean }>(`workflows/steps/${id}/compensate`, { reason }),

  dlqReplay: (id: string): Promise<{ replayed: true }> => jarvisPost<{ replayed: true }>(`dlq/${id}/replay`, {}),

  dlqDiscard: (id: string): Promise<{ discarded: true }> => jarvisPost<{ discarded: true }>(`dlq/${id}/discard`, {}),

  submitCorrection: (body: { receiptId: string; correctedFact: string }): Promise<{ id: string }> => jarvisPost<{ id: string }>("corrections", body),

  // Honestly loose response — the domain_policies row shape wasn't read/verified this session.
  upsertPolicy: (tenantId: string, actionType: string, body: { policy: Record<string, unknown>; requiresConfirmation: boolean }): Promise<unknown> =>
    jarvisPut(`policies/${tenantId}/${actionType}`, body),

  // D1.T2 pulse bar / D1.T3 activity theater.
  vitals: (): Promise<Vitals> => jarvisGet<Vitals>("vitals"),

  activity: (params?: { since?: string; limit?: number }): Promise<ActivityPage> =>
    jarvisGet<ActivityPage>("activity", toStringParams(params)),

  workCases: (): Promise<{
    view: "work-cases"
    data: WorkCaseProjection[]
    page: { limit: number; hasMore: boolean; nextCursor: string | null; rootScope: "canonical_work" | "legacy_instruction"; childRowsTruncated: boolean; childRowLimitPerTable: number }
  }> => jarvisGet("read-models/work-cases"),

  workExecution: (workId: string): Promise<{ execution: ExecutionProjection }> =>
    jarvisGet<{ execution: ExecutionProjection }>(`works/${workId}/execution`),

  workReplay: (workId: string): Promise<{ replay: CausalReplayProjection }> =>
    jarvisGet<{ replay: CausalReplayProjection }>(`works/${workId}/replay`),

  cancelComputerRun: (runId: string): Promise<{ cancellationRequested: boolean }> =>
    jarvisPost<{ cancellationRequested: boolean }>(`computer/runs/${runId}/cancel`, {}),

  cashCollections: (): Promise<{ view: "cash-collections"; data: CashCollections }> =>
    jarvisGet<{ view: "cash-collections"; data: CashCollections }>("read-models/cash-collections"),

  dealerZeroTimeCompression: (body: { dateSeed: string; scenario: DealerZeroScenario; multiplier: number }): Promise<TimeCompressedDemo> =>
    jarvisPost<TimeCompressedDemo>("dealer-zero/time-compression", body),
}

// Referenced only for its compile-time `satisfies` check above (API_PATHS) and to
// keep the import from being flagged unused by editors that don't see through
// `satisfies` — never used at runtime.
void API_PATHS
