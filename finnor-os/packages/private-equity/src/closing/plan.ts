import { beginWorkPlannerAttempt, finishWorkPlannerAttempt, persistSelectedWorkPlan } from "@finnor/db";
import {
  buildConstraintSet, buildGoalSpec, buildPlanningWorldSnapshot, compileAndSelectPlans, DEFAULT_PLAN_BUDGETS,
  type CandidateCompilationFacts, type CandidatePlan, type NodeCompilationFacts, type PlanningSnapshotCapability,
} from "@finnor/planning";
import type { PeMutationContext } from "../types";
import { ClosingWorkContinuationSchema, type ClosingSpec } from "@finnor/shared-types";
import { principal, tx } from "../owner-context";
import { ClosingError } from "./contracts";
import { closingDigest } from "./compiler";

export function closingPlannedChildren(spec: ClosingSpec, programmeId: string, workId: string,
  publication: { version: number; graph_version: number }) {
  const specDigest = closingDigest(spec);
  return [
    ...spec.steps.filter(s => ["REQUEST_SIGNATURE", "DRAW_FUNDS", "PAY_FUNDS", "TRANSFER_RIGHTS", "FILE",
      "ACQUIRE_EVIDENCE", "REQUEST_PROFESSIONAL"].includes(s.kind)).map(s => ({
      key: s.key, actionType: ["ACQUIRE_EVIDENCE", "REQUEST_PROFESSIONAL"].includes(s.kind) ? "create_task" : "execute_closing_operation",
      payload: ["ACQUIRE_EVIDENCE", "REQUEST_PROFESSIONAL"].includes(s.kind) ? {
        subjectRef: { entityType: "work", entityId: workId },
        title: `Closing ${s.kind.toLowerCase()} ${s.requirementKey}`, dueAt: spec.originalGrant.deadlineAt,
        assigneeRef: { partyType: "employee", partyId: s.actor.principalId }, priority: "high",
        workRef: { workId },
      } : { dealId: spec.transactionId, programmeId, nodeKey: s.key, specDigest },
      irreversible: s.irreversible, actorId: s.actor.principalId,
    })),
    ...spec.continuingDuties.map(d => ({
      key: `duty:${d.key}`, actionType: "create_task", payload: {
        subjectRef: { entityType: "work", entityId: workId }, title: `Closing duty ${d.key}`,
        dueAt: d.dueAt, assigneeRef: { partyType: "employee", partyId: d.ownerPrincipalId },
        priority: "high", workRef: { workId },
      }, irreversible: false, actorId: d.ownerPrincipalId,
    })),
    { key: "publish-close", actionType: "declare_deal_closed", payload: {
      dealId: spec.transactionId, expectedVersion: publication.version, expectedGraphVersion: publication.graph_version,
    }, irreversible: true, actorId: "" },
  ];
}
export async function selectClosingPlan(ctx: PeMutationContext, spec: ClosingSpec, b: {
  programmeId: string; workId: string; inputId: string; inputDigest: string; specDigest: string;
  authorityRevision: number; parentRevisionId: string | null; instruction: string; focusNode?: string;
}) {
  const { bindClosingWorkObjective } = await import("../../../orchestration/src/objective-loop");
  const legalIntake = await tx(ctx, async c => (await c.query(
    "SELECT body->'workContinuation' AS binding FROM finnor_os.pe_closing_events WHERE tenant_id=$1 AND programme_id=$2 AND kind='LEGAL_SPEC_INTAKE' AND idempotency_key='legal-intake'",
    [ctx.auth.tenantId, b.programmeId],
  )).rows[0], true);
  const originalGoal = legalIntake?.binding == null ? undefined : ClosingWorkContinuationSchema.parse(legalIntake.binding);
  const objective = await bindClosingWorkObjective({
    tenantId: ctx.auth.tenantId, principalId: principal(ctx), workId: b.workId, workInputId: b.inputId,
    instruction: b.instruction, transactionId: spec.transactionId, specDigest: b.specDigest,
    deadlineAt: spec.originalGrant.deadlineAt, maxSteps: spec.originalGrant.maxSteps,
    maxActions: Math.min(spec.originalGrant.maxSteps, spec.steps.length + spec.continuingDuties.length + 1),
    originalGoal,
  });
  const native = await tx(ctx, async c => ({
    publication: (await c.query<{ version: number; graph_version: number }>("SELECT version,graph_version FROM finnor_os.pe_deals WHERE tenant_id=$1 AND id=$2", [ctx.auth.tenantId, spec.transactionId])).rows[0],
    links: (await c.query<{ node_key: string }>("SELECT node_key FROM finnor_os.pe_closing_node_links WHERE tenant_id=$1 AND programme_id=$2", [ctx.auth.tenantId, b.programmeId])).rows,
    actors: (await c.query<{ id: string; role: string }>("SELECT id,role FROM finnor_os.users WHERE tenant_id=$1 AND status='active'", [ctx.auth.tenantId])).rows,
  }), true);
  if (!native.publication) throw new ClosingError("CLOSING_CANONICAL_TRANSACTION_REQUIRED");
  const children = closingPlannedChildren(spec, b.programmeId, b.workId, native.publication)
    .filter(n => !native.links.some(l => l.node_key === n.key))
    // Publication is selected only after the independent conjunction passed.
    // Unused evidence-acquisition alternatives must not become mandatory work
    // after their predicates are already proven by current owner evidence.
    .filter(n => b.focusNode !== "publish-close" || n.key === "publish-close")
    .sort((a, bNode) => Number(bNode.key === b.focusNode) - Number(a.key === b.focusNode))
    .slice(0, DEFAULT_PLAN_BUDGETS.maxActions);
  if (b.focusNode && !children.some(n => n.key === b.focusNode)) throw new ClosingError("CLOSING_EXACT_NATIVE_CHILD_ALREADY_OWNED_OR_UNSUPPORTED");
  const attempt = await beginWorkPlannerAttempt({ tenantId: ctx.auth.tenantId, workId: b.workId, workInputId: b.inputId,
    attemptKey: `v3:${b.programmeId}:${b.focusNode ?? "initial"}:${b.parentRevisionId ?? "root"}` });
  const replay = await tx(ctx, async c => (await c.query(
    "SELECT r.id FROM finnor_os.work_planner_attempts a JOIN finnor_os.work_plan_revisions r ON r.tenant_id=a.tenant_id AND r.id=a.selected_plan_revision_id WHERE a.tenant_id=$1 AND a.id=$2 AND r.work_input_id=$3 AND r.status='active'",
    [ctx.auth.tenantId, attempt.id, b.inputId],
  )).rows[0], true);
  if (replay) return { planRevisionId: replay.id as string, deadlineAt: objective.deadlineAt };
  const request = { intent: "closing_readiness" as const, dealId: spec.transactionId };
  const goal = buildGoalSpec({
    objective: b.instruction, workId: b.workId, workInputId: b.inputId,
    targets: [{ kind: "entity", type: "pe_deal", id: spec.transactionId, sourceRef: "S1:legally-accepted-closing-spec" }],
    deadline: objective.deadlineAt, explicitNonGoals: ["V4_FORMATION", "V5_RELATIONSHIP_CONTROLLER", "S8_SELF_ADMISSION", "FINANCING_PRINCIPAL_AS_PROFIT"],
    successCondition: { version: 1, statement: b.instruction, source: "explicit", mode: "all", criteria: [
      { kind: "canonical_query", request, assertion: { path: ["verifiedClosing", "status"], operator: "eq", expected: "CLOSED" } },
      { kind: "canonical_query", request, assertion: { path: ["verifiedClosing", "specDigest"], operator: "eq", expected: b.specDigest } },
    ] },
  });
  const capability: PlanningSnapshotCapability = {
    capability: "query:closing_readiness", kind: "query", modelProposable: false, available: true,
    health: "available", risk: "low", irreversible: false, requiredReferences: ["dealId"],
    effectClass: null, observationStrategy: "operational_query", reversibility: "read_only", supportedRecoveryModes: ["retry"],
    externalSideEffect: false, authorityRequirement: "query",
  };
  const actionCapabilities: PlanningSnapshotCapability[] = [...new Set(children.map(n => n.actionType))].map(name => ({
    capability: name, kind: "action", modelProposable: false, available: true, health: "available",
    risk: name === "create_task" ? "low" : "high", irreversible: name !== "create_task",
    requiredReferences: ["dealId"], effectClass: name === "execute_closing_operation" ? "external_side_effect" : "local_mutation",
    observationStrategy: "business_effect", reversibility: name === "create_task" ? "reversible" : "irreversible",
    supportedRecoveryModes: ["escalate"], externalSideEffect: name === "execute_closing_operation",
    authorityRequirement: name === "create_task" ? "policy" : "typed_approval",
  }));
  const constraints = buildConstraintSet({
    tenantId: ctx.auth.tenantId, verticalKey: "private_equity", allowedCapabilities: [capability.capability, "check:objective_success",
      ...actionCapabilities.map(c => c.capability)],
    humanOnlyCapabilities: [], prohibitedCapabilities: [], authorityRevision: b.authorityRevision,
    budgets: DEFAULT_PLAN_BUDGETS, deadlineAt: objective.deadlineAt, softPreferences: [],
  });
  const snapshot = buildPlanningWorldSnapshot({
    tenantId: ctx.auth.tenantId, verticalKey: "private_equity", workId: b.workId, workInputId: b.inputId,
    plannerAttemptId: attempt.id, capturedAt: new Date().toISOString(), decisionContextHash: b.specDigest,
    canonicalStateHash: b.inputDigest,
    canonicalEntities: [{ kind: "entity", type: "pe_deal", id: spec.transactionId, versionHash: null, sourceRef: "S1:accepted-terms" }],
    authority: { revision: b.authorityRevision, roles: [ctx.auth.role], employeeId: principal(ctx) },
    capabilities: [capability, ...actionCapabilities], currentEffects: [], sourceHealth: { status: "complete", missing: [] },
  });
  const candidate: CandidatePlan = { version: 1, candidateKey: "v3-owned-closing-controller", nodes: [
    { key: "read_closing_owner", kind: "query", request, supports: goal.criteria.map(c => c.id) },
    ...children.map((n, index) => ({
      key: `closing_child_${index}`, kind: "action" as const, actionType: n.actionType, payload: n.payload,
      dependsOn: ["read_closing_owner"], rationale: `Original ClosingGraph child ${n.key}; independent readiness remains the physical dispatch gate.`,
      preconditions: [{ kind: "observation_satisfied" as const, ref: b.specDigest,
        requirement: { programmeId: b.programmeId, nodeKey: n.key, independentOriginalSpecCheckRequired: true }, certainty: "uncertain" as const }],
      recovery: { version: 1 as const, mode: "escalate" as const, on: ["failure", "stale", "timeout", "divergence"] as Array<"failure" | "stale" | "timeout" | "divergence">,
        maxAttempts: 1, neverReplayVerifiedIrreversibleEffect: true as const },
    })),
    ...goal.criteria.map((c, i) => ({ key: `check_${i}`, kind: "check" as const, criterionId: c.id,
      dependsOn: ["read_closing_owner", ...children.map((_n, index) => `closing_child_${index}`)], observation: c.criterion })),
  ] };
  const facts: CandidateCompilationFacts = { candidateKey: candidate.candidateKey, nodes: Object.fromEntries(candidate.nodes.map(n => {
    const original = n.kind === "action" ? children[Number(n.key.split("_").at(-1))] : undefined;
    const actorId = original?.actionType === "execute_closing_operation" ? original.actorId : principal(ctx);
    const fact: NodeCompilationFacts = {
    registered: true,
    schemaValid: true, schemaErrors: [], grounded: true, crossTenant: false, stale: false,
    authority: n.kind === "action" && n.actionType !== "create_task" ? "approval_required" : "allowed",
    health: "available", risk: n.kind === "action" && n.actionType !== "create_task" ? "high" : "low",
    irreversible: original?.irreversible ?? false,
    uncertainPrerequisiteNodeKeys: n.kind === "action" ? ["read_closing_owner"] : [],
    estimatedCostMicros: null, estimatedLatencyMs: null, supportedRecoveryModes: n.kind === "action" ? ["escalate"] : ["retry"],
    };
    if (n.kind === "action") fact.grounded = native.actors.some(a => a.id === actorId && a.role === "owner")
      && (original?.actionType !== "create_task" || native.actors.some(a => a.id === original.actorId));
    return [n.key, fact];
  })) };
  const compiled = compileAndSelectPlans({ candidates: [candidate], facts: [facts], goal, constraints, snapshot });
  if (!compiled.selected?.graph) {
    await finishWorkPlannerAttempt({ tenantId: ctx.auth.tenantId, attemptId: attempt.id, status: "failed", failure: { code: "V3_NATIVE_PLAN_REJECTED", compiled } });
    throw new ClosingError("CLOSING_NATIVE_PLAN_REJECTED");
  }
  const plan = await persistSelectedWorkPlan({
    tenantId: ctx.auth.tenantId, workId: b.workId, workInputId: b.inputId, plannerAttemptId: attempt.id,
    objectiveLoopId: objective.id, parentRevisionId: b.parentRevisionId, reason: b.parentRevisionId ? "redirect" : "initial",
    goalSpec: goal, constraintSet: constraints, planningSnapshot: snapshot, candidatePlans: [candidate], compilationResult: compiled,
    planGraph: compiled.selected.graph, score: compiled.selected.score, semanticHash: compiled.selected.graph.semanticHash,
  });
  await finishWorkPlannerAttempt({ tenantId: ctx.auth.tenantId, attemptId: attempt.id, status: "succeeded", plannerResult: {
    planRevisionId: plan.id, programmeId: b.programmeId, qualification: "V3_CONTROLLER_IMPLEMENTATION_NOT_S8_ADMISSION",
  } });
  return { planRevisionId: plan.id, deadlineAt: objective.deadlineAt };
}
