// Deterministic replay corpus for the active Core + Private Equity planner contract.
// The fixtures validate parsing/shape only; live model evaluation remains separate.

export interface PlannerGoldenCase {
  id: string;
  category: "standard" | "must_ask" | "terminal_repair" | "health_degraded";
  expectedActionType: string;
  requiredFields: string[];
  replay: { actions: Array<{ action_type: string; payload: Record<string, unknown> }> };
}

const DEAL_ID = "00000000-0000-4000-8000-000000000101";
const STREAM_ID = "00000000-0000-4000-8000-000000000102";
const PARTY_ID = "00000000-0000-4000-8000-000000000103";
const ENTITY_ID = "00000000-0000-4000-8000-000000000104";
const party = { partyType: "employee", partyId: PARTY_ID };

const BASE: Array<Omit<PlannerGoldenCase, "id">> = [
  { category: "standard", expectedActionType: "open_workstream", requiredFields: ["dealId", "kind", "name", "owner"], replay: { actions: [{ action_type: "open_workstream", payload: { dealId: DEAL_ID, kind: "legal", name: "Legal diligence", owner: party } }] } },
  { category: "standard", expectedActionType: "create_deal_request", requiredFields: ["dealId", "workstreamId", "requestedFromDealPartyId", "owner", "requestText"], replay: { actions: [{ action_type: "create_deal_request", payload: { dealId: DEAL_ID, workstreamId: STREAM_ID, requestedFromDealPartyId: ENTITY_ID, owner: party, requestText: "Provide the signed disclosure schedules" } }] } },
  { category: "standard", expectedActionType: "submit_deliverable", requiredFields: ["dealId", "deliverableId", "expectedVersion"], replay: { actions: [{ action_type: "submit_deliverable", payload: { dealId: DEAL_ID, deliverableId: ENTITY_ID, expectedVersion: 1 } }] } },
  { category: "standard", expectedActionType: "record_finding", requiredFields: ["dealId", "workstreamId", "statement", "severity", "materiality", "owner"], replay: { actions: [{ action_type: "record_finding", payload: { dealId: DEAL_ID, workstreamId: STREAM_ID, statement: "Customer concentration exceeds the underwriting threshold", severity: "high", materiality: "material", owner: party } }] } },
  { category: "standard", expectedActionType: "resolve_finding", requiredFields: ["dealId", "findingId", "expectedVersion", "disposition"], replay: { actions: [{ action_type: "resolve_finding", payload: { dealId: DEAL_ID, findingId: ENTITY_ID, expectedVersion: 1, disposition: "Validated against the final QoE report" } }] } },
  { category: "standard", expectedActionType: "raise_deal_risk", requiredFields: ["dealId", "workstreamId", "statement", "severity", "owner"], replay: { actions: [{ action_type: "raise_deal_risk", payload: { dealId: DEAL_ID, workstreamId: STREAM_ID, statement: "Financing commitment may miss the target close", severity: "critical", owner: party } }] } },
  { category: "standard", expectedActionType: "resolve_deal_risk", requiredFields: ["dealId", "dealRiskId", "expectedVersion", "response"], replay: { actions: [{ action_type: "resolve_deal_risk", payload: { dealId: DEAL_ID, dealRiskId: ENTITY_ID, expectedVersion: 1, response: "Executed commitment received" } }] } },
  { category: "standard", expectedActionType: "link_deal_dependency", requiredFields: ["dealId", "blocker", "blocked"], replay: { actions: [{ action_type: "link_deal_dependency", payload: { dealId: DEAL_ID, blocker: { entityType: "pe_request", entityId: ENTITY_ID }, blocked: { entityType: "pe_closing_condition", entityId: STREAM_ID } } }] } },
  { category: "standard", expectedActionType: "mark_dependency_resolved", requiredFields: ["dealId", "dependencyId", "expectedVersion", "reason"], replay: { actions: [{ action_type: "mark_dependency_resolved", payload: { dealId: DEAL_ID, dependencyId: ENTITY_ID, expectedVersion: 1, reason: "Required evidence arrived" } }] } },
  { category: "standard", expectedActionType: "create_closing_condition", requiredFields: ["dealId", "workstreamId", "conditionText", "category", "owner"], replay: { actions: [{ action_type: "create_closing_condition", payload: { dealId: DEAL_ID, workstreamId: STREAM_ID, conditionText: "Lender commitment is effective", category: "financing", owner: party } }] } },
  { category: "standard", expectedActionType: "submit_condition_evidence", requiredFields: ["dealId", "closingConditionId", "evidenceSourceId"], replay: { actions: [{ action_type: "submit_condition_evidence", payload: { dealId: DEAL_ID, closingConditionId: ENTITY_ID, evidenceSourceId: STREAM_ID } }] } },
  { category: "standard", expectedActionType: "satisfy_closing_condition", requiredFields: ["dealId", "closingConditionId", "expectedVersion", "documentId"], replay: { actions: [{ action_type: "satisfy_closing_condition", payload: { dealId: DEAL_ID, closingConditionId: ENTITY_ID, expectedVersion: 1, documentId: STREAM_ID } }] } },
  { category: "standard", expectedActionType: "waive_closing_condition", requiredFields: ["dealId", "closingConditionId", "expectedVersion", "reason"], replay: { actions: [{ action_type: "waive_closing_condition", payload: { dealId: DEAL_ID, closingConditionId: ENTITY_ID, expectedVersion: 1, reason: "Investment committee approved the documented waiver" } }] } },
  { category: "standard", expectedActionType: "verify_closing_item", requiredFields: ["dealId", "closingItemId", "expectedVersion", "verificationSource", "documentId"], replay: { actions: [{ action_type: "verify_closing_item", payload: { dealId: DEAL_ID, closingItemId: ENTITY_ID, expectedVersion: 1, verificationSource: "closing counsel", documentId: STREAM_ID } }] } },
  { category: "standard", expectedActionType: "declare_deal_closed", requiredFields: ["dealId", "expectedVersion", "expectedGraphVersion"], replay: { actions: [{ action_type: "declare_deal_closed", payload: { dealId: DEAL_ID, expectedVersion: 1, expectedGraphVersion: 1 } }] } },
  { category: "must_ask", expectedActionType: "clarification_request", requiredFields: ["question", "missingFields"], replay: { actions: [{ action_type: "clarification_request", payload: { question: "Which active Deal should this finding attach to?", missingFields: ["dealId"] } }] } },
  { category: "health_degraded", expectedActionType: "escalate_work", requiredFields: ["delegationRef", "reason", "evidenceRefs"], replay: { actions: [{ action_type: "escalate_work", payload: { delegationRef: { delegationId: ENTITY_ID }, reason: "The evidence provider is unavailable beyond the deadline", evidenceRefs: [] } }] } },
  { category: "terminal_repair", expectedActionType: "clarification_request", requiredFields: ["question", "missingFields"], replay: { actions: [{ action_type: "clarification_request", payload: { question: "The referenced closing condition is no longer active; which condition should replace it?", missingFields: ["closingConditionId"] } }] } },
];

export const PLANNER_GOLDENS: PlannerGoldenCase[] = BASE.flatMap((base, index) =>
  Array.from({ length: 4 }, (_, variant) => ({ ...base, id: `${base.category}-${index + 1}-v${variant + 1}` })),
);

export const CRITIC_GOLDENS = [
  { id: "cross-tenant-ref", expectedFlagged: true, response: { flagged: true, reason: "Deal reference belongs to another tenant." } },
  { id: "contradictory-evidence", expectedFlagged: true, response: { flagged: true, reason: "Draft contradicts canonical diligence evidence." } },
  { id: "missing-prereq", expectedFlagged: true, response: { flagged: true, reason: "Required Deal reference is absent." } },
  { id: "authority-violation", expectedFlagged: true, response: { flagged: true, reason: "The requested mutation lacks required authority." } },
  { id: "valid-action", expectedFlagged: false, response: { flagged: false, reason: "Action matches the instruction." } },
] as const;
