import type { AttentionQueueResult, WorkforceStatusResult } from "@finnor/shared-types";
import type { WorkAggregate } from "@finnor/db";
import type { IcWorkspaceReadModel } from "./ic-types";
import type { PeEntityType, PeWorldRootRef, PeWorldState } from "./types";

export const COMPANY_BRAIN_NAMESPACES = ["private_equity", "core", "underwriting", "planning", "workforce"] as const;
export type CompanyBrainNamespace = (typeof COMPANY_BRAIN_NAMESPACES)[number];

export const CORE_BRAIN_OBJECT_TYPES = [
  "document",
  "document_version",
  "evidence_source",
  "evidence_version",
  "source_observation",
  "source_coverage",
  "source_conflict",
  "work",
  "domain_action",
  "business_effect",
  "decision_receipt",
  "attention",
] as const;
export type CoreBrainObjectType = (typeof CORE_BRAIN_OBJECT_TYPES)[number];

export const UNDERWRITING_BRAIN_OBJECT_TYPES = [
  "underwriting_model",
  "underwriting_model_version",
  "underwriting_scenario",
  "underwriting_run",
  "underwriting_sensitivity",
] as const;
export type UnderwritingBrainObjectType = (typeof UNDERWRITING_BRAIN_OBJECT_TYPES)[number];

export const PLANNING_BRAIN_OBJECT_TYPES = ["goal", "plan_revision", "plan_node", "completion_proof"] as const;
export type PlanningBrainObjectType = (typeof PLANNING_BRAIN_OBJECT_TYPES)[number];

export const WORKFORCE_BRAIN_OBJECT_TYPES = ["agent_profile", "agent_revision", "agent_assignment", "learning_revision"] as const;
export type WorkforceBrainObjectType = (typeof WORKFORCE_BRAIN_OBJECT_TYPES)[number];

export interface PrivateEquityBrainRef {
  namespace: "private_equity";
  owner: "@finnor/private-equity";
  type: PeEntityType;
  id: string;
  revisionId?: string;
}

export interface CoreBrainRef {
  namespace: "core";
  owner: "@finnor/db" | "@finnor/read-models";
  type: CoreBrainObjectType;
  id: string;
  revisionId?: string;
}

export interface UnderwritingBrainRef {
  namespace: "underwriting";
  owner: "@finnor/private-equity";
  type: UnderwritingBrainObjectType;
  id: string;
  revisionId?: string;
}

export interface PlanningBrainRef {
  namespace: "planning";
  owner: "@finnor/db";
  type: PlanningBrainObjectType;
  id: string;
  revisionId?: string;
}

export interface WorkforceBrainRef {
  namespace: "workforce";
  owner: "@finnor/db" | "@finnor/read-models";
  type: WorkforceBrainObjectType;
  id: string;
  revisionId?: string;
}

export type CompanyBrainObjectRef =
  | PrivateEquityBrainRef
  | CoreBrainRef
  | UnderwritingBrainRef
  | PlanningBrainRef
  | WorkforceBrainRef;

export type CompanyBrainQualifiedType = `${CompanyBrainNamespace}:${CompanyBrainObjectRef["type"]}`;

export interface CompanyBrainSourceRef {
  owner: "@finnor/private-equity" | "@finnor/db" | "@finnor/read-models";
  table: string;
  id: string;
  revisionId?: string;
  fieldPath?: string;
}

export type CompanyBrainEpistemicState = "KNOWN" | "UNKNOWN" | "STALE" | "CONFLICTING";

export interface CompanyBrainEpistemicWarning {
  propositionId: string;
  predicate: string;
  sourceStatus: "UNKNOWN" | "STALE" | "CONFLICTING" | "UNCERTAIN" | "CONTRADICTED";
  mappedState: CompanyBrainEpistemicState;
  reason: string;
  evidenceRefs: string[];
}

export interface CompanyBrainDerivation {
  name: string;
  inputRefs: CompanyBrainObjectRef[];
  sourceRefs: CompanyBrainSourceRef[];
}

export interface CompanyBrainFact {
  key: string;
  value: unknown;
  asOf: string;
  sourceRefs: CompanyBrainSourceRef[];
  epistemicState: CompanyBrainEpistemicState;
  derivation?: CompanyBrainDerivation;
}

export interface CompanyBrainTemporalTruth {
  support: "canonical_history" | "immutable_version" | "current_only" | "unsupported";
  completeness: "complete" | "partial" | "unavailable_before_baseline" | "unsupported";
  baseline: string | null;
  reasons: string[];
}

export interface CandidateCompanyBrainAction {
  actionType: string;
  label: string;
  status: "candidate";
  resourceRef: CompanyBrainObjectRef;
  authorityEvaluation: "required_at_execution";
}

export type CompanyBrainInspectionTarget =
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
  | { kind: "raw_activity"; activityId: string; source: string };

export interface CompanyBrainNode {
  ref: CompanyBrainObjectRef;
  type: CompanyBrainObjectRef["type"];
  label: string;
  state: string | null;
  rootRefs: PeWorldRootRef[];
  version: number | string | null;
  revision: number | string | null;
  facts: CompanyBrainFact[];
  asOf: string;
  temporal: CompanyBrainTemporalTruth;
  epistemicState: CompanyBrainEpistemicState;
  epistemicWarnings: CompanyBrainEpistemicWarning[];
  provenanceRefs: CompanyBrainSourceRef[];
  workRefs: Array<{ workId: string; sourceRef: CompanyBrainSourceRef }>;
  inspectionTarget: CompanyBrainInspectionTarget;
  availableActions: CandidateCompanyBrainAction[];
}

export interface CompanyBrainEdge {
  fromRef: CompanyBrainObjectRef;
  toRef: CompanyBrainObjectRef;
  relationship: CompanyBrainRelationshipKind;
  sourceRef: CompanyBrainSourceRef;
  asOf: string;
}

export const COMPANY_BRAIN_RELATIONSHIP_KINDS = [
  "strategy_opportunity",
  "opportunity_deal",
  "deal_child",
  "deal_investment_case",
  "investment_case_thesis",
  "investment_case_assumption",
  "investment_case_decision",
  "decision_effect",
  "finding_risk",
  "dependency_blocks",
  "document_link",
  "evidence_link",
  "document_version",
  "evidence_version",
  "source_observation_evidence",
  "source_observation_object",
  "work_entity_link",
  "underwriting_model",
  "underwriting_model_version",
  "underwriting_scenario",
  "underwriting_run",
  "underwriting_sensitivity",
  "ic_case_investment_case",
  "ic_case_child",
  "ic_source_link",
  "ic_final_decision",
  "work_plan_revision",
  "plan_revision_goal",
  "plan_revision_node",
  "plan_dependency",
  "action_effect",
  "effect_receipt",
  "plan_completion_proof",
  "agent_revision",
  "assignment_agent",
  "assignment_work",
  "assignment_plan_node",
  "learning_revision_agent",
  "reassignment_previous",
] as const;
export type CompanyBrainRelationshipKind = (typeof COMPANY_BRAIN_RELATIONSHIP_KINDS)[number];

export interface CompanyBrainRelationshipRegistration {
  kind: CompanyBrainRelationshipKind;
  fromTypes: readonly CompanyBrainQualifiedType[];
  toTypes: readonly CompanyBrainQualifiedType[];
  direction: "outbound" | "bidirectional";
  sourceOwner: CompanyBrainSourceRef["owner"];
  persistedSources: ReadonlyArray<{ table: string; columns: readonly string[] }>;
  resolver: string;
  tenantRule: "authenticated_tenant_only";
  historyBehavior: "canonical_as_of" | "created_at_bounded" | "current_only" | "immutable";
  inspectionBehavior: "source_row" | "source_field";
}

export interface CompanyBrainProjection {
  root: PeWorldRootRef;
  asOf: string;
  nodes: CompanyBrainNode[];
  edges: CompanyBrainEdge[];
  temporal: CompanyBrainTemporalTruth;
  sourceStatus: Array<{ owner: string; status: "complete" | "partial" | "unsupported"; reason?: string }>;
  bounds: { nodes: number; edges: number; truncated: boolean; maxNodes: number; maxEdges: number };
}

export interface PeOperatingContext {
  root: PeWorldRootRef | null;
  selectedObject: CompanyBrainObjectRef | null;
  workId: string | null;
}

export interface CompanyBrainSourceBundle {
  world: PeWorldState;
  underwriting: Array<{ investmentCaseId: string; workspace: Record<string, unknown> }>;
  ic: IcWorkspaceReadModel[];
  works: WorkAggregate[];
  workforce: WorkforceStatusResult | null;
  attention: AttentionQueueResult | null;
  sourceStatus?: Array<{ owner: string; status: "complete" | "partial" | "unsupported"; reason?: string }>;
}

export interface CompanyBrainSearchResult {
  ref: CompanyBrainObjectRef;
  label: string;
  state: string | null;
  rootRefs: PeWorldRootRef[];
  inspectionTarget: CompanyBrainInspectionTarget;
}

export interface CompanyBrainTraverseResult {
  rootRef: CompanyBrainObjectRef;
  depth: number;
  nodes: CompanyBrainNode[];
  edges: CompanyBrainEdge[];
  page: { limit: number; returned: number; total: number; truncated: boolean };
}

export interface CompanyBrainHistoryEntry {
  ref: CompanyBrainObjectRef;
  version: number;
  recordedAt: string;
  observedAt: string | null;
  snapshotHash: string;
  previousVersionId: string | null;
  sourceRef: CompanyBrainSourceRef;
}
