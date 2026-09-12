import { workAggregate, type WorkAggregate } from "@finnor/db";
import { executeAttentionQueueQuery, workforceStatus } from "@finnor/read-models";
import type { AttentionItem, AttentionQueueResult, WorkforceStatusResult } from "@finnor/shared-types";
import { getIcWorkspace, listIcCases } from "./ic-repository";
import { peTransaction, shapePeRow, type SqlRow } from "./repository";
import { listUnderwritingWorkspace } from "./underwriting-repository";
import { loadPrivateEquityWorldState } from "./world-state";
import {
  CORE_BRAIN_OBJECT_TYPES,
  PLANNING_BRAIN_OBJECT_TYPES,
  UNDERWRITING_BRAIN_OBJECT_TYPES,
  WORKFORCE_BRAIN_OBJECT_TYPES,
  type CandidateCompanyBrainAction,
  type CompanyBrainEdge,
  type CompanyBrainEpistemicState,
  type CompanyBrainEpistemicWarning,
  type CompanyBrainFact,
  type CompanyBrainHistoryEntry,
  type CompanyBrainInspectionTarget,
  type CompanyBrainNode,
  type CompanyBrainObjectRef,
  type CompanyBrainProjection,
  type CompanyBrainSearchResult,
  type CompanyBrainSourceBundle,
  type CompanyBrainSourceRef,
  type CompanyBrainTemporalTruth,
  type CompanyBrainTraverseResult,
  type CoreBrainObjectType,
  type PlanningBrainObjectType,
  type PeOperatingContext,
  type UnderwritingBrainObjectType,
  type WorkforceBrainObjectType,
} from "./company-brain-types";
import { createCompanyBrainEdge } from "./company-brain-relationships";
import {
  PE_ENTITY_TYPES,
  PeDomainError,
  type PeEntityType,
  type PeMutationContext,
  type PeWorldRootRef,
  type PeWorldState,
} from "./types";

const DEFAULT_MAX_NODES = 2_000;
const DEFAULT_MAX_EDGES = 5_000;
const MAX_SEARCH_ROOTS = 10;
const MAX_SEARCH_RESULTS = 100;
const MAX_TRAVERSE_DEPTH = 4;
const MAX_TRAVERSE_ROWS = 250;

const PE_TYPE_SET = new Set<string>(PE_ENTITY_TYPES);
const CORE_TYPE_SET = new Set<string>(CORE_BRAIN_OBJECT_TYPES);
const UNDERWRITING_TYPE_SET = new Set<string>(UNDERWRITING_BRAIN_OBJECT_TYPES);
const PLANNING_TYPE_SET = new Set<string>(PLANNING_BRAIN_OBJECT_TYPES);
const WORKFORCE_TYPE_SET = new Set<string>(WORKFORCE_BRAIN_OBJECT_TYPES);

const PE_TABLES: Record<PeEntityType, string> = {
  pe_strategy: "pe_strategies",
  pe_opportunity: "pe_opportunities",
  pe_deal: "pe_deals",
  pe_investment_case: "pe_investment_cases",
  pe_thesis: "pe_theses",
  pe_assumption: "pe_assumptions",
  pe_decision: "pe_decisions",
  pe_deal_party: "pe_deal_parties",
  pe_workstream: "pe_workstreams",
  pe_request: "pe_requests",
  pe_deliverable: "pe_deliverables",
  pe_finding: "pe_findings",
  pe_deal_risk: "pe_deal_risks",
  pe_dependency: "pe_dependencies",
  pe_milestone: "pe_milestones",
  pe_closing_condition: "pe_closing_conditions",
  pe_closing_item: "pe_closing_items",
  pe_document_link: "pe_document_links",
  pe_evidence_link: "pe_evidence_links",
  pe_finding_risk_link: "pe_finding_risk_links",
  pe_ic_case: "pe_ic_cases",
  pe_ic_memo: "pe_ic_memos",
  pe_ic_question: "pe_ic_questions",
  pe_ic_recommendation: "pe_ic_recommendations",
  pe_ic_vote: "pe_ic_votes",
  pe_ic_dissent: "pe_ic_dissents",
  pe_ic_condition: "pe_ic_conditions",
  pe_ic_decision_proposal: "pe_ic_decision_proposals",
};

const WORLD_COLLECTIONS: Array<[PeEntityType, keyof PeWorldState]> = [
  ["pe_opportunity", "opportunities"],
  ["pe_deal", "deals"],
  ["pe_investment_case", "investmentCases"],
  ["pe_thesis", "theses"],
  ["pe_assumption", "assumptions"],
  ["pe_decision", "decisions"],
  ["pe_deal_party", "dealParties"],
  ["pe_workstream", "workstreams"],
  ["pe_request", "requests"],
  ["pe_deliverable", "deliverables"],
  ["pe_finding", "findings"],
  ["pe_deal_risk", "dealRisks"],
  ["pe_finding_risk_link", "findingRiskLinks"],
  ["pe_dependency", "dependencies"],
  ["pe_milestone", "milestones"],
  ["pe_closing_condition", "closingConditions"],
  ["pe_closing_item", "closingItems"],
  ["pe_document_link", "documentLinks"],
  ["pe_evidence_link", "evidenceLinks"],
];

const FACT_KEYS = [
  "state", "status", "version", "revision", "graphVersion", "summary", "description", "codeName",
  "targetClosingAt", "actualCloseAt", "signedLoiAt", "kind", "role", "priority", "severity", "materiality",
  "dueAt", "targetAt", "required", "requiredForClose", "late", "overdue", "validity", "resultHash",
  "semanticHash", "contentHash", "versionNumber", "sourceType", "sourceSystem", "observedAt", "retrievedAt",
  "computedAt", "finalizedAt", "completedAt", "runtimeStatus", "profileStatus", "currentLoad", "attempt",
  "capability", "nodeKind", "reason", "relationship", "truthStatus", "mappingStatus", "conflictState",
] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function iso(value: unknown, fallback: string): string {
  if (value instanceof Date && Number.isFinite(value.valueOf())) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

function safeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(safeValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeValue(item)]));
  return value;
}

function idOf(row: Record<string, unknown>): string | null {
  return text(row.id);
}

function humanize(value: string): string {
  return value.replace(/^pe_/, "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function labelOf(type: CompanyBrainObjectRef["type"], row: Record<string, unknown>, id: string): string {
  for (const key of ["name", "title", "question", "condition", "statement", "item", "objective", "key", "assumptionKey", "decision", "actionType", "kind"]) {
    const value = text(row[key]);
    if (value) return value;
  }
  return `${humanize(type)} ${id.slice(0, 8)}`;
}

function stateOf(row: Record<string, unknown>): string | null {
  return text(row.state) ?? text(row.status) ?? text(row.runtimeStatus) ?? text(row.profileStatus);
}

export function companyBrainRefKey(ref: CompanyBrainObjectRef): string {
  return `${ref.namespace}:${ref.type}:${ref.id}:${ref.revisionId ?? ""}`;
}

function peRef(type: PeEntityType, id: string): CompanyBrainObjectRef {
  return { namespace: "private_equity", owner: "@finnor/private-equity", type, id };
}

function coreRef(type: CoreBrainObjectType, id: string, revisionId?: string): CompanyBrainObjectRef {
  return { namespace: "core", owner: type === "attention" ? "@finnor/read-models" : "@finnor/db", type, id, ...(revisionId ? { revisionId } : {}) };
}

function underwritingRef(type: UnderwritingBrainObjectType, id: string): CompanyBrainObjectRef {
  return { namespace: "underwriting", owner: "@finnor/private-equity", type, id };
}

function planningRef(type: PlanningBrainObjectType, id: string, revisionId?: string): CompanyBrainObjectRef {
  return { namespace: "planning", owner: "@finnor/db", type, id, ...(revisionId ? { revisionId } : {}) };
}

function workforceRef(type: WorkforceBrainObjectType, id: string): CompanyBrainObjectRef {
  return { namespace: "workforce", owner: "@finnor/db", type, id };
}

export function parseCompanyBrainObjectRef(value: unknown): CompanyBrainObjectRef | null {
  const candidate = record(value);
  const namespace = text(candidate.namespace);
  const type = text(candidate.type);
  const id = text(candidate.id);
  const revisionId = text(candidate.revisionId) ?? undefined;
  if (!namespace || !type || !id) return null;
  if (namespace === "private_equity" && PE_TYPE_SET.has(type) && candidate.owner === "@finnor/private-equity") return peRef(type as PeEntityType, id);
  if (namespace === "core" && CORE_TYPE_SET.has(type) && (candidate.owner === "@finnor/db" || candidate.owner === "@finnor/read-models")) {
    return { namespace, owner: candidate.owner, type: type as CoreBrainObjectType, id, ...(revisionId ? { revisionId } : {}) };
  }
  if (namespace === "underwriting" && UNDERWRITING_TYPE_SET.has(type) && candidate.owner === "@finnor/private-equity") return underwritingRef(type as UnderwritingBrainObjectType, id);
  if (namespace === "planning" && PLANNING_TYPE_SET.has(type) && candidate.owner === "@finnor/db") return planningRef(type as PlanningBrainObjectType, id, revisionId);
  if (namespace === "workforce" && WORKFORCE_TYPE_SET.has(type) && (candidate.owner === "@finnor/db" || candidate.owner === "@finnor/read-models")) return workforceRef(type as WorkforceBrainObjectType, id);
  return null;
}

export function mapCompanyBrainEpistemicWarning(warning: PeWorldState["epistemicWarnings"][number]): CompanyBrainEpistemicWarning {
  const mappedState: CompanyBrainEpistemicState = warning.status === "STALE"
    ? "STALE"
    : warning.status === "CONFLICTING" || warning.status === "CONTRADICTED"
      ? "CONFLICTING"
      : "UNKNOWN";
  return {
    propositionId: warning.propositionId,
    predicate: warning.predicate,
    sourceStatus: warning.status,
    mappedState,
    reason: warning.reason,
    evidenceRefs: [...warning.evidenceRefs],
  };
}

function epistemicState(warnings: CompanyBrainEpistemicWarning[]): CompanyBrainEpistemicState {
  if (warnings.some((warning) => warning.mappedState === "CONFLICTING")) return "CONFLICTING";
  if (warnings.some((warning) => warning.mappedState === "STALE")) return "STALE";
  if (warnings.some((warning) => warning.mappedState === "UNKNOWN")) return "UNKNOWN";
  return "KNOWN";
}

function sourceRef(owner: CompanyBrainSourceRef["owner"], table: string, id: string, extras: Partial<Pick<CompanyBrainSourceRef, "revisionId" | "fieldPath">> = {}): CompanyBrainSourceRef {
  return { owner, table, id, ...extras };
}

function currentTemporal(reason = "The canonical owner exposes this object as a current projection only"): CompanyBrainTemporalTruth {
  return { support: "current_only", completeness: "unsupported", baseline: null, reasons: [reason] };
}

function immutableTemporal(): CompanyBrainTemporalTruth {
  return { support: "immutable_version", completeness: "complete", baseline: null, reasons: [] };
}

function p1Temporal(world: PeWorldState): CompanyBrainTemporalTruth {
  return {
    support: "canonical_history",
    completeness: world.temporalCompleteness.status,
    baseline: world.temporalCompleteness.baselineAt,
    reasons: [...world.temporalCompleteness.reasons],
  };
}

function factsFor(
  row: Record<string, unknown>,
  at: string,
  source: CompanyBrainSourceRef,
  state: CompanyBrainEpistemicState,
): CompanyBrainFact[] {
  const factAt = iso(row.updatedAt ?? row.observedAt ?? row.computedAt ?? row.recordedAt ?? row.createdAt, at);
  return FACT_KEYS.flatMap((key) => Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined
    ? [{ key, value: safeValue(row[key]), asOf: factAt, sourceRefs: [source], epistemicState: state }]
    : []);
}

function candidateActions(ref: CompanyBrainObjectRef): CandidateCompanyBrainAction[] {
  const registry: Partial<Record<CompanyBrainObjectRef["type"], Array<[string, string]>>> = {
    pe_deal: [["pe.update_deal", "Update deal"], ["pe.declare_deal_closed", "Evaluate close"]],
    pe_request: [["pe.transition_request", "Advance request"]],
    pe_deliverable: [["pe.receive_deliverable", "Receive deliverable"], ["pe.accept_deliverable", "Accept deliverable"]],
    pe_finding: [["pe.resolve_finding", "Resolve finding"]],
    pe_deal_risk: [["pe.transition_risk", "Update risk"]],
    pe_closing_condition: [["pe.satisfy_closing_condition", "Satisfy condition"]],
    pe_closing_item: [["pe.verify_closing_item", "Verify closing item"]],
    pe_ic_case: [["pe.ic.advance_case", "Advance IC case"]],
    work: [["work.resume", "Resume work"], ["work.cancel", "Cancel work"]],
    agent_profile: [["workforce.configure_agent", "Configure agent"]],
    agent_assignment: [["workforce.reassign_agent", "Reassign work"]],
    learning_revision: [],
  };
  return (registry[ref.type] ?? []).map(([actionType, label]) => ({
    actionType,
    label,
    status: "candidate" as const,
    resourceRef: ref,
    authorityEvaluation: "required_at_execution" as const,
  }));
}

function targetFor(ref: CompanyBrainObjectRef, context: {
  root: PeWorldRootRef;
  workId?: string;
  planRevisionId?: string;
  planNodeId?: string;
  investmentCaseId?: string;
  icCaseId?: string;
  evidenceSourceId?: string;
  documentId?: string;
  attentionId?: string;
}): CompanyBrainInspectionTarget {
  if (ref.namespace === "private_equity") {
    if (ref.type.startsWith("pe_ic_") && context.icCaseId) return { kind: "ic", icCaseId: context.icCaseId, objectRef: ref };
    return { kind: "pe_context", root: context.root, objectRef: ref };
  }
  if (ref.type === "work" && context.workId) return { kind: "work", workId: context.workId };
  if (ref.type === "plan_revision" && context.workId) return { kind: "plan_revision", workId: context.workId, planRevisionId: ref.id };
  if (ref.type === "plan_node" && context.workId && context.planRevisionId) return { kind: "plan_node", workId: context.workId, planRevisionId: context.planRevisionId, planNodeId: ref.id };
  if (ref.type === "domain_action" && context.workId) return { kind: "domain_action", workId: context.workId, domainActionId: ref.id };
  if (ref.type === "business_effect" && context.workId) return { kind: "business_effect", workId: context.workId, businessEffectId: ref.id };
  if (ref.type === "decision_receipt" && context.workId) return { kind: "decision_receipt", workId: context.workId, decisionReceiptId: ref.id };
  if (ref.type === "completion_proof" && context.workId && context.planRevisionId) return { kind: "completion_proof", workId: context.workId, planRevisionId: context.planRevisionId };
  if ((ref.type === "evidence_source" || ref.type === "evidence_version") && context.evidenceSourceId) {
    return { kind: "evidence", evidenceSourceId: context.evidenceSourceId, ...(ref.type === "evidence_version" ? { evidenceVersionId: ref.id } : {}) };
  }
  if ((ref.type === "document" || ref.type === "document_version") && context.documentId) {
    return { kind: "document", documentId: context.documentId, ...(ref.type === "document_version" ? { documentVersionId: ref.id } : {}) };
  }
  if (ref.namespace === "underwriting" && context.investmentCaseId) {
    return { kind: "underwriting", investmentCaseId: context.investmentCaseId, ...(ref.type === "underwriting_run" ? { runId: ref.id } : {}), ...(ref.type === "underwriting_model" ? { modelId: ref.id } : {}) };
  }
  if (ref.type === "agent_profile") return { kind: "agent", agentProfileId: ref.id };
  if (ref.type === "agent_revision") return { kind: "agent", agentProfileId: context.workId ?? ref.id, agentRevisionId: ref.id };
  if (ref.type === "agent_assignment" && context.workId) return { kind: "assignment", assignmentId: ref.id, workId: context.workId };
  if (ref.type === "attention" && context.workId && context.attentionId) return { kind: "attention", attentionId: context.attentionId, workId: context.workId };
  return { kind: "brain_object", ref };
}

function rootRefsFromAttention(item: AttentionItem, fallback: PeWorldRootRef): PeWorldRootRef[] {
  const roots: PeWorldRootRef[] = [];
  for (const ref of item.rootRefs) {
    if ((ref.entityType === "pe_strategy" || ref.entityType === "pe_opportunity" || ref.entityType === "pe_deal") && text(ref.entityId)) {
      roots.push({ entityType: ref.entityType, entityId: ref.entityId });
    }
  }
  return roots.length ? roots : [fallback];
}

function attentionPersistedSource(item: AttentionItem): CompanyBrainSourceRef | null {
  const parts = item.id.split(":");
  const persistedId = parts[1];
  if (!persistedId) return null;
  const tableByKind: Partial<Record<AttentionItem["kind"], [CompanyBrainSourceRef["owner"], string]>> = {
    work_recovery: ["@finnor/db", "works"],
    work_failure: ["@finnor/db", "works"],
    work_assigned: ["@finnor/db", "works"],
    approval_required: ["@finnor/db", "authority_approval_requests"],
    clarification_required: ["@finnor/db", "domain_actions"],
    manual_verification_required: ["@finnor/db", "domain_actions"],
    wait_timed_out: ["@finnor/db", "work_event_waits"],
    ai_assignment_failed: ["@finnor/db", "workforce_assignments"],
    no_eligible_ai_worker: ["@finnor/db", "workforce_assignments"],
    worker_budget_exhausted: ["@finnor/db", "workforce_assignments"],
    learning_proposal_review: ["@finnor/db", "learning_proposals"],
    p5_question_blocking: ["@finnor/private-equity", "pe_ic_questions"],
    p5_vote_required: ["@finnor/private-equity", "pe_ic_cases"],
    p5_decision_required: ["@finnor/private-equity", "pe_ic_cases"],
    p5_condition_active: ["@finnor/private-equity", "pe_ic_conditions"],
  };
  const source = tableByKind[item.kind];
  return source ? sourceRef(source[0], source[1], persistedId) : null;
}

interface NodeInput {
  ref: CompanyBrainObjectRef;
  row: Record<string, unknown>;
  source: CompanyBrainSourceRef;
  rootRefs: PeWorldRootRef[];
  temporal: CompanyBrainTemporalTruth;
  asOf: string;
  warnings?: CompanyBrainEpistemicWarning[];
  target: CompanyBrainInspectionTarget;
  workRefs?: CompanyBrainNode["workRefs"];
  label?: string;
  state?: string | null;
  version?: number | string | null;
  revision?: number | string | null;
}

function createNode(input: NodeInput): CompanyBrainNode {
  const warnings = input.warnings ?? [];
  const epistemic = epistemicState(warnings);
  return {
    ref: input.ref,
    type: input.ref.type,
    label: input.label ?? labelOf(input.ref.type, input.row, input.ref.id),
    state: input.state === undefined ? stateOf(input.row) : input.state,
    rootRefs: input.rootRefs,
    version: input.version === undefined ? integer(input.row.version) : input.version,
    revision: input.revision === undefined ? integer(input.row.revision) : input.revision,
    facts: factsFor(input.row, input.asOf, input.source, epistemic),
    asOf: input.asOf,
    temporal: input.temporal,
    epistemicState: epistemic,
    epistemicWarnings: warnings,
    provenanceRefs: [input.source],
    workRefs: input.workRefs ?? [],
    inspectionTarget: input.target,
    availableActions: candidateActions(input.ref),
  };
}

function sourceStatusFor(bundle: CompanyBrainSourceBundle): CompanyBrainProjection["sourceStatus"] {
  if (bundle.sourceStatus) return bundle.sourceStatus;
  return [
    { owner: "P1 Private Equity world", status: "complete" },
    { owner: "P4 underwriting", status: "complete" },
    { owner: "P5 IC", status: "complete" },
    { owner: "P6 Work", status: "complete" },
    { owner: "P7 workforce", status: bundle.workforce ? "complete" : "partial", ...(!bundle.workforce ? { reason: "Source projection unavailable" } : {}) },
  ];
}

export function projectCompanyBrain(
  bundle: CompanyBrainSourceBundle,
  options: { maxNodes?: number; maxEdges?: number } = {},
): CompanyBrainProjection {
  const world = bundle.world;
  const asOf = world.stateAt;
  const rootRefs = [world.root];
  const nodes = new Map<string, CompanyBrainNode>();
  const edges = new Map<string, CompanyBrainEdge>();
  const peTemporal = p1Temporal(world);
  const mappedWarnings = world.epistemicWarnings.map(mapCompanyBrainEpistemicWarning);
  const warningFor = (type: string, id: string) => mappedWarnings.filter((warning) => warning.propositionId.includes(`:${type}:${id}:`));
  const addNode = (node: CompanyBrainNode) => { if (!nodes.has(companyBrainRefKey(node.ref))) nodes.set(companyBrainRefKey(node.ref), node); };
  const findNode = (ref: CompanyBrainObjectRef) => nodes.get(companyBrainRefKey(ref));
  const addEdge = (kind: Parameters<typeof createCompanyBrainEdge>[0]["kind"], fromRef: CompanyBrainObjectRef, toRef: CompanyBrainObjectRef, source: CompanyBrainSourceRef, edgeAt = asOf) => {
    if (!findNode(fromRef) || !findNode(toRef)) return;
    const edge = createCompanyBrainEdge({ kind, fromRef, toRef, sourceRef: source, asOf: edgeAt });
    const key = `${kind}:${companyBrainRefKey(fromRef)}:${companyBrainRefKey(toRef)}:${source.table}:${source.id}:${source.fieldPath ?? ""}`;
    if (!edges.has(key)) edges.set(key, edge);
  };

  const addPe = (type: PeEntityType, row: Record<string, unknown>) => {
    const id = idOf(row);
    if (!id) return;
    const ref = peRef(type, id);
    const source = sourceRef("@finnor/private-equity", PE_TABLES[type], id, { revisionId: integer(row.version)?.toString() });
    addNode(createNode({ ref, row, source, rootRefs, temporal: peTemporal, asOf, warnings: warningFor(type, id), target: targetFor(ref, { root: world.root }) }));
  };

  if (world.strategy) addPe("pe_strategy", world.strategy);
  if (world.opportunity) addPe("pe_opportunity", world.opportunity);
  if (world.deal) addPe("pe_deal", world.deal);
  for (const [type, key] of WORLD_COLLECTIONS) for (const row of rows(world[key])) addPe(type, row);

  for (const row of world.documents) {
    const id = idOf(row);
    if (!id) continue;
    const ref = coreRef("document", id);
    const source = sourceRef("@finnor/db", "documents", id);
    addNode(createNode({ ref, row, source, rootRefs, temporal: currentTemporal("Document metadata is current-only; version payloads remain separately addressable"), asOf, target: targetFor(ref, { root: world.root, documentId: id }) }));
  }
  for (const row of world.evidence) {
    const sourceId = text(row.sourceId);
    const versionId = text(row.versionId);
    if (!sourceId || !versionId) continue;
    const sourceObject = coreRef("evidence_source", sourceId);
    const versionObject = coreRef("evidence_version", versionId);
    const source = sourceRef("@finnor/db", "evidence_sources", sourceId);
    const versionSource = sourceRef("@finnor/db", "evidence_source_versions", versionId, { revisionId: integer(row.versionNumber)?.toString() });
    addNode(createNode({ ref: sourceObject, row, source, rootRefs, temporal: currentTemporal("EvidenceSource metadata is current-only; versions are immutable"), asOf, target: targetFor(sourceObject, { root: world.root, evidenceSourceId: sourceId }) }));
    addNode(createNode({ ref: versionObject, row, source: versionSource, rootRefs, temporal: immutableTemporal(), asOf, target: targetFor(versionObject, { root: world.root, evidenceSourceId: sourceId }) }));
    addEdge("evidence_version", sourceObject, versionObject, versionSource, iso(row.asOf, asOf));
  }
  for (const row of world.observedEvidence) {
    const observationId = text(row.observationId) ?? idOf(row);
    if (!observationId) continue;
    const ref = coreRef("source_observation", observationId);
    const source = sourceRef("@finnor/db", "external_ref_observations", observationId);
    addNode(createNode({ ref, row, source, rootRefs, temporal: immutableTemporal(), asOf, target: targetFor(ref, { root: world.root }) }));
    const versionId = text(row.evidenceVersionId);
    if (versionId) addEdge("source_observation_evidence", ref, coreRef("evidence_version", versionId), source, iso(row.receivedAt, asOf));
    const entityType = text(row.canonicalEntityType);
    const entityId = text(row.canonicalEntityId);
    if (entityType && entityId && PE_TYPE_SET.has(entityType)) addEdge("source_observation_object", ref, peRef(entityType as PeEntityType, entityId), source, iso(row.receivedAt, asOf));
  }
  for (const row of world.sourceCoverage) {
    const id = text(row.coverageHistoryId) ?? text(row.sourceScopeId);
    if (!id) continue;
    const coverageRevision = integer(record(row.coverage).revision);
    const ref = coreRef("source_coverage", id, coverageRevision?.toString());
    const source = sourceRef(
      "@finnor/db",
      text(row.coverageHistoryId) ? "integration_source_coverage_history" : "integration_source_scopes",
      id,
      { revisionId: coverageRevision?.toString() },
    );
    addNode(createNode({ ref, row, source, rootRefs, temporal: currentTemporal("Coverage facts expose an effective interval but no Company Brain history endpoint"), asOf, target: targetFor(ref, { root: world.root }) }));
  }
  for (const row of world.conflicts) {
    const id = idOf(row);
    if (!id) continue;
    const ref = coreRef("source_conflict", id);
    const source = sourceRef("@finnor/db", "external_ref_observations", id);
    addNode(createNode({ ref, row, source, rootRefs, temporal: immutableTemporal(), asOf, state: text(row.conflictState) ?? text(row.materializationStatus), target: targetFor(ref, { root: world.root }) }));
  }
  for (const row of world.decisionReceipts) {
    const id = idOf(row);
    if (!id) continue;
    const workId = text(row.workId);
    const ref = coreRef("decision_receipt", id);
    const source = sourceRef("@finnor/db", "decision_receipts", id);
    addNode(createNode({ ref, row, source, rootRefs, temporal: currentTemporal(), asOf, state: row.finalizedAt ? "finalized" : "open", target: targetFor(ref, { root: world.root, ...(workId ? { workId } : {}) }) }));
  }

  const peNode = (type: PeEntityType, id: unknown) => text(id) ? peRef(type, String(id)) : null;
  for (const row of world.opportunities) {
    const child = peNode("pe_opportunity", row.id); const parent = peNode("pe_strategy", row.strategyId);
    if (child && parent) addEdge("strategy_opportunity", parent, child, sourceRef("@finnor/private-equity", "pe_opportunities", child.id), iso(row.updatedAt, asOf));
  }
  for (const row of world.deals) {
    const child = peNode("pe_deal", row.id); const parent = peNode("pe_opportunity", row.opportunityId);
    if (child && parent) addEdge("opportunity_deal", parent, child, sourceRef("@finnor/private-equity", "pe_deals", child.id), iso(row.updatedAt, asOf));
  }
  const dealChildren = WORLD_COLLECTIONS.filter(([type]) => !["pe_opportunity", "pe_deal", "pe_investment_case", "pe_thesis", "pe_assumption", "pe_decision"].includes(type));
  for (const [type, key] of dealChildren) for (const row of rows(world[key])) {
    const child = peNode(type, row.id); const deal = peNode("pe_deal", row.dealId);
    if (child && deal) addEdge("deal_child", deal, child, sourceRef("@finnor/private-equity", PE_TABLES[type], child.id), iso(row.updatedAt ?? row.createdAt, asOf));
  }
  for (const row of world.investmentCases) {
    const child = peNode("pe_investment_case", row.id); const deal = peNode("pe_deal", row.dealId);
    if (child && deal) addEdge("deal_investment_case", deal, child, sourceRef("@finnor/private-equity", "pe_investment_cases", child.id), iso(row.updatedAt, asOf));
  }
  for (const [kind, type, collection, table] of [
    ["investment_case_thesis", "pe_thesis", world.theses, "pe_theses"],
    ["investment_case_assumption", "pe_assumption", world.assumptions, "pe_assumptions"],
    ["investment_case_decision", "pe_decision", world.decisions, "pe_decisions"],
  ] as const) for (const row of collection) {
    const child = peNode(type, row.id); const investment = peNode("pe_investment_case", row.investmentCaseId);
    if (child && investment) addEdge(kind, investment, child, sourceRef("@finnor/private-equity", table, child.id), iso(row.updatedAt, asOf));
  }
  for (const row of world.findingRiskLinks) {
    const id = idOf(row); const finding = peNode("pe_finding", row.findingId); const risk = peNode("pe_deal_risk", row.dealRiskId);
    if (id && finding && risk && !row.archivedAt) addEdge("finding_risk", finding, risk, sourceRef("@finnor/private-equity", "pe_finding_risk_links", id), iso(row.createdAt, asOf));
  }
  for (const row of world.dependencies) {
    const id = idOf(row); const blockerType = text(row.blockerType); const blockedType = text(row.blockedType);
    if (!id || row.removedAt || !blockerType || !blockedType || !PE_TYPE_SET.has(blockerType) || !PE_TYPE_SET.has(blockedType)) continue;
    const blocker = peNode(blockerType as PeEntityType, row.blockerId); const blocked = peNode(blockedType as PeEntityType, row.blockedId);
    if (blocker && blocked) addEdge("dependency_blocks", blocker, blocked, sourceRef("@finnor/private-equity", "pe_dependencies", id), iso(row.createdAt, asOf));
  }
  for (const row of world.documentLinks) {
    const id = idOf(row); const entityType = text(row.entityType); const entityId = text(row.entityId); const documentId = text(row.documentId);
    if (!id || row.archivedAt || !entityType || !entityId || !documentId || !PE_TYPE_SET.has(entityType)) continue;
    addEdge("document_link", peRef(entityType as PeEntityType, entityId), coreRef("document", documentId), sourceRef("@finnor/private-equity", "pe_document_links", id), iso(row.createdAt, asOf));
  }
  for (const row of world.evidenceLinks) {
    const id = idOf(row); const entityType = text(row.entityType); const entityId = text(row.entityId); const evidenceSourceId = text(row.evidenceSourceId); const evidenceVersionId = text(row.evidenceVersionId);
    if (!id || row.archivedAt || !entityType || !entityId || !evidenceSourceId || !PE_TYPE_SET.has(entityType)) continue;
    const evidenceRef = evidenceVersionId ? coreRef("evidence_version", evidenceVersionId) : coreRef("evidence_source", evidenceSourceId);
    addEdge("evidence_link", peRef(entityType as PeEntityType, entityId), evidenceRef, sourceRef("@finnor/private-equity", "pe_evidence_links", id), iso(row.createdAt, asOf));
  }

  for (const entry of bundle.underwriting) {
    const investmentRef = peRef("pe_investment_case", entry.investmentCaseId);
    const workspace = record(entry.workspace);
    for (const row of rows(workspace.models)) {
      const id = idOf(row); if (!id) continue;
      const ref = underwritingRef("underwriting_model", id); const source = sourceRef("@finnor/private-equity", "underwriting_models", id);
      addNode(createNode({ ref, row, source, rootRefs, temporal: currentTemporal(), asOf, target: targetFor(ref, { root: world.root, investmentCaseId: entry.investmentCaseId }) }));
      addEdge("underwriting_model", investmentRef, ref, source, iso(row.createdAt, asOf));
    }
    for (const row of rows(workspace.modelVersions)) {
      const id = idOf(row); const modelId = text(row.modelId); if (!id || !modelId) continue;
      const ref = underwritingRef("underwriting_model_version", id); const source = sourceRef("@finnor/private-equity", "underwriting_model_versions", id);
      addNode(createNode({ ref, row, source, rootRefs, temporal: immutableTemporal(), asOf, target: targetFor(ref, { root: world.root, investmentCaseId: entry.investmentCaseId }) }));
      addEdge("underwriting_model_version", underwritingRef("underwriting_model", modelId), ref, source, iso(row.createdAt, asOf));
    }
    for (const row of rows(workspace.scenarios)) {
      const id = idOf(row); if (!id) continue;
      const ref = underwritingRef("underwriting_scenario", id); const source = sourceRef("@finnor/private-equity", "underwriting_scenarios", id);
      addNode(createNode({ ref, row, source, rootRefs, temporal: immutableTemporal(), asOf, target: targetFor(ref, { root: world.root, investmentCaseId: entry.investmentCaseId }) }));
      addEdge("underwriting_scenario", investmentRef, ref, source, iso(row.createdAt, asOf));
    }
    for (const row of rows(workspace.runs)) {
      const id = idOf(row); const modelVersionId = text(row.modelVersionId); if (!id || !modelVersionId) continue;
      const ref = underwritingRef("underwriting_run", id); const source = sourceRef("@finnor/private-equity", "underwriting_runs", id);
      addNode(createNode({ ref, row, source, rootRefs, temporal: immutableTemporal(), asOf, target: targetFor(ref, { root: world.root, investmentCaseId: entry.investmentCaseId }) }));
      addEdge("underwriting_run", underwritingRef("underwriting_model_version", modelVersionId), ref, source, iso(row.computedAt ?? row.createdAt, asOf));
    }
    for (const row of rows(workspace.sensitivities)) {
      const id = idOf(row); if (!id) continue;
      const ref = underwritingRef("underwriting_sensitivity", id); const source = sourceRef("@finnor/private-equity", "underwriting_sensitivities", id);
      addNode(createNode({ ref, row, source, rootRefs, temporal: immutableTemporal(), asOf, target: targetFor(ref, { root: world.root, investmentCaseId: entry.investmentCaseId }) }));
      const modelVersionId = text(row.modelVersionId);
      addEdge("underwriting_sensitivity", modelVersionId ? underwritingRef("underwriting_model_version", modelVersionId) : investmentRef, ref, source, iso(row.createdAt, asOf));
    }
  }

  const addIcChild = (caseRef: CompanyBrainObjectRef, caseId: string, type: PeEntityType, table: string, row: Record<string, unknown>) => {
    const id = idOf(row); if (!id) return;
    const ref = peRef(type, id); const source = sourceRef("@finnor/private-equity", table, id, { revisionId: integer(row.version)?.toString() });
    addNode(createNode({ ref, row, source, rootRefs, temporal: peTemporal, asOf, warnings: warningFor(type, id), target: targetFor(ref, { root: world.root, icCaseId: caseId }) }));
    addEdge("ic_case_child", caseRef, ref, source, iso(row.createdAt ?? row.recordedAt, asOf));
    for (const link of rows(row.sources)) {
      const linkId = idOf(link); if (!linkId) continue;
      let target: CompanyBrainObjectRef | null = null;
      const sourceKind = text(link.sourceKind);
      if (sourceKind === "EVIDENCE_VERSION" && text(link.evidenceVersionId)) target = coreRef("evidence_version", String(link.evidenceVersionId));
      else if (sourceKind === "ARTIFACT_ANCHOR" && text(link.documentVersionId)) target = coreRef("document_version", String(link.documentVersionId));
      else if (sourceKind === "UNDERWRITING_RUN" && text(link.underwritingRunId)) target = underwritingRef("underwriting_run", String(link.underwritingRunId));
      else if (sourceKind === "P1_WORLD" && text(link.worldEntityType) && text(link.worldEntityId) && PE_TYPE_SET.has(String(link.worldEntityType))) target = peRef(String(link.worldEntityType) as PeEntityType, String(link.worldEntityId));
      else if (sourceKind === "IC_QUESTION" && text(link.questionId)) target = peRef("pe_ic_question", String(link.questionId));
      else if (sourceKind === "PE_RISK" && text(link.peRiskId)) target = peRef("pe_deal_risk", String(link.peRiskId));
      else if (sourceKind === "IC_CONDITION" && text(link.conditionId)) target = peRef("pe_ic_condition", String(link.conditionId));
      if (target) addEdge("ic_source_link", ref, target, sourceRef("@finnor/private-equity", "pe_ic_source_links", linkId), iso(link.createdAt, asOf));
    }
  };

  for (const workspace of bundle.ic) {
    const process = record(workspace.case); const caseId = idOf(process); const investmentCaseId = text(process.investmentCaseId);
    if (!caseId || !investmentCaseId) continue;
    const caseRef = peRef("pe_ic_case", caseId); const source = sourceRef("@finnor/private-equity", "pe_ic_cases", caseId, { revisionId: integer(process.version)?.toString() });
    addNode(createNode({ ref: caseRef, row: process, source, rootRefs, temporal: peTemporal, asOf, warnings: warningFor("pe_ic_case", caseId), target: targetFor(caseRef, { root: world.root, icCaseId: caseId }) }));
    addEdge("ic_case_investment_case", caseRef, peRef("pe_investment_case", investmentCaseId), source, iso(process.updatedAt ?? process.createdAt, asOf));
    if (workspace.memo) addIcChild(caseRef, caseId, "pe_ic_memo", "pe_ic_memos", workspace.memo);
    if (workspace.deck && workspace.deck.id !== workspace.memo?.id) addIcChild(caseRef, caseId, "pe_ic_memo", "pe_ic_memos", workspace.deck);
    for (const row of workspace.questions) addIcChild(caseRef, caseId, "pe_ic_question", "pe_ic_questions", row);
    for (const row of workspace.recommendations) addIcChild(caseRef, caseId, "pe_ic_recommendation", "pe_ic_recommendations", row);
    for (const row of workspace.votes) addIcChild(caseRef, caseId, "pe_ic_vote", "pe_ic_votes", row);
    for (const row of workspace.dissents) addIcChild(caseRef, caseId, "pe_ic_dissent", "pe_ic_dissents", row);
    for (const row of workspace.conditions) addIcChild(caseRef, caseId, "pe_ic_condition", "pe_ic_conditions", row);
    if (workspace.decisionProposal) addIcChild(caseRef, caseId, "pe_ic_decision_proposal", "pe_ic_decision_proposals", workspace.decisionProposal);
    const proof = record(workspace.decisionProof);
    const proofId = idOf(proof); const decisionId = text(proof.decisionId) ?? text(process.finalDecisionId);
    if (proofId && decisionId) addEdge("ic_final_decision", caseRef, peRef("pe_decision", decisionId), sourceRef("@finnor/private-equity", "pe_ic_decision_links", proofId), iso(proof.finalizedAt, asOf));
    for (const artifact of [workspace.artifacts.memo, workspace.artifacts.deck]) {
      const artifactRow = record(artifact); const documentId = text(artifactRow.documentId); const documentVersionId = text(artifactRow.documentVersionId);
      if (!documentId || !documentVersionId) continue;
      const documentObject = coreRef("document", documentId); const versionObject = coreRef("document_version", documentVersionId);
      const documentSource = sourceRef("@finnor/db", "documents", documentId);
      const versionSource = sourceRef("@finnor/db", "document_versions", documentVersionId);
      addNode(createNode({ ref: documentObject, row: artifactRow, source: documentSource, rootRefs, temporal: currentTemporal(), asOf, target: targetFor(documentObject, { root: world.root, documentId }) }));
      addNode(createNode({ ref: versionObject, row: artifactRow, source: versionSource, rootRefs, temporal: immutableTemporal(), asOf, target: targetFor(versionObject, { root: world.root, documentId }) }));
      addEdge("document_version", documentObject, versionObject, versionSource, iso(artifactRow.createdAt, asOf));
    }
  }

  const workRootRefs = new Map<string, PeWorldRootRef[]>();
  for (const link of world.workLinks) {
    const workId = text(link.workId); if (workId) workRootRefs.set(workId, rootRefs);
  }
  for (const aggregate of bundle.works) {
    const work = record(aggregate.work); const workId = idOf(work); if (!workId) continue;
    const scopedRoots = workRootRefs.get(workId) ?? rootRefs;
    const workRef = coreRef("work", workId); const source = sourceRef("@finnor/db", "works", workId);
    addNode(createNode({ ref: workRef, row: work, source, rootRefs: scopedRoots, temporal: currentTemporal(), asOf, target: targetFor(workRef, { root: world.root, workId }) }));
    for (const plan of rows(aggregate.planRevisions)) {
      const planId = idOf(plan); if (!planId) continue;
      const planRef = planningRef("plan_revision", planId); const planSource = sourceRef("@finnor/db", "work_plan_revisions", planId, { revisionId: integer(plan.revision)?.toString() });
      addNode(createNode({ ref: planRef, row: plan, source: planSource, rootRefs: scopedRoots, temporal: immutableTemporal(), asOf, target: targetFor(planRef, { root: world.root, workId }) }));
      addEdge("work_plan_revision", workRef, planRef, planSource, iso(plan.selectedAt, asOf));
      const goalHash = text(plan.goalHash);
      if (goalHash) {
        const goalRef = planningRef("goal", goalHash, planId); const goalSource = sourceRef("@finnor/db", "work_plan_revisions", planId, { fieldPath: "goal_spec" });
        const goalRow: Record<string, unknown> = { ...record(plan.goalSpec), semanticHash: goalHash };
        addNode(createNode({ ref: goalRef, row: goalRow, source: goalSource, rootRefs: scopedRoots, temporal: immutableTemporal(), asOf, label: text(goalRow["objective"]) ?? `Goal ${goalHash.slice(0, 8)}`, target: targetFor(goalRef, { root: world.root, workId, planRevisionId: planId }) }));
        addEdge("plan_revision_goal", planRef, goalRef, goalSource, iso(plan.selectedAt, asOf));
      }
      const graph = record(plan.planGraph);
      for (const [index, nodeRow] of rows(graph.nodes).entries()) {
        const nodeId = idOf(nodeRow); if (!nodeId) continue;
        const nodeRef = planningRef("plan_node", nodeId, planId); const nodeSource = sourceRef("@finnor/db", "work_plan_revisions", planId, { fieldPath: `plan_graph.nodes[${index}]` });
        addNode(createNode({ ref: nodeRef, row: nodeRow, source: nodeSource, rootRefs: scopedRoots, temporal: immutableTemporal(), asOf, target: targetFor(nodeRef, { root: world.root, workId, planRevisionId: planId, planNodeId: nodeId }) }));
        addEdge("plan_revision_node", planRef, nodeRef, nodeSource, iso(plan.selectedAt, asOf));
      }
      for (const [index, edgeRow] of rows(graph.edges).entries()) {
        const from = text(edgeRow.from); const to = text(edgeRow.to); if (!from || !to) continue;
        addEdge("plan_dependency", planningRef("plan_node", from, planId), planningRef("plan_node", to, planId), sourceRef("@finnor/db", "work_plan_revisions", planId, { fieldPath: `plan_graph.edges[${index}]` }), iso(plan.selectedAt, asOf));
      }
      if (plan.completionProof && Object.keys(record(plan.completionProof)).length) {
        const proofRef = planningRef("completion_proof", planId); const proofSource = sourceRef("@finnor/db", "work_plan_revisions", planId, { fieldPath: "completion_proof" });
        addNode(createNode({ ref: proofRef, row: record(plan.completionProof), source: proofSource, rootRefs: scopedRoots, temporal: immutableTemporal(), asOf, state: record(plan.completionProof).verified === true ? "verified" : "unverified", target: targetFor(proofRef, { root: world.root, workId, planRevisionId: planId }) }));
        addEdge("plan_completion_proof", planRef, proofRef, proofSource, iso(plan.completedAt, asOf));
      }
    }
    for (const action of rows(aggregate.actions)) {
      const id = idOf(action); if (!id) continue;
      const ref = coreRef("domain_action", id); const actionSource = sourceRef("@finnor/db", "domain_actions", id);
      addNode(createNode({ ref, row: action, source: actionSource, rootRefs: scopedRoots, temporal: currentTemporal(), asOf, target: targetFor(ref, { root: world.root, workId }) }));
    }
    for (const effect of rows(aggregate.businessEffects)) {
      const id = idOf(effect); const actionId = text(effect.domainActionId); if (!id) continue;
      const ref = coreRef("business_effect", id); const effectSource = sourceRef("@finnor/db", "business_effects", id);
      addNode(createNode({ ref, row: effect, source: effectSource, rootRefs: scopedRoots, temporal: currentTemporal(), asOf, target: targetFor(ref, { root: world.root, workId }) }));
      if (actionId) addEdge("action_effect", coreRef("domain_action", actionId), ref, effectSource, iso(effect.createdAt, asOf));
    }
    for (const receipt of rows(aggregate.receipts)) {
      const id = idOf(receipt); const effectId = text(receipt.businessEffectId); if (!id) continue;
      const ref = coreRef("decision_receipt", id); const receiptSource = sourceRef("@finnor/db", "decision_receipts", id);
      addNode(createNode({ ref, row: receipt, source: receiptSource, rootRefs: scopedRoots, temporal: currentTemporal(), asOf, state: receipt.finalizedAt ? "finalized" : "open", target: targetFor(ref, { root: world.root, workId }) }));
      if (effectId) addEdge("effect_receipt", coreRef("business_effect", effectId), ref, receiptSource, iso(receipt.createdAt, asOf));
    }
  }
  for (const link of world.workLinks) {
    const id = idOf(link); const entityType = text(link.entityType); const entityId = text(link.entityId); const workId = text(link.workId);
    if (!id || !entityType || !entityId || !workId || !PE_TYPE_SET.has(entityType)) continue;
    const entityRef = peRef(entityType as PeEntityType, entityId); const workRef = coreRef("work", workId); const linkSource = sourceRef("@finnor/db", "work_entity_links", id);
    addEdge("work_entity_link", entityRef, workRef, linkSource, iso(link.createdAt, asOf));
    const entityNode = findNode(entityRef);
    if (entityNode && !entityNode.workRefs.some((item) => item.workId === workId)) entityNode.workRefs.push({ workId, sourceRef: linkSource });
  }
  for (const link of world.decisionEffectLinks) {
    const id = idOf(link); const decisionId = text(link.decisionId); const effectType = text(link.effectType); const effectId = text(link.effectId);
    if (!id || !decisionId || !effectType || !effectId) continue;
    const effectRef = effectType === "work" ? coreRef("work", effectId) : effectType === "domain_action" ? coreRef("domain_action", effectId) : effectType === "decision_receipt" ? coreRef("decision_receipt", effectId) : null;
    if (effectRef) addEdge("decision_effect", peRef("pe_decision", decisionId), effectRef, sourceRef("@finnor/private-equity", "pe_decision_effect_links", id), iso(link.createdAt, asOf));
  }

  if (bundle.workforce) {
    const linkedWorkIds = new Set(workRootRefs.keys());
    const relevantAssignments = bundle.workforce.assignments.filter((assignment) => linkedWorkIds.has(assignment.workId));
    const relevantAgentIds = new Set(relevantAssignments.map((assignment) => assignment.agentProfileId));
    for (const worker of bundle.workforce.workers.filter((candidate) => relevantAgentIds.has(candidate.id))) {
      const profileRef = workforceRef("agent_profile", worker.id); const profileSource = sourceRef("@finnor/db", "agent_profiles", worker.id);
      addNode(createNode({ ref: profileRef, row: record(worker), source: profileSource, rootRefs, temporal: currentTemporal(), asOf, target: targetFor(profileRef, { root: world.root }) }));
      if (worker.activeRevision) {
        const revisionRef = workforceRef("agent_revision", worker.activeRevision.id); const revisionSource = sourceRef("@finnor/db", "agent_profile_revisions", worker.activeRevision.id, { revisionId: String(worker.activeRevision.revision) });
        addNode(createNode({ ref: revisionRef, row: record(worker.activeRevision), source: revisionSource, rootRefs, temporal: immutableTemporal(), asOf, target: { kind: "agent", agentProfileId: worker.id, agentRevisionId: worker.activeRevision.id } }));
        addEdge("agent_revision", profileRef, revisionRef, revisionSource, worker.activeRevision.createdAt);
      }
    }
    for (const assignment of relevantAssignments) {
      const ref = workforceRef("agent_assignment", assignment.id); const assignmentSource = sourceRef("@finnor/db", "workforce_assignments", assignment.id);
      addNode(createNode({ ref, row: record(assignment), source: assignmentSource, rootRefs: workRootRefs.get(assignment.workId)!, temporal: currentTemporal(), asOf, target: targetFor(ref, { root: world.root, workId: assignment.workId }) }));
      addEdge("assignment_agent", ref, workforceRef("agent_profile", assignment.agentProfileId), assignmentSource, assignment.createdAt);
      addEdge("assignment_work", ref, coreRef("work", assignment.workId), assignmentSource, assignment.createdAt);
      addEdge("assignment_plan_node", ref, planningRef("plan_node", assignment.planNodeId, assignment.planRevisionId), assignmentSource, assignment.createdAt);
      const previousAssignmentId = text(assignment.previousAssignmentId);
      if (previousAssignmentId) addEdge("reassignment_previous", ref, workforceRef("agent_assignment", previousAssignmentId), assignmentSource, assignment.createdAt);
    }
    for (const revision of bundle.workforce.learningRevisions.filter((candidate) => relevantAgentIds.has(candidate.targetAgentProfileId))) {
      const ref = workforceRef("learning_revision", revision.id); const revisionSource = sourceRef("@finnor/db", "learning_revisions", revision.id, { revisionId: String(revision.revision) });
      addNode(createNode({ ref, row: record(revision), source: revisionSource, rootRefs, temporal: immutableTemporal(), asOf, target: { kind: "agent", agentProfileId: revision.targetAgentProfileId } }));
      addEdge("learning_revision_agent", ref, workforceRef("agent_profile", revision.targetAgentProfileId), revisionSource, revision.createdAt);
    }
  }

  if (bundle.attention) for (const item of bundle.attention.items) {
    const exactRoot = item.rootRefs.some((ref) => (
      (ref.entityType === "pe_strategy" || ref.entityType === "pe_opportunity" || ref.entityType === "pe_deal")
      && Boolean(findNode(peRef(ref.entityType, ref.entityId)))
    ));
    const linkedWork = workRootRefs.has(item.workId);
    if (!exactRoot && !linkedWork) continue;
    const persistedSource = attentionPersistedSource(item);
    if (!persistedSource) continue;
    const ref = coreRef("attention", persistedSource.id, item.id);
    addNode(createNode({
      ref,
      row: record(item),
      source: persistedSource,
      rootRefs: rootRefsFromAttention(item, world.root),
      temporal: currentTemporal("Attention is an authenticated current read projection over canonical sources"),
      asOf,
      label: item.reason,
      state: "needs_attention",
      target: targetFor(ref, { root: world.root, workId: item.workId, attentionId: item.id }),
    }));
  }

  const sortedNodes = [...nodes.values()].sort((left, right) => companyBrainRefKey(left.ref).localeCompare(companyBrainRefKey(right.ref)));
  const sortedEdges = [...edges.values()].sort((left, right) => `${left.relationship}:${companyBrainRefKey(left.fromRef)}:${companyBrainRefKey(left.toRef)}:${left.sourceRef.id}`.localeCompare(`${right.relationship}:${companyBrainRefKey(right.fromRef)}:${companyBrainRefKey(right.toRef)}:${right.sourceRef.id}`));
  const maxNodes = Math.min(DEFAULT_MAX_NODES, Math.max(1, Math.floor(options.maxNodes ?? DEFAULT_MAX_NODES)));
  const maxEdges = Math.min(DEFAULT_MAX_EDGES, Math.max(1, Math.floor(options.maxEdges ?? DEFAULT_MAX_EDGES)));
  const boundedNodes = sortedNodes.slice(0, maxNodes);
  const included = new Set(boundedNodes.map((node) => companyBrainRefKey(node.ref)));
  const eligibleEdges = sortedEdges.filter((edge) => included.has(companyBrainRefKey(edge.fromRef)) && included.has(companyBrainRefKey(edge.toRef)));
  const boundedEdges = eligibleEdges.slice(0, maxEdges);
  return {
    root: world.root,
    asOf,
    nodes: boundedNodes,
    edges: boundedEdges,
    temporal: peTemporal,
    sourceStatus: sourceStatusFor(bundle),
    bounds: {
      nodes: boundedNodes.length,
      edges: boundedEdges.length,
      truncated: sortedNodes.length > maxNodes || eligibleEdges.length > maxEdges,
      maxNodes,
      maxEdges,
    },
  };
}

async function settledMany<T>(
  owner: string,
  inputs: Array<Promise<T>>,
  statuses: NonNullable<CompanyBrainSourceBundle["sourceStatus"]>,
): Promise<T[]> {
  const results = await Promise.allSettled(inputs);
  const values = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const failures = results.length - values.length;
  statuses.push({ owner, status: failures ? "partial" : "complete", ...(failures ? { reason: `${failures} bounded source reads were unavailable` } : {}) });
  return values;
}

export async function loadCompanyBrainSourceBundle(
  ctx: PeMutationContext,
  input: { root: PeWorldRootRef; asOf?: string },
): Promise<CompanyBrainSourceBundle> {
  const world = await loadPrivateEquityWorldState(ctx, input.root, input.asOf);
  const statuses: NonNullable<CompanyBrainSourceBundle["sourceStatus"]> = [{ owner: "P1 Private Equity world", status: world.temporalCompleteness.status === "complete" ? "complete" : "partial", ...(world.temporalCompleteness.reasons.length ? { reason: world.temporalCompleteness.reasons.join("; ") } : {}) }];
  const investmentCaseIds = [...new Set(world.investmentCases.map((row) => text(row.id)).filter((id): id is string => Boolean(id)))].slice(0, 50);
  const historical = input.asOf !== undefined;
  let underwriting: CompanyBrainSourceBundle["underwriting"] = [];
  let works: WorkAggregate[] = [];
  let workforce: WorkforceStatusResult | null = null;
  let attention: AttentionQueueResult | null = null;

  if (historical) {
    statuses.push(
      { owner: "P4 underwriting", status: "unsupported", reason: "Current workspace owner has no asOf list contract" },
      { owner: "P6 Work", status: "unsupported", reason: "Work aggregate owner has no historical payload contract" },
      { owner: "P7 workforce", status: "unsupported", reason: "Workforce status is a current projection" },
      { owner: "Attention", status: "unsupported", reason: "Attention is a current projection" },
    );
  } else {
    const underwritingRows = await settledMany("P4 underwriting", investmentCaseIds.map(async (investmentCaseId) => ({ investmentCaseId, workspace: await listUnderwritingWorkspace(ctx, investmentCaseId) })), statuses);
    underwriting = underwritingRows;
    const workIds = [...new Set(world.workLinks.map((row) => text(row.workId)).filter((id): id is string => Boolean(id)))].slice(0, 100);
    works = (await settledMany("P6 Work", workIds.map((workId) => workAggregate(ctx.auth.tenantId, workId)), statuses)).filter((value): value is WorkAggregate => value !== null);
    const [workforceResult, attentionResult] = await Promise.allSettled([
      workforceStatus(ctx.auth.tenantId, { page: { limit: 100 } }),
      executeAttentionQueueQuery(ctx.auth.tenantId, { intent: "attention_queue", page: { limit: 100 } }, { employeeId: ctx.auth.employeeId, userId: ctx.auth.userId, verticalKey: "private_equity", maxRows: 100 }, new Date(world.stateAt)),
    ]);
    workforce = workforceResult.status === "fulfilled" ? workforceResult.value : null;
    attention = attentionResult.status === "fulfilled" ? attentionResult.value : null;
    statuses.push({ owner: "P7 workforce", status: workforce ? (workforce.status === "partial" ? "partial" : "complete") : "partial", ...(!workforce ? { reason: "Workforce source unavailable" } : {}) });
    statuses.push({ owner: "Attention", status: attention ? (attention.status === "partial" || attention.status === "unavailable" ? "partial" : "complete") : "partial", ...(!attention ? { reason: "Attention source unavailable" } : {}) });
  }

  let ic: CompanyBrainSourceBundle["ic"] = [];
  try {
    const listed = await listIcCases(ctx, { limit: 100 });
    const relevant = listed.cases.filter((row) => investmentCaseIds.includes(String(row.investmentCaseId))).slice(0, 50);
    ic = await settledMany("P5 IC", relevant.map((row) => getIcWorkspace(ctx, { icCaseId: String(row.id), ...(input.asOf ? { asOf: input.asOf } : {}) })), statuses);
  } catch (error) {
    statuses.push({ owner: "P5 IC", status: "partial", reason: error instanceof Error ? error.message : "IC source unavailable" });
  }
  return { world, underwriting, ic, works, workforce, attention, sourceStatus: statuses };
}

export async function loadCompanyBrainProjection(
  ctx: PeMutationContext,
  input: { root: PeWorldRootRef; asOf?: string; maxNodes?: number; maxEdges?: number },
): Promise<CompanyBrainProjection> {
  const bundle = await loadCompanyBrainSourceBundle(ctx, input);
  return projectCompanyBrain(bundle, { maxNodes: input.maxNodes, maxEdges: input.maxEdges });
}

export async function listCompanyBrainRoots(
  ctx: PeMutationContext,
  input: { query?: string; limit?: number } = {},
): Promise<CompanyBrainSearchResult[]> {
  const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.floor(input.limit ?? 50)));
  const query = input.query?.trim() ?? "";
  return peTransaction(ctx, async (_db, client) => {
    const result = await client.query<SqlRow>(
      `SELECT * FROM (
         SELECT 'pe_strategy'::text entity_type,id::text,name label,state,updated_at FROM finnor_os.pe_strategies WHERE tenant_id=$1
         UNION ALL
         SELECT 'pe_opportunity'::text entity_type,id::text,name label,state,updated_at FROM finnor_os.pe_opportunities WHERE tenant_id=$1
         UNION ALL
         SELECT 'pe_deal'::text entity_type,id::text,name label,status state,updated_at FROM finnor_os.pe_deals WHERE tenant_id=$1
       ) roots
       WHERE ($2='' OR roots.id ILIKE '%'||$2||'%' OR roots.label ILIKE '%'||$2||'%')
       ORDER BY roots.updated_at DESC,roots.entity_type,roots.id LIMIT $3`,
      [ctx.auth.tenantId, query, limit],
    );
    return result.rows.map((raw) => {
      const row = shapePeRow(raw);
      const root = { entityType: String(row.entityType) as PeWorldRootRef["entityType"], entityId: String(row.id) };
      const ref = peRef(root.entityType, root.entityId);
      return { ref, label: String(row.label), state: text(row.state), rootRefs: [root], inspectionTarget: { kind: "pe_context", root, objectRef: ref } };
    });
  }, { readOnly: true });
}

export function searchCompanyBrainProjection(
  projection: CompanyBrainProjection,
  query: string,
  limit = 50,
): CompanyBrainSearchResult[] {
  const normalized = query.trim().toLocaleLowerCase();
  const bounded = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.floor(limit)));
  return projection.nodes
    .filter((node) => !normalized || node.ref.id.toLocaleLowerCase().includes(normalized) || node.label.toLocaleLowerCase().includes(normalized) || node.type.toLocaleLowerCase().includes(normalized))
    .sort((left, right) => {
      const leftExact = left.ref.id.toLocaleLowerCase() === normalized || left.label.toLocaleLowerCase() === normalized ? 0 : 1;
      const rightExact = right.ref.id.toLocaleLowerCase() === normalized || right.label.toLocaleLowerCase() === normalized ? 0 : 1;
      return leftExact - rightExact || left.label.localeCompare(right.label) || companyBrainRefKey(left.ref).localeCompare(companyBrainRefKey(right.ref));
    })
    .slice(0, bounded)
    .map((node) => ({ ref: node.ref, label: node.label, state: node.state, rootRefs: node.rootRefs, inspectionTarget: node.inspectionTarget }));
}

export function companyBrainObject(projection: CompanyBrainProjection, ref: CompanyBrainObjectRef): CompanyBrainNode | null {
  return projection.nodes.find((node) => companyBrainRefKey(node.ref) === companyBrainRefKey(ref)) ?? null;
}

export function resolvePeOperatingContext(
  projection: CompanyBrainProjection | null,
  input: PeOperatingContext,
): PeOperatingContext {
  if (!input.root) {
    if (projection || input.selectedObject || input.workId) throw new PeDomainError("PE_BRAIN_INVALID_CONTEXT", "A selected object or Work requires a canonical PE root");
    return { root: null, selectedObject: null, workId: null };
  }
  if (!projection || projection.root.entityType !== input.root.entityType || projection.root.entityId !== input.root.entityId) {
    throw new PeDomainError("PE_BRAIN_INVALID_CONTEXT", "Operating context root does not match its authenticated projection");
  }
  if (input.selectedObject && !companyBrainObject(projection, input.selectedObject)) {
    throw new PeDomainError("PE_ENTITY_NOT_FOUND", "Selected object is not related to the authenticated PE root");
  }
  if (input.workId && !companyBrainObject(projection, { namespace: "core", owner: "@finnor/db", type: "work", id: input.workId })) {
    throw new PeDomainError("PE_ENTITY_NOT_FOUND", "Work is not linked to the authenticated PE root");
  }
  return { root: input.root, selectedObject: input.selectedObject, workId: input.workId };
}

export function traverseCompanyBrain(
  projection: CompanyBrainProjection,
  ref: CompanyBrainObjectRef,
  input: { depth?: number; limit?: number; direction?: "outbound" | "inbound" | "both" } = {},
): CompanyBrainTraverseResult {
  const depth = Math.min(MAX_TRAVERSE_DEPTH, Math.max(0, Math.floor(input.depth ?? 1)));
  const limit = Math.min(MAX_TRAVERSE_ROWS, Math.max(1, Math.floor(input.limit ?? 100)));
  const direction = input.direction ?? "both";
  const root = companyBrainObject(projection, ref);
  if (!root) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "Company Brain object was not found in the authenticated root projection");
  const visited = new Set([companyBrainRefKey(ref)]);
  let frontier = [ref];
  const selectedEdges = new Map<string, CompanyBrainEdge>();
  for (let level = 0; level < depth && frontier.length; level += 1) {
    const frontierKeys = new Set(frontier.map(companyBrainRefKey));
    const next: CompanyBrainObjectRef[] = [];
    for (const edge of projection.edges) {
      const from = companyBrainRefKey(edge.fromRef); const to = companyBrainRefKey(edge.toRef);
      const followsOut = direction !== "inbound" && frontierKeys.has(from);
      const followsIn = direction !== "outbound" && frontierKeys.has(to);
      if (!followsOut && !followsIn) continue;
      selectedEdges.set(`${edge.relationship}:${from}:${to}:${edge.sourceRef.id}`, edge);
      const candidate = followsOut ? edge.toRef : edge.fromRef;
      const key = companyBrainRefKey(candidate);
      if (!visited.has(key)) { visited.add(key); next.push(candidate); }
    }
    frontier = next;
  }
  const allNodes = projection.nodes.filter((node) => visited.has(companyBrainRefKey(node.ref)));
  const total = allNodes.length;
  const boundedNodes = allNodes.slice(0, limit);
  const included = new Set(boundedNodes.map((node) => companyBrainRefKey(node.ref)));
  const boundedEdges = [...selectedEdges.values()].filter((edge) => included.has(companyBrainRefKey(edge.fromRef)) && included.has(companyBrainRefKey(edge.toRef))).slice(0, limit);
  return { rootRef: ref, depth, nodes: boundedNodes, edges: boundedEdges, page: { limit, returned: boundedNodes.length, total, truncated: total > limit } };
}

export function companyBrainProvenance(projection: CompanyBrainProjection, ref: CompanyBrainObjectRef): { node: CompanyBrainNode; sourceRefs: CompanyBrainSourceRef[]; evidenceNodes: CompanyBrainNode[]; edges: CompanyBrainEdge[] } {
  const node = companyBrainObject(projection, ref);
  if (!node) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "Company Brain object was not found in the authenticated root projection");
  const touching = projection.edges.filter((edge) => companyBrainRefKey(edge.fromRef) === companyBrainRefKey(ref) || companyBrainRefKey(edge.toRef) === companyBrainRefKey(ref));
  const evidenceKeys = new Set(touching.filter((edge) => ["evidence_link", "document_link", "ic_source_link", "source_observation_evidence"].includes(edge.relationship)).flatMap((edge) => [companyBrainRefKey(edge.fromRef), companyBrainRefKey(edge.toRef)]));
  return { node, sourceRefs: [...new Map([...node.provenanceRefs, ...node.facts.flatMap((fact) => fact.sourceRefs), ...touching.map((edge) => edge.sourceRef)].map((source) => [`${source.owner}:${source.table}:${source.id}:${source.fieldPath ?? ""}`, source])).values()], evidenceNodes: projection.nodes.filter((candidate) => evidenceKeys.has(companyBrainRefKey(candidate.ref))), edges: touching };
}

function lineage(
  projection: CompanyBrainProjection,
  ref: CompanyBrainObjectRef,
  allowed: Set<CompanyBrainEdge["relationship"]>,
): CompanyBrainTraverseResult {
  const scoped = { ...projection, edges: projection.edges.filter((edge) => allowed.has(edge.relationship)) };
  return traverseCompanyBrain(scoped, ref, { depth: 4, limit: 250, direction: "both" });
}

export function companyBrainEvidenceLineage(projection: CompanyBrainProjection, ref: CompanyBrainObjectRef): CompanyBrainTraverseResult {
  return lineage(projection, ref, new Set(["document_link", "document_version", "evidence_link", "evidence_version", "source_observation_evidence", "source_observation_object", "investment_case_assumption", "investment_case_thesis", "underwriting_model", "underwriting_model_version", "underwriting_run", "ic_source_link", "ic_final_decision", "decision_effect", "action_effect", "effect_receipt", "plan_completion_proof"]));
}

export function companyBrainDecisionLineage(projection: CompanyBrainProjection, ref: CompanyBrainObjectRef): CompanyBrainTraverseResult {
  return lineage(projection, ref, new Set(["evidence_link", "ic_source_link", "investment_case_assumption", "investment_case_decision", "underwriting_run", "ic_case_investment_case", "ic_case_child", "ic_final_decision", "decision_effect", "work_entity_link", "work_plan_revision", "plan_revision_node", "action_effect", "effect_receipt", "plan_completion_proof"]));
}

export async function companyBrainHistory(
  ctx: PeMutationContext,
  input: { root: PeWorldRootRef; ref: CompanyBrainObjectRef; limit?: number },
): Promise<{ support: CompanyBrainTemporalTruth["support"]; entries: CompanyBrainHistoryEntry[] }> {
  const projection = await loadCompanyBrainProjection(ctx, { root: input.root });
  const node = companyBrainObject(projection, input.ref);
  if (!node) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "Company Brain history object was not found in the authenticated root projection");
  if (input.ref.namespace !== "private_equity") return { support: node.temporal.support, entries: [] };
  const limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 50)));
  return peTransaction(ctx, async (_db, client) => {
    const result = await client.query<{
      id: string; entity_version: number; recorded_at: Date; observed_at: Date | null; snapshot_hash: string; previous_version_id: string | null;
    }>(
      `SELECT id::text,entity_version,recorded_at,observed_at,snapshot_hash,previous_version_id::text
         FROM finnor_os.canonical_entity_versions
        WHERE tenant_id=$1 AND entity_type=$2 AND entity_id=$3
        ORDER BY recorded_at DESC,entity_version DESC LIMIT $4`,
      [ctx.auth.tenantId, input.ref.type, input.ref.id, limit],
    );
    return {
      support: "canonical_history" as const,
      entries: result.rows.map((row) => ({
        ref: input.ref,
        version: row.entity_version,
        recordedAt: row.recorded_at.toISOString(),
        observedAt: row.observed_at?.toISOString() ?? null,
        snapshotHash: row.snapshot_hash,
        previousVersionId: row.previous_version_id,
        sourceRef: sourceRef("@finnor/private-equity", "canonical_entity_versions", row.id, { revisionId: String(row.entity_version) }),
      })),
    };
  }, { readOnly: true });
}

export async function searchCompanyBrain(
  ctx: PeMutationContext,
  input: { query: string; root?: PeWorldRootRef; limit?: number },
): Promise<CompanyBrainSearchResult[]> {
  if (input.root) return searchCompanyBrainProjection(await loadCompanyBrainProjection(ctx, { root: input.root }), input.query, input.limit);
  const roots = await listCompanyBrainRoots(ctx, { query: input.query, limit: Math.min(input.limit ?? 50, MAX_SEARCH_ROOTS) });
  if (input.query.trim() || roots.length === 0) return roots.slice(0, input.limit ?? 50);
  return roots.slice(0, input.limit ?? 50);
}
