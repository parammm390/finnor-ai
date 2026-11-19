import type { PoolClient } from "pg";
import { beginWorkPlannerAttemptTx, finishWorkPlannerAttemptTx, persistSelectedWorkPlanTx, transactionDb } from "@finnor/db";
import { buildGoalSpec, buildConstraintSet, buildPlanningWorldSnapshot, compileAndSelectPlans, DEFAULT_PLAN_BUDGETS,
  type CandidatePlan, type CandidateCompilationFacts, type PlanningSnapshotCapability } from "@finnor/planning";
import type { TenantContext } from "@finnor/shared-types";
import { organizationDigest } from "./compiler";
import type { OrganizationTransformationProgram } from "./contracts";
import { orgCurrent, orgEvent, orgFail, type OrganizationRequestRow } from "./store";

/** S4 owns the canonical query/check plan, not an invented numerical value of
 * reorganizing people. The owner's exact selected alternative is a constraint;
 * unqualified queue hypotheses remain distinct from S2/S3 benefit evidence. */
export async function selectOrganizationPlanTx(ctx: TenantContext, q: OrganizationRequestRow,
  program: OrganizationTransformationProgram, c: PoolClient, alternativeId?: string) {
  await orgCurrent(ctx, q, c);
  const db = transactionDb(c), selected = alternativeId ? program.alternatives.find(a => a.id === alternativeId) : null;
  if (alternativeId && !selected) orgFail("W5_S4_EXACT_ALTERNATIVE_REQUIRED");
  const attempt = await beginWorkPlannerAttemptTx(db, { tenantId: ctx.tenantId, workId: q.work_id,
    workInputId: q.work_input_id, attemptKey: "w5:" + q.id + ":" + program.revision + ":" + (alternativeId ?? "construction") });
  const query = { intent: "organization_transformation_v1" as const, requestId: q.id, workId: q.work_id,
    ...(alternativeId ? { alternativeId } : {}) };
  const goal = buildGoalSpec({ objective: q.original.mandate.purpose, workId: q.work_id, workInputId: q.work_input_id,
    targets: [{ kind: "entity", type: "work", id: q.work_id, sourceRef: q.original.organization.ref.id }],
    deadline: q.original.mandate.originalDeadline,
    explicitNonGoals: ["employment_changes", "removed_mandatory_approvals", "new_authority", "unobserved_field_benefit", "effect_redispatch"],
    successCondition: { version: 1, statement: "Independently checked original-bound organization proposal", source: "explicit", mode: "all",
      criteria: [{ kind: "canonical_query", request: query,
        assertion: { path: ["data", "checked"], operator: "eq", expected: true } },
      ...(alternativeId ? [{ kind: "canonical_query" as const, request: query,
        assertion: { path: ["data", "alternativeId"], operator: "eq" as const, expected: alternativeId } }] : [])] } });
  const capability: PlanningSnapshotCapability = { capability: "query:organization_transformation_v1", kind: "query",
    modelProposable: true, available: true, health: "available", risk: "low", irreversible: false,
    requiredReferences: ["workId", "requestId"], effectClass: null, observationStrategy: "operational_query",
    reversibility: "read_only", supportedRecoveryModes: ["retry", "replan", "escalate"], externalSideEffect: false, authorityRequirement: "query" };
  const constraints = buildConstraintSet({ tenantId: ctx.tenantId, verticalKey: "private_equity",
    allowedCapabilities: [capability.capability, "check:objective_success"], humanOnlyCapabilities: [], prohibitedCapabilities: [],
    authorityRevision: Number(q.rights_revision), budgets: { ...DEFAULT_PLAN_BUDGETS, maxActions: 0 },
    deadlineAt: q.original.mandate.originalDeadline, softPreferences: [] });
  const effects = (await c.query(`SELECT e.semantic_hash,e.status,e.operation_class FROM finnor_os.business_effects e
    JOIN finnor_os.domain_actions d ON d.tenant_id=e.tenant_id AND d.id=e.domain_action_id
    WHERE e.tenant_id=$1 AND d.work_id=ANY($2::uuid[]) LIMIT 1025`,
    [ctx.tenantId, [...new Set([q.work_id, ...q.original.organization.obligations.map(o => o.workId)])]])).rows;
  if (effects.length > 1024) orgFail("W5_S4_COMPLETE_LIVE_EFFECT_POPULATION_REQUIRED");
  const snapshot = buildPlanningWorldSnapshot({ tenantId: ctx.tenantId, verticalKey: "private_equity", workId: q.work_id,
    workInputId: q.work_input_id, plannerAttemptId: attempt.id, capturedAt: new Date().toISOString(),
    decisionContextHash: organizationDigest({ original: q.original_digest, alternatives: program.alternatives, alternativeId }),
    canonicalStateHash: q.original_input_digest,
    canonicalEntities: [{ kind: "entity", type: "work", id: q.work_id, versionHash: q.original_input_digest,
      sourceRef: q.original.organization.ref.id }],
    authority: { revision: Number(q.rights_revision), roles: [ctx.role], employeeId: q.principal_id }, capabilities: [capability],
    currentEffects: effects.map(e => ({ semanticHash: e.semantic_hash, status: e.status,
      irreversible: ["financial_write", "external_side_effect", "external_spend", "batch_external"].includes(e.operation_class) })),
    sourceHealth: { status: "complete", missing: [] } });
  const candidate: CandidatePlan = { version: 1, candidateKey: "organization:" + (alternativeId ?? "checked-construction"),
    nodes: [{ key: "observe_checked_organization", kind: "query", request: query, supports: goal.criteria.map(c => c.id) },
      ...goal.criteria.map((criterion, index) => ({ key: "check_" + index, kind: "check" as const,
        criterionId: criterion.id, dependsOn: ["observe_checked_organization"], observation: criterion.criterion }))] };
  const facts: CandidateCompilationFacts = { candidateKey: candidate.candidateKey,
    nodes: Object.fromEntries(candidate.nodes.map(node => [node.key, { capability: node.kind === "query" ? capability.capability : "check:objective_success",
      registered: true, schemaValid: true, schemaErrors: [], grounded: true, crossTenant: false, stale: false,
      authority: "allowed", health: "available", risk: "low", irreversible: false, requiredReferences: ["workId", "requestId"],
      estimatedCostMicros: null, estimatedLatencyMs: null, supportedRecoveryModes: ["retry", "replan", "escalate"] }])) };
  const compiled = compileAndSelectPlans({ candidates: [candidate], facts: [facts], goal, constraints, snapshot });
  if (!compiled.selected?.graph) {
    await finishWorkPlannerAttemptTx(db, { tenantId: ctx.tenantId, attemptId: attempt.id, status: "failed",
      failure: { code: "W5_S4_CANONICAL_PLAN_REJECTED", compiled } });
    orgFail("W5_S4_CANONICAL_PLAN_REJECTED");
  }
  const active = (await c.query<{ id: string }>(`SELECT id FROM finnor_os.work_plan_revisions
    WHERE tenant_id=$1 AND work_id=$2 AND status='active'`,
    [ctx.tenantId, q.work_id])).rows[0];
  const plan = await persistSelectedWorkPlanTx(db, { tenantId: ctx.tenantId, workId: q.work_id, workInputId: q.work_input_id,
    plannerAttemptId: attempt.id, parentRevisionId: active?.id ?? null,
    reason: active ? "redirect" : "initial", goalSpec: goal, constraintSet: constraints,
    planningSnapshot: snapshot, candidatePlans: [candidate], compilationResult: compiled, planGraph: compiled.selected.graph,
    score: compiled.selected.score, semanticHash: compiled.selected.graph.semanticHash });
  await finishWorkPlannerAttemptTx(db, { tenantId: ctx.tenantId, attemptId: attempt.id, status: "succeeded",
    plannerResult: { planRevisionId: plan.id, alternativeId: alternativeId ?? null,
      qualification: "S4_CURRENT_ORIGINAL_QUERY_CHECK_NOT_CAUSAL_BUSINESS_BENEFIT" } });
  await c.query("UPDATE finnor_os.w5_requests SET plan_revision_id=$3 WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, q.id, plan.id]);
  await orgEvent(ctx, q, "S4_PLAN_SELECTED", "s4:" + program.revision, { planRevisionId: plan.id, alternativeId: alternativeId ?? null,
    completeAlternativeDigests: program.alternatives.map(a => ({ id: a.id, digest: organizationDigest(a) })),
    existingEffectPopulation: effects.length, originalWorkId: q.work_id, executionAuthorityGranted: false }, c);
  return plan.id;
}
