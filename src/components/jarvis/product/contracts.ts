import type { CompanyBrainProjection, InspectionTarget, PeWorldRootRef, SemanticActivityProjection } from "../pe/contracts"
import type { ProductTruthState, SourceHealthSnapshot } from "./source-health"

export interface ProductResource<T> {
  data: T | null
  status: "idle" | "loading" | "ready" | "error"
  error: string | null
  errorValue?: unknown
  truthState: ProductTruthState
  lastConfirmedAt: string | null
  reload: () => void
}

export interface AttentionRootRef {
  entityType: string
  entityId: string
  relationship: "about" | "target" | "result"
  source: string
}

export interface AttentionItem {
  id: string
  workId: string
  planRevisionId?: string
  planNodeId?: string
  rootRefs: AttentionRootRef[]
  kind: string
  reason: string
  assignedOrEligibleActor: { employeeId: string; basis: string; capability: string | null }
  deadline: string | null
  slackMs: number | null
  blocks: Array<{ kind: string; id: string }>
  unblocks: Array<{ kind: string; id: string }>
  authorityBoundary: null | { operation: string; capability: string; resource: { type: string; id: string }; authorityRevision: number | null; selectionGrantsAuthority: false }
  recoveryBoundary: null | { source: string; mode: string; reasonCode: string }
  impact: { blocksWorkCompletion: boolean; downstreamPlanNodes: number; completionCriteria: number; sourceBackedMateriality: { classification: string; sourceRef: string } | null }
  evidenceRefs: Array<{ type: string; id: string; hash?: string }>
  nextHumanBoundary: { kind: string; description: string; capability: string | null; executable: false }
  rankVector: { tuple: [number, number, number, number, number, number, number, number, string] }
  rankReason: { primary: string; factors: string[] }
  createdAt: string
}

export interface AttentionQueueResult {
  kind: "operational_query_result"
  status: "ok" | "partial" | "unavailable"
  intent: "attention_queue"
  items: AttentionItem[]
  viewer: { employeeId: string | null; authorityRevision: number | null }
  sourceStatus: {
    status: "complete" | "partial" | "unavailable"
    sources: Array<{ source: string; status: "available" | "unavailable" | "not_applicable"; tables: string[]; errorCode?: string }>
    unavailableSources: string[]
  }
  asOf: string
}

export type UnderwritingScalar = string | boolean
export type UnderwritingValue = UnderwritingScalar | Record<string, UnderwritingScalar>

export interface UnderwritingProvenance {
  kind: string
  id: string
  versionId?: string
  anchorId?: string
  semanticHash?: string
  effectiveAt?: string
  observedAt?: string
  retrievedAt?: string
}

export interface UnderwritingInput {
  nodeId: string
  valueType: string
  unit: string
  currency?: string
  shape: "scalar" | "series"
  value: UnderwritingValue | null
  truthClass: string
  status: string
  provenance: UnderwritingProvenance[]
  reason?: string
}

export interface UnderwritingNodeResult {
  nodeId: string
  value: UnderwritingValue
  valueType: string
  unit: string
  currency?: string
  shape: "scalar" | "series"
  truthClass: string
  directDependencies: string[]
  calculation: string
}

export interface UnderwritingRun {
  id: string
  modelVersionId: string
  scenarioId: string | null
  workId: string | null
  worldAt: string
  computedAt: string
  engineVersion: string
  modelSemanticHash: string
  inputHash: string
  resultHash: string
  status: "SUCCEEDED" | "FAILED"
  validity: "VALID" | "INVALID" | "INCOMPLETE" | "NON_CONVERGENT"
  failureCode: string | null
  inputSnapshot: { schemaVersion: string; investmentCaseId: string; worldAt: string; semanticHash: string; values: Record<string, UnderwritingInput> }
  result: {
    status: "SUCCEEDED" | "FAILED"
    validity: "VALID" | "INVALID" | "INCOMPLETE" | "NON_CONVERGENT"
    engineVersion: string
    modelSemanticHash: string
    inputSemanticHash: string
    scenarioSemanticHash?: string
    resultSemanticHash: string
    values: Record<string, UnderwritingNodeResult>
    outputs: Record<string, UnderwritingNodeResult>
    checks: Array<{ nodeId: string; passed: boolean; severity: "error" | "warning"; code: string; message: string; difference?: string; tolerance?: string }>
    solverDiagnostics: Array<Record<string, unknown>>
    failure?: { code: string; message: string; details: Record<string, unknown> }
  }
}

export interface UnderwritingWorkspace {
  investmentCase: { id: string; dealId: string; title: string; summary: string | null; state: string; version: number; createdAt: string; updatedAt: string }
  models: Array<{ id: string; investmentCaseId: string; modelKey: string; name: string; createdAt: string }>
  modelVersions: Array<{ id: string; modelId: string; versionKey: string; semanticHash: string; schemaVersion: string; financialConventionVersion: string; minimumEngineVersion: string; parentVersionId: string | null; createdAt: string }>
  modelInputBindings: Array<{ modelVersionId: string; inputNodeId: string; sourceKind: string; assumptionId: string | null; evidenceVersionId: string | null; documentId: string | null; documentVersionId: string | null; anchorId: string | null; anchorHash: string | null; valuePath: string | null; valueSelector: string | null; staleAfterDays: number | null }>
  scenarios: Array<{ id: string; modelVersionId: string; parentScenarioId: string | null; name: string; semanticHash: string; definition: { overrides: Array<{ nodeId: string; value: UnderwritingValue; reason?: string }> }; createdAt: string }>
  runs: UnderwritingRun[]
  sensitivities: Array<{ id: string; modelVersionId: string; baseRunId: string; name: string; definitionHash: string; status: string; cellCount: number; createdAt: string }>
  artifactBindings: Array<{ id: string; modelVersionId: string; documentId: string; documentVersionId: string; direction: "input" | "output"; bindingMode: string; modelNodeId: string; anchorId: string; anchorHash: string; valueSelector: string | null; comparisonPolicy: Record<string, unknown> | null; bindingVersion: number; supersedesBindingId: string | null }>
  artifactProjections: Array<Record<string, unknown>>
  complete: true
}

export interface UnderwritingLineage {
  nodeId: string
  calculation: string
  value: UnderwritingValue
  truthClass: string
  directDependencies: string[]
  sourceProvenance: UnderwritingProvenance[]
  dependencies: UnderwritingLineage[]
}

export type IcRecord = Record<string, unknown> & { id?: string }
export interface IcWorkspace {
  viewer: { employeeId: string | null }
  case: IcRecord & { id: string; dealId: string; investmentCaseId: string; state: string; version: number; voteSetVersion: number; votingBasisVersion: number | null; primaryUnderwritingRunId: string | null }
  investmentCase: IcRecord & { id: string; title?: string; summary?: string | null; state?: string; version?: number }
  committee: { config: IcRecord; members: IcRecord[] }
  memo: IcRecord | null
  deck: IcRecord | null
  artifacts: { memo: IcRecord | null; deck: IcRecord | null }
  underwriting: null | { run: IcRecord & { id?: string; status?: string; validity?: string; resultHash?: string; modelVersionId?: string; scenarioId?: string | null; worldAt?: string }; checks: IcRecord[]; eligibleUnderPinnedPolicy: boolean; eligibilityBlockers: string[] }
  questions: Array<IcRecord & { id: string; state?: string; version?: number; question?: string; answer?: string | null; substantiationStatus?: string; requiredBeforeVote?: boolean; requiredBeforeDecision?: boolean; sources: IcRecord[] }>
  recommendations: IcRecord[]
  currentRecommendation: (IcRecord & { id?: string; revision?: number; outcome?: string; rationale?: string; memoId?: string; underwritingRunId?: string }) | null
  votes: Array<IcRecord & { id: string; employeeId?: string; recommendationId?: string; choice?: string; rationale?: string | null; recordedAt?: string }>
  dissents: Array<IcRecord & { id: string; employeeId?: string; rationale?: string; sources: IcRecord[] }>
  conditions: Array<IcRecord & { id: string; title?: string; description?: string; conditionType?: string; state?: string; version?: number; ownerEmployeeId?: string; required?: boolean; evidenceRequired?: boolean; sources: IcRecord[] }>
  decisionProposal: IcRecord | null
  decision: (IcRecord & { title?: string; decision?: string; rationale?: string; state?: string; decidedAt?: string; supersedesDecisionId?: string | null }) | null
  decisionProof: IcRecord | null
  readiness: { votingEligible: boolean; decisionEligible: boolean; blockers: string[]; aggregation: null | { counts: { eligible: number; participating: number; approve: number; reject: number; abstain: number; defer: number; thresholdDenominator: number }; quorum: { status: string; required: number; actual: number }; threshold: { status: string; requiredApprovals: number | null; actualApprovals: number; rule: { kind: string } }; process: { status: string; blockers: string[] }; proposedOutcome: string | null } }
  controls: Record<string, boolean>
  controlBlockers: Record<string, string[]>
  asOf: string
}

export interface WorkAggregateView {
  work: { id: string; status: string; initialInstruction: string; executionModel: string | null; currentOwnerId: string | null; assignedTo: string | null; createdAt: string; updatedAt: string; failure: unknown; recovery: unknown; finalOutcome: unknown }
  planRevisions: Array<{ id: string; revision: number; parentRevisionId: string | null; reason: string; status: string; goalSpec: unknown; constraintSet: unknown; planningSnapshot: unknown; validation: unknown; planGraph: unknown; score: unknown; graphHash: string; semanticHash: string; completionProof: unknown; selectedAt: string; completedAt: string | null }>
  actions: Array<{ id: string; actionType: string; status: string; planRevisionId: string | null; planNodeId: string | null; groundedPayload: unknown; predictedReceipt: unknown; createdAt: string }>
  businessEffects: Array<{ id: string; domainActionId: string | null; status: string; effect: unknown; observedResult: unknown; verification: unknown; semanticHash: string }>
  objectiveSteps: Array<{ id: string; stepNumber: number; phase: string; decisionKind: string | null; planRevisionId: string | null; planNodeId: string | null; observation: unknown; recoveryKind: string | null; failure: unknown; iterationOutcome: string | null; completedAt: string | null }>
  queryExecutions: Array<{ id: string; status: string; intent: string; resultSummary: unknown }>
  eventWaits: Array<{ id: string; status: string; eventType: string; deadlineAt: string | null; matchedEventId: string | null }>
  receipts: Array<{ id: string; domainActionId: string | null; actualResult: unknown; failure: unknown; finalizedAt: string | null }>
}

export interface FirmDealProjection {
  root: PeWorldRootRef
  projection: CompanyBrainProjection
  activity: SemanticActivityProjection | null
}

export interface FirmDealProjectionSet {
  items: FirmDealProjection[]
  requested: number
  failedRoots: PeWorldRootRef[]
  failedActivityRoots: PeWorldRootRef[]
}

export interface PeProductData {
  sources: SourceHealthSnapshot[]
  roots: ProductResource<import("../pe/contracts").CompanyBrainSearchResult[]>
  brain: ProductResource<CompanyBrainProjection>
  activity: ProductResource<import("../pe/contracts").SemanticActivityProjection>
  workforce: ProductResource<import("../pe/contracts").WorkforceStatusProjection>
  attention: ProductResource<AttentionQueueResult>
  refreshAll: () => void
}

export interface CommandOpenOptions {
  prompt?: string
  target?: InspectionTarget
}
