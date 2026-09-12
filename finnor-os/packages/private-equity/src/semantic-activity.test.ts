import type { WorkAggregate } from "@finnor/db";
import type { AttentionQueueResult, WorkforceStatusResult } from "@finnor/shared-types";
import { describe, expect, it } from "vitest";
import type { CompanyBrainSourceBundle } from "./company-brain-types";
import { groupSemanticActivity, projectSemanticActivity } from "./semantic-activity";
import type { PeWorldState } from "./types";

const at = "2026-09-12T01:00:00.000Z";
const rootId = "10000000-0000-4000-8000-000000000001";
const decisionId = "10000000-0000-4000-8000-000000000002";
const workId = "10000000-0000-4000-8000-000000000003";
const planId = "10000000-0000-4000-8000-000000000004";
const actionId = "10000000-0000-4000-8000-000000000005";
const effectId = "10000000-0000-4000-8000-000000000006";
const receiptId = "10000000-0000-4000-8000-000000000007";
const agentId = "10000000-0000-4000-8000-000000000008";
const agentRevisionId = "10000000-0000-4000-8000-000000000009";
const oldAssignmentId = "10000000-0000-4000-8000-000000000010";
const assignmentId = "10000000-0000-4000-8000-000000000011";
const approvalId = "10000000-0000-4000-8000-000000000012";

function world(): PeWorldState {
  return {
    root: { entityType: "pe_deal", entityId: rootId },
    stateAt: at,
    temporalCompleteness: { status: "complete", baselineAt: at, unavailableEntityTypes: [], reasons: [] },
    strategy: null,
    opportunity: null,
    deal: { id: rootId, name: "Atlas", status: "active", version: 1 },
    opportunities: [],
    deals: [{ id: rootId, name: "Atlas", status: "active", version: 1 }],
    investmentCases: [],
    theses: [],
    assumptions: [],
    decisions: [{ id: decisionId, dealId: rootId, title: "Proceed", state: "final", version: 2 }],
    decisionEffectLinks: [],
    dealParties: [],
    workstreams: [],
    requests: [],
    deliverables: [],
    findings: [],
    dealRisks: [],
    findingRiskLinks: [],
    dependencies: [],
    milestones: [],
    closingConditions: [],
    closingItems: [],
    documents: [],
    evidence: [],
    observedEvidence: [],
    sourceCoverage: [],
    sourceCoverageWarnings: [],
    unresolvedProviderObservations: 0,
    ambiguousProviderObservations: 0,
    providerFreshnessWarnings: [],
    providerEvidenceCompleteness: { status: "not_configured", absenceClaimsPermitted: false, reasons: [] },
    documentLinks: [],
    evidenceLinks: [],
    workLinks: [{ id: "10000000-0000-4000-8000-000000000013", entityType: "pe_deal", entityId: rootId, workId, createdAt: at }],
    taskLinks: [],
    businessEvents: [{
      id: "10000000-0000-4000-8000-000000000014",
      entityType: "pe_decision",
      entityId: decisionId,
      eventType: "pe_decision_final",
      payload: { from: "draft", to: "final", actor: "10000000-0000-4000-8000-000000000015" },
      source: "@finnor/private-equity",
      occurredAt: at,
    }],
    authorityDecisions: [],
    approvalRequests: [],
    decisionReceipts: [],
    conflicts: [],
    epistemicWarnings: [],
    provenance: [],
  };
}

function work(): WorkAggregate {
  return {
    work: { id: workId, status: "executing", initialInstruction: "Review Atlas", createdBy: "10000000-0000-4000-8000-000000000015", createdAt: at },
    events: [{ id: "10000000-0000-4000-8000-000000000016", workId, seq: 1, eventType: "action_execution_started", fromStatus: "actionable", toStatus: "executing", payload: { actionId }, createdAt: at }],
    planRevisions: [{
      id: planId,
      workId,
      revision: 1,
      reason: "initial",
      status: "completed",
      goalHash: "goal-hash",
      goalSpec: { objective: "Complete diligence", completionCriteria: [{ kind: "receipt", id: receiptId }] },
      planGraph: { nodes: [{ id: "node-a", kind: "action" }], edges: [] },
      completionProof: { verified: true, receiptIds: [receiptId] },
      selectedAt: at,
      completedAt: at,
    }],
    objectiveSteps: [],
    actions: [{ id: actionId, workId, planRevisionId: planId, planNodeId: "node-a", actionType: "pe.review", status: "completed", businessEffectId: effectId, createdAt: at }],
    businessEffects: [{ id: effectId, domainActionId: actionId, status: "verified", semanticHash: "sha256:effect", observedAt: at, createdAt: at }],
    receipts: [{ id: receiptId, workId, domainActionId: actionId, businessEffectId: effectId, objective: "Review", evidence: [], createdAt: at, finalizedAt: at }],
    repairs: [],
    entityLinks: [], queryExecutions: [], operations: [], operationTargets: [], operationEvents: [], objectiveLoop: null,
    objectivePlannerAttempts: [], eventWaits: [], wakeClaims: [], integrationEvents: [],
  } as unknown as WorkAggregate;
}

function workforce(): WorkforceStatusResult {
  const assignmentBase = {
    workId, planRevisionId: planId, planNodeId: "node-a", objectiveLoopId: null, objectiveStepId: null,
    agentProfileId: agentId, agentRevisionId, capability: "pe.review", nodeKind: "action" as const,
    attempt: 1, assignmentReason: "eligible", reassignmentReason: null, domainActionId: actionId,
    startedAt: at, completedAt: at, failure: null, createdAt: at, updatedAt: at,
  };
  return {
    view: "workforce_status",
    status: "ok",
    asOf: at,
    configurationState: "configured",
    workers: [{
      id: agentId, key: "deal-review", name: "Deal Review", profileStatus: "enabled", runtimeStatus: "working", currentLoad: 1,
      activeRevision: { id: agentRevisionId, revision: 1, modelRoute: { provider: "bedrock", purpose: "objective_execution" }, capabilityGrants: [], maxConcurrentAssignments: 1, autonomyLimits: { maxActions: 1, maxQueries: 1, maxReplans: 1, maxPlannerCalls: 1, maxWallClockMs: 1 }, planningHints: {}, learningRevisionId: null, configHash: "hash", createdAt: at },
      latestAssignment: null, metrics: [],
    }],
    assignments: [
      { id: oldAssignmentId, ...assignmentBase, state: "completed", previousAssignmentId: null },
      { id: assignmentId, ...assignmentBase, state: "running", previousAssignmentId: oldAssignmentId, completedAt: null, reassignmentReason: "lease_expired" },
    ],
    currentAssignments: [], completedAssignments: [], blockedOrFailedAssignments: [], proposals: [], learningRevisions: [],
    sourceStatus: { status: "complete", asOf: at, tables: ["agent_profiles", "agent_profile_revisions", "workforce_assignments", "learning_observations", "learning_proposals", "learning_revisions"], truncatedSources: [], bounds: { agentProfiles: { returned: 1, totalCount: 1, limit: 100, truncated: false }, workforceAssignments: { returned: 2, limit: 100, truncated: false }, learningObservations: { returned: 0, limit: 100, truncated: false }, learningProposals: { returned: 0, limit: 100, truncated: false }, learningRevisions: { returned: 0, limit: 100, truncated: false } } },
  } as unknown as WorkforceStatusResult;
}

function attention(): AttentionQueueResult {
  return {
    view: "attention_queue",
    status: "ok",
    asOf: at,
    viewer: { employeeId: "10000000-0000-4000-8000-000000000015", authorityRevision: 2 },
    items: [{
      id: `approval_required:${approvalId}`,
      workId,
      planRevisionId: planId,
      planNodeId: "node-a",
      rootRefs: [{ entityType: "pe_deal", entityId: rootId, relationship: "about", source: "work_entity_links" }],
      kind: "approval_required",
      reason: "Approval is required.",
      assignedOrEligibleActor: { employeeId: "10000000-0000-4000-8000-000000000015", basis: "approval_eligibility", capability: "pe.review" },
      deadline: null, slackMs: null,
      blocks: [{ kind: "approval", id: approvalId }],
      unblocks: [{ kind: "work_completion", id: workId }],
      authorityBoundary: null, recoveryBoundary: null,
      impact: { blocksWorkCompletion: true, downstreamPlanNodes: 1, completionCriteria: 1, sourceBackedMateriality: null },
      evidenceRefs: [{ type: "authority_approval_request", id: approvalId }],
      nextHumanBoundary: { kind: "approve", description: "Review", capability: "pe.review", executable: false },
      rankVector: { safetyRecoveryRank: 1, deadlineRank: 1, slackMs: null, downstreamCompletionCriteria: 1, downstreamPlanNodes: 1, authorityBottleneckRank: 1, materialityRank: null, ageMs: 0, stableTieBreak: approvalId, tuple: [1, 1, 0, -1, -1, 1, 0, 0, approvalId] },
      rankReason: { primary: "approval", factors: [] },
      createdAt: at,
    }],
    sourceStatus: { status: "complete", sources: [], unavailableSources: [] },
  } as unknown as AttentionQueueResult;
}

function bundle(): CompanyBrainSourceBundle {
  return { world: world(), underwriting: [], ic: [], works: [work()], workforce: workforce(), attention: attention() };
}

describe("PE semantic activity", () => {
  it("maps exact canonical sources without inventing causality", () => {
    const projection = projectSemanticActivity(bundle());
    const decision = projection.items.find((item) => item.kind === "final_decision");
    expect(decision).toMatchObject({
      bucket: "verified_outcomes",
      subjectRef: { type: "pe_decision", id: decisionId },
      change: { before: "draft", after: "final" },
      reasonCode: null,
      causalRefs: [],
    });
    expect(decision?.sourceRefs).toEqual([{ owner: "@finnor/db", table: "business_events", id: "10000000-0000-4000-8000-000000000014" }]);
  });

  it("classifies Attention, active execution, and durable verification into the three required buckets", () => {
    const projection = projectSemanticActivity(bundle());
    expect(projection.items.find((item) => item.kind === "attention_raised")?.bucket).toBe("needs_attention");
    expect(projection.items.find((item) => item.kind === "work_transition")?.bucket).toBe("in_motion");
    expect(projection.items.find((item) => item.kind === "receipt_finalized")?.bucket).toBe("verified_outcomes");
    expect(projection.items.find((item) => item.kind === "completion_proof_verified")?.bucket).toBe("verified_outcomes");
    expect(projection.groups.map((group) => group.bucket)).toEqual(["needs_attention", "in_motion", "verified_outcomes"]);
  });

  it("preserves root, Work, plan, assignment, and exact inspection attribution", () => {
    const projection = projectSemanticActivity(bundle());
    expect(projection.items.every((item) => item.rootRefs.some((root) => root.entityId === rootId))).toBe(true);
    expect(projection.items.every((item) => Boolean(item.inspectionTarget) && item.sourceRefs.length > 0)).toBe(true);
    const reassignment = projection.items.find((item) => item.subjectRef.id === assignmentId);
    expect(reassignment).toMatchObject({ workId, planRevisionId: planId, planNodeId: "node-a", change: { type: "assignment_reassigned" } });
    expect(reassignment?.causalRefs).toContainEqual(expect.objectContaining({ relationship: "reassigned_from", id: oldAssignmentId, sourceRef: expect.objectContaining({ table: "workforce_assignments", fieldPath: "previous_assignment_id" }) }));
  });

  it("emits no semantic item when the canonical subject has no exact Brain target", () => {
    const input = bundle();
    input.world.businessEvents.push({ id: "20000000-0000-4000-8000-000000000001", entityType: "pe_finding", entityId: "20000000-0000-4000-8000-000000000002", eventType: "pe_finding_opened", occurredAt: at, payload: {}, source: "@finnor/private-equity" });
    expect(projectSemanticActivity(input).items.some((item) => item.sourceRefs[0]?.id === "20000000-0000-4000-8000-000000000001")).toBe(false);
  });

  it("groups each causal thread chronologically and sorts threads by latest event", () => {
    const projection = projectSemanticActivity(bundle());
    const grouped = groupSemanticActivity(projection.items);
    for (const bucket of grouped) for (const root of bucket.roots) for (const thread of root.threads) {
      const dates = thread.itemIds.map((id) => projection.items.find((item) => item.id === id)!.occurredAt);
      expect(dates).toEqual([...dates].sort());
    }
  });
});
