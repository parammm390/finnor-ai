import { z } from "zod";

export const PLAN_NODE_KINDS = ["query", "action", "wait", "check"] as const;
export type PlanNodeKind = (typeof PLAN_NODE_KINDS)[number];

export const PLAN_VIOLATION_CODES = [
  "CANDIDATE_BUDGET_EXCEEDED",
  "CANDIDATE_KEY_DUPLICATE",
  "CANDIDATE_SCHEMA_INVALID",
  "GOAL_SCOPE_MISMATCH",
  "GOAL_TARGET_UNGROUNDED",
  "GOAL_DEADLINE_INVALID",
  "HARD_CONSTRAINT_INVALID",
  "HARD_CONSTRAINT_VIOLATED",
  "UNKNOWN_CAPABILITY",
  "CAPABILITY_NOT_ALLOWED",
  "HUMAN_ONLY_CAPABILITY",
  "PAYLOAD_SCHEMA_INVALID",
  "UNGROUNDED_REFERENCE",
  "CROSS_TENANT_REFERENCE",
  "STALE_GROUNDING",
  "WRONG_VERTICAL_ROOT",
  "POLICY_CONFLICT",
  "PRECONDITION_UNSATISFIED",
  "AUTHORITY_DENIED",
  "INTEGRATION_UNAVAILABLE",
  "DEPENDENCY_UNKNOWN",
  "DEPENDENCY_SELF_REFERENCE",
  "DEPENDENCY_CYCLE",
  "DUPLICATE_NODE_SEMANTICS",
  "DUPLICATE_CONSEQUENTIAL_EFFECT",
  "PLAN_DEPTH_EXCEEDED",
  "EDGE_BUDGET_EXCEEDED",
  "NODE_BUDGET_EXCEEDED",
  "ACTION_BUDGET_EXCEEDED",
  "QUERY_BUDGET_EXCEEDED",
  "WAIT_BUDGET_EXCEEDED",
  "COST_BUDGET_EXCEEDED",
  "DEADLINE_IMPOSSIBLE",
  "PAYLOAD_BUDGET_EXCEEDED",
  "WAIT_CORRELATION_WEAK",
  "UNSUPPORTED_RECOVERY",
  "IRREVERSIBLE_BEFORE_UNCERTAIN_PREREQUISITE",
  "VERIFIED_IRREVERSIBLE_REPLAY",
  "COMPLETION_COVERAGE_MISSING",
  "COMPLETION_CLAIM_UNKNOWN",
] as const;
export type PlanViolationCode = (typeof PLAN_VIOLATION_CODES)[number];

export interface GoalCriterion {
  /** Stable semantic id derived from the accepted server-side criterion. */
  id: string;
  criterion: Record<string, unknown>;
}

export interface GoalTarget {
  kind: "entity" | "party" | "resource";
  type: string;
  id: string;
  versionHash?: string;
  sourceRef: string;
}

export interface GoalSpec {
  version: 1;
  statement: string;
  objective: string;
  workId: string;
  workInputId: string;
  targets: GoalTarget[];
  successCondition: Record<string, unknown>;
  criteria: GoalCriterion[];
  deadline: string | null;
  explicitNonGoals: string[];
  source: "explicit" | "objective_first_policy" | "legacy_backfill";
  semanticHash: string;
}

export interface PlanBudgets {
  maxCandidates: number;
  maxNodes: number;
  maxEdges: number;
  maxConstraints: number;
  maxActions: number;
  maxQueries: number;
  maxWaits: number;
  maxDepth: number;
  maxPayloadBytes: number;
  maxEstimatedCostMicros: number;
}

export const PLANNING_CONSTRAINT_KINDS = [
  "capability_allowlist",
  "capability_prohibited",
  "human_only",
  "exact_target",
  "deadline",
  "authority",
  "policy",
  "state_precondition",
  "budget",
  "non_goal",
] as const;
export type PlanningConstraintKind = (typeof PLANNING_CONSTRAINT_KINDS)[number];

export interface PlanningConstraint {
  id: string;
  kind: PlanningConstraintKind;
  source: "user" | "canonical" | "policy" | "authority" | "capability" | "work" | "server" | "model";
  strength: "hard" | "soft";
  scope: { type: "goal" | "plan" | "node" | "capability" | "target"; ref?: string };
  requirement: Record<string, unknown>;
  provenance: { ref: string; hash: string };
}

export interface ConstraintSet {
  version: 1;
  tenantId: string;
  verticalKey: string;
  allowedCapabilities: string[];
  humanOnlyCapabilities: string[];
  prohibitedCapabilities: string[];
  authorityRevision: number | null;
  budgets: PlanBudgets;
  constraints: PlanningConstraint[];
  deadlineAt: string | null;
  /** Advisory preferences may affect score only. They can never relax hard rules. */
  softPreferences: Array<{ key: string; weight: number; source: "server" | "model" }>;
  semanticHash: string;
}

export interface PlanningSnapshotCapability {
  capability: string;
  kind: "query" | "action" | "wait" | "check";
  modelProposable: boolean;
  available: boolean;
  health: "available" | "degraded" | "unavailable";
  risk: "low" | "medium" | "high";
  irreversible: boolean;
  requiredReferences: string[];
  effectClass: string | null;
  observationStrategy: "operational_query" | "business_effect" | "decision_receipt" | "provider_observation" | "integration_event" | "objective_success";
  reversibility: "read_only" | "reversible" | "compensatable" | "irreversible" | "unknown_provider_dependent";
  supportedRecoveryModes: RecoverySpec["mode"][];
  externalSideEffect: boolean;
  authorityRequirement: "query" | "policy" | "approval" | "typed_approval" | "human_attestation";
}

export interface PlanningWorldSnapshot {
  version: 1;
  workId: string;
  workInputId: string;
  plannerAttemptId: string;
  tenantId: string;
  verticalKey: string;
  capturedAt: string;
  decisionContextHash: string;
  canonicalStateHash: string;
  work: { id: string; status: string | null; inputId: string };
  interactionContextRef: { hash: string; sourceRef: string } | null;
  canonicalEntities: Array<{ kind: "entity" | "party" | "resource"; type: string; id: string; versionHash: string | null; sourceRef: string }>;
  canonicalVersions: Array<{ sourceRef: string; versionHash: string }>;
  activeObjective: { id: string; revision: number; successConditionHash: string } | null;
  completedEffects: Array<{ semanticHash: string; irreversible: boolean; evidenceRef: string }>;
  outstandingEffects: Array<{ semanticHash: string; status: string; evidenceRef: string }>;
  policyRefs: Array<{ actionType: string; policyId: string | null; version: number | null; semanticHash: string }>;
  evidenceRefs: Array<{ type: string; id: string; hash?: string }>;
  epistemicWarnings: Array<{ code: string; sourceRef: string }>;
  sourceRefs: Array<{ kind: string; ref: string; asOf: string | null; hash?: string }>;
  authority: { employeeId: string | null; revision: number | null; roles: string[] };
  capabilities: PlanningSnapshotCapability[];
  currentEffects: Array<{ semanticHash: string; status: string; irreversible: boolean }>;
  sourceHealth: { status: "complete" | "partial" | "unavailable"; missing: string[] };
  semanticHash: string;
}

export interface ObservationSpec {
  version: 1;
  source: "operational_query" | "business_effect" | "decision_receipt" | "provider_observation" | "integration_event" | "objective_success";
  assertion: Record<string, unknown>;
  freshness: "current" | "event_bound";
}

export interface RecoverySpec {
  version: 1;
  on: Array<"failure" | "stale" | "timeout" | "divergence">;
  mode: "retry" | "replan" | "recover" | "compensate" | "escalate";
  maxAttempts: number;
  neverReplayVerifiedIrreversibleEffect: true;
}

export interface CandidatePrecondition {
  kind: "entity_exists" | "version_matches" | "state_matches" | "authority_current" | "policy_current" | "capability_available" | "observation_satisfied";
  ref: string;
  requirement: Record<string, unknown>;
  certainty: "known" | "uncertain";
}

export interface CandidateExpectedEffect {
  kind: "query_result" | "business_effect" | "event" | "objective_progress";
  assertion: Record<string, unknown>;
}

export interface CandidateNodeBase {
  key: string;
  dependsOn?: string[];
  supports?: string[];
  rationale?: string;
  preconditions?: CandidatePrecondition[];
  expectedEffects?: CandidateExpectedEffect[];
  recovery?: RecoverySpec;
}

export interface CandidateQueryNode extends CandidateNodeBase {
  kind: "query";
  request: Record<string, unknown>;
}
export interface CandidateActionNode extends CandidateNodeBase {
  kind: "action";
  actionType: string;
  payload: Record<string, unknown>;
}
export interface CandidateWaitNode extends CandidateNodeBase {
  kind: "wait";
  waitFor: Record<string, unknown>;
  deadlineAt?: string;
}
export interface CandidateCheckNode extends CandidateNodeBase {
  kind: "check";
  criterionId: string;
  observation?: Record<string, unknown>;
}
export type CandidatePlanNode = CandidateQueryNode | CandidateActionNode | CandidateWaitNode | CandidateCheckNode;

export interface CandidatePlan {
  version: 1;
  candidateKey: string;
  nodes: CandidatePlanNode[];
  rationale?: string;
  softPreferences?: Array<{ key: string; weight: number }>;
}

export interface NodeCompilationFacts {
  registered: boolean;
  schemaValid: boolean;
  schemaErrors: string[];
  grounded: boolean;
  crossTenant: boolean;
  stale: boolean;
  authority: "allowed" | "approval_required" | "denied" | "unknown";
  health: "available" | "degraded" | "unavailable";
  risk: "low" | "medium" | "high";
  irreversible: boolean;
  wrongVerticalRoot?: boolean;
  policyAllowed?: boolean;
  preconditionsSatisfied?: boolean;
  deadlineFeasible?: boolean;
  uncertainPrerequisiteNodeKeys?: string[];
  supportedRecoveryModes?: RecoverySpec["mode"][];
  effectSemanticHash?: string;
  estimatedCostMicros?: number | null;
  estimatedLatencyMs?: number | null;
  predictedReceipt?: Record<string, unknown>;
  groundedPayload?: Record<string, unknown>;
}

export interface CandidateCompilationFacts {
  candidateKey: string;
  nodes: Record<string, NodeCompilationFacts>;
}

export interface PlanViolation {
  code: PlanViolationCode;
  candidateKey: string;
  nodeKey?: string;
  path?: string;
  message: string;
}

export interface PlanNodeBase {
  id: string;
  kind: PlanNodeKind;
  dependsOn: string[];
  supports: string[];
  preconditions: CandidatePrecondition[];
  expectedEffects: CandidateExpectedEffect[];
  observation: ObservationSpec;
  recovery: RecoverySpec;
  semanticHash: string;
}
export interface PlanQueryNode extends PlanNodeBase { kind: "query"; request: Record<string, unknown> }
export interface PlanActionNode extends PlanNodeBase {
  kind: "action";
  actionType: string;
  payload: Record<string, unknown>;
  groundedPayload: Record<string, unknown>;
  predictedReceipt: Record<string, unknown> | null;
  authority: "allowed" | "approval_required";
  risk: "low" | "medium" | "high";
  irreversible: boolean;
}
export interface PlanWaitNode extends PlanNodeBase { kind: "wait"; waitFor: Record<string, unknown>; deadlineAt?: string }
export interface PlanCheckNode extends PlanNodeBase { kind: "check"; criterionId: string; assertion: Record<string, unknown> }
export type PlanNode = PlanQueryNode | PlanActionNode | PlanWaitNode | PlanCheckNode;

/** Lower is better in every numeric dimension; semanticHash is the final stable tie-break. */
export interface PlanScoreVector {
  hardViolations: number;
  completionGaps: number;
  groundingUncertainty: number;
  authorityFriction: number;
  capabilityDegradation: number;
  irreversibleRisk: number;
  recoveryWeakness: number;
  epistemicUncertainty: number;
  sideEffectCount: number;
  nodeCount: number;
  estimatedCostMicros: number | null;
  estimatedLatencyMs: number | null;
  preferencePenalty: number;
  semanticHash: string;
}

export interface PlanEdge {
  from: string;
  to: string;
  kind: "causal_prerequisite";
  semanticHash: string;
}

export interface PlanGraph {
  version: 1;
  goalHash: string;
  constraintHash: string;
  snapshotHash: string;
  nodes: PlanNode[];
  edges: PlanEdge[];
  completionCoverage: Array<{ criterionId: string; checkNodeId: string }>;
  semanticHash: string;
}

export interface CompiledCandidate {
  candidateKey: string;
  candidateSemanticHash: string;
  accepted: boolean;
  violations: PlanViolation[];
  score: PlanScoreVector;
  graph: PlanGraph | null;
}

export interface PlanCompilationResult {
  version: 1;
  candidates: CompiledCandidate[];
  selected: CompiledCandidate | null;
}

export interface PlanRevision {
  version: 1;
  revision: number;
  parentRevisionId: string | null;
  reason: "initial" | "observation" | "failure" | "stale" | "timeout" | "redirect";
  status: "active" | "superseded" | "completed" | "blocked" | "failed";
  goal: GoalSpec;
  constraints: ConstraintSet;
  snapshot: PlanningWorldSnapshot;
  graph: PlanGraph;
  score: PlanScoreVector;
}

export interface CompletionProof {
  version: 1;
  finalPlanRevisionId: string;
  planRevisionId: string;
  planSemanticHash: string;
  goalSemanticHash: string;
  successConditionHash: string;
  verified: boolean;
  verifiedAt: string;
  verification: Record<string, unknown>;
  evidenceRefs: Array<{ type: string; id: string }>;
}

const NodeKey = z.string().min(1).max(120).regex(/^[A-Za-z0-9_.:-]+$/);
const Dependencies = z.array(NodeKey).max(24).optional();
const Supports = z.array(z.string().min(1).max(100)).max(24).optional();
const Common = {
  key: NodeKey,
  dependsOn: Dependencies,
  supports: Supports,
  rationale: z.string().min(1).max(4_000).optional(),
  preconditions: z.array(z.object({
    kind: z.enum(["entity_exists", "version_matches", "state_matches", "authority_current", "policy_current", "capability_available", "observation_satisfied"]),
    ref: z.string().min(1).max(500),
    requirement: z.record(z.unknown()),
    certainty: z.enum(["known", "uncertain"]),
  }).strict()).max(24).optional(),
  expectedEffects: z.array(z.object({
    kind: z.enum(["query_result", "business_effect", "event", "objective_progress"]),
    assertion: z.record(z.unknown()),
  }).strict()).max(24).optional(),
  recovery: z.object({
    version: z.literal(1),
    on: z.array(z.enum(["failure", "stale", "timeout", "divergence"])).min(1).max(4),
    mode: z.enum(["retry", "replan", "recover", "compensate", "escalate"]),
    maxAttempts: z.number().int().min(1).max(10),
    neverReplayVerifiedIrreversibleEffect: z.literal(true),
  }).strict().optional(),
};
export const CandidatePlanSchema = z.object({
  version: z.literal(1),
  candidateKey: z.string().min(1).max(120),
  nodes: z.array(z.discriminatedUnion("kind", [
    z.object({ ...Common, kind: z.literal("query"), request: z.record(z.unknown()) }).strict(),
    z.object({ ...Common, kind: z.literal("action"), actionType: z.string().min(1).max(200), payload: z.record(z.unknown()) }).strict(),
    z.object({ ...Common, kind: z.literal("wait"), waitFor: z.record(z.unknown()), deadlineAt: z.string().datetime().optional() }).strict(),
    z.object({ ...Common, kind: z.literal("check"), criterionId: z.string().min(1).max(100), observation: z.record(z.unknown()).optional() }).strict(),
  ])).min(1).max(40),
  rationale: z.string().min(1).max(8_000).optional(),
  softPreferences: z.array(z.object({ key: z.string().min(1).max(100), weight: z.number().min(-100).max(100) }).strict()).max(20).optional(),
}).strict();
