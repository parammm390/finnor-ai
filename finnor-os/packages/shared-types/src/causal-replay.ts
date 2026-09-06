import type { Role } from "./index";
import type { OperatingInteractionContext } from "./operating-interaction";

export type CausalReplayStage =
  | "trigger"
  | "context"
  | "evidence"
  | "planning"
  | "policy"
  | "authority"
  | "approval"
  | "dependency"
  | "execution"
  | "provider"
  | "external_event"
  | "canonical_change"
  | "verification"
  | "receipt"
  | "failure"
  | "recovery"
  | "compensation"
  | "missing";

export type CausalEvidenceAvailability = "available" | "restricted" | "expired" | "unavailable" | "legacy_incomplete";

export interface DecisionContextEntitySnapshot {
  entityType: string;
  entityId: string;
  relationship: "focused" | "selected" | "excluded" | "referenced";
  label: string | null;
  status: string | null;
  occurredAt: string | null;
  sourceTable: string | null;
}

/**
 * Bounded, immutable operational provenance captured before a planner decision.
 * It deliberately excludes prompts, model reasoning, memory contents, credentials,
 * raw provider payloads, and full database snapshots.
 */
export interface DecisionContextSnapshot {
  version: 1;
  capturedAt: string;
  interactionContext: OperatingInteractionContext | null;
  entities: DecisionContextEntitySnapshot[];
  cohort: {
    executionId: string;
    intent: string;
    status: string;
    rowCount: number;
    completedAt: string | null;
  } | null;
  canonicalEvidence: Array<{ kind: string; source: string; ref: string | null; asOf: string }>;
  canonicalSummaries: Array<{ name: string; source: string; asOf: string; dataHash: string }>;
  authority: { employeeId: string | null; revision: number | null; roles: string[] };
  health: { status: "complete" | "partial" | "unavailable"; missing: string[] };
}

export interface CausalReplayEvidenceRef {
  source: string;
  ref: string | null;
  recordedAt: string;
  availability: CausalEvidenceAvailability;
  integrityHash: string | null;
}

export interface CausalReplayNode {
  id: string;
  stage: CausalReplayStage;
  title: string;
  summary: string;
  status: string;
  occurredAt: string;
  sourceRefs: string[];
  evidence: CausalReplayEvidenceRef[];
  facts: Record<string, unknown>;
  entityRefs: Array<{ entityType: string; entityId: string }>;
}

export interface CausalReplayEdge {
  id: string;
  from: string;
  to: string;
  relation: string;
  certainty: "proven" | "missing";
  evidenceRefs: string[];
  explanation: string;
}

export interface CausalReplayMoment {
  at: string;
  nodeIds: string[];
  headline: string;
  stage: CausalReplayStage;
}

export interface CausalReplayExplanation {
  trigger: string;
  context: string;
  plan: string;
  governance: string;
  execution: string;
  verification: string;
  outcome: string;
  gaps: string[];
}

/** A GET-only projection over existing durable Work facts. It contains no mutation
 * controls, executable payloads, retry commands, or provider session material. */
export interface CausalReplayProjection {
  version: 1;
  mode: "read_only";
  work: {
    id: string;
    status: string;
    executionModel: "query" | "atomic_effect" | "objective" | null;
    objective: string;
    objectiveState: string | null;
    successCondition: unknown;
    successVerification: unknown;
    createdAt: string;
    updatedAt: string;
  };
  nodes: CausalReplayNode[];
  edges: CausalReplayEdge[];
  moments: CausalReplayMoment[];
  explanation: CausalReplayExplanation;
  completeness: {
    status: "complete" | "partial" | "legacy_incomplete";
    provenEdges: number;
    missingEdges: number;
    missing: string[];
  };
  viewer: { role: Role; evidenceVisibility: "full" | "restricted" };
  readOnlyGuarantee: {
    source: "durable_projection";
    method: "GET";
    mutationControlsIncluded: false;
    sideEffectsPossible: false;
  };
  limits: {
    nodes: number;
    edges: number;
    actionEvents: number;
    computerArtifacts: number;
  };
  truncated: { nodes: boolean; edges: boolean; actionEvents: boolean; computerArtifacts: boolean };
  asOf: string;
}
