import type { AttentionCausalRef, AttentionEvidenceRef, AttentionItem } from "@finnor/shared-types";
import { companyBrainRefKey, loadCompanyBrainSourceBundle, projectCompanyBrain } from "./company-brain";
import type {
  CompanyBrainInspectionTarget,
  CompanyBrainNode,
  CompanyBrainObjectRef,
  CompanyBrainProjection,
  CompanyBrainSourceBundle,
  CompanyBrainSourceRef,
} from "./company-brain-types";
import { PE_ENTITY_TYPES, type PeEntityType, type PeMutationContext, type PeWorldRootRef } from "./types";

export const SEMANTIC_ACTIVITY_BUCKETS = ["needs_attention", "in_motion", "verified_outcomes"] as const;
export type SemanticActivityBucket = (typeof SEMANTIC_ACTIVITY_BUCKETS)[number];

export const SEMANTIC_ACTIVITY_KINDS = [
  "strategy_transition", "opportunity_transition", "deal_transition", "investment_case_transition",
  "thesis_change", "assumption_change", "finding_change", "risk_change", "request_transition",
  "deliverable_transition", "dependency_change", "milestone_transition", "closing_condition_transition",
  "closing_item_transition", "final_decision", "source_observation_received", "evidence_version_recorded",
  "source_freshness_changed", "mapping_conflict", "document_created", "document_version_created",
  "document_linked", "underwriting_model_created", "underwriting_model_version_created",
  "underwriting_scenario_evaluated", "underwriting_run_completed", "underwriting_run_failed",
  "underwriting_sensitivity_evaluated", "ic_case_transition", "ic_memo_version_selected",
  "ic_question_change", "ic_recommendation_recorded", "ic_vote_recorded", "ic_dissent_recorded",
  "ic_condition_change", "ic_decision_proposal_transition", "ic_final_decision_linked", "work_transition",
  "goal_changed", "plan_revision_created", "replan", "plan_node_transition", "action_state",
  "business_effect_state", "receipt_finalized", "completion_proof_verified", "recovery_or_reconciliation",
  "attention_raised", "agent_revision_activated", "assignment_state", "learning_proposal", "learning_review",
  "learning_revision_promoted",
] as const;
export type SemanticActivityKind = (typeof SEMANTIC_ACTIVITY_KINDS)[number];

export interface SemanticActivityActorRef {
  kind: "human" | "agent" | "system" | "provider";
  id: string;
}

export interface SemanticActivityReference {
  type: string;
  id: string;
  hash?: string;
}

export interface SemanticActivityCausalRef extends SemanticActivityReference {
  relationship: string;
  sourceRef: CompanyBrainSourceRef;
  targetRef?: CompanyBrainObjectRef;
}

export interface SemanticActivityItem {
  id: string;
  occurredAt: string;
  kind: SemanticActivityKind;
  bucket: SemanticActivityBucket;
  rootRefs: PeWorldRootRef[];
  subjectRef: CompanyBrainObjectRef;
  actor: "human" | "agent" | "system" | "provider";
  actorRef?: SemanticActivityActorRef;
  workId?: string;
  planRevisionId?: string;
  planNodeId?: string;
  change: { type: string; before?: unknown; after?: unknown; label: string };
  reasonCode: string | null;
  causalRefs: SemanticActivityCausalRef[];
  evidenceRefs: SemanticActivityReference[];
  receiptRefs: CompanyBrainObjectRef[];
  proofRefs: CompanyBrainObjectRef[];
  blocks: SemanticActivityReference[];
  unblocks: SemanticActivityReference[];
  inspectionTarget: CompanyBrainInspectionTarget;
  sourceRefs: CompanyBrainSourceRef[];
  asOf: string;
}

export interface SemanticActivityProjection {
  schemaVersion: "pe-semantic-activity.v1";
  root: PeWorldRootRef;
  asOf: string;
  items: SemanticActivityItem[];
  groups: Array<{
    bucket: SemanticActivityBucket;
    roots: Array<{
      root: PeWorldRootRef;
      threads: Array<{ id: string; latestOccurredAt: string; itemIds: string[] }>;
    }>;
  }>;
  sourceStatus: CompanyBrainProjection["sourceStatus"];
  bounds: { returned: number; total: number; limit: number; truncated: boolean };
}

const PE_TYPE_SET = new Set<string>(PE_ENTITY_TYPES);
const MAX_ITEMS = 1_000;

const PE_EVENT_KINDS: Partial<Record<PeEntityType, SemanticActivityKind>> = {
  pe_strategy: "strategy_transition",
  pe_opportunity: "opportunity_transition",
  pe_deal: "deal_transition",
  pe_investment_case: "investment_case_transition",
  pe_thesis: "thesis_change",
  pe_assumption: "assumption_change",
  pe_finding: "finding_change",
  pe_deal_risk: "risk_change",
  pe_request: "request_transition",
  pe_deliverable: "deliverable_transition",
  pe_dependency: "dependency_change",
  pe_milestone: "milestone_transition",
  pe_closing_condition: "closing_condition_transition",
  pe_closing_item: "closing_item_transition",
};

const IC_EVENT_KINDS: Readonly<Record<string, SemanticActivityKind>> = {
  ic_case_opened: "ic_case_transition",
  ic_case_preparing: "ic_case_transition",
  ic_case_ready_for_review: "ic_case_transition",
  ic_case_ready_for_vote: "ic_case_transition",
  ic_case_voting: "ic_case_transition",
  ic_case_decision_proposed: "ic_case_transition",
  ic_case_decided: "ic_case_transition",
  ic_case_withdrawn: "ic_case_transition",
  ic_memo_version_selected: "ic_memo_version_selected",
  ic_question_opened: "ic_question_change",
  ic_question_answered: "ic_question_change",
  ic_question_resolved: "ic_question_change",
  ic_question_waived: "ic_question_change",
  ic_question_superseded: "ic_question_change",
  ic_recommendation_created: "ic_recommendation_recorded",
  ic_vote_recorded: "ic_vote_recorded",
  ic_dissent_recorded: "ic_dissent_recorded",
  ic_condition_created: "ic_condition_change",
  ic_condition_active: "ic_condition_change",
  ic_condition_satisfied: "ic_condition_change",
  ic_condition_waived: "ic_condition_change",
  ic_condition_failed: "ic_condition_change",
  ic_condition_superseded: "ic_condition_change",
  ic_decision_proposal_prepared: "ic_decision_proposal_transition",
  ic_decision_finalized: "ic_final_decision_linked",
};

const SPECIAL_PE_EVENTS: Readonly<Record<string, SemanticActivityKind>> = {
  pe_decision_final: "final_decision",
  pe_document_linked: "document_linked",
};

const ATTENTION_SOURCE_TABLES: Readonly<Record<string, [CompanyBrainSourceRef["owner"], string]>> = {
  work: ["@finnor/db", "works"],
  authority_approval_request: ["@finnor/db", "authority_approval_requests"],
  domain_action: ["@finnor/db", "domain_actions"],
  work_objective_loop: ["@finnor/db", "work_objective_loops"],
  work_objective_step: ["@finnor/db", "work_objective_steps"],
  work_event_wait: ["@finnor/db", "work_event_waits"],
  business_effect: ["@finnor/db", "business_effects"],
  workforce_assignment: ["@finnor/db", "workforce_assignments"],
  learning_proposal: ["@finnor/db", "learning_proposals"],
  pe_ic_question: ["@finnor/private-equity", "pe_ic_questions"],
  pe_ic_case: ["@finnor/private-equity", "pe_ic_cases"],
  pe_ic_condition: ["@finnor/private-equity", "pe_ic_conditions"],
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function iso(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.valueOf())) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return null;
}

function humanize(value: string): string {
  return value.replace(/^pe_/, "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function peRef(type: PeEntityType, id: string): CompanyBrainObjectRef {
  return { namespace: "private_equity", owner: "@finnor/private-equity", type, id };
}

function coreRef(type: Extract<CompanyBrainObjectRef, { namespace: "core" }>["type"], id: string, revisionId?: string): CompanyBrainObjectRef {
  return { namespace: "core", owner: type === "attention" ? "@finnor/read-models" : "@finnor/db", type, id, ...(revisionId ? { revisionId } : {}) };
}

function underwritingRef(type: Extract<CompanyBrainObjectRef, { namespace: "underwriting" }>["type"], id: string): CompanyBrainObjectRef {
  return { namespace: "underwriting", owner: "@finnor/private-equity", type, id };
}

function planningRef(type: Extract<CompanyBrainObjectRef, { namespace: "planning" }>["type"], id: string, revisionId?: string): CompanyBrainObjectRef {
  return { namespace: "planning", owner: "@finnor/db", type, id, ...(revisionId ? { revisionId } : {}) };
}

function workforceRef(type: Extract<CompanyBrainObjectRef, { namespace: "workforce" }>["type"], id: string): CompanyBrainObjectRef {
  return { namespace: "workforce", owner: "@finnor/db", type, id };
}

function sourceRef(owner: CompanyBrainSourceRef["owner"], table: string, id: string, fieldPath?: string): CompanyBrainSourceRef {
  return { owner, table, id, ...(fieldPath ? { fieldPath } : {}) };
}

function activityRef(type: string, id: unknown, hash?: unknown): SemanticActivityReference | null {
  const exactId = text(id);
  if (!exactId) return null;
  const exactHash = text(hash);
  return { type, id: exactId, ...(exactHash ? { hash: exactHash } : {}) };
}

function uniqueReferences(values: Array<SemanticActivityReference | null>): SemanticActivityReference[] {
  return [...new Map(values.filter((value): value is SemanticActivityReference => value !== null).map((value) => [`${value.type}:${value.id}`, value])).values()];
}

function actorFrom(value: unknown, source?: unknown): Pick<SemanticActivityItem, "actor" | "actorRef"> {
  const exact = text(value);
  const sourceName = text(source)?.toLowerCase() ?? "";
  if (sourceName.includes("microsoft") || sourceName.includes("provider")) {
    return { actor: "provider", actorRef: { kind: "provider", id: exact ?? sourceName } };
  }
  if (exact?.startsWith("agent:")) return { actor: "agent", actorRef: { kind: "agent", id: exact.slice(6) } };
  if (exact) return { actor: "human", actorRef: { kind: "human", id: exact } };
  return { actor: "system" };
}

function causal(
  relationship: string,
  type: string,
  id: unknown,
  source: CompanyBrainSourceRef,
  targetRef?: CompanyBrainObjectRef,
): SemanticActivityCausalRef | null {
  const exactId = text(id);
  return exactId ? { relationship, type, id: exactId, sourceRef: source, ...(targetRef ? { targetRef } : {}) } : null;
}

function uniqueCausal(values: Array<SemanticActivityCausalRef | null>): SemanticActivityCausalRef[] {
  return [...new Map(values.filter((value): value is SemanticActivityCausalRef => value !== null).map((value) => [
    `${value.relationship}:${value.type}:${value.id}:${value.sourceRef.table}:${value.sourceRef.id}:${value.sourceRef.fieldPath ?? ""}`,
    value,
  ])).values()];
}

function transitionBucket(entityType: string, eventType: string, after: unknown): SemanticActivityBucket {
  const state = (text(after) ?? eventType.split("_").at(-1) ?? "").toLowerCase();
  if (entityType === "pe_decision" && state === "final") return "verified_outcomes";
  if (entityType === "pe_finding" && ["created", "opened", "open"].includes(state)) return "needs_attention";
  if (entityType === "pe_deal_risk" && !["resolved", "accepted"].includes(state)) return "needs_attention";
  if (entityType === "pe_dependency" && state !== "removed") return "needs_attention";
  if (entityType === "pe_closing_condition" && ["created", "open", "evidence_pending", "failed"].includes(state)) return "needs_attention";
  if (entityType === "pe_closing_item" && ["created", "open"].includes(state)) return "needs_attention";
  if (["failed", "rejected", "invalidated", "terminated"].includes(state)) return "needs_attention";
  if (["final", "resolved", "accepted", "fulfilled", "achieved", "satisfied", "verified", "waived", "closed", "removed"].includes(state)) return "verified_outcomes";
  return "in_motion";
}

function actionBucket(status: string, verified: boolean): SemanticActivityBucket {
  if (["failed", "rejected", "needs_human_review", "blocked_integration_unavailable"].includes(status)) return "needs_attention";
  if (status === "completed") return verified ? "verified_outcomes" : "needs_attention";
  return "in_motion";
}

function effectBucket(status: string): SemanticActivityBucket {
  if (status === "verified") return "verified_outcomes";
  if (["partially_verified", "unverified", "divergent", "reconciliation_required", "failed"].includes(status)) return "needs_attention";
  return "in_motion";
}

function workBucket(status: string, verified: boolean): SemanticActivityBucket {
  if (["blocked", "failed", "recovery", "awaiting_approval"].includes(status)) return "needs_attention";
  if (status === "completed") return verified ? "verified_outcomes" : "needs_attention";
  return "in_motion";
}

function attentionSource(item: AttentionItem): CompanyBrainSourceRef | null {
  for (const evidence of item.evidenceRefs) {
    const table = ATTENTION_SOURCE_TABLES[evidence.type];
    if (table) return sourceRef(table[0], table[1], evidence.id);
  }
  return null;
}

function attentionReference(value: AttentionCausalRef | AttentionEvidenceRef): SemanticActivityReference {
  if ("kind" in value) return { type: value.kind, id: value.id };
  return { type: value.type, id: value.id, ...(value.hash ? { hash: value.hash } : {}) };
}

interface EventInput {
  source: CompanyBrainSourceRef;
  occurredAt: unknown;
  kind: SemanticActivityKind;
  bucket: SemanticActivityBucket;
  subjectRef: CompanyBrainObjectRef;
  change: SemanticActivityItem["change"];
  actor?: Pick<SemanticActivityItem, "actor" | "actorRef">;
  reasonCode?: unknown;
  causalRefs?: SemanticActivityCausalRef[];
  evidenceRefs?: SemanticActivityReference[];
  receiptRefs?: CompanyBrainObjectRef[];
  proofRefs?: CompanyBrainObjectRef[];
  blocks?: SemanticActivityReference[];
  unblocks?: SemanticActivityReference[];
  workId?: string | null;
  planRevisionId?: string | null;
  planNodeId?: string | null;
  inspectionTarget?: CompanyBrainInspectionTarget;
}

export function groupSemanticActivity(items: readonly SemanticActivityItem[]): SemanticActivityProjection["groups"] {
  return SEMANTIC_ACTIVITY_BUCKETS.map((bucket) => {
    const roots = new Map<string, { root: PeWorldRootRef; items: SemanticActivityItem[] }>();
    for (const item of items.filter((candidate) => candidate.bucket === bucket)) {
      const root = item.rootRefs[0];
      if (!root) continue;
      const key = `${root.entityType}:${root.entityId}`;
      const group = roots.get(key) ?? { root, items: [] };
      group.items.push(item);
      roots.set(key, group);
    }
    return {
      bucket,
      roots: [...roots.values()].map(({ root, items: rootItems }) => {
        const threads = new Map<string, SemanticActivityItem[]>();
        for (const item of rootItems) {
          const cause = item.causalRefs[0];
          const id = item.workId ? `work:${item.workId}` : cause ? `cause:${cause.type}:${cause.id}` : `subject:${companyBrainRefKey(item.subjectRef)}`;
          const values = threads.get(id) ?? [];
          values.push(item);
          threads.set(id, values);
        }
        return {
          root,
          threads: [...threads.entries()].map(([id, values]) => {
            const chronological = [...values].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
            return { id, latestOccurredAt: chronological.at(-1)!.occurredAt, itemIds: chronological.map((item) => item.id) };
          }).sort((left, right) => right.latestOccurredAt.localeCompare(left.latestOccurredAt) || left.id.localeCompare(right.id)),
        };
      }).sort((left, right) => (right.threads[0]?.latestOccurredAt ?? "").localeCompare(left.threads[0]?.latestOccurredAt ?? "") || `${left.root.entityType}:${left.root.entityId}`.localeCompare(`${right.root.entityType}:${right.root.entityId}`)),
    };
  });
}

/**
 * Pure deterministic P1-P7 semantic projection. It intentionally accepts the same
 * authenticated source bundle as Company Brain and refuses to emit an item unless
 * the subject already has an exact, renderable Brain inspection target.
 */
export function projectSemanticActivity(bundle: CompanyBrainSourceBundle, options: { limit?: number } = {}): SemanticActivityProjection {
  const brain = projectCompanyBrain(bundle);
  const nodeIndex = new Map(brain.nodes.map((node) => [companyBrainRefKey(node.ref), node]));
  const events = new Map<string, SemanticActivityItem>();
  const add = (input: EventInput): void => {
    const occurredAt = iso(input.occurredAt);
    const subject: CompanyBrainNode | undefined = nodeIndex.get(companyBrainRefKey(input.subjectRef));
    if (!occurredAt || !subject || !input.source.id.trim()) return;
    const id = `semantic:${input.source.table}:${input.source.id}:${input.kind}${input.source.fieldPath ? `:${input.source.fieldPath}` : ""}`;
    events.set(id, {
      id,
      occurredAt,
      kind: input.kind,
      bucket: input.bucket,
      rootRefs: subject.rootRefs,
      subjectRef: subject.ref,
      ...(input.actor ?? { actor: "system" as const }),
      ...(input.workId ? { workId: input.workId } : {}),
      ...(input.planRevisionId ? { planRevisionId: input.planRevisionId } : {}),
      ...(input.planNodeId ? { planNodeId: input.planNodeId } : {}),
      change: input.change,
      reasonCode: text(input.reasonCode),
      causalRefs: input.causalRefs ?? [],
      evidenceRefs: input.evidenceRefs ?? [],
      receiptRefs: input.receiptRefs ?? [],
      proofRefs: input.proofRefs ?? [],
      blocks: input.blocks ?? [],
      unblocks: input.unblocks ?? [],
      inspectionTarget: input.inspectionTarget ?? subject.inspectionTarget,
      sourceRefs: [input.source],
      asOf: brain.asOf,
    });
  };

  // P1 and P5 transitions: only trigger-defined canonical BusinessEvent names.
  for (const raw of bundle.world.businessEvents) {
    const row = record(raw);
    const id = text(row.id);
    const eventType = text(row.eventType);
    const entityType = text(row.entityType);
    const entityId = text(row.entityId);
    if (!id || !eventType || !entityType || !entityId || !PE_TYPE_SET.has(entityType)) continue;
    const peType = entityType as PeEntityType;
    const prefixValid = eventType.startsWith(`${peType}_`);
    const kind = IC_EVENT_KINDS[eventType] ?? SPECIAL_PE_EVENTS[eventType] ?? (prefixValid ? PE_EVENT_KINDS[peType] : undefined);
    if (!kind) continue;
    const payload = record(row.payload);
    const source = sourceRef("@finnor/db", "business_events", id);
    const after = payload.to ?? payload.state ?? eventType.split("_").at(-1);
    const receiptId = text(payload.decisionReceiptId);
    const underwritingRunId = text(payload.underwritingRunId);
    add({
      source,
      occurredAt: row.occurredAt,
      kind,
      bucket: kind === "final_decision" || kind === "ic_final_decision_linked"
        ? "verified_outcomes"
        : kind === "ic_question_change" && !["resolved", "waived", "superseded"].includes(String(after).toLowerCase())
          ? "needs_attention"
          : kind === "ic_condition_change" && !["satisfied", "waived", "superseded"].includes(String(after).toLowerCase())
            ? "needs_attention"
            : transitionBucket(entityType, eventType, after),
      subjectRef: peRef(peType, entityId),
      actor: actorFrom(payload.actor, row.source),
      change: {
        type: eventType,
        ...(payload.from !== undefined && payload.from !== null ? { before: payload.from } : {}),
        ...(after !== undefined && after !== null ? { after } : {}),
        label: humanize(eventType),
      },
      reasonCode: payload.reason,
      causalRefs: uniqueCausal([
        causal("decision_receipt", "decision_receipt", receiptId, { ...source, fieldPath: "payload.decisionReceiptId" }, receiptId ? coreRef("decision_receipt", receiptId) : undefined),
        causal("underwriting_run", "underwriting_run", underwritingRunId, { ...source, fieldPath: "payload.underwritingRunId" }, underwritingRunId ? underwritingRef("underwriting_run", underwritingRunId) : undefined),
        causal("supersedes", peType, payload.supersedesId, { ...source, fieldPath: "payload.supersedesId" }, text(payload.supersedesId) ? peRef(peType, String(payload.supersedesId)) : undefined),
      ]),
      evidenceRefs: Array.isArray(payload.evidence) ? uniqueReferences(payload.evidence.map((entry) => {
        const value = record(entry);
        return activityRef(text(value.type) ?? "evidence", value.versionId ?? value.id);
      })) : [],
      receiptRefs: receiptId ? [coreRef("decision_receipt", receiptId)] : [],
    });
  }

  // Evidence, provider observations, persisted freshness, conflicts, and documents.
  for (const raw of bundle.world.observedEvidence) {
    const row = record(raw); const id = text(row.observationId); if (!id) continue;
    const source = sourceRef("@finnor/db", "external_ref_observations", id);
    const versionId = text(row.evidenceVersionId);
    const canonicalType = text(row.canonicalEntityType); const canonicalId = text(row.canonicalEntityId);
    add({
      source, occurredAt: row.recordedAt ?? row.retrievedAt, kind: "source_observation_received",
      bucket: ["conflict", "ambiguous", "unresolved", "out_of_order"].includes(String(row.materializationStatus)) ? "needs_attention" : "in_motion",
      subjectRef: coreRef("source_observation", id), actor: actorFrom(row.provider, row.provider),
      change: { type: "source_observation_received", after: row.materializationStatus, label: "Source observation received" },
      reasonCode: row.reason,
      causalRefs: uniqueCausal([
        causal("observed_evidence_version", "evidence_version", versionId, { ...source, fieldPath: "evidence_version_id" }, versionId ? coreRef("evidence_version", versionId) : undefined),
        causal("mapped_to_canonical_object", canonicalType ?? "canonical_object", canonicalId, { ...source, fieldPath: "canonical_entity_id" }, canonicalType && canonicalId && PE_TYPE_SET.has(canonicalType) ? peRef(canonicalType as PeEntityType, canonicalId) : undefined),
      ]),
      evidenceRefs: uniqueReferences([activityRef("evidence_version", versionId)]),
    });
  }
  for (const raw of bundle.world.evidence) {
    const row = record(raw); const versionId = text(row.versionId); const evidenceSourceId = text(row.sourceId);
    if (!versionId || !evidenceSourceId) continue;
    const source = sourceRef("@finnor/db", "evidence_source_versions", versionId);
    add({
      source, occurredAt: row.retrievedAt ?? row.asOf, kind: "evidence_version_recorded", bucket: "in_motion",
      subjectRef: coreRef("evidence_version", versionId),
      change: { type: "evidence_version_recorded", after: row.versionNumber, label: "Evidence version recorded" },
      causalRefs: uniqueCausal([causal("version_of", "evidence_source", evidenceSourceId, { ...source, fieldPath: "source_id" }, coreRef("evidence_source", evidenceSourceId))]),
      evidenceRefs: uniqueReferences([activityRef("evidence_version", versionId, row.contentHash)]),
    });
  }
  for (const raw of bundle.world.sourceCoverage) {
    const row = record(raw); const id = text(row.coverageHistoryId); if (!id) continue;
    const coverage = record(row.coverage); const freshness = record(row.freshness);
    const state = text(freshness.state) ?? text(coverage.state) ?? "UNKNOWN";
    const source = sourceRef("@finnor/db", "integration_source_coverage_history", id);
    add({
      source, occurredAt: coverage.recordedAt, kind: "source_freshness_changed",
      bucket: ["FRESH", "COMPLETE"].includes(state.toUpperCase()) ? "in_motion" : "needs_attention",
      subjectRef: coreRef("source_coverage", id), actor: actorFrom(undefined, row.provider),
      change: { type: "source_freshness_changed", after: state, label: `Source freshness ${humanize(state)}` },
      reasonCode: coverage.reason ?? freshness.reason,
    });
  }
  for (const raw of bundle.world.conflicts) {
    const row = record(raw); const id = text(row.id); if (!id) continue;
    const source = sourceRef("@finnor/db", "external_ref_observations", id);
    add({
      source, occurredAt: row.receivedAt ?? row.observedAt, kind: "mapping_conflict", bucket: "needs_attention",
      subjectRef: coreRef("source_conflict", id), actor: actorFrom(row.provider, row.provider),
      change: { type: "mapping_conflict", after: row.conflictState ?? row.materializationStatus, label: "Canonical mapping conflict" },
      reasonCode: row.reason, evidenceRefs: uniqueReferences([activityRef("source_observation", id)]),
    });
  }
  for (const raw of bundle.world.documents) {
    const row = record(raw); const id = text(row.id); if (!id) continue;
    add({
      source: sourceRef("@finnor/db", "documents", id), occurredAt: row.createdAt, kind: "document_created", bucket: "in_motion",
      subjectRef: coreRef("document", id), actor: actorFrom(undefined, row.sourceSystem),
      change: { type: "document_created", after: row.kind, label: "Document created" },
    });
  }

  // P4 is immutable calculation truth; there is no synthetic run-start event.
  for (const entry of bundle.underwriting) {
    const workspace = record(entry.workspace);
    for (const row of rows(workspace.models)) {
      const id = text(row.id); if (!id) continue;
      add({ source: sourceRef("@finnor/private-equity", "underwriting_models", id), occurredAt: row.createdAt, kind: "underwriting_model_created", bucket: "in_motion", subjectRef: underwritingRef("underwriting_model", id), actor: actorFrom(row.createdBy), change: { type: "underwriting_model_created", after: row.modelKey, label: "Underwriting model created" } });
    }
    for (const row of rows(workspace.modelVersions)) {
      const id = text(row.id); if (!id) continue;
      const source = sourceRef("@finnor/private-equity", "underwriting_model_versions", id);
      add({
        source, occurredAt: row.createdAt, kind: "underwriting_model_version_created", bucket: "in_motion",
        subjectRef: underwritingRef("underwriting_model_version", id), actor: actorFrom(row.createdBy),
        change: { type: "underwriting_model_version_created", after: row.versionKey, label: "Underwriting model version created" },
        causalRefs: uniqueCausal([
          causal("version_of", "underwriting_model", row.modelId, { ...source, fieldPath: "model_id" }, text(row.modelId) ? underwritingRef("underwriting_model", String(row.modelId)) : undefined),
          causal("supersedes", "underwriting_model_version", row.parentVersionId, { ...source, fieldPath: "parent_version_id" }, text(row.parentVersionId) ? underwritingRef("underwriting_model_version", String(row.parentVersionId)) : undefined),
        ]),
      });
    }
    for (const row of rows(workspace.scenarios)) {
      const id = text(row.id); if (!id) continue;
      const source = sourceRef("@finnor/private-equity", "underwriting_scenarios", id);
      add({
        source, occurredAt: row.createdAt, kind: "underwriting_scenario_evaluated", bucket: "in_motion",
        subjectRef: underwritingRef("underwriting_scenario", id), actor: actorFrom(row.createdBy),
        change: { type: "underwriting_scenario_recorded", after: row.semanticHash, label: "Underwriting scenario recorded" },
        causalRefs: uniqueCausal([
          causal("evaluates_model_version", "underwriting_model_version", row.modelVersionId, { ...source, fieldPath: "model_version_id" }, text(row.modelVersionId) ? underwritingRef("underwriting_model_version", String(row.modelVersionId)) : undefined),
          causal("derived_from_scenario", "underwriting_scenario", row.parentScenarioId, { ...source, fieldPath: "parent_scenario_id" }, text(row.parentScenarioId) ? underwritingRef("underwriting_scenario", String(row.parentScenarioId)) : undefined),
        ]),
      });
    }
    for (const row of rows(workspace.runs)) {
      const id = text(row.id); if (!id) continue;
      const status = text(row.status) ?? "UNKNOWN"; const valid = status === "SUCCEEDED" && row.validity === "VALID";
      const source = sourceRef("@finnor/private-equity", "underwriting_runs", id);
      add({
        source, occurredAt: row.computedAt, kind: valid ? "underwriting_run_completed" : "underwriting_run_failed",
        bucket: valid ? "verified_outcomes" : "needs_attention", subjectRef: underwritingRef("underwriting_run", id),
        actor: actorFrom(row.createdBy), workId: text(row.workId),
        change: { type: valid ? "underwriting_run_completed" : "underwriting_run_failed", after: { status, validity: row.validity, resultHash: row.resultHash }, label: valid ? "Underwriting run completed" : "Underwriting run requires attention" },
        reasonCode: row.failureCode,
        causalRefs: uniqueCausal([
          causal("executed_model_version", "underwriting_model_version", row.modelVersionId, { ...source, fieldPath: "model_version_id" }, text(row.modelVersionId) ? underwritingRef("underwriting_model_version", String(row.modelVersionId)) : undefined),
          causal("evaluated_scenario", "underwriting_scenario", row.scenarioId, { ...source, fieldPath: "scenario_id" }, text(row.scenarioId) ? underwritingRef("underwriting_scenario", String(row.scenarioId)) : undefined),
          causal("attached_to_work", "work", row.workId, { ...source, fieldPath: "work_id" }, text(row.workId) ? coreRef("work", String(row.workId)) : undefined),
        ]),
      });
    }
    for (const row of rows(workspace.sensitivities)) {
      const id = text(row.id); if (!id) continue;
      const status = text(row.status) ?? "UNKNOWN"; const source = sourceRef("@finnor/private-equity", "underwriting_sensitivities", id);
      add({
        source, occurredAt: row.createdAt, kind: "underwriting_sensitivity_evaluated",
        bucket: status === "SUCCEEDED" ? "verified_outcomes" : "needs_attention",
        subjectRef: underwritingRef("underwriting_sensitivity", id), actor: actorFrom(row.createdBy),
        change: { type: "underwriting_sensitivity_evaluated", after: { status, cellCount: row.cellCount }, label: status === "SUCCEEDED" ? "Underwriting sensitivity evaluated" : "Underwriting sensitivity requires attention" },
        reasonCode: status === "SUCCEEDED" ? null : status,
        causalRefs: uniqueCausal([causal("based_on_run", "underwriting_run", row.baseRunId, { ...source, fieldPath: "base_run_id" }, text(row.baseRunId) ? underwritingRef("underwriting_run", String(row.baseRunId)) : undefined)]),
      });
    }
  }

  // P3 document versions exposed through the P5 artifact contract.
  for (const workspace of bundle.ic) {
    for (const row of [record(workspace.artifacts.memo), record(workspace.artifacts.deck)]) {
      const documentId = text(row.documentId); const versionId = text(row.documentVersionId);
      if (!documentId || !versionId) continue;
      const source = sourceRef("@finnor/db", "document_versions", versionId);
      add({
        source, occurredAt: row.createdAt, kind: "document_version_created", bucket: "in_motion",
        subjectRef: coreRef("document_version", versionId), actor: actorFrom(row.createdBy),
        change: { type: "document_version_created", after: row.versionNumber, label: "Document version created" },
        causalRefs: uniqueCausal([
          causal("version_of", "document", documentId, { ...source, fieldPath: "document_id" }, coreRef("document", documentId)),
          causal("supersedes", "document_version", row.supersedesVersionId, { ...source, fieldPath: "supersedes_version_id" }, text(row.supersedesVersionId) ? coreRef("document_version", String(row.supersedesVersionId)) : undefined),
        ]),
      });
    }
  }

  // P6 Work, immutable plans/goals, semantic actions/effects/receipts/proofs, and recovery.
  for (const aggregate of bundle.works) {
    const work = record(aggregate.work); const workId = text(work.id); if (!workId) continue;
    const receipts = rows(aggregate.receipts); const plans = rows(aggregate.planRevisions); const effects = rows(aggregate.businessEffects);
    const finalizedReceiptIds = new Set(receipts.filter((row) => Boolean(row.finalizedAt)).map((row) => text(row.id)).filter((id): id is string => Boolean(id)));
    const proofPlanIds = new Set(plans.filter((row) => record(row.completionProof).verified === true).map((row) => text(row.id)).filter((id): id is string => Boolean(id)));
    const verifiedEffectIds = new Set(effects.filter((row) => row.status === "verified").map((row) => text(row.id)).filter((id): id is string => Boolean(id)));
    const verifiedWork = finalizedReceiptIds.size > 0 || proofPlanIds.size > 0 || work.finalOutcome !== null && work.finalOutcome !== undefined;
    for (const row of rows(aggregate.events)) {
      const id = text(row.id); if (!id) continue;
      const payload = record(row.payload); const status = text(row.toStatus) ?? "unknown"; const source = sourceRef("@finnor/db", "work_events", id);
      add({
        source, occurredAt: row.createdAt, kind: "work_transition", bucket: workBucket(status, verifiedWork),
        subjectRef: coreRef("work", workId), actor: actorFrom(payload.actorId ?? work.createdBy), workId,
        planRevisionId: text(payload.planRevisionId), planNodeId: text(payload.planNodeId),
        change: { type: text(row.eventType) ?? "work_transition", ...(row.fromStatus ? { before: row.fromStatus } : {}), after: status, label: humanize(text(row.eventType) ?? "work_transition") },
        reasonCode: payload.reasonCode ?? record(payload.failure).code,
        causalRefs: uniqueCausal([
          causal("domain_action", "domain_action", payload.actionId, { ...source, fieldPath: "payload.actionId" }, text(payload.actionId) ? coreRef("domain_action", String(payload.actionId)) : undefined),
          causal("business_effect", "business_effect", payload.businessEffectId, { ...source, fieldPath: "payload.businessEffectId" }, text(payload.businessEffectId) ? coreRef("business_effect", String(payload.businessEffectId)) : undefined),
          causal("plan_revision", "plan_revision", payload.planRevisionId, { ...source, fieldPath: "payload.planRevisionId" }, text(payload.planRevisionId) ? planningRef("plan_revision", String(payload.planRevisionId)) : undefined),
        ]),
        receiptRefs: [...finalizedReceiptIds].map((receiptId) => coreRef("decision_receipt", receiptId)),
        proofRefs: [...proofPlanIds].map((planId) => planningRef("completion_proof", planId)),
      });
    }
    for (const row of plans) {
      const id = text(row.id); if (!id) continue;
      const source = sourceRef("@finnor/db", "work_plan_revisions", id); const isReplan = text(row.reason) !== "initial" || Boolean(row.parentRevisionId);
      add({
        source, occurredAt: row.selectedAt, kind: isReplan ? "replan" : "plan_revision_created",
        bucket: ["blocked", "failed"].includes(String(row.status)) ? "needs_attention" : "in_motion",
        subjectRef: planningRef("plan_revision", id), actor: actorFrom(work.createdBy), workId, planRevisionId: id,
        change: { type: isReplan ? "replan" : "plan_revision_created", after: { revision: row.revision, reason: row.reason, status: row.status }, label: isReplan ? "Work replanned" : "Plan revision created" },
        reasonCode: row.reason,
        causalRefs: uniqueCausal([
          causal("plan_for_work", "work", workId, { ...source, fieldPath: "work_id" }, coreRef("work", workId)),
          causal("supersedes_plan_revision", "plan_revision", row.parentRevisionId, { ...source, fieldPath: "parent_revision_id" }, text(row.parentRevisionId) ? planningRef("plan_revision", String(row.parentRevisionId)) : undefined),
        ]),
      });
      const goalHash = text(row.goalHash);
      if (goalHash) add({
        source: { ...source, fieldPath: "goal_spec" }, occurredAt: row.selectedAt, kind: "goal_changed", bucket: "in_motion",
        subjectRef: planningRef("goal", goalHash, id), actor: actorFrom(work.createdBy), workId, planRevisionId: id,
        change: { type: "goal_revision_selected", after: row.goalSpec, label: "Goal and completion criteria selected" },
        causalRefs: uniqueCausal([causal("defined_by_plan_revision", "plan_revision", id, { ...source, fieldPath: "goal_spec" }, planningRef("plan_revision", id))]),
      });
      if (record(row.completionProof).verified === true) add({
        source: { ...source, fieldPath: "completion_proof" }, occurredAt: row.completedAt, kind: "completion_proof_verified", bucket: "verified_outcomes",
        subjectRef: planningRef("completion_proof", id), workId, planRevisionId: id,
        change: { type: "completion_proof_verified", after: row.completionProof, label: "Completion proof verified" },
        causalRefs: uniqueCausal([causal("proves_plan_revision", "plan_revision", id, { ...source, fieldPath: "completion_proof" }, planningRef("plan_revision", id))]),
        proofRefs: [planningRef("completion_proof", id)],
      });
    }
    for (const row of rows(aggregate.objectiveSteps)) {
      const id = text(row.id); const planRevisionId = text(row.planRevisionId); const planNodeId = text(row.planNodeId);
      if (!id || !planRevisionId || !planNodeId) continue;
      const source = sourceRef("@finnor/db", "work_objective_steps", id); const outcome = text(row.iterationOutcome) ?? text(row.phase) ?? "unknown";
      const verified = Boolean(row.successVerification) && outcome === "completed";
      add({
        source, occurredAt: row.completedAt ?? row.startedAt, kind: "plan_node_transition",
        bucket: verified ? "verified_outcomes" : ["blocked", "failed"].includes(outcome) ? "needs_attention" : "in_motion",
        subjectRef: planningRef("plan_node", planNodeId, planRevisionId), workId, planRevisionId, planNodeId,
        change: { type: "plan_node_transition", after: outcome, label: `Plan node ${humanize(outcome)}` },
        reasonCode: row.decisionReason ?? record(row.failure).code,
        causalRefs: uniqueCausal([
          causal("objective_step_for_work", "work", workId, { ...source, fieldPath: "work_id" }, coreRef("work", workId)),
          causal("executes_plan_revision", "plan_revision", planRevisionId, { ...source, fieldPath: "plan_revision_id" }, planningRef("plan_revision", planRevisionId)),
          causal("domain_action", "domain_action", row.domainActionId, { ...source, fieldPath: "domain_action_id" }, text(row.domainActionId) ? coreRef("domain_action", String(row.domainActionId)) : undefined),
        ]),
      });
    }
    for (const row of rows(aggregate.actions)) {
      const id = text(row.id); if (!id) continue;
      const status = text(row.status) ?? "unknown"; const effectId = text(row.businessEffectId); const source = sourceRef("@finnor/db", "domain_actions", id);
      add({
        source, occurredAt: row.executionStartedAt ?? row.createdAt, kind: "action_state",
        bucket: actionBucket(status, Boolean(effectId && verifiedEffectIds.has(effectId))), subjectRef: coreRef("domain_action", id),
        actor: actorFrom(row.initiatedBy), workId, planRevisionId: text(row.planRevisionId), planNodeId: text(row.planNodeId),
        change: { type: `action_${status}`, after: status, label: `Action ${humanize(status)}` },
        reasonCode: status === "failed" ? record(row.failure).code : null,
        causalRefs: uniqueCausal([
          causal("part_of_work", "work", workId, { ...source, fieldPath: "work_id" }, coreRef("work", workId)),
          causal("materializes_plan_node", "plan_node", row.planNodeId, { ...source, fieldPath: "plan_node_id" }, text(row.planNodeId) && text(row.planRevisionId) ? planningRef("plan_node", String(row.planNodeId), String(row.planRevisionId)) : undefined),
          causal("depends_on_action", "domain_action", Array.isArray(row.dependsOn) ? row.dependsOn[0] : null, { ...source, fieldPath: "depends_on" }, Array.isArray(row.dependsOn) && text(row.dependsOn[0]) ? coreRef("domain_action", String(row.dependsOn[0])) : undefined),
        ]),
      });
    }
    for (const row of effects) {
      const id = text(row.id); if (!id) continue;
      const status = text(row.status) ?? "unknown"; const actionId = text(row.domainActionId); const source = sourceRef("@finnor/db", "business_effects", id);
      add({
        source, occurredAt: row.observedAt ?? row.executionStartedAt ?? row.authorizedAt ?? row.createdAt,
        kind: ["reconciliation_required", "divergent"].includes(status) ? "recovery_or_reconciliation" : "business_effect_state",
        bucket: effectBucket(status), subjectRef: coreRef("business_effect", id), workId,
        change: { type: `business_effect_${status}`, after: status, label: `Business effect ${humanize(status)}` },
        reasonCode: record(row.verification).reasonCode ?? (status === "failed" ? status : null),
        causalRefs: uniqueCausal([
          causal("compiled_from_action", "domain_action", actionId, { ...source, fieldPath: "domain_action_id" }, actionId ? coreRef("domain_action", actionId) : undefined),
          causal("replaces_effect", "business_effect", row.replacementForEffectId, { ...source, fieldPath: "replacement_for_effect_id" }, text(row.replacementForEffectId) ? coreRef("business_effect", String(row.replacementForEffectId)) : undefined),
          causal("compensates_effect", "business_effect", row.compensationForEffectId, { ...source, fieldPath: "compensation_for_effect_id" }, text(row.compensationForEffectId) ? coreRef("business_effect", String(row.compensationForEffectId)) : undefined),
        ]),
        evidenceRefs: uniqueReferences([activityRef("business_effect", id, row.semanticHash)]),
      });
    }
    for (const row of receipts) {
      const id = text(row.id); if (!id || !row.finalizedAt) continue;
      const source = sourceRef("@finnor/db", "decision_receipts", id);
      add({
        source, occurredAt: row.finalizedAt, kind: "receipt_finalized", bucket: "verified_outcomes",
        subjectRef: coreRef("decision_receipt", id), workId,
        change: { type: "decision_receipt_finalized", after: row.failure ? "failed" : "finalized", label: "Decision receipt finalized" },
        reasonCode: record(row.failure).code,
        causalRefs: uniqueCausal([
          causal("records_action", "domain_action", row.domainActionId, { ...source, fieldPath: "domain_action_id" }, text(row.domainActionId) ? coreRef("domain_action", String(row.domainActionId)) : undefined),
          causal("verifies_effect", "business_effect", row.businessEffectId, { ...source, fieldPath: "business_effect_id" }, text(row.businessEffectId) ? coreRef("business_effect", String(row.businessEffectId)) : undefined),
          causal("records_workflow_run", "workflow_run", row.workflowRunId, { ...source, fieldPath: "workflow_run_id" }),
          causal("records_workflow_step", "workflow_step", row.workflowStepId, { ...source, fieldPath: "workflow_step_id" }),
        ]),
        evidenceRefs: Array.isArray(row.evidence) ? uniqueReferences(row.evidence.map((entry) => {
          const value = record(entry);
          return activityRef(text(value.type) ?? text(value.source) ?? "evidence", value.id ?? value.ref, value.hash);
        })) : [],
        receiptRefs: [coreRef("decision_receipt", id)],
      });
    }
    for (const row of rows(aggregate.repairs)) {
      const id = text(row.id); if (!id) continue;
      const source = sourceRef("@finnor/db", "plan_repairs", id);
      add({
        source, occurredAt: row.createdAt, kind: "recovery_or_reconciliation",
        bucket: row.status === "completed" ? "in_motion" : "needs_attention", subjectRef: coreRef("work", workId), workId,
        change: { type: "plan_repair", after: row.status, label: "Plan recovery recorded" }, reasonCode: row.reason ?? row.status,
        causalRefs: uniqueCausal([causal("repairs_action", "domain_action", row.failedDomainActionId, { ...source, fieldPath: "failed_domain_action_id" }, text(row.failedDomainActionId) ? coreRef("domain_action", String(row.failedDomainActionId)) : undefined)]),
      });
    }
  }

  // P7 is filtered to assignments attached to this Brain root's Work set.
  const linkedWorkIds = new Set(bundle.works.map((aggregate) => text(record(aggregate.work).id)).filter((id): id is string => Boolean(id)));
  if (bundle.workforce) {
    const assignments = bundle.workforce.assignments.filter((assignment) => linkedWorkIds.has(assignment.workId));
    const agentIds = new Set(assignments.map((assignment) => assignment.agentProfileId));
    for (const worker of bundle.workforce.workers.filter((candidate) => agentIds.has(candidate.id))) {
      if (!worker.activeRevision) continue;
      const revision = worker.activeRevision; const source = sourceRef("@finnor/db", "agent_profile_revisions", revision.id);
      add({
        source, occurredAt: revision.createdAt, kind: "agent_revision_activated", bucket: "in_motion",
        subjectRef: workforceRef("agent_revision", revision.id), change: { type: "agent_revision_activated", after: revision.revision, label: "Agent revision activated" },
        causalRefs: uniqueCausal([
          causal("revision_of_agent", "agent_profile", worker.id, { ...source, fieldPath: "agent_profile_id" }, workforceRef("agent_profile", worker.id)),
          causal("uses_learning_revision", "learning_revision", revision.learningRevisionId, { ...source, fieldPath: "learning_revision_id" }, revision.learningRevisionId ? workforceRef("learning_revision", revision.learningRevisionId) : undefined),
        ]),
      });
    }
    for (const assignment of assignments) {
      const source = sourceRef("@finnor/db", "workforce_assignments", assignment.id);
      const failed = assignment.state === "failed" || Boolean(assignment.failure);
      const reassigned = assignment.state === "reassigned" || Boolean(assignment.previousAssignmentId);
      const verified = assignment.state === "completed" && !assignment.failure;
      add({
        source, occurredAt: assignment.completedAt ?? assignment.startedAt ?? assignment.updatedAt ?? assignment.createdAt,
        kind: "assignment_state", bucket: failed ? "needs_attention" : verified ? "verified_outcomes" : "in_motion",
        subjectRef: workforceRef("agent_assignment", assignment.id),
        actor: assignment.state === "queued" ? { actor: "system" } : { actor: "agent", actorRef: { kind: "agent", id: assignment.agentProfileId } },
        workId: assignment.workId, planRevisionId: assignment.planRevisionId, planNodeId: assignment.planNodeId,
        change: { type: reassigned ? "assignment_reassigned" : `assignment_${assignment.state}`, after: assignment.state, label: reassigned ? "Agent assignment reassigned" : `Agent assignment ${humanize(assignment.state)}` },
        reasonCode: assignment.reassignmentReason ?? text(record(assignment.failure).code),
        causalRefs: uniqueCausal([
          causal("assigned_to_work", "work", assignment.workId, { ...source, fieldPath: "work_id" }, coreRef("work", assignment.workId)),
          causal("assigned_to_plan_node", "plan_node", assignment.planNodeId, { ...source, fieldPath: "plan_node_id" }, planningRef("plan_node", assignment.planNodeId, assignment.planRevisionId)),
          causal("uses_agent_revision", "agent_revision", assignment.agentRevisionId, { ...source, fieldPath: "agent_revision_id" }, workforceRef("agent_revision", assignment.agentRevisionId)),
          causal("reassigned_from", "workforce_assignment", assignment.previousAssignmentId, { ...source, fieldPath: "previous_assignment_id" }, assignment.previousAssignmentId ? workforceRef("agent_assignment", assignment.previousAssignmentId) : undefined),
          causal("materialized_action", "domain_action", assignment.domainActionId, { ...source, fieldPath: "domain_action_id" }, assignment.domainActionId ? coreRef("domain_action", assignment.domainActionId) : undefined),
        ]),
      });
    }
    for (const proposal of bundle.workforce.proposals) {
      const worker = bundle.workforce.workers.find((candidate) => candidate.activeRevision?.id === proposal.targetAgentRevisionId && agentIds.has(candidate.id));
      if (!worker) continue;
      const source = sourceRef("@finnor/db", "learning_proposals", proposal.id); const reviewed = proposal.status !== "proposed" && Boolean(proposal.reviewedAt);
      add({
        source, occurredAt: proposal.reviewedAt ?? proposal.createdAt, kind: reviewed ? "learning_review" : "learning_proposal",
        bucket: proposal.status === "rejected" ? "needs_attention" : proposal.status === "promoted" ? "verified_outcomes" : "in_motion",
        subjectRef: workforceRef("agent_profile", worker.id), actor: actorFrom(reviewed ? proposal.reviewedBy : undefined),
        change: { type: reviewed ? "learning_proposal_reviewed" : "learning_proposal_created", after: proposal.status, label: reviewed ? "Learning proposal reviewed" : "Learning proposal created" },
        reasonCode: proposal.status === "rejected" ? "REJECTED" : null,
        causalRefs: uniqueCausal([causal("targets_agent_revision", "agent_revision", proposal.targetAgentRevisionId, { ...source, fieldPath: "target_agent_revision_id" }, workforceRef("agent_revision", proposal.targetAgentRevisionId))]),
      });
    }
    for (const revision of bundle.workforce.learningRevisions.filter((candidate) => agentIds.has(candidate.targetAgentProfileId))) {
      const source = sourceRef("@finnor/db", "learning_revisions", revision.id);
      add({
        source, occurredAt: revision.createdAt, kind: "learning_revision_promoted", bucket: "verified_outcomes",
        subjectRef: workforceRef("learning_revision", revision.id), actor: actorFrom(revision.promotedBy),
        change: { type: "learning_revision_promoted", after: revision.revision, label: "Verified learning revision promoted" },
        causalRefs: uniqueCausal([
          causal("promoted_from_proposal", "learning_proposal", revision.sourceProposalId, { ...source, fieldPath: "source_proposal_id" }),
          causal("applies_to_agent", "agent_profile", revision.targetAgentProfileId, { ...source, fieldPath: "target_agent_profile_id" }, workforceRef("agent_profile", revision.targetAgentProfileId)),
        ]),
      });
    }
  }

  // Attention is a current semantic projection, never reconstructed from raw activity.
  if (bundle.attention) for (const item of bundle.attention.items) {
    if (!linkedWorkIds.has(item.workId)) continue;
    const persisted = attentionSource(item); if (!persisted) continue;
    const subject = brain.nodes.find((node) => node.ref.type === "attention" && node.ref.revisionId === item.id);
    if (!subject) continue;
    const source = { ...persisted, fieldPath: `attention:${item.id}` };
    add({
      source, occurredAt: item.createdAt, kind: "attention_raised", bucket: "needs_attention", subjectRef: subject.ref,
      actor: { actor: "human", actorRef: { kind: "human", id: item.assignedOrEligibleActor.employeeId } },
      workId: item.workId, planRevisionId: item.planRevisionId, planNodeId: item.planNodeId,
      change: { type: item.kind, after: "needs_attention", label: item.reason },
      reasonCode: item.recoveryBoundary?.reasonCode ?? item.kind,
      causalRefs: item.blocks.map((value) => ({ ...attentionReference(value), relationship: "blocks", sourceRef: source })),
      evidenceRefs: item.evidenceRefs.map(attentionReference), blocks: item.blocks.map(attentionReference), unblocks: item.unblocks.map(attentionReference),
      inspectionTarget: subject.inspectionTarget,
    });
  }

  const sorted = [...events.values()].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || left.id.localeCompare(right.id));
  const limit = Math.min(MAX_ITEMS, Math.max(1, Math.floor(options.limit ?? 500)));
  const items = sorted.slice(0, limit);
  return {
    schemaVersion: "pe-semantic-activity.v1",
    root: brain.root,
    asOf: brain.asOf,
    items,
    groups: groupSemanticActivity(items),
    sourceStatus: brain.sourceStatus,
    bounds: { returned: items.length, total: sorted.length, limit, truncated: sorted.length > limit },
  };
}

export async function loadSemanticActivity(
  ctx: PeMutationContext,
  input: { root: PeWorldRootRef; asOf?: string; limit?: number },
): Promise<SemanticActivityProjection> {
  const bundle = await loadCompanyBrainSourceBundle(ctx, { root: input.root, asOf: input.asOf });
  return projectSemanticActivity(bundle, { limit: input.limit });
}
