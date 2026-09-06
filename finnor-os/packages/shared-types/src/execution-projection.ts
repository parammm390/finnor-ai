import type { AuthorityOperation, AuthorityOutcome, AuthorityRisk, DomainActionStatus, ErrorKind, Role } from "./index";
import type { ComputerEffectStatus, ComputerExecutionMode, ComputerRunStatus } from "./computer";
import type { BusinessEffectSet, BusinessEffectVerification } from "./business-effects";
import type { ObjectiveSuccessCondition, ObjectiveSuccessVerification } from "./objectives";

// No active Phase-5 workflow step has a registered typed compensation binding.
export const EXECUTION_COMPENSATABLE_STEP_TYPES = [] as const;

/**
 * Presentation-safe, reconstructable view of one durable Work execution. The
 * projection owns no lifecycle state: every sourceRef points back to an existing
 * Work, action, authority, workflow, operation, computer, or receipt row.
 */
export interface ExecutionProjection {
  version: 1;
  work: {
    id: string;
    status: string;
    executionModel: "query" | "atomic_effect" | "objective" | null;
    objective: string;
    objectiveState: string | null;
    successCondition: ObjectiveSuccessCondition | null;
    successVerification: ObjectiveSuccessVerification | null;
    successVerifiedAt: string | null;
    createdAt: string;
    updatedAt: string;
    finalOutcome: Record<string, unknown> | null;
    failure: ExecutionFailure | null;
  };
  targets: ExecutionTarget[];
  nodes: ExecutionActionNode[];
  edges: ExecutionDependencyEdge[];
  workflows: ExecutionWorkflow[];
  receipts: ExecutionReceipt[];
  viewer: { role: Role; evidenceVisibility: "full" | "restricted" };
  limits: {
    actions: number;
    workflowSteps: number;
    computerStepsPerRun: number;
    evidencePerReceipt: number;
  };
  truncated: {
    actions: boolean;
    workflowSteps: boolean;
    computerSteps: boolean;
    evidence: boolean;
  };
  asOf: string;
}

export interface ExecutionTarget {
  entityType: string;
  entityId: string;
  label: string | null;
  status: string | null;
  sourceRef: string;
}

export type ExecutionNodeStatus =
  | "waiting_dependency"
  | "runnable"
  | "awaiting_approval"
  | "approved"
  | "queued"
  | "executing"
  | "reconciling"
  | "verifying"
  | "succeeded"
  | "failed"
  | "blocked"
  | "denied"
  | "rejected";

export type ExecutionVerificationState =
  | "not_started"
  | "awaiting_observation"
  | "verified"
  | "failed"
  | "unknown"
  | "reconciling";

export interface ExecutionActionNode {
  id: string;
  planId: string | null;
  actionType: string;
  businessVerb: string;
  summary: string | null;
  sourceStatus: DomainActionStatus;
  status: ExecutionNodeStatus;
  semanticPayload: Record<string, unknown>;
  businessEffect: ExecutionBusinessEffect | null;
  targets: ExecutionTarget[];
  dependencyIds: string[];
  dependentIds: string[];
  blockedBy: Array<{ actionId: string; status: DomainActionStatus }>;
  actor: ExecutionActor | null;
  route: ExecutionProviderRoute | null;
  authority: ExecutionAuthority;
  approval: ExecutionApproval;
  intent: {
    expectedResult: Record<string, unknown> | null;
    source: "receipt" | "prediction" | "none";
  };
  observation: {
    actualResult: Record<string, unknown> | null;
    evidence: ExecutionEvidence[];
    verification: ExecutionVerificationState;
    basis: string;
  };
  externalEffect: "none" | "pending" | "confirmed" | "possible" | "unknown";
  failure: ExecutionFailure | null;
  workflowRunIds: string[];
  receiptIds: string[];
  computer: ExecutionComputerRun | null;
  controls: ExecutionControl[];
  timestamps: {
    createdAt: string;
    executionStartedAt: string | null;
    lastChangedAt: string;
  };
  sourceRefs: string[];
}

export interface ExecutionBusinessEffect {
  id: string;
  semanticHash: string;
  scopeHash: string;
  status: string;
  contract: BusinessEffectSet;
  verification: BusinessEffectVerification | null;
  sourceRef: string;
}

export interface ExecutionDependencyEdge {
  fromActionId: string;
  toActionId: string;
  state: "waiting" | "runnable" | "succeeded" | "failed" | "blocked";
  sourceRef: string;
}

export interface ExecutionActor {
  employeeId: string;
  displayName: string | null;
  role: Role | null;
  sourceRef: string;
}

export interface ExecutionProviderRoute {
  application: string | null;
  provider: string | null;
  identity: {
    kind: "communication_identity" | "application_account";
    id: string;
    label: string | null;
    channel: string | null;
  } | null;
  route: "native" | "api" | "browser" | "computer" | "manual" | "workflow" | null;
  source: "persisted_execution" | "persisted_configuration";
  sourceRef: string;
}

export interface ExecutionAuthority {
  state: "allowed" | "approval_required" | "denied" | "authority_changed" | "reauthorization_required" | "unknown";
  decisionId: string | null;
  revision: number | null;
  operation: AuthorityOperation | null;
  outcome: AuthorityOutcome | null;
  risk: AuthorityRisk | null;
  reasonCode: string | null;
  employeeId: string | null;
  sourceRef: string | null;
}

export interface ExecutionApproval {
  required: boolean;
  status: "not_required" | "pending" | "approved" | "rejected" | "expired" | "unknown";
  requestId: string | null;
  currentStep: number | null;
  totalSteps: number;
  decidedBy: ExecutionActor | null;
  decidedAt: string | null;
  consequence: string;
  sourceRef: string | null;
}

export interface ExecutionEvidence {
  source: string;
  ref: string | null;
  timestamp: string;
  restricted: boolean;
}

export interface ExecutionFailure {
  errorKind: ErrorKind | null;
  message: string;
  recoveryPath: string | null;
  reconciliationRequired: boolean;
  retrySafe: boolean;
  humanRequired: boolean;
  sourceRef: string;
}

export type ExecutionControlKind =
  | "approve"
  | "reject"
  | "pause"
  | "resume"
  | "cancel"
  | "retry"
  | "escalate"
  | "compensate";

export interface ExecutionControl {
  kind: ExecutionControlKind;
  label: string;
  endpoint: string;
  method: "POST";
  expectedVersion: number | null;
  reason: string;
}

export interface ExecutionWorkflow {
  id: string;
  workflowType: string;
  status: "running" | "completed" | "failed" | "compensating" | "compensated" | "paused" | "cancelled" | "escalated";
  version: number;
  actionIds: string[];
  steps: ExecutionWorkflowStep[];
  controls: ExecutionControl[];
  createdAt: string;
  updatedAt: string;
  sourceRef: string;
}

export interface ExecutionWorkflowStep {
  id: string;
  sequence: number;
  stepType: string;
  status: "pending" | "leased" | "waiting_observation" | "completed" | "failed" | "compensating" | "compensated";
  executionState: "authorized" | "claimed" | "commit_started" | "awaiting_observation" | "reconciling" | "verified" | "failed_before_effect" | "failed_after_possible_effect" | "cancelled_before_effect" | "cancellation_requested" | "blocked";
  effectCommitAt: string | null;
  cancellationRequestedAt: string | null;
  attempts: number;
  terminalReason: string | null;
  domainActionId: string | null;
  integration: {
    capability: string;
    provider: string | null;
    status: "running" | "succeeded" | "failed" | "unknown";
    sourceRef: string;
  } | null;
  reconciliation: { caseId: string; status: "open" | "resolved"; sourceRef: string } | null;
  compensation: { caseId: string; status: "pending" | "succeeded" | "failed"; sourceRef: string } | null;
  controls: ExecutionControl[];
  updatedAt: string;
  sourceRef: string;
}

export interface ExecutionComputerRun {
  id: string;
  status: ComputerRunStatus;
  effectStatus: ComputerEffectStatus;
  mode: ComputerExecutionMode;
  application: string;
  provider: string;
  account: { id: string; label: string };
  actor: ExecutionActor;
  task: string;
  target: { kind: string; identifier: string };
  currentActivity: string | null;
  steps: Array<{
    id: string;
    seq: number;
    phase: ComputerRunStatus;
    operation: string;
    status: "started" | "succeeded" | "blocked" | "failed";
    summary: string;
    createdAt: string;
    completedAt: string | null;
  }>;
  stepCount: number;
  stepsTruncated: boolean;
  result: Record<string, unknown> | null;
  failureCode: string | null;
  blockReason: string | null;
  cancellationRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  sourceRef: string;
}

export interface ExecutionReceipt {
  id: string;
  workId: string;
  domainActionId: string | null;
  workflowRunId: string | null;
  workflowStepId: string | null;
  businessEffectId: string | null;
  intendedEffectHash: string | null;
  authorizedEffectHash: string | null;
  executedEffectHash: string | null;
  effectVerification: BusinessEffectVerification | null;
  recoveryEffectId: string | null;
  objective: string;
  policyApplied: { id: string; version: number } | null;
  riskTier: AuthorityRisk;
  approval: { required: boolean; approvedBy: string | null; at: string | null };
  expectedResult: Record<string, unknown> | null;
  actualResult: Record<string, unknown> | null;
  evidence: ExecutionEvidence[];
  failure: ExecutionFailure | null;
  finalizedAt: string | null;
  createdAt: string;
  sourceRef: string;
}
