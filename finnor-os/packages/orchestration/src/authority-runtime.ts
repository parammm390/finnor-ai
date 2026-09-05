import type { AuthorityRequest, AuthorityResource, AuthorityRisk, DomainAction, DomainPolicy, DraftAction, TenantContext } from "@finnor/shared-types";
import { evaluateAuthority, recordActionAuthority, revalidateActionExecution } from "@finnor/authority";
import type { OperationalQueryRequest } from "./fast-read-lane";
import { ACTION_HARDENING_SPEC_BY_ACTION, approvalRequirementForAction } from "../../../scripts/release/action-hardening-spec";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOURCE_KEYS: Record<string, string> = {
  householdId: "household",
  customerId: "household",
  targetId: "household",
  technicianId: "technician",
  visitId: "service_visit",
  serviceVisitId: "service_visit",
  workOrderId: "work_order",
  invoiceId: "invoice",
  paymentId: "payment",
  leadId: "lead",
  opportunityId: "opportunity",
  quoteId: "quote",
  proposalId: "proposal",
  appointmentId: "appointment",
  workId: "work",
  taskId: "task",
  documentId: "document",
  locationId: "location",
  delegationId: "delegation",
  internalEventId: "internal_event",
  objectiveLoopId: "objective_loop",
  communicationIdentityId: "communication_identity",
  applicationAccountId: "application_account",
  authProfileId: "auth_profile",
  dealId: "pe_deal",
  dealPartyId: "pe_deal_party",
  requestedFromDealPartyId: "pe_deal_party",
  responsibleDealPartyId: "pe_deal_party",
  workstreamId: "pe_workstream",
  requestId: "pe_request",
  deliverableId: "pe_deliverable",
  findingId: "pe_finding",
  dealRiskId: "pe_deal_risk",
  dependencyId: "pe_dependency",
  milestoneId: "pe_milestone",
  closingConditionId: "pe_closing_condition",
  closingItemId: "pe_closing_item",
  evidenceSourceId: "evidence_source",
  evidenceVersionId: "evidence_source_version",
  verifierEmployeeId: "employee",
};

function walk(value: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(value)) { for (const item of value) walk(item, visit); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    visit(key, child);
    walk(child, visit);
  }
}

export function authorityResourcesFromPayload(payload: Record<string, unknown>): AuthorityResource[] {
  const resources: AuthorityResource[] = [];
  // Typed nested references are the P2 planner contract. Resolve their declared
  // canonical type rather than reducing every PartyRef to an unscoped UUID.
  const collectTypedRefs = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) collectTypedRefs(item); return; }
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (typeof row.partyType === "string" && typeof row.partyId === "string" && UUID.test(row.partyId)) {
      resources.push({ type: row.partyType, id: row.partyId });
    }
    if (typeof row.entityType === "string" && typeof row.entityId === "string" && UUID.test(row.entityId)) {
      resources.push({ type: row.entityType, id: row.entityId });
    }
    for (const child of Object.values(row)) collectTypedRefs(child);
  };
  collectTypedRefs(payload);
  walk(payload, (key, value) => {
    const type = RESOURCE_KEYS[key] ?? (key.endsWith("Ids") ? RESOURCE_KEYS[`${key.slice(0, -3)}Id`] : undefined);
    if (!type) return;
    const ids = Array.isArray(value) ? value : [value];
    for (const id of ids) if (typeof id === "string" && UUID.test(id)) resources.push({ type, id });
  });
  return [...new Map(resources.map((row) => [`${row.type}:${row.id}`, row])).values()];
}

export function authorityAmountFromPayload(payload: Record<string, unknown>): number | undefined {
  const amounts: number[] = [];
  walk(payload, (key, value) => {
    if (!/(?:amount|total|price|spend|budget|cost)(?:Usd)?$/i.test(key)) return;
    const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    if (Number.isFinite(number) && number >= 0) amounts.push(number);
  });
  return amounts.length > 0 ? Math.max(...amounts) : undefined;
}

export function authorityRiskForAction(actionType: string): AuthorityRisk {
  const spec = ACTION_HARDENING_SPEC_BY_ACTION.get(actionType);
  if (!spec) return "high";
  if (spec.profile === "READ_ONLY" || spec.profile === "META_NO_SIDE_EFFECT") return "low";
  if (spec.external || spec.profile === "FINANCIAL_WRITE" || spec.profile === "DURABLE_WORKFLOW" || spec.profile === "BATCH_EXTERNAL") return "high";
  return "medium";
}

export function actionAuthorityRequest(action: DomainAction, policy: DomainPolicy, draft: DraftAction): AuthorityRequest {
  const approval = approvalRequirementForAction(action.actionType, policy.requiresConfirmation, draft.requiresConfirmation);
  const alreadyApproved = action.status === "approved" || action.status === "executing";
  const resources = draft.businessEffect
    ? draft.businessEffect.targets.map((target) => ({ type: target.type, ...(UUID.test(target.id) ? { id: target.id } : {}) }))
    : authorityResourcesFromPayload(draft.payload ?? action.payload);
  const primaryTypeByAction: Record<string, string> = {
    open_workstream: "pe_workstream", create_deal_request: "pe_request", submit_deliverable: "pe_deliverable",
    record_finding: "pe_finding", resolve_finding: "pe_finding", raise_deal_risk: "pe_deal_risk",
    resolve_deal_risk: "pe_deal_risk", link_deal_dependency: "pe_dependency", mark_dependency_resolved: "pe_dependency",
    create_closing_condition: "pe_closing_condition", submit_condition_evidence: "pe_closing_condition",
    satisfy_closing_condition: "pe_closing_condition", waive_closing_condition: "pe_closing_condition",
    verify_closing_item: "pe_closing_item", declare_deal_closed: "pe_deal",
  };
  const primaryType = primaryTypeByAction[action.actionType];
  const orderedResources = primaryType
    ? [...resources].sort((left, right) => Number(right.type === primaryType) - Number(left.type === primaryType))
    : resources;
  return {
    operation: alreadyApproved ? "execution" : "action",
    capability: `action:${action.actionType}`,
    resources: orderedResources,
    amountUsd: draft.businessEffect?.exposure?.currency === "USD" ? draft.businessEffect.exposure.amount : authorityAmountFromPayload(draft.payload ?? action.payload),
    risk: draft.businessEffect?.authority.risk ?? authorityRiskForAction(action.actionType),
    policyRequiresApproval: approval.requiresConfirmation && !alreadyApproved,
    workId: action.workId ?? undefined,
    domainActionId: action.id,
    businessEffectId: draft.businessEffect?.id,
    businessEffectHash: draft.businessEffect?.semanticHash,
  };
}

export async function evaluateActionAuthorityBoundary(action: DomainAction, policy: DomainPolicy, draft: DraftAction) {
  const ctx: TenantContext = action.initiatedBy
    ? { tenantId: action.tenantId, userId: action.initiatedBy, employeeId: action.initiatedBy, role: "owner" }
    : { tenantId: action.tenantId, userId: "system:orchestration", role: "owner" };
  const request = actionAuthorityRequest(action, policy, draft);
  if (action.status === "approved" || action.status === "executing") {
    const decision = await revalidateActionExecution(action.tenantId, action.id);
    return { request, decision };
  }
  const decision = await evaluateAuthority(ctx, request);
  await recordActionAuthority({ ctx, actionId: action.id, request, decision });
  return { request, decision };
}

export function queryAuthorityRequest(request: OperationalQueryRequest, workId?: string): AuthorityRequest {
  const raw = request as unknown as Record<string, unknown>;
  const params = raw.params && typeof raw.params === "object" ? raw.params as Record<string, unknown> : raw;
  let resource: AuthorityResource = { type: "*" };
  switch (request.intent) {
    case "customer_lookup":
    case "customer_cohort": resource = { type: "household", ...(typeof params.householdId === "string" ? { id: params.householdId } : {}) }; break;
    case "schedule_range": resource = { type: "schedule", ...(typeof params.technicianId === "string" ? { id: params.technicianId } : {}) }; break;
    case "money_summary": resource = { type: "financial_ledger" }; break;
    case "work_list": resource = { type: "work", ...(typeof params.recordId === "string" ? { id: params.recordId } : {}) }; break;
    case "inventory_status": resource = { type: "inventory" }; break;
    case "agent_activity": resource = { type: "agent_activity" }; break;
    case "business_state": resource = { type: "business_state" }; break;
    case "company_context": {
      const anchor = params.anchor && typeof params.anchor === "object" ? params.anchor as Record<string, unknown> : null;
      resource = anchor && typeof anchor.partyType === "string"
        ? { type: anchor.partyType, ...(typeof anchor.partyId === "string" ? { id: anchor.partyId } : {}) }
        : anchor && typeof anchor.entityType === "string"
          ? { type: anchor.entityType, ...(typeof anchor.entityId === "string" ? { id: anchor.entityId } : {}) }
          : { type: "household", ...(typeof params.householdId === "string" ? { id: params.householdId } : {}) };
      break;
    }
    case "party_lookup":
    case "party_context":
    case "party_availability": {
      const ref = params.ref && typeof params.ref === "object" ? params.ref as Record<string, unknown> : null;
      resource = ref && typeof ref.partyType === "string"
        ? { type: ref.partyType, ...(typeof ref.partyId === "string" ? { id: ref.partyId } : {}) }
        : { type: "party" };
      break;
    }
    case "team_roster": {
      const ref = params.teamRef && typeof params.teamRef === "object" ? params.teamRef as Record<string, unknown> : null;
      resource = ref && typeof ref.partyType === "string"
        ? { type: ref.partyType, ...(typeof ref.partyId === "string" ? { id: ref.partyId } : {}) }
        : { type: "team" };
      break;
    }
    case "deal_context":
    case "deal_workstreams":
    case "open_requests":
    case "open_findings":
    case "open_deal_risks":
    case "critical_dependencies":
    case "closing_readiness":
      resource = { type: "pe_deal", ...(typeof params.dealId === "string" ? { id: params.dealId } : {}) };
      break;
  }
  return { operation: "query", capability: `query:${request.intent}`, resource, risk: "low", workId };
}
