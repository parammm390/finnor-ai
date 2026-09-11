import { createHash } from "node:crypto";
import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import {
  domainActions,
  domainPolicyRevisions,
  persistSelectedWorkPlan,
  recordRejectedWorkPlan,
  workInputs,
  workPlanRevisions,
  works,
  withTenant,
} from "@finnor/db";
import type { DomainAction, DomainPolicy, TenantContext } from "@finnor/shared-types";
import { sha256, type PlanActionNode, type PlanViolation } from "@finnor/planning";
import { buildCommandGraph, groundEntitiesWithDb } from "./compiler";
import type { PlanningResult } from "./planner";

export class PlanCompilationError extends Error {
  readonly code = "PLAN_COMPILATION_REJECTED";
  constructor(readonly violations: PlanViolation[]) {
    super(violations.length > 0
      ? `No candidate plan satisfied hard constraints: ${violations.map((item) => `${item.code}${item.nodeKey ? `(${item.nodeKey})` : ""}`).join(", ")}`
      : "No candidate plan satisfied hard constraints");
    this.name = "PlanCompilationError";
  }
}

/** Stable UUID used only as the legacy DomainAction row identity. It is derived
 * from immutable plan identity, so a crash between revision selection and action
 * insertion cannot duplicate the same semantic node. */
export function deterministicPlanActionId(planRevisionId: string, planNodeId: string): string {
  const hex = createHash("sha256").update(`${planRevisionId}:${planNodeId}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function domainPolicy(row: typeof domainPolicyRevisions.$inferSelect): DomainPolicy {
  return {
    id: row.policyId,
    tenantId: row.tenantId,
    actionType: row.actionType,
    policy: row.policy as Record<string, unknown>,
    requiresConfirmation: row.requiresConfirmation,
    confirmationTemplate: row.confirmationTemplate,
    modelProvider: row.modelProvider ?? undefined,
    confirmationTimeoutHours: row.confirmationTimeoutHours ?? undefined,
    version: row.version,
  };
}

function toDomainAction(row: typeof domainActions.$inferSelect): DomainAction {
  return {
    id: row.id,
    tenantId: row.tenantId,
    actionType: row.actionType,
    payload: row.payload as Record<string, unknown>,
    policyId: row.policyId,
    policyVersion: row.policyVersion,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    workId: row.workId,
    plannerAttemptId: row.plannerAttemptId,
    planRevisionId: row.planRevisionId,
    planNodeId: row.planNodeId,
    initiatedBy: row.initiatedBy,
    authorityDecisionId: row.authorityDecisionId,
    authorityRevision: row.authorityRevision,
    authorityContext: row.authorityContext as Record<string, unknown>,
    objectiveStepId: row.objectiveStepId,
    businessEffectId: row.businessEffectId,
    groundedPayload: row.groundedPayload as DomainAction["groundedPayload"],
    compiledGraph: row.compiledGraph as DomainAction["compiledGraph"],
  };
}

export interface MaterializedPlan {
  planRevisionId: string;
  planRevision: number;
  planSemanticHash: string;
  actions: DomainAction[];
}

export interface SelectedPlanRevision {
  planRevisionId: string;
  planRevision: number;
  planSemanticHash: string;
  graph: NonNullable<NonNullable<PlanningResult["compilation"]["selected"]>["graph"]>;
}

/** The only CandidatePlan selection persistence boundary. */
export async function selectPlanRevision(params: {
  planning: PlanningResult;
  tenantContext: TenantContext;
  workId: string;
  workInputId: string;
  plannerAttemptId: string;
  instructionId?: string;
  objectiveLoopId?: string | null;
  parentRevisionId?: string | null;
  reason?: "initial" | "observation" | "failure" | "stale" | "timeout" | "redirect";
}): Promise<SelectedPlanRevision> {
  const selected = params.planning.compilation.selected;
  if (!selected?.graph) {
    await recordRejectedWorkPlan({
      tenantId: params.tenantContext.tenantId,
      workId: params.workId,
      plannerAttemptId: params.plannerAttemptId,
      objectiveLoopId: params.objectiveLoopId ?? null,
      goalSpec: params.planning.goal,
      constraintSet: params.planning.constraints,
      planningSnapshot: params.planning.snapshot,
      candidatePlans: params.planning.candidates,
      compilationResult: params.planning.compilation,
    });
    throw new PlanCompilationError(params.planning.compilation.candidates.flatMap((candidate) => candidate.violations));
  }

  const revision = await persistSelectedWorkPlan({
    tenantId: params.tenantContext.tenantId,
    workId: params.workId,
    workInputId: params.workInputId,
    plannerAttemptId: params.plannerAttemptId,
    objectiveLoopId: params.objectiveLoopId ?? null,
    parentRevisionId: params.parentRevisionId ?? null,
    reason: params.reason ?? "initial",
    goalSpec: params.planning.goal,
    constraintSet: params.planning.constraints,
    planningSnapshot: params.planning.snapshot,
    candidatePlans: params.planning.candidates,
    compilationResult: params.planning.compilation,
    planGraph: selected.graph,
    score: selected.score,
    semanticHash: selected.graph.semanticHash,
  });
  return { planRevisionId: revision.id, planRevision: revision.revision, planSemanticHash: revision.semanticHash, graph: selected.graph };
}

/** The sole PlanGraph -> DomainAction adapter. Compatibility columns are derived
 * from the immutable graph; no caller may inject an independent Action[] plan. */
export async function selectAndMaterializePlan(params: Parameters<typeof selectPlanRevision>[0]): Promise<MaterializedPlan> {
  const selectedRevision = await selectPlanRevision(params);
  const selected = params.planning.compilation.selected!;
  const revision = { id: selectedRevision.planRevisionId, revision: selectedRevision.planRevision, semanticHash: selectedRevision.planSemanticHash };

  const actionNodes = selectedRevision.graph.nodes.filter((node): node is PlanActionNode => node.kind === "action");
  if (actionNodes.length === 0) {
    return { planRevisionId: revision.id, planRevision: revision.revision, planSemanticHash: revision.semanticHash, actions: [] };
  }

  const rows = await withTenant(params.tenantContext.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${workPlanRevisions} WHERE ${workPlanRevisions.id}=${revision.id} AND ${workPlanRevisions.tenantId}=${params.tenantContext.tenantId} FOR UPDATE`);
    const [currentRevision] = await db.select({ status: workPlanRevisions.status, semanticHash: workPlanRevisions.semanticHash }).from(workPlanRevisions).where(and(
      eq(workPlanRevisions.tenantId, params.tenantContext.tenantId),
      eq(workPlanRevisions.id, revision.id),
      eq(workPlanRevisions.workId, params.workId),
    )).limit(1);
    const [work] = await db.select({ status: works.status }).from(works).where(and(eq(works.tenantId, params.tenantContext.tenantId), eq(works.id, params.workId))).limit(1);
    const [input] = await db.select({ id: workInputs.id }).from(workInputs).where(and(eq(workInputs.tenantId, params.tenantContext.tenantId), eq(workInputs.workId, params.workId)))
      .orderBy(desc(workInputs.createdAt), desc(workInputs.id)).limit(1);
    if (currentRevision?.status !== "active" || currentRevision.semanticHash !== revision.semanticHash) throw new Error("PlanRevision was superseded before materialization");
    if (!work || ["cancelled", "completed", "failed"].includes(work.status)) throw new Error(`Work is ${work?.status ?? "missing"}; plan materialization is forbidden`);
    if (input?.id !== params.workInputId) throw new Error("WorkInput changed before plan materialization");
    const actionTypes = [...new Set(actionNodes.map((node) => node.actionType))];
    const policyRows = await db.select().from(domainPolicyRevisions).where(and(
      eq(domainPolicyRevisions.tenantId, params.tenantContext.tenantId),
      inArray(domainPolicyRevisions.actionType, actionTypes),
      lte(domainPolicyRevisions.effectiveFrom, new Date()),
    )).orderBy(desc(domainPolicyRevisions.effectiveFrom), desc(domainPolicyRevisions.version));
    const policies = new Map(policyRows
      .filter((row, index, all) => all.findIndex((candidate) => candidate.actionType === row.actionType) === index)
      .map((row) => [row.actionType, domainPolicy(row)]));
    const actionIdByNode = new Map(actionNodes.map((node) => [node.id, deterministicPlanActionId(revision.id, node.id)]));
    const values = [];
    for (const node of actionNodes) {
      const policy = policies.get(node.actionType);
      const snapshotPolicy = params.planning.snapshot.policyRefs.find((ref) => ref.actionType === node.actionType);
      const currentPolicyHash = policy?.version ? sha256({ actionType: policy.actionType, policyId: policy.id, version: policy.version, policy: policy.policy, requiresConfirmation: policy.requiresConfirmation }) : null;
      if ((snapshotPolicy && snapshotPolicy.semanticHash !== currentPolicyHash) || (!snapshotPolicy && policy?.version)) {
        throw new PlanCompilationError([{ code: "POLICY_CONFLICT", candidateKey: selected.candidateKey, nodeKey: node.id, message: "Effective policy changed before PlanGraph materialization" }]);
      }
      const requiresConfirmation = node.authority === "approval_required" || policy?.requiresConfirmation === true;
      const grounding = await groundEntitiesWithDb(db, params.tenantContext.tenantId, node.payload);
      if (grounding.some((field) => field.status !== "verified")) {
        throw new PlanCompilationError([{ code: "UNGROUNDED_REFERENCE", candidateKey: selected.candidateKey, nodeKey: node.id, message: "Grounding changed before PlanGraph materialization" }]);
      }
      values.push({
        id: actionIdByNode.get(node.id)!,
        tenantId: params.tenantContext.tenantId,
        actionType: node.actionType,
        payload: node.groundedPayload,
        policyId: policy?.id || null,
        policyVersion: policy?.version ?? null,
        status: "draft" as const,
        groundedPayload: grounding,
        compiledGraph: buildCommandGraph(node.actionType, requiresConfirmation),
        planId: revision.id,
        dependsOn: node.dependsOn.flatMap((dependency) => actionIdByNode.get(dependency) ?? []),
        predictedReceipt: node.predictedReceipt,
        instructionId: params.instructionId ?? null,
        workId: params.workId,
        plannerAttemptId: params.plannerAttemptId,
        planRevisionId: revision.id,
        planNodeId: node.id,
        initiatedBy: params.tenantContext.employeeId ?? (/^[0-9a-f-]{36}$/i.test(params.tenantContext.userId) ? params.tenantContext.userId : null),
      });
    }
    await db.insert(domainActions).values(values).onConflictDoNothing();
    return db.select().from(domainActions).where(and(
      eq(domainActions.tenantId, params.tenantContext.tenantId),
      eq(domainActions.planRevisionId, revision.id),
    ));
  });
  const byNode = new Map(rows.map((row) => [row.planNodeId, row]));
  const ordered = actionNodes.map((node) => byNode.get(node.id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
  if (ordered.length !== actionNodes.length) throw new Error("PlanGraph materialization did not produce exactly one DomainAction per action node");
  return {
    planRevisionId: revision.id,
    planRevision: revision.revision,
    planSemanticHash: revision.semanticHash,
    actions: ordered.map(toDomainAction),
  };
}
