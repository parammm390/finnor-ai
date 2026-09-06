import { describe, expect, it } from "vitest";
import {
  PE_PROPOSITION_PREDICATES,
  buildPrivateEquityEpistemicSnapshot,
  mapPrivateEquitySourceObservation,
  pePropositionId,
  privateEquityUserAssertion,
  type DealCloseEligibility,
  type DealExecutionGraph,
} from "@finnor/private-equity";

const tenantId = "11111111-1111-4111-8111-111111111111";
const dealId = "22222222-2222-4222-8222-222222222222";
const conditionId = "33333333-3333-4333-8333-333333333333";
const itemId = "44444444-4444-4444-8444-444444444444";
const requestId = "55555555-5555-4555-8555-555555555555";
const deliverableId = "66666666-6666-4666-8666-666666666666";
const workstreamId = "77777777-7777-4777-8777-777777777777";
const dependencyId = "88888888-8888-4888-8888-888888888888";
const now = "2026-09-05T12:00:00.000Z";

function graph(): DealExecutionGraph {
  const stamp = { createdAt: now, updatedAt: now };
  return {
    deal: { id: dealId, name: "Atlas", status: "active", graphVersion: 7, signedLoiAt: now, targetClosingAt: "2026-09-11T12:00:00.000Z", ...stamp },
    dealParties: [],
    workstreams: [{ id: workstreamId, state: "active", ...stamp }],
    requests: [{ id: requestId, workstreamId, state: "acknowledged", requiresAcceptedDeliverable: true, overdue: true, ...stamp }],
    deliverables: [{ id: deliverableId, requestId, workstreamId, state: "received", ...stamp }],
    findings: [],
    dealRisks: [],
    findingRiskLinks: [],
    dependencies: [{ id: dependencyId, blockerType: "pe_request", blockerId: requestId, blockedType: "pe_closing_condition", blockedId: conditionId, removedAt: null, ...stamp }],
    milestones: [],
    closingConditions: [{ id: conditionId, state: "evidence_pending", requiredForClose: true, evidenceRequired: true, waiverRequiresApproval: true, ...stamp }],
    closingItems: [{ id: itemId, state: "ready", requiredForClose: true, verificationEvidenceRequired: true, ...stamp }],
    documentLinks: [],
    evidenceLinks: [],
    workLinks: [],
    taskLinks: [],
    businessEvents: [],
    authorityDecisions: [],
    approvalRequests: [],
    decisionReceipts: [],
    asOf: now,
  };
}

function eligibility(): DealCloseEligibility {
  return {
    dealId,
    dealState: "active",
    dealVersion: 1,
    graphVersion: 7,
    signedLoiPresent: true,
    eligible: false,
    blockingConditions: [{ id: conditionId, condition: "Debt payoff letter", state: "evidence_pending" }],
    failedConditions: [],
    unverifiedClosingItems: [{ id: itemId, item: "Funds flow", state: "ready" }],
    blockingDependencies: [{ dependencyId, blocker: { entityType: "pe_request", entityId: requestId }, blocked: { entityType: "pe_closing_condition", entityId: conditionId }, relation: "blocks" }],
    invalidWaivers: [],
    integrityErrors: [],
  };
}

function snapshot(assertions: Parameters<typeof buildPrivateEquityEpistemicSnapshot>[0]["assertions"] = []) {
  return buildPrivateEquityEpistemicSnapshot({ tenantId, principalId: tenantId, dealId, graph: graph(), eligibility: eligibility(), assertions, asOf: now });
}

describe("Private Equity Phase 3 epistemic runtime", () => {
  it("publishes the bounded proposition catalog exactly", () => {
    expect(PE_PROPOSITION_PREDICATES).toEqual([
      "deal.exists", "deal.loi_signed", "deal.target_close_at", "deal.lifecycle_state", "workstream.state",
      "request.acknowledged", "request.fulfilled", "request.overdue", "deliverable.received", "deliverable.accepted",
      "finding.current", "deal_risk.current", "dependency.resolved", "milestone.achieved", "closing_condition.state",
      "closing_condition.evidence_sufficient", "closing_condition.waiver_valid", "closing_item.ready", "closing_item.verified",
      "deal.close_eligible",
    ]);
  });

  it("keeps canonical Request state as the winner while retaining contradictory provider evidence", () => {
    const propositionId = pePropositionId(dealId, "pe_request", requestId, "request.fulfilled");
    const result = snapshot([{ propositionId, kind: "provider_observation", value: true, ref: "provider:request:1", observedAt: now }]);
    const proposition = result.state.propositions.find((candidate) => candidate.id === propositionId)!;
    expect(proposition.status).toBe("KNOWN");
    expect(proposition.value).toEqual({ kind: "DETERMINISTIC", value: false });
    expect(proposition.sourceAuthority).toBe("CANONICAL_OWNER");
    expect(proposition.contradictingEvidenceRefs).toHaveLength(1);
    expect(result.warnings.find((warning) => warning.propositionId === propositionId)?.status).toBe("CONTRADICTED");
  });

  it("treats provider, Document, and user claims as evidence without calling them verified", () => {
    const propositionId = pePropositionId(dealId, "pe_closing_condition", conditionId, "closing_condition.evidence_sufficient");
    const user = privateEquityUserAssertion({
      dealId,
      entity: { entityType: "pe_closing_condition", entityId: conditionId },
      predicate: "closing_condition.evidence_sufficient",
      value: true,
      inputRef: "input:1",
      observedAt: now,
    });
    const kinds = [
      snapshot([{ propositionId, kind: "provider_observation", value: true, ref: "provider:1", observedAt: now }]),
      snapshot([{ propositionId, kind: "document_claim", value: true, ref: "document:1:version:1", observedAt: now }]),
      snapshot([user]),
    ];
    expect(kinds.map((result) => result.state.propositions.find((candidate) => candidate.id === propositionId)?.source?.kind))
      .toEqual(["PROVIDER_OBSERVATION", "DOCUMENT", "EXPLICIT_USER_INPUT"]);
    expect(kinds.every((result) => result.state.canonicalTruth.every((truth) => truth.propositionId !== propositionId))).toBe(true);
    expect(kinds.every((result) => result.decisions.find((decision) => decision.decisionType === "closing_condition_satisfaction")?.ready === false)).toBe(true);
  });

  it("preserves equal-authority conflict, configured staleness, and first-class unknown", () => {
    const propositionId = pePropositionId(dealId, "pe_closing_condition", conditionId, "closing_condition.evidence_sufficient");
    const conflict = snapshot([
      { propositionId, kind: "provider_observation", value: true, ref: "provider:a", observedAt: now },
      { propositionId, kind: "provider_observation", value: false, ref: "provider:b", observedAt: now },
    ]);
    expect(conflict.state.propositions.find((candidate) => candidate.id === propositionId)?.status).toBe("CONFLICTING");
    expect(conflict.state.conflicts.some((item) => item.resolution === "UNRESOLVED")).toBe(true);

    const stale = buildPrivateEquityEpistemicSnapshot({
      tenantId,
      principalId: tenantId,
      dealId,
      graph: graph(),
      eligibility: eligibility(),
      assertions: [{ propositionId, kind: "provider_observation", value: true, ref: "provider:old", observedAt: "2026-09-01T00:00:00.000Z", maximumAgeMs: 1_000, freshnessPolicyRef: "policy:closing:1" }],
      asOf: now,
    });
    expect(stale.state.propositions.find((candidate) => candidate.id === propositionId)?.status).toBe("STALE");
    expect(snapshot().state.propositions.find((candidate) => candidate.id === propositionId)?.status).toBe("UNKNOWN");
  });

  it("does not admit memory or web as proof of internal Deal state", () => {
    const propositionId = pePropositionId(dealId, "pe_closing_condition", conditionId, "closing_condition.evidence_sufficient");
    const result = snapshot([
      { propositionId, kind: "memory", value: true, ref: "memory:1", observedAt: now },
      { propositionId, kind: "web", value: true, ref: "web:1", observedAt: now },
    ]);
    expect(result.state.propositions.find((candidate) => candidate.id === propositionId)?.status).toBe("UNKNOWN");
    expect(result.state.evidence.some((item) => item.propositionId === propositionId)).toBe(false);
  });

  it("hands P4 an exact not-ready decision plus bounded acquisition paths", () => {
    const result = snapshot();
    const close = result.decisions.find((decision) => decision.decisionType === "deal_close")!;
    const request = result.decisions.find((decision) => decision.decisionType === "request_fulfillment")!;
    expect(close.ready).toBe(false);
    expect(close.unresolvedPropositionIds).toEqual([pePropositionId(dealId, "pe_deal", dealId, "deal.close_eligible")]);
    expect(close.acquisitionOptions.map((item) => item.adapterId)).toEqual(["CANONICAL_OPERATIONAL_QUERY", "WORK_EVENT_WAIT"]);
    expect(request.ready).toBe(false);
    expect(request.unresolvedPropositionIds).toContain(pePropositionId(dealId, "pe_request", requestId, "request.fulfilled"));
    expect(request.unresolvedPropositionIds).toContain(pePropositionId(dealId, "pe_deliverable", deliverableId, "deliverable.accepted"));
  });

  it("maps provider observations to Source Truth observe-only records", () => {
    const record = mapPrivateEquitySourceObservation({
      tenantId,
      integrationId: "99999999-9999-4999-8999-999999999999",
      provider: "virtual_data_room",
      sourceScope: "deal-room",
      externalObjectType: "request",
      externalId: "REQ-10",
      dealId,
      entity: { entityType: "pe_request", entityId: requestId },
      claims: [{ entity: { entityType: "pe_request", entityId: requestId }, predicate: "request.fulfilled", value: true }],
      observedAt: now,
    });
    expect(record.materialization).toBe("observe_only");
    expect(record.ownership).toEqual({ default: "finnor", direction: "inbound" });
    expect(record.candidateCanonicalIds).toEqual([requestId]);
  });
});
