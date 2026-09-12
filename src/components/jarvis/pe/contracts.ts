export const PE_WORLD_ROOT_TYPES = ["pe_strategy", "pe_opportunity", "pe_deal"] as const
export type PeWorldRootType = (typeof PE_WORLD_ROOT_TYPES)[number]

export interface PeWorldRootRef {
  entityType: PeWorldRootType
  entityId: string
}

export const PE_ENTITY_TYPES = [
  "pe_strategy", "pe_opportunity", "pe_deal", "pe_investment_case", "pe_thesis",
  "pe_assumption", "pe_decision", "pe_deal_party", "pe_workstream", "pe_request",
  "pe_deliverable", "pe_finding", "pe_deal_risk", "pe_dependency", "pe_milestone",
  "pe_closing_condition", "pe_closing_item", "pe_document_link", "pe_evidence_link",
  "pe_finding_risk_link", "pe_ic_case", "pe_ic_memo", "pe_ic_question",
  "pe_ic_recommendation", "pe_ic_vote", "pe_ic_dissent", "pe_ic_condition",
  "pe_ic_decision_proposal",
] as const
export type PeEntityType = (typeof PE_ENTITY_TYPES)[number]

export const CORE_BRAIN_OBJECT_TYPES = [
  "document", "document_version", "evidence_source", "evidence_version", "source_observation",
  "source_coverage", "source_conflict", "work", "domain_action", "business_effect",
  "decision_receipt", "attention",
] as const
export const UNDERWRITING_BRAIN_OBJECT_TYPES = [
  "underwriting_model", "underwriting_model_version", "underwriting_scenario",
  "underwriting_run", "underwriting_sensitivity",
] as const
export const PLANNING_BRAIN_OBJECT_TYPES = ["goal", "plan_revision", "plan_node", "completion_proof"] as const
export const WORKFORCE_BRAIN_OBJECT_TYPES = ["agent_profile", "agent_revision", "agent_assignment", "learning_revision"] as const

export type CompanyBrainObjectRef =
  | { namespace: "private_equity"; owner: "@finnor/private-equity"; type: PeEntityType; id: string; revisionId?: string }
  | { namespace: "core"; owner: "@finnor/db" | "@finnor/read-models"; type: (typeof CORE_BRAIN_OBJECT_TYPES)[number]; id: string; revisionId?: string }
  | { namespace: "underwriting"; owner: "@finnor/private-equity"; type: (typeof UNDERWRITING_BRAIN_OBJECT_TYPES)[number]; id: string; revisionId?: string }
  | { namespace: "planning"; owner: "@finnor/db"; type: (typeof PLANNING_BRAIN_OBJECT_TYPES)[number]; id: string; revisionId?: string }
  | { namespace: "workforce"; owner: "@finnor/db" | "@finnor/read-models"; type: (typeof WORKFORCE_BRAIN_OBJECT_TYPES)[number]; id: string; revisionId?: string }

export interface CompanyBrainSourceRef {
  owner: "@finnor/private-equity" | "@finnor/db" | "@finnor/read-models"
  table: string
  id: string
  revisionId?: string
  fieldPath?: string
}

export type InspectionTarget =
  | { kind: "brain_object"; ref: CompanyBrainObjectRef }
  | { kind: "pe_context"; root: PeWorldRootRef; objectRef?: CompanyBrainObjectRef }
  | { kind: "work"; workId: string }
  | { kind: "plan_revision"; workId: string; planRevisionId: string }
  | { kind: "plan_node"; workId: string; planRevisionId: string; planNodeId: string }
  | { kind: "evidence"; evidenceSourceId: string; evidenceVersionId?: string }
  | { kind: "document"; documentId: string; documentVersionId?: string }
  | { kind: "underwriting"; investmentCaseId: string; modelId?: string; runId?: string }
  | { kind: "ic"; icCaseId: string; objectRef?: CompanyBrainObjectRef }
  | { kind: "domain_action"; workId: string; domainActionId: string }
  | { kind: "business_effect"; workId: string; businessEffectId: string }
  | { kind: "decision_receipt"; workId: string; decisionReceiptId: string }
  | { kind: "completion_proof"; workId: string; planRevisionId: string }
  | { kind: "agent"; agentProfileId: string; agentRevisionId?: string }
  | { kind: "assignment"; assignmentId: string; workId: string }
  | { kind: "attention"; attentionId: string; workId: string }
  | { kind: "raw_activity"; activityId: string; source: string }

export interface PeOperatingContext {
  root: PeWorldRootRef | null
  selectedObject: CompanyBrainObjectRef | null
  workId: string | null
}

export type CompanyBrainEpistemicState = "KNOWN" | "UNKNOWN" | "STALE" | "CONFLICTING"

export interface CompanyBrainFact {
  key: string
  value: unknown
  asOf: string
  sourceRefs: CompanyBrainSourceRef[]
  epistemicState: CompanyBrainEpistemicState
  derivation?: { name: string; inputRefs: CompanyBrainObjectRef[]; sourceRefs: CompanyBrainSourceRef[] }
}

export interface CandidateCompanyBrainAction {
  actionType: string
  label: string
  status: "candidate"
  resourceRef: CompanyBrainObjectRef
  authorityEvaluation: "required_at_execution"
}

export interface CompanyBrainNode {
  ref: CompanyBrainObjectRef
  type: CompanyBrainObjectRef["type"]
  label: string
  state: string | null
  rootRefs: PeWorldRootRef[]
  version: number | string | null
  revision: number | string | null
  facts: CompanyBrainFact[]
  asOf: string
  temporal: { support: string; completeness: string; baseline: string | null; reasons: string[] }
  epistemicState: CompanyBrainEpistemicState
  epistemicWarnings: Array<{ propositionId: string; predicate: string; sourceStatus: string; mappedState: CompanyBrainEpistemicState; reason: string; evidenceRefs: string[] }>
  provenanceRefs: CompanyBrainSourceRef[]
  workRefs: Array<{ workId: string; sourceRef: CompanyBrainSourceRef }>
  inspectionTarget: InspectionTarget
  availableActions: CandidateCompanyBrainAction[]
}

export interface CompanyBrainEdge {
  fromRef: CompanyBrainObjectRef
  toRef: CompanyBrainObjectRef
  relationship: string
  sourceRef: CompanyBrainSourceRef
  asOf: string
}

export interface CompanyBrainProjection {
  root: PeWorldRootRef
  asOf: string
  nodes: CompanyBrainNode[]
  edges: CompanyBrainEdge[]
  temporal: { support: string; completeness: string; baseline: string | null; reasons: string[] }
  sourceStatus: Array<{ owner: string; status: "complete" | "partial" | "unsupported"; reason?: string }>
  bounds: { nodes: number; edges: number; truncated: boolean; maxNodes: number; maxEdges: number }
}

export interface CompanyBrainSearchResult {
  ref: CompanyBrainObjectRef
  label: string
  state: string | null
  rootRefs: PeWorldRootRef[]
  inspectionTarget: InspectionTarget
}

export type SemanticActivityBucket = "needs_attention" | "in_motion" | "verified_outcomes"

export interface SemanticActivityItem {
  id: string
  occurredAt: string
  kind: string
  bucket: SemanticActivityBucket
  rootRefs: PeWorldRootRef[]
  subjectRef: CompanyBrainObjectRef
  actor: "human" | "agent" | "system" | "provider"
  actorRef?: { kind: "human" | "agent" | "system" | "provider"; id: string }
  workId?: string
  planRevisionId?: string
  planNodeId?: string
  change: { type: string; before?: unknown; after?: unknown; label: string }
  reasonCode: string | null
  causalRefs: Array<{ relationship: string; type: string; id: string; sourceRef: CompanyBrainSourceRef; targetRef?: CompanyBrainObjectRef }>
  evidenceRefs: Array<{ type: string; id: string; hash?: string }>
  receiptRefs: CompanyBrainObjectRef[]
  proofRefs: CompanyBrainObjectRef[]
  blocks: Array<{ type: string; id: string; hash?: string }>
  unblocks: Array<{ type: string; id: string; hash?: string }>
  inspectionTarget: InspectionTarget
  sourceRefs: CompanyBrainSourceRef[]
  asOf: string
}

export interface SemanticActivityProjection {
  schemaVersion: "pe-semantic-activity.v1"
  root: PeWorldRootRef
  asOf: string
  items: SemanticActivityItem[]
  groups: Array<{ bucket: SemanticActivityBucket; roots: Array<{ root: PeWorldRootRef; threads: Array<{ id: string; latestOccurredAt: string; itemIds: string[] }> }> }>
  sourceStatus: CompanyBrainProjection["sourceStatus"]
  bounds: { returned: number; total: number; limit: number; truncated: boolean }
}

/** Diagnostic-only raw activity contract. SemanticActivityProjection is the
 * primary PE activity surface; this stays exact with the API/OpenAPI enum. */
export interface RawActivityItem {
  source: "action_log" | "workflow_step" | "computer_step" | "work_event" | "call"
  id: string
  occurredAt: string
  detail: Record<string, unknown>
}

export type WorkforceRuntimeStatus = "idle" | "working" | "waiting" | "blocked" | "failed" | "unavailable"

export interface WorkforceAssignmentProjection {
  id: string
  workId: string
  planRevisionId: string
  planNodeId: string
  objectiveLoopId: string | null
  objectiveStepId: string | null
  agentProfileId: string
  agentRevisionId: string
  capability: string
  nodeKind: "query" | "action" | "wait" | "check"
  state: "queued" | "claimed" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "reassigned"
  attempt: number
  assignmentReason: string
  reassignmentReason: string | null
  domainActionId: string | null
  startedAt: string | null
  completedAt: string | null
  failure: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

export interface WorkforceMetricProjection {
  agentRevisionId: string
  capability: string
  nodeKind: "query" | "action" | "wait" | "check"
  contextClass: string
  attemptCount: number
  qualityAttemptCount: number
  verifiedCompletionCount: number
  qualityFailureCount: number
  humanRejectionCount: number
  providerOutageCount: number
  externalFailureCount: number
  replanCount: number
  recoveryCount: number
  sampleState: "KNOWN" | "UNKNOWN"
  verifiedCompletionRate: number | null
  qualityFailureRate: number | null
  humanRejectionRate: number | null
  medianLatencyMs: number | null
  p95LatencyMs: number | null
  knownCostUsd: number | null
}

export interface WorkforceWorkerProjection {
  id: string
  key: string
  name: string
  profileStatus: "enabled" | "disabled"
  runtimeStatus: WorkforceRuntimeStatus
  currentLoad: number
  activeRevision: null | {
    id: string
    revision: number
    modelRoute: { provider: string; model?: string | null; purpose: "objective_execution" }
    capabilityGrants: Array<{ capability: string; kind: "query" | "action" | "wait" | "check" }>
    maxConcurrentAssignments: number
    autonomyLimits: { maxActions: number; maxQueries: number; maxReplans: number; maxPlannerCalls: number; maxWallClockMs: number; maxKnownCostUsd?: number | null; maxKnownTokens?: number | null }
    planningHints: Record<string, unknown>
    learningRevisionId: string | null
    configHash: string
    createdAt: string
  }
  latestAssignment: WorkforceAssignmentProjection | null
  metrics: WorkforceMetricProjection[]
}

export interface WorkforceStatusProjection {
  kind: "operational_query_result"
  status: "ok" | "partial" | "unavailable"
  intent: "workforce_status"
  configurationState: "configured" | "unconfigured"
  workers: WorkforceWorkerProjection[]
  assignments: WorkforceAssignmentProjection[]
  currentAssignments: WorkforceAssignmentProjection[]
  completedAssignments: WorkforceAssignmentProjection[]
  blockedOrFailedAssignments: WorkforceAssignmentProjection[]
  proposals: Array<{ id: string; targetType: "agent_profile" | "agent_capability"; targetId: string; targetAgentRevisionId: string; capability: string | null; evidenceWindow: Record<string, unknown>; sampleSize: number; proposedChange: Record<string, unknown>; confidenceClass: "SUPPORTED" | "STRONG"; status: "proposed" | "approved" | "rejected" | "promoted"; reviewedBy: string | null; reviewedAt: string | null; createdAt: string }>
  learningRevisions: Array<{ id: string; targetAgentProfileId: string; revision: number; parentRevisionId: string | null; sourceProposalId: string; semanticHash: string; promotedBy: string; createdAt: string }>
  truncated: boolean
  page: { limit: number; returned: number; totalCount: number | null; totalCountExact: boolean; hasMore: boolean; nextCursor: string | null; truncated: boolean }
  sourceStatus: {
    status: "complete" | "partial"
    asOf: string
    tables: string[]
    truncatedSources: string[]
    bounds: Record<string, { returned: number; limit: number; truncated: boolean; totalCount?: number }>
  }
  asOf: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PE_TYPES = new Set<string>(PE_ENTITY_TYPES)
const CORE_TYPES = new Set<string>(CORE_BRAIN_OBJECT_TYPES)
const UNDERWRITING_TYPES = new Set<string>(UNDERWRITING_BRAIN_OBJECT_TYPES)
const PLANNING_TYPES = new Set<string>(PLANNING_BRAIN_OBJECT_TYPES)
const WORKFORCE_TYPES = new Set<string>(WORKFORCE_BRAIN_OBJECT_TYPES)

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function isPeWorldRootRef(value: unknown): value is PeWorldRootRef {
  const row = record(value)
  return Boolean(row && PE_WORLD_ROOT_TYPES.includes(row.entityType as PeWorldRootType) && typeof row.entityId === "string" && UUID.test(row.entityId))
}

export function isCompanyBrainObjectRef(value: unknown): value is CompanyBrainObjectRef {
  const row = record(value)
  if (!row || typeof row.id !== "string" || !row.id || typeof row.type !== "string" || typeof row.namespace !== "string" || typeof row.owner !== "string") return false
  if (row.revisionId !== undefined && (typeof row.revisionId !== "string" || !row.revisionId)) return false
  if (row.namespace === "private_equity") return row.owner === "@finnor/private-equity" && PE_TYPES.has(row.type) && UUID.test(row.id)
  if (row.namespace === "core") return (row.owner === "@finnor/db" || row.owner === "@finnor/read-models") && CORE_TYPES.has(row.type)
  if (row.namespace === "underwriting") return row.owner === "@finnor/private-equity" && UNDERWRITING_TYPES.has(row.type) && UUID.test(row.id)
  if (row.namespace === "planning") return row.owner === "@finnor/db" && PLANNING_TYPES.has(row.type)
  if (row.namespace === "workforce") return (row.owner === "@finnor/db" || row.owner === "@finnor/read-models") && WORKFORCE_TYPES.has(row.type) && UUID.test(row.id)
  return false
}

function exactStrings(row: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every((key) => typeof row[key] === "string" && Boolean((row[key] as string).trim()))
    && optional.every((key) => row[key] === undefined || (typeof row[key] === "string" && Boolean((row[key] as string).trim())))
}

export function isInspectionTarget(value: unknown): value is InspectionTarget {
  const row = record(value)
  if (!row || typeof row.kind !== "string") return false
  switch (row.kind) {
    case "brain_object": return isCompanyBrainObjectRef(row.ref)
    case "pe_context": return isPeWorldRootRef(row.root) && (row.objectRef === undefined || isCompanyBrainObjectRef(row.objectRef))
    case "work": return exactStrings(row, ["workId"])
    case "plan_revision": return exactStrings(row, ["workId", "planRevisionId"])
    case "plan_node": return exactStrings(row, ["workId", "planRevisionId", "planNodeId"])
    case "evidence": return exactStrings(row, ["evidenceSourceId"], ["evidenceVersionId"])
    case "document": return exactStrings(row, ["documentId"], ["documentVersionId"])
    case "underwriting": return exactStrings(row, ["investmentCaseId"], ["modelId", "runId"])
    case "ic": return exactStrings(row, ["icCaseId"]) && (row.objectRef === undefined || isCompanyBrainObjectRef(row.objectRef))
    case "domain_action": return exactStrings(row, ["workId", "domainActionId"])
    case "business_effect": return exactStrings(row, ["workId", "businessEffectId"])
    case "decision_receipt": return exactStrings(row, ["workId", "decisionReceiptId"])
    case "completion_proof": return exactStrings(row, ["workId", "planRevisionId"])
    case "agent": return exactStrings(row, ["agentProfileId"], ["agentRevisionId"])
    case "assignment": return exactStrings(row, ["assignmentId", "workId"])
    case "attention": return exactStrings(row, ["attentionId", "workId"])
    case "raw_activity": return exactStrings(row, ["activityId", "source"])
    default: return false
  }
}

export function refKey(ref: CompanyBrainObjectRef): string {
  return `${ref.namespace}:${ref.owner}:${ref.type}:${ref.id}:${ref.revisionId ?? ""}`
}

export function humanize(value: string): string {
  return value.replace(/^pe_/, "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
}
