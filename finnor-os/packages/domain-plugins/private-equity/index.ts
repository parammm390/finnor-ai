import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  authorityApprovalRequests,
  authorityDecisions,
  decisionReceipts,
  documents,
  evidenceSources,
  evidenceSourceVersions,
  withTenant,
} from "@finnor/db";
import {
  attachCanonicalEvidence,
  attachWorkToDealGraph,
  buildPrivateEquityEpistemicSnapshot,
  createClosingCondition,
  createDealRisk,
  createDependency,
  createFinding,
  createRequest,
  createWorkstream,
  declareDealClosed,
  evaluateDealCloseEligibility,
  loadDealExecutionGraph,
  loadPrivateEquityAssertions,
  loadPrivateEquityAssertionsForEvidence,
  pePropositionId,
  PeDomainError,
  receiveDeliverable,
  removeDependency,
  resolveDealRisk,
  resolveFinding,
  satisfyClosingCondition,
  verifyClosingItem,
  waiveClosingCondition,
  type DealExecutionGraph,
  type GovernanceProof,
  type PeEntityRef,
  type PeMutationContext,
  type PeMutationResult,
} from "@finnor/private-equity";
import { resolveParty } from "@finnor/read-models";
import type {
  DomainAction,
  DomainPolicy,
  DraftAction,
  ExecutionResult,
  PartyRef,
  ValidationResult,
} from "@finnor/shared-types";
import type { ToolRegistry } from "@finnor/tools";
import {
  ActionGroundingError,
  type DomainActionGrounding,
  type DomainEnginePlugin,
} from "../shared/plugin-interface";
import {
  PRIVATE_EQUITY_ACTION_SCHEMAS,
  PRIVATE_EQUITY_ACTION_TYPES,
  type PrivateEquityActionType,
} from "./schemas";

export * from "./schemas";

type Payload = Record<string, unknown>;
type Row = Record<string, unknown>;

export interface PrivateEquityActionContract {
  actionType: PrivateEquityActionType;
  canonicalMutationOwner: string;
  resultEntityType: PeEntityRef["entityType"];
  idempotencyIdentity: "domain_action_id";
  verification: "canonical_return_and_reread";
  receiptPath: "core_durable_action_receipt";
}

/** Auditable one-to-one map: the plugin translates, while PE2 remains the only
 * owner of business truth and state-machine semantics. */
export const PRIVATE_EQUITY_ACTION_CONTRACTS: readonly PrivateEquityActionContract[] = [
  ["open_workstream", "createWorkstream", "pe_workstream"],
  ["create_deal_request", "createRequest", "pe_request"],
  ["submit_deliverable", "receiveDeliverable", "pe_deliverable"],
  ["record_finding", "createFinding", "pe_finding"],
  ["resolve_finding", "resolveFinding", "pe_finding"],
  ["raise_deal_risk", "createDealRisk", "pe_deal_risk"],
  ["resolve_deal_risk", "resolveDealRisk", "pe_deal_risk"],
  ["link_deal_dependency", "createDependency", "pe_dependency"],
  ["mark_dependency_resolved", "removeDependency", "pe_dependency"],
  ["create_closing_condition", "createClosingCondition", "pe_closing_condition"],
  ["submit_condition_evidence", "attachCanonicalEvidence", "pe_evidence_link"],
  ["satisfy_closing_condition", "satisfyClosingCondition", "pe_closing_condition"],
  ["waive_closing_condition", "waiveClosingCondition", "pe_closing_condition"],
  ["verify_closing_item", "verifyClosingItem", "pe_closing_item"],
  ["declare_deal_closed", "declareDealClosed", "pe_deal"],
].map(([actionType, canonicalMutationOwner, resultEntityType]) => ({
  actionType: actionType as PrivateEquityActionType,
  canonicalMutationOwner: canonicalMutationOwner!,
  resultEntityType: resultEntityType as PeEntityRef["entityType"],
  idempotencyIdentity: "domain_action_id" as const,
  verification: "canonical_return_and_reread" as const,
  receiptPath: "core_durable_action_receipt" as const,
}));

const CONTRACT_BY_ACTION = new Map(PRIVATE_EQUITY_ACTION_CONTRACTS.map((row) => [row.actionType, row]));
const CREATE_ID_FIELD: Partial<Record<PrivateEquityActionType, string>> = {
  open_workstream: "workstreamId",
  create_deal_request: "requestId",
  record_finding: "findingId",
  raise_deal_risk: "dealRiskId",
  link_deal_dependency: "dependencyId",
  create_closing_condition: "closingConditionId",
};

const COLLECTION_BY_TYPE: Partial<Record<PeEntityRef["entityType"], keyof DealExecutionGraph>> = {
  pe_deal_party: "dealParties",
  pe_workstream: "workstreams",
  pe_request: "requests",
  pe_deliverable: "deliverables",
  pe_finding: "findings",
  pe_deal_risk: "dealRisks",
  pe_dependency: "dependencies",
  pe_milestone: "milestones",
  pe_closing_condition: "closingConditions",
  pe_closing_item: "closingItems",
  pe_document_link: "documentLinks",
  pe_evidence_link: "evidenceLinks",
  pe_finding_risk_link: "findingRiskLinks",
};

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function requiredString(payload: Payload, field: string): string {
  const value = payload[field];
  if (typeof value !== "string") throw new ActionGroundingError("PE_INVALID_REFERENCE", `${field} is required`);
  return value;
}

function currentRow(graph: DealExecutionGraph, entityType: PeEntityRef["entityType"], entityId: string): Row | null {
  if (entityType === "pe_deal") return String(graph.deal.id) === entityId ? graph.deal : null;
  const collection = COLLECTION_BY_TYPE[entityType];
  if (!collection) return null;
  const rows = graph[collection];
  return Array.isArray(rows) ? (rows as Row[]).find((row) => String(row.id) === entityId) ?? null : null;
}

function entityRef(field: string, entityType: PeEntityRef["entityType"], entityId: string) {
  return { field, entityType, entityId };
}

function requiredEntityRefs(actionType: PrivateEquityActionType, payload: Payload): Array<ReturnType<typeof entityRef> & { states?: string[]; expectedVersion?: number }> {
  const ref = (field: string, entityType: PeEntityRef["entityType"], states?: string[], versionField?: string) => ({
    ...entityRef(field, entityType, requiredString(payload, field)),
    ...(states ? { states } : {}),
    ...(versionField ? { expectedVersion: Number(payload[versionField]) } : {}),
  });
  switch (actionType) {
    case "open_workstream": return [];
    case "create_deal_request": return [ref("workstreamId", "pe_workstream", ["not_started", "active"]), ref("requestedFromDealPartyId", "pe_deal_party", ["active"])];
    case "submit_deliverable": return [ref("deliverableId", "pe_deliverable", ["expected", "rejected", "received"], "expectedVersion")];
    case "record_finding": return [
      ref("workstreamId", "pe_workstream", ["not_started", "active"]),
      ...(payload.relatedRequestId ? [ref("relatedRequestId", "pe_request")] : []),
      ...(payload.relatedDeliverableId ? [ref("relatedDeliverableId", "pe_deliverable")] : []),
    ];
    case "resolve_finding": return [ref("findingId", "pe_finding", ["open", "resolved"], "expectedVersion")];
    case "raise_deal_risk": return [
      ref("workstreamId", "pe_workstream", ["not_started", "active"]),
      ...((payload.originatingFindingIds as string[] | undefined) ?? []).map((id, index) => ({ ...entityRef(`originatingFindingIds[${index}]`, "pe_finding", id) })),
    ];
    case "resolve_deal_risk": return [ref("dealRiskId", "pe_deal_risk", ["open", "mitigating", "resolved"], "expectedVersion")];
    case "link_deal_dependency": {
      const blocker = record(payload.blocker);
      const blocked = record(payload.blocked);
      return [
        { ...entityRef("blocker.entityId", blocker.entityType as PeEntityRef["entityType"], String(blocker.entityId)) },
        { ...entityRef("blocked.entityId", blocked.entityType as PeEntityRef["entityType"], String(blocked.entityId)) },
      ];
    }
    case "mark_dependency_resolved": return [ref("dependencyId", "pe_dependency", undefined, "expectedVersion")];
    case "create_closing_condition": return [
      ref("workstreamId", "pe_workstream", ["not_started", "active"]),
      ...(payload.responsibleDealPartyId ? [ref("responsibleDealPartyId", "pe_deal_party", ["active"])] : []),
    ];
    case "submit_condition_evidence": return [ref("closingConditionId", "pe_closing_condition", ["open", "evidence_pending"])];
    case "satisfy_closing_condition": return [ref("closingConditionId", "pe_closing_condition", ["open", "evidence_pending", "satisfied"], "expectedVersion")];
    case "waive_closing_condition": return [ref("closingConditionId", "pe_closing_condition", ["open", "evidence_pending", "waived"], "expectedVersion")];
    case "verify_closing_item": return [ref("closingItemId", "pe_closing_item", ["ready", "verified"], "expectedVersion")];
    case "declare_deal_closed": return [{ ...entityRef("dealId", "pe_deal", requiredString(payload, "dealId")), states: ["active", "closed"], expectedVersion: Number(payload.expectedVersion) }];
  }
}

async function validateCoreRefs(tenantId: string, payload: Payload): Promise<string[]> {
  const failures: string[] = [];
  await withTenant(tenantId, async (db) => {
    if (typeof payload.documentId === "string") {
      const [row] = await db.select({ id: documents.id }).from(documents).where(and(eq(documents.tenantId, tenantId), eq(documents.id, payload.documentId))).limit(1);
      if (!row) failures.push("documentId");
    }
    if (typeof payload.evidenceSourceId === "string") {
      const [row] = await db.select({ id: evidenceSources.id }).from(evidenceSources).where(and(
        eq(evidenceSources.id, payload.evidenceSourceId),
        eq(evidenceSources.scope, "tenant"),
        eq(evidenceSources.tenantId, tenantId),
      )).limit(1);
      if (!row) failures.push("evidenceSourceId");
    }
    if (typeof payload.evidenceVersionId === "string") {
      const sourceId = typeof payload.evidenceSourceId === "string" ? payload.evidenceSourceId : randomUUID();
      const [row] = await db.select({ id: evidenceSourceVersions.id }).from(evidenceSourceVersions).where(and(
        eq(evidenceSourceVersions.id, payload.evidenceVersionId),
        eq(evidenceSourceVersions.sourceId, sourceId),
        eq(evidenceSourceVersions.scope, "tenant"),
        eq(evidenceSourceVersions.tenantId, tenantId),
      )).limit(1);
      if (!row) failures.push("evidenceVersionId");
    }
  });
  return failures;
}

async function validatePartyRef(tenantId: string, value: unknown, field: string, requesterEmployeeId?: string): Promise<void> {
  if (!value) return;
  const resolution = await resolveParty(tenantId, { ref: value as PartyRef }, { requesterEmployeeId });
  if (resolution.status !== "resolved") {
    throw new ActionGroundingError("PE_PARTY_NOT_RESOLVED", `${field} is missing, inactive, ambiguous, or outside this tenant`, { field, status: resolution.status });
  }
}

function decisionIdFor(actionType: PrivateEquityActionType, payload: Payload): string | null {
  if (actionType === "satisfy_closing_condition") return `pe:decision:closing-condition:${String(payload.closingConditionId)}`;
  if (actionType === "verify_closing_item") return `pe:decision:closing-item:${String(payload.closingItemId)}`;
  if (actionType === "declare_deal_closed") return `pe:decision:deal-close:${String(payload.dealId)}`;
  return null;
}

async function groundPrivateEquityAction(draft: DraftAction, action: DomainAction): Promise<DomainActionGrounding> {
  const actionType = action.actionType as PrivateEquityActionType;
  const payload: Payload = { ...draft.payload };
  const dealId = requiredString(payload, "dealId");
  const workId = action.workId;
  if (!workId) throw new ActionGroundingError("PE_WORK_REQUIRED", "A Private Equity mutation must belong to one durable Work item");
  const actorId = action.initiatedBy ?? "system:private-equity";
  const ctx: PeMutationContext = { auth: { tenantId: action.tenantId, userId: actorId, ...(action.initiatedBy ? { employeeId: action.initiatedBy } : {}), role: "owner" } };
  let graph: DealExecutionGraph;
  try {
    graph = await loadDealExecutionGraph(ctx, dealId);
  } catch (error) {
    if (error instanceof PeDomainError) throw new ActionGroundingError(error.code, error.message, record(error.details));
    throw error;
  }
  if (String(graph.deal.id) !== dealId) throw new ActionGroundingError("PE_DEAL_NOT_FOUND", "The exact Deal is not available in this tenant");
  if (!graph.workLinks.some((row) => String(row.workId) === workId)) {
    throw new ActionGroundingError("PE_WORK_DEAL_MISMATCH", "The durable Work item is not anchored to this exact Deal", { workId, dealId });
  }
  if (graph.deal.status !== "active" && !(actionType === "declare_deal_closed" && graph.deal.status === "closed")) {
    throw new ActionGroundingError("PE_DEAL_TERMINAL", "The exact Deal is no longer active", { dealId, state: graph.deal.status });
  }

  const createIdField = CREATE_ID_FIELD[actionType];
  if (createIdField) {
    if (typeof payload[createIdField] === "string" && payload[createIdField] !== action.id) {
      throw new ActionGroundingError(
        "PE_CREATE_ID_RESERVED",
        `${createIdField} is derived from the durable DomainAction identity and cannot be planner-selected`,
        { field: createIdField },
      );
    }
    payload[createIdField] = action.id;
  }
  payload.workId = workId;

  if (actionType === "create_deal_request") {
    const requestId = String(payload.requestId);
    const requestText = String(payload.requestText).trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
    const equivalent = graph.requests.find((row) => (
      String(row.id) !== requestId
      && String(row.workstreamId) === String(payload.workstreamId)
      && String(row.requestedFromDealPartyId) === String(payload.requestedFromDealPartyId)
      && String(row.requestText).trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US") === requestText
      && !["fulfilled", "cancelled"].includes(String(row.state))
    ));
    if (equivalent) {
      throw new ActionGroundingError(
        "PE_REQUEST_ALREADY_EXISTS",
        "An equivalent unresolved request already exists in this Deal workstream",
        { existingRequestId: String(equivalent.id), workstreamId: String(payload.workstreamId) },
      );
    }
  }

  const groundedPayload: DomainActionGrounding["groundedPayload"] = [
    { field: "dealId", status: "verified" },
    { field: "workId", status: "verified" },
  ];
  const snapshots: Array<{ entityType: string; entityId: string; state: unknown; version: unknown }> = [];
  for (const ref of requiredEntityRefs(actionType, payload)) {
    const row = currentRow(graph, ref.entityType, ref.entityId);
    if (!row) throw new ActionGroundingError("PE_ENTITY_NOT_FOUND", `${ref.field} does not resolve inside the exact Deal`, { field: ref.field, dealId });
    const state = row.state ?? row.status ?? (row.removedAt ? "removed" : "active");
    if (ref.states && !ref.states.includes(String(state))) {
      throw new ActionGroundingError("PE_INVALID_TRANSITION", `${ref.field} is in state ${String(state)}, which is not valid for ${actionType}`, { field: ref.field, state });
    }
    if (ref.expectedVersion !== undefined && Number(row.version) !== ref.expectedVersion) {
      throw new ActionGroundingError("PE_STALE_VERSION", `${ref.field} changed since it was inspected`, { field: ref.field, expectedVersion: ref.expectedVersion, actualVersion: row.version });
    }
    groundedPayload.push({ field: ref.field, status: "verified" });
    snapshots.push({ entityType: ref.entityType, entityId: ref.entityId, state, version: row.version ?? null });
  }
  if (createIdField) groundedPayload.push({ field: createIdField, status: "verified" });

  await validatePartyRef(action.tenantId, payload.owner, "owner", action.initiatedBy ?? undefined);
  if (payload.owner) groundedPayload.push({ field: "owner.partyId", status: "verified" });
  if (typeof payload.verifierEmployeeId === "string") {
    await validatePartyRef(action.tenantId, { partyType: "employee", partyId: payload.verifierEmployeeId }, "verifierEmployeeId", action.initiatedBy ?? undefined);
    groundedPayload.push({ field: "verifierEmployeeId", status: "verified" });
  }
  const invalidCoreRefs = await validateCoreRefs(action.tenantId, payload);
  if (invalidCoreRefs.length) throw new ActionGroundingError("PE_EVIDENCE_NOT_GROUNDED", "Evidence or Document references are not exact tenant-owned canonical records", { fields: invalidCoreRefs });
  for (const field of ["documentId", "evidenceSourceId", "evidenceVersionId"] as const) {
    if (payload[field]) groundedPayload.push({ field, status: "verified" });
  }

  const decisionId = decisionIdFor(actionType, payload);
  let decisionReadiness: { decisionId: string; ready: boolean; unresolvedPropositionIds: string[]; acquisitionOptions: unknown[] } | null = null;
  if (decisionId) {
    const eligibility = await evaluateDealCloseEligibility(ctx, dealId);
    const linkedAssertions = await loadPrivateEquityAssertions(ctx, dealId);
    const proposedAssertions = typeof payload.evidenceSourceId === "string"
      ? await loadPrivateEquityAssertionsForEvidence(
          ctx,
          dealId,
          payload.evidenceSourceId,
          payload.evidenceVersionId as string | undefined,
        )
      : [];
    const assertions = [...new Map([...linkedAssertions, ...proposedAssertions].map((row) => [`${row.propositionId}:${row.ref}`, row])).values()];
    const epistemic = buildPrivateEquityEpistemicSnapshot({
      tenantId: action.tenantId,
      principalId: actorId,
      dealId,
      graph,
      eligibility,
      assertions,
    });
    decisionReadiness = epistemic.decisions.find((row) => row.decisionId === decisionId) ?? null;
    // The P3 decision projection intentionally reserves "ready" for a canonical
    // post-mutation claim. P4's satisfaction action has a narrower precondition:
    // exact governed/durable evidence must freshly and unambiguously establish
    // evidence_sufficient=true. The PE2 transition then becomes canonical truth.
    if (actionType === "satisfy_closing_condition" && !decisionReadiness?.ready) {
      const propositionId = pePropositionId(dealId, "pe_closing_condition", String(payload.closingConditionId), "closing_condition.evidence_sufficient");
      const proposition = epistemic.state.propositions.find((row) => row.id === propositionId);
      const proposedRefs = new Set(proposedAssertions.map((row) => row.ref));
      const proposedEvidenceIds = new Set(epistemic.state.evidence
        .filter((row) => row.propositionId === propositionId && proposedRefs.has(row.provenance.sourceRef))
        .map((row) => row.id));
      const proposedEvidenceSelected = proposition?.evidenceRefs.some((ref) => proposedEvidenceIds.has(ref)) === true;
      const hasUnresolvedConflict = epistemic.state.conflicts.some((conflict) =>
        conflict.propositionId === propositionId && conflict.resolution === "UNRESOLVED");
      const evidenceReady = proposition?.status === "KNOWN"
        && proposition.value.kind === "DETERMINISTIC"
        && proposition.value.value === true
        && ["GOVERNED_OBSERVATION", "DURABLE_EVIDENCE", "CANONICAL_OWNER"].includes(String(proposition.sourceAuthority))
        && proposedEvidenceSelected
        && !hasUnresolvedConflict;
      if (evidenceReady && decisionReadiness) decisionReadiness = { ...decisionReadiness, ready: true, unresolvedPropositionIds: [], acquisitionOptions: [] };
    }
    if (!decisionReadiness?.ready) {
      throw new ActionGroundingError("PE_DECISION_NOT_READY", "Mandatory Private Equity DecisionRequirements are unresolved; acquire information, wait, or ask before mutating business truth", {
        decisionId,
        unresolvedPropositionIds: decisionReadiness?.unresolvedPropositionIds ?? [],
        acquisitionOptions: decisionReadiness?.acquisitionOptions ?? [],
      });
    }
  }

  payload.grounding = {
    verticalKey: "private_equity",
    deal: { entityType: "pe_deal", entityId: dealId, state: graph.deal.status, version: graph.deal.version, graphVersion: graph.deal.graphVersion },
    work: { entityType: "work", entityId: workId },
    entities: snapshots,
    ...(decisionReadiness ? { decisionReadiness } : {}),
  };
  return { draft: { ...draft, payload }, groundedPayload };
}

function date(value: unknown): Date | undefined {
  return typeof value === "string" ? new Date(value) : undefined;
}

async function governanceProof(draft: DraftAction, tenantId: string): Promise<GovernanceProof> {
  if (!draft.domainActionId || !draft.businessEffect) {
    throw new PeDomainError("PE_GOVERNANCE_PROOF_MISSING", "The governed action is missing its exact authority or BusinessEffect identity");
  }
  const [approval, receipt] = await withTenant(tenantId, async (db) => {
    const [approvedRequest] = await db.select({
      authorityDecisionId: authorityApprovalRequests.authorityDecisionId,
      capability: authorityDecisions.capability,
      businessEffectId: authorityApprovalRequests.businessEffectId,
      businessEffectHash: authorityApprovalRequests.businessEffectHash,
    }).from(authorityApprovalRequests).innerJoin(
      authorityDecisions,
      and(
        eq(authorityDecisions.id, authorityApprovalRequests.authorityDecisionId),
        eq(authorityDecisions.tenantId, authorityApprovalRequests.tenantId),
      ),
    ).where(and(
      eq(authorityApprovalRequests.tenantId, tenantId),
      eq(authorityApprovalRequests.domainActionId, draft.domainActionId!),
      eq(authorityApprovalRequests.status, "approved"),
      eq(authorityApprovalRequests.businessEffectId, draft.businessEffect!.id),
      eq(authorityApprovalRequests.businessEffectHash, draft.businessEffect!.semanticHash),
      eq(authorityDecisions.domainActionId, draft.domainActionId!),
      eq(authorityDecisions.capability, `action:${draft.actionType}`),
      eq(authorityDecisions.businessEffectId, draft.businessEffect!.id),
      eq(authorityDecisions.businessEffectHash, draft.businessEffect!.semanticHash),
    )).limit(1);
    const [decisionReceipt] = await db.select({ id: decisionReceipts.id }).from(decisionReceipts).where(and(
      eq(decisionReceipts.tenantId, tenantId),
      eq(decisionReceipts.domainActionId, draft.domainActionId!),
      eq(decisionReceipts.businessEffectId, draft.businessEffect!.id),
      eq(decisionReceipts.authorizedEffectHash, draft.businessEffect!.semanticHash),
    )).orderBy(desc(decisionReceipts.createdAt)).limit(1);
    return [approvedRequest, decisionReceipt] as const;
  });
  if (!approval) throw new PeDomainError("PE_APPROVAL_PROOF_MISSING", "The exact approved authority request is not available at execution");
  if (!receipt) throw new PeDomainError("PE_DECISION_RECEIPT_MISSING", "The exact authorized DecisionReceipt is not available at execution");
  return { authorityDecisionId: approval.authorityDecisionId, decisionReceiptId: receipt.id };
}

function existingCreateResult(graph: DealExecutionGraph, actionType: PrivateEquityActionType, payload: Payload): PeMutationResult | null {
  const field = CREATE_ID_FIELD[actionType];
  const contract = CONTRACT_BY_ACTION.get(actionType);
  if (!field || !contract || typeof payload[field] !== "string") return null;
  const row = currentRow(graph, contract.resultEntityType, payload[field] as string);
  return row ? { row, changed: false, idempotent: true } : null;
}

async function executeMutation(actionType: PrivateEquityActionType, payload: Payload, ctx: PeMutationContext, draft: DraftAction): Promise<PeMutationResult> {
  const existing = existingCreateResult(await loadDealExecutionGraph(ctx, String(payload.dealId)), actionType, payload);
  if (existing) return existing;
  switch (actionType) {
    case "open_workstream": return createWorkstream(ctx, {
      id: String(payload.workstreamId), dealId: String(payload.dealId), kind: payload.kind as never,
      name: String(payload.name), owner: payload.owner as never,
    });
    case "create_deal_request": return createRequest(ctx, {
      id: String(payload.requestId), dealId: String(payload.dealId), workstreamId: String(payload.workstreamId),
      requestedFromDealPartyId: String(payload.requestedFromDealPartyId), owner: payload.owner as never,
      requestText: String(payload.requestText), requestedAt: date(payload.requestedAt), dueAt: date(payload.dueAt),
      requiresAcceptedDeliverable: payload.requiresAcceptedDeliverable as boolean | undefined,
    });
    case "submit_deliverable": return receiveDeliverable(ctx, {
      dealId: String(payload.dealId), deliverableId: String(payload.deliverableId), expectedVersion: Number(payload.expectedVersion),
      documentId: payload.documentId as string | undefined, supersedesLinkId: payload.supersedesLinkId as string | undefined,
    });
    case "record_finding": return createFinding(ctx, {
      id: String(payload.findingId), dealId: String(payload.dealId), workstreamId: String(payload.workstreamId),
      relatedRequestId: payload.relatedRequestId as string | undefined, relatedDeliverableId: payload.relatedDeliverableId as string | undefined,
      statement: String(payload.statement), severity: payload.severity as never, materiality: payload.materiality as never,
      owner: payload.owner as never, requiredForWorkstreamCompletion: payload.requiredForWorkstreamCompletion as boolean | undefined,
    });
    case "resolve_finding": return resolveFinding(ctx, { findingId: String(payload.findingId), expectedVersion: Number(payload.expectedVersion), disposition: String(payload.disposition) });
    case "raise_deal_risk": return createDealRisk(ctx, {
      id: String(payload.dealRiskId), dealId: String(payload.dealId), workstreamId: String(payload.workstreamId), statement: String(payload.statement),
      severity: payload.severity as never, owner: payload.owner as never, response: payload.response as string | undefined,
      requiredForWorkstreamCompletion: payload.requiredForWorkstreamCompletion as boolean | undefined,
      originatingFindingIds: payload.originatingFindingIds as string[] | undefined,
    });
    case "resolve_deal_risk": return resolveDealRisk(ctx, { dealRiskId: String(payload.dealRiskId), expectedVersion: Number(payload.expectedVersion), response: String(payload.response) });
    case "link_deal_dependency": return createDependency(ctx, {
      id: String(payload.dependencyId), dealId: String(payload.dealId), blocker: payload.blocker as never, blocked: payload.blocked as never,
    });
    case "mark_dependency_resolved": return removeDependency(ctx, { dependencyId: String(payload.dependencyId), expectedVersion: Number(payload.expectedVersion), reason: String(payload.reason) });
    case "create_closing_condition": return createClosingCondition(ctx, {
      id: String(payload.closingConditionId), dealId: String(payload.dealId), workstreamId: String(payload.workstreamId), conditionText: String(payload.conditionText),
      category: String(payload.category), requiredForClose: payload.requiredForClose as boolean | undefined, evidenceRequired: payload.evidenceRequired as boolean | undefined,
      waiverRequiresApproval: payload.waiverRequiresApproval as boolean | undefined, owner: payload.owner as never,
      responsibleDealPartyId: payload.responsibleDealPartyId as string | undefined, dueAt: date(payload.dueAt),
    });
    case "submit_condition_evidence": return attachCanonicalEvidence(ctx, {
      dealId: String(payload.dealId), entity: { entityType: "pe_closing_condition", entityId: String(payload.closingConditionId) },
      evidenceSourceId: String(payload.evidenceSourceId), evidenceVersionId: payload.evidenceVersionId as string | undefined,
      relationship: payload.relationship as "supports" | "verifies" | "authorizes",
    });
    case "satisfy_closing_condition": return satisfyClosingCondition(ctx, {
      dealId: String(payload.dealId), closingConditionId: String(payload.closingConditionId), expectedVersion: Number(payload.expectedVersion),
      documentId: payload.documentId as string | undefined, evidenceSourceId: payload.evidenceSourceId as string | undefined,
      evidenceVersionId: payload.evidenceVersionId as string | undefined,
    });
    case "waive_closing_condition": return waiveClosingCondition(ctx, {
      closingConditionId: String(payload.closingConditionId), expectedVersion: Number(payload.expectedVersion), reason: String(payload.reason),
      governance: await governanceProof(draft, ctx.auth.tenantId),
    });
    case "verify_closing_item": return verifyClosingItem(ctx, {
      dealId: String(payload.dealId), closingItemId: String(payload.closingItemId), expectedVersion: Number(payload.expectedVersion),
      verifierEmployeeId: payload.verifierEmployeeId as string | undefined, verificationSource: payload.verificationSource as string | undefined,
      documentId: payload.documentId as string | undefined, evidenceSourceId: payload.evidenceSourceId as string | undefined,
      evidenceVersionId: payload.evidenceVersionId as string | undefined,
    });
    case "declare_deal_closed": return declareDealClosed(ctx, {
      dealId: String(payload.dealId), expectedVersion: Number(payload.expectedVersion), expectedGraphVersion: Number(payload.expectedGraphVersion),
      governance: await governanceProof(draft, ctx.auth.tenantId),
    });
  }
}

function summary(actionType: PrivateEquityActionType, payload: Payload): string {
  const target = payload.closingConditionId ?? payload.closingItemId ?? payload.findingId ?? payload.dealRiskId
    ?? payload.dependencyId ?? payload.requestId ?? payload.workstreamId ?? payload.dealId;
  return `${actionType.replaceAll("_", " ")} on exact canonical target ${String(target)} in Deal ${String(payload.dealId)}.`;
}

export const privateEquityPlugin: DomainEnginePlugin = {
  name: "private-equity",
  // Kept literal at the registration seam so the static release registry can
  // independently discover the executable surface. A contract test proves this
  // list is exactly the schema-key set, preventing registration/schema drift.
  actionTypes: [
    "open_workstream",
    "create_deal_request",
    "submit_deliverable",
    "record_finding",
    "resolve_finding",
    "raise_deal_risk",
    "resolve_deal_risk",
    "link_deal_dependency",
    "mark_dependency_resolved",
    "create_closing_condition",
    "submit_condition_evidence",
    "satisfy_closing_condition",
    "waive_closing_condition",
    "verify_closing_item",
    "declare_deal_closed",
  ],
  payloadSchemas: PRIVATE_EQUITY_ACTION_SCHEMAS,
  canHandle(actionType) {
    return PRIVATE_EQUITY_ACTION_TYPES.includes(actionType as PrivateEquityActionType);
  },
  validate(actionType, payload): ValidationResult {
    const schema = PRIVATE_EQUITY_ACTION_SCHEMAS[actionType as PrivateEquityActionType];
    if (!schema) return { valid: false, errors: [`unhandled action ${actionType}`] };
    const parsed = schema.safeParse(payload);
    return parsed.success ? { valid: true, errors: [] } : {
      valid: false,
      errors: parsed.error.issues.map((issue) => `payload.${issue.path.join(".")}: ${issue.message}`),
    };
  },
  draft(actionType, payload, policy: DomainPolicy): DraftAction {
    const typed = actionType as PrivateEquityActionType;
    const parsed = PRIVATE_EQUITY_ACTION_SCHEMAS[typed].parse(payload) as Payload;
    return {
      actionType,
      payload: parsed,
      summary: summary(typed, parsed),
      // Core hardening supplies irreversible floors for waiver and close; the
      // plugin may request more confirmation but can never lower that floor.
      requiresConfirmation: policy.requiresConfirmation,
    };
  },
  ground(draft, action) {
    return groundPrivateEquityAction(draft, action);
  },
  simulate(actionType, payload) {
    const parsed = PRIVATE_EQUITY_ACTION_SCHEMAS[actionType as PrivateEquityActionType].parse(payload) as Payload;
    return {
      mode: "schema",
      summary: `${actionType.replaceAll("_", " ")} is schema-valid; exact Deal/Work/entity versions, evidence readiness, authority, and close eligibility remain execution-time facts.`,
      predicted: { actionType, fields: Object.keys(parsed).sort(), fieldChanges: [] },
    };
  },
  async execute(draft: DraftAction, tools: ToolRegistry): Promise<ExecutionResult> {
    const runtime = tools.runtimeContext();
    if (!runtime?.tenantId || !runtime.domainActionId) {
      return { status: "failure", output: {}, error: "Private Equity execution requires the trusted scoped runtime", errorKind: "validation" };
    }
    const actionType = draft.actionType as PrivateEquityActionType;
    const contract = CONTRACT_BY_ACTION.get(actionType);
    if (!contract) return { status: "failure", output: {}, error: `No PE action contract for ${draft.actionType}`, errorKind: "terminal" };
    const ctx: PeMutationContext = {
      auth: {
        tenantId: runtime.tenantId,
        userId: runtime.actorId ?? "system:private-equity",
        ...(runtime.actorId && /^[0-9a-f-]{36}$/i.test(runtime.actorId) ? { employeeId: runtime.actorId } : {}),
        role: "owner",
      },
      provenance: { sourceSystem: "@finnor/plugin-private-equity", externalId: runtime.domainActionId, createdBy: runtime.actorId ?? "system:private-equity" },
    };
    try {
      const result = await executeMutation(actionType, draft.payload, ctx, draft);
      const entityId = String(result.row.id);
      const workId = String(draft.payload.workId);
      // Closing atomically makes the Deal graph immutable.  Its Work->Deal anchor
      // was required during grounding, so trying to add another link after close
      // would turn a successful close into a false plugin failure.
      if (actionType !== "declare_deal_closed") {
        await attachWorkToDealGraph(ctx, {
          dealId: String(draft.payload.dealId),
          workId,
          entities: [{ entityType: contract.resultEntityType, entityId, relationship: "result" }],
        });
      }
      return {
        status: "success",
        output: {
          actionType,
          canonicalMutationOwner: contract.canonicalMutationOwner,
          idempotencyIdentity: runtime.domainActionId,
          entity: { entityType: contract.resultEntityType, entityId },
          canonicalState: result.row,
          changed: result.changed,
          idempotent: result.idempotent,
          canonicalObserved: true,
          verified: true,
          workAttachment: actionType === "declare_deal_closed" ? "preexisting_deal_anchor" : "result_linked",
        },
        expected: { canonicalObserved: true, entityType: contract.resultEntityType, entityId },
      };
    } catch (error) {
      const code = error instanceof PeDomainError ? error.code : "PE_EXECUTION_FAILED";
      const message = error instanceof Error ? error.message : "Private Equity mutation failed";
      const conflict = code === "PE_STALE_VERSION" || code === "PE_DEAL_NOT_CLOSE_ELIGIBLE" || code === "PE_INVALID_TRANSITION";
      return { status: "failure", output: { actionType, code }, error: message, errorKind: conflict ? "conflict" : "terminal" };
    }
  },
};

export default privateEquityPlugin;
