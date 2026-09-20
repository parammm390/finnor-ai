import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { PlanGraph, PlanNode } from "@finnor/planning";
import {
  businessEffects,
  decisionReceipts,
  domainActions,
  integrationEvents,
  workEventWaits,
  workObjectiveLoops,
  workObjectiveSteps,
  workPlanRevisions,
  workRecoveryDecisions,
  works,
  withTenant,
  type Db,
} from "@finnor/db";
import { decideRecovery, type RecoveryDecision } from "./orchestration-protocol";
import {
  resolvePlanFrontier,
  type HistoricalIrreversibleEffectEvidence,
  type PlanFrontier,
  type PlanProgressInspection,
  type PlanReadyUnit,
} from "./plan-progress";

const EXECUTABLE_WORK_STATES = ["received", "understanding", "actionable", "awaiting_approval", "executing", "recovery"] as const;
const ACTIVE_NODE_STATES = ["scheduled", "claimed", "running", "waiting"] as const;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function graph(value: unknown): PlanGraph {
  const row = object(value);
  if (row.version !== 1 || !Array.isArray(row.nodes) || typeof row.semanticHash !== "string") {
    throw new Error("Persisted PlanRevision does not contain a valid immutable PlanGraph");
  }
  return row as unknown as PlanGraph;
}

function reservationKind(node: PlanNode): "query" | "action" | "wait" | "check" {
  return node.kind;
}

async function inspectionTx(db: Db, tenantId: string, workId: string): Promise<PlanProgressInspection> {
  const actions = await db.select().from(domainActions).where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.workId, workId)));
  const actionIds = actions.map((action) => action.id);
  // One withTenant callback owns one PostgreSQL client/transaction. Keep its
  // statements serial; callers obtain concurrency across independent callbacks.
  const effects = actionIds.length > 0
    ? await db.select().from(businessEffects).where(and(eq(businessEffects.tenantId, tenantId), inArray(businessEffects.domainActionId, actionIds)))
    : [];
  const receipts = await db.select().from(decisionReceipts).where(and(eq(decisionReceipts.tenantId, tenantId), eq(decisionReceipts.workId, workId)));
  const waits = await db.select().from(workEventWaits).where(and(eq(workEventWaits.tenantId, tenantId), eq(workEventWaits.workId, workId)));
  const events = await db.select().from(integrationEvents).where(and(eq(integrationEvents.tenantId, tenantId), eq(integrationEvents.workId, workId)));
  return { actions, businessEffects: effects, receipts, eventWaits: waits, integrationEvents: events };
}

const AMBIGUOUS_EFFECT_STATUSES = new Set(["executing", "executed", "partially_verified", "unverified", "reconciliation_required"]);

function historicalIrreversibleEffects(
  currentPlanRevisionId: string,
  planRows: Array<Pick<typeof workPlanRevisions.$inferSelect, "id" | "planGraph">>,
  inspection: PlanProgressInspection,
): HistoricalIrreversibleEffectEvidence[] {
  const graphByPlan = new Map(planRows.map((row) => [row.id, graph(row.planGraph)]));
  const actionById = new Map(inspection.actions.map(object)
    .flatMap((action) => typeof action.id === "string" ? [[action.id, action] as const] : []));
  return inspection.businessEffects.map(object).flatMap((effect) => {
    const action = typeof effect.domainActionId === "string" ? actionById.get(effect.domainActionId) : undefined;
    const planRevisionId = typeof action?.planRevisionId === "string" ? action.planRevisionId : null;
    const planNodeId = typeof action?.planNodeId === "string" ? action.planNodeId : null;
    const effectId = typeof effect.id === "string" ? effect.id : null;
    const effectStatus = typeof effect.status === "string" ? effect.status : "";
    if (!planRevisionId || !planNodeId || !effectId || planRevisionId === currentPlanRevisionId) return [];
    const node = graphByPlan.get(planRevisionId)?.nodes.find((candidate) => candidate.id === planNodeId);
    if (!node || node.kind !== "action" || !node.irreversible) return [];
    const state = effectStatus === "verified" ? "verified" as const
      : AMBIGUOUS_EFFECT_STATUSES.has(effectStatus) ? "unknown_outcome" as const
        : null;
    if (!state) return [];
    return [{
      nodeSemanticHash: node.semanticHash,
      sourcePlanRevisionId: planRevisionId,
      sourcePlanNodeId: planNodeId,
      sourceObjectiveStepId: action && typeof action.objectiveStepId === "string" ? action.objectiveStepId : null,
      businessEffectId: effectId,
      state,
      effectStatus,
    }];
  }).sort((left, right) => left.nodeSemanticHash.localeCompare(right.nodeSemanticHash)
    || left.sourcePlanRevisionId.localeCompare(right.sourcePlanRevisionId)
    || left.businessEffectId.localeCompare(right.businessEffectId));
}

async function effectReplayEvidenceTx(
  db: Db,
  tenantId: string,
  workId: string,
  currentPlanRevisionId: string,
  inspection?: PlanProgressInspection,
): Promise<HistoricalIrreversibleEffectEvidence[]> {
  const observed = inspection ?? await inspectionTx(db, tenantId, workId);
  const referencedPlanIds = [...new Set(observed.actions.map(object)
    .flatMap((action) => typeof action.planRevisionId === "string" ? [action.planRevisionId] : []))];
  if (referencedPlanIds.length === 0) return [];
  const plans = await db.select({ id: workPlanRevisions.id, planGraph: workPlanRevisions.planGraph })
    .from(workPlanRevisions).where(and(
      eq(workPlanRevisions.tenantId, tenantId),
      eq(workPlanRevisions.workId, workId),
      inArray(workPlanRevisions.id, referencedPlanIds),
    ));
  return historicalIrreversibleEffects(currentPlanRevisionId, plans, observed);
}

/** Dispatch-time defense in depth. Planning and frontier reservation both fence
 * this condition; this read closes the gap when historical effect state changes
 * after selection but before the provider boundary is reached. */
export async function irreversibleEffectReplayFence(params: {
  tenantId: string;
  workId: string;
  currentPlanRevisionId: string;
  nodeSemanticHash: string;
}): Promise<HistoricalIrreversibleEffectEvidence | null> {
  return withTenant(params.tenantId, async (db) => {
    const evidence = await effectReplayEvidenceTx(db, params.tenantId, params.workId, params.currentPlanRevisionId);
    return evidence.find((candidate) => candidate.nodeSemanticHash === params.nodeSemanticHash) ?? null;
  });
}

export interface ReservedPlanNode {
  step: typeof workObjectiveSteps.$inferSelect;
  unit: PlanReadyUnit;
}

export type FrontierReservationResult =
  | { state: "reserved"; planRevisionId: string; objectiveRevision: number; reservations: ReservedPlanNode[]; frontier: Extract<PlanFrontier, { state: "ready" }> }
  | { state: "waiting"; planRevisionId: string; objectiveRevision: number; reservations: []; frontier: Extract<PlanFrontier, { state: "waiting" }> }
  | { state: "exhausted"; planRevisionId: string; objectiveRevision: number; reservations: []; frontier: Extract<PlanFrontier, { state: "exhausted" }> }
  | { state: "recovery"; planRevisionId: string; objectiveRevision: number; reservations: []; frontier: Extract<PlanFrontier, { state: "recovery" }>; recoveryDecision: typeof workRecoveryDecisions.$inferSelect };

async function persistRecoveryTx(params: {
  db: Db;
  tenantId: string;
  workId: string;
  loop: typeof workObjectiveLoops.$inferSelect;
  plan: typeof workPlanRevisions.$inferSelect;
  planGraph: PlanGraph;
  frontier: Extract<PlanFrontier, { state: "recovery" }>;
  steps: Array<typeof workObjectiveSteps.$inferSelect>;
  inspection: PlanProgressInspection;
}): Promise<typeof workRecoveryDecisions.$inferSelect> {
  const activeAttemptNodeId = params.steps
    .filter((candidate) => candidate.completedAt === null && candidate.objectiveRevision === params.loop.revision && candidate.planNodeId)
    .sort((left, right) => left.stepNumber - right.stepNumber || left.id.localeCompare(right.id))[0]?.planNodeId;
  const node = params.planGraph.nodes.find((candidate) => candidate.id === params.frontier.nodeId)
    ?? params.planGraph.nodes.find((candidate) => candidate.id === activeAttemptNodeId)
    ?? [...params.planGraph.nodes].sort((left, right) => left.semanticHash.localeCompare(right.semanticHash))[0];
  if (!node) throw new Error("A recovery transition requires at least one immutable PlanNode");
  const observation = params.frontier.observations.find((candidate) => candidate.nodeId === node.id);
  const step = params.steps.filter((candidate) => candidate.planNodeId === node.id)
    .sort((left, right) => (right.attemptNumber ?? 0) - (left.attemptNumber ?? 0) || right.stepNumber - left.stepNumber)[0];
  const action = step?.domainActionId
    ? params.inspection.actions.map(object).find((candidate) => candidate.id === step.domainActionId)
    : undefined;
  const effect = step?.domainActionId
    ? params.inspection.businessEffects.map(object).find((candidate) => candidate.domainActionId === step.domainActionId)
    : undefined;
  const cause: RecoveryDecision["cause"] = params.frontier.cause === "cancellation" ? "cancellation"
    : params.frontier.cause === "deadline" ? "deadline"
      : params.frontier.cause === "budget" ? "budget"
        : observation?.cause === "unknown_outcome" ? "unknown_outcome"
          : params.frontier.cause;
  const semantic = decideRecovery({
    workId: params.workId,
    objectiveRevision: params.loop.revision,
    planRevisionId: params.plan.id,
    node,
    objectiveStepId: step?.id ?? null,
    recoveryParentStepId: step?.recoveryParentStepId ?? step?.id ?? null,
    attemptNumber: Math.max(1, observation?.attemptNumber ?? step?.attemptNumber ?? 1),
    cause,
    reason: params.frontier.reason,
    verificationState: observation?.verification?.state ?? null,
    deadlineExhausted: params.frontier.cause === "deadline",
    budgetExhausted: params.frontier.cause === "budget",
    cancelled: params.frontier.cause === "cancellation",
    unknownExternalOutcome: observation?.cause === "unknown_outcome" || String(effect?.status ?? "") === "reconciliation_required",
    verifiedIrreversibleEffect: node.kind === "action" && node.irreversible && String(effect?.status ?? "") === "verified",
  });
  const values = {
    tenantId: params.tenantId,
    workId: params.workId,
    objectiveLoopId: params.loop.id,
    objectiveRevision: params.loop.revision,
    planRevisionId: params.plan.id,
    planNodeId: node.id,
    objectiveStepId: step?.id ?? null,
    attemptNumber: semantic.attemptNumber,
    recoveryParentStepId: semantic.recoveryParentStepId,
    authorityDecisionId: step?.authorityDecisionId ?? (typeof action?.authorityDecisionId === "string" ? action.authorityDecisionId : null),
    domainActionId: step?.domainActionId ?? null,
    businessEffectId: typeof effect?.id === "string" ? effect.id : null,
    verificationResult: observation?.verification ?? null,
    decision: semantic.kind,
    cause: semantic.cause,
    reason: semantic.reason,
    context: semantic,
    decisionKey: semantic.decisionKey,
  } as const;
  const [created] = await params.db.insert(workRecoveryDecisions).values(values).onConflictDoNothing({
    target: [workRecoveryDecisions.tenantId, workRecoveryDecisions.decisionKey],
  }).returning();
  if (created) return created;
  const [existing] = await params.db.select().from(workRecoveryDecisions).where(and(
    eq(workRecoveryDecisions.tenantId, params.tenantId),
    eq(workRecoveryDecisions.decisionKey, semantic.decisionKey),
  )).limit(1);
  if (!existing) throw new Error("RecoveryDecision convergence failed");
  return existing;
}

/**
 * The sole PlanGraph -> durable logical-attempt scheduler. It serializes only
 * frontier reservation on the Objective row; workers subsequently claim the
 * independent rows through WorkforceAssignment leases.
 */
export async function reserveReadyPlanFrontier(params: {
  tenantId: string;
  workId: string;
  objectiveLoopId: string;
  expectedObjectiveRevision: number;
  planRevisionId: string;
  controllerStepId?: string;
  maxReady?: number;
}): Promise<FrontierReservationResult> {
  return withTenant(params.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${workObjectiveLoops} WHERE ${workObjectiveLoops.tenantId}=${params.tenantId} AND ${workObjectiveLoops.id}=${params.objectiveLoopId} FOR UPDATE`);
    await db.execute(sql`SELECT id FROM ${workPlanRevisions} WHERE ${workPlanRevisions.tenantId}=${params.tenantId} AND ${workPlanRevisions.id}=${params.planRevisionId} FOR UPDATE`);
    const [loop] = await db.select().from(workObjectiveLoops).where(and(eq(workObjectiveLoops.tenantId, params.tenantId), eq(workObjectiveLoops.id, params.objectiveLoopId))).limit(1);
    const [plan] = await db.select().from(workPlanRevisions).where(and(eq(workPlanRevisions.tenantId, params.tenantId), eq(workPlanRevisions.id, params.planRevisionId), eq(workPlanRevisions.workId, params.workId))).limit(1);
    const [work] = await db.select().from(works).where(and(eq(works.tenantId, params.tenantId), eq(works.id, params.workId))).limit(1);
    if (!loop || loop.workId !== params.workId) throw new Error("Objective/Work reservation scope mismatch");
    if (!plan) throw new Error("PlanRevision is absent from the reservation scope");
    if (!work) throw new Error("Work is absent from the reservation scope");
    if (loop.revision !== params.expectedObjectiveRevision) throw new Error("Objective revision changed before frontier reservation");
    const planGraph = graph(plan.planGraph);
    const steps = await db.select().from(workObjectiveSteps).where(and(
      eq(workObjectiveSteps.tenantId, params.tenantId),
      eq(workObjectiveSteps.objectiveLoopId, loop.id),
      eq(workObjectiveSteps.planRevisionId, plan.id),
    )).orderBy(asc(workObjectiveSteps.stepNumber), asc(workObjectiveSteps.id));
    const inspection = await inspectionTx(db, params.tenantId, params.workId);
    const historicalEffects = await effectReplayEvidenceTx(db, params.tenantId, params.workId, plan.id, inspection);
    const activeSteps = steps.filter((step) => step.completedAt === null && step.objectiveRevision === loop.revision
      && ACTIVE_NODE_STATES.includes((step.executionState ?? "scheduled") as (typeof ACTIVE_NODE_STATES)[number]));
    const activeResourceKeys = activeSteps.flatMap((step) => step.resourceKeys);
    const frontier = resolvePlanFrontier(planGraph, steps, inspection, {
      maxReady: Math.max(1, Math.min(params.maxReady ?? loop.maxParallelNodes, loop.maxParallelNodes)),
      maxConcurrent: loop.maxParallelNodes,
      activeClaims: activeSteps.length,
      remainingActions: Math.max(0, loop.maxActions - loop.actionCount),
      remainingQueries: Math.max(0, loop.maxQueries - loop.queryCount),
      remainingWaits: Math.max(0, loop.maxWaits - loop.waitCount),
      remainingAttempts: Math.max(0, loop.maxNodeAttempts - loop.nodeAttemptCount),
      remainingEstimatedCostMicros: Math.max(0, loop.maxEstimatedCostMicros - loop.reservedEstimatedCostMicros),
      planActive: plan.status === "active",
      workExecutable: EXECUTABLE_WORK_STATES.includes(work.status as (typeof EXECUTABLE_WORK_STATES)[number])
        && !["blocked", "completed", "failed", "cancelled"].includes(loop.state),
      cancelled: work.status === "cancelled" || loop.state === "cancelled",
      now: new Date(),
      deadlineAt: loop.deadlineAt,
      objectiveRevision: loop.revision,
      activeResourceKeys,
      historicalIrreversibleEffects: historicalEffects,
    });
    if (frontier.state === "recovery") {
      const recoveryDecision = await persistRecoveryTx({ db, tenantId: params.tenantId, workId: params.workId, loop, plan, planGraph, frontier, steps, inspection });
      return { state: "recovery", planRevisionId: plan.id, objectiveRevision: loop.revision, reservations: [], frontier, recoveryDecision };
    }
    if (frontier.state === "waiting") return { state: "waiting", planRevisionId: plan.id, objectiveRevision: loop.revision, reservations: [], frontier };
    if (frontier.state === "exhausted") return { state: "exhausted", planRevisionId: plan.id, objectiveRevision: loop.revision, reservations: [], frontier };

    let stepNumber = loop.stepCount;
    const reservations: ReservedPlanNode[] = [];
    const controller = params.controllerStepId
      ? (await db.select().from(workObjectiveSteps).where(and(
          eq(workObjectiveSteps.tenantId, params.tenantId),
          eq(workObjectiveSteps.id, params.controllerStepId),
          eq(workObjectiveSteps.objectiveLoopId, loop.id),
          sql`${workObjectiveSteps.completedAt} IS NULL`,
        )).limit(1))[0]
      : undefined;
    for (const [index, unit] of frontier.ready.entries()) {
      const values = {
        objectiveRevision: loop.revision,
        attemptNumber: unit.attemptNumber,
        executionRole: "node" as const,
        executionState: "scheduled" as const,
        planRevisionId: plan.id,
        planNodeId: unit.node.id,
        recoveryParentStepId: unit.recoveryParentStepId,
        resourceKeys: unit.resourceKeys,
        budgetReservationKind: reservationKind(unit.node),
        estimatedCostReservationMicros: unit.reservation.estimatedCostMicros,
        budgetReservedAt: new Date(),
        phase: "deciding" as const,
        idempotencyKey: `objective:${loop.id}:revision:${loop.revision}:plan:${plan.id}:node:${unit.node.id}:attempt:${unit.attemptNumber}`,
      };
      let reserved: typeof workObjectiveSteps.$inferSelect | undefined;
      if (index === 0 && controller && !controller.planNodeId) {
        [reserved] = await db.update(workObjectiveSteps).set(values).where(and(
          eq(workObjectiveSteps.tenantId, params.tenantId),
          eq(workObjectiveSteps.id, controller.id),
          sql`${workObjectiveSteps.planNodeId} IS NULL`,
          sql`${workObjectiveSteps.completedAt} IS NULL`,
        )).returning();
      } else {
        stepNumber += 1;
        [reserved] = await db.insert(workObjectiveSteps).values({
          tenantId: params.tenantId,
          objectiveLoopId: loop.id,
          workId: params.workId,
          stepNumber,
          ...values,
        }).onConflictDoNothing({ target: [workObjectiveSteps.objectiveLoopId, workObjectiveSteps.idempotencyKey] }).returning();
      }
      if (!reserved) {
        [reserved] = await db.select().from(workObjectiveSteps).where(and(
          eq(workObjectiveSteps.tenantId, params.tenantId),
          eq(workObjectiveSteps.objectiveLoopId, loop.id),
          eq(workObjectiveSteps.idempotencyKey, values.idempotencyKey),
        )).limit(1);
      }
      if (!reserved) throw new Error("Logical PlanNode attempt reservation did not converge");
      reservations.push({ step: reserved, unit });
    }
    const actionReservations = frontier.ready.filter((unit) => unit.node.kind === "action").length;
    const queryReservations = frontier.ready.filter((unit) => unit.node.kind === "query").length;
    const waitReservations = frontier.ready.filter((unit) => unit.node.kind === "wait").length;
    const costReservation = frontier.ready.reduce((sum, unit) => sum + unit.reservation.estimatedCostMicros, 0);
    await db.update(workObjectiveLoops).set({
      stepCount: Math.max(loop.stepCount, ...reservations.map((item) => item.step.stepNumber)),
      actionCount: loop.actionCount + actionReservations,
      queryCount: loop.queryCount + queryReservations,
      waitCount: loop.waitCount + waitReservations,
      nodeAttemptCount: loop.nodeAttemptCount + frontier.ready.length,
      reservedEstimatedCostMicros: loop.reservedEstimatedCostMicros + costReservation,
      state: "continue",
      nextRunAt: null,
      reason: `Reserved ${frontier.ready.length} causally ready PlanNode attempt${frontier.ready.length === 1 ? "" : "s"}.`,
      nextStep: "Governed workers may claim the reserved immutable PlanNodes.",
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: new Date(),
    }).where(and(eq(workObjectiveLoops.tenantId, params.tenantId), eq(workObjectiveLoops.id, loop.id), eq(workObjectiveLoops.revision, loop.revision)));
    return { state: "reserved", planRevisionId: plan.id, objectiveRevision: loop.revision, reservations, frontier };
  });
}

/** Read-only operational projection; it performs no runtime/provider calls. */
export async function inspectOrchestrationKernel(tenantId: string, workId: string): Promise<Record<string, unknown> | null> {
  return withTenant(tenantId, async (db) => {
    const [work] = await db.select().from(works).where(and(eq(works.tenantId, tenantId), eq(works.id, workId))).limit(1);
    const [loop] = await db.select().from(workObjectiveLoops).where(and(eq(workObjectiveLoops.tenantId, tenantId), eq(workObjectiveLoops.workId, workId))).limit(1);
    const [plan] = await db.select().from(workPlanRevisions).where(and(eq(workPlanRevisions.tenantId, tenantId), eq(workPlanRevisions.workId, workId), eq(workPlanRevisions.status, "active"))).limit(1);
    if (!work) return null;
    if (!loop || !plan) return { work, objectiveLoop: loop ?? null, activePlanRevision: plan ?? null, readyFrontier: null };
    const steps = await db.select().from(workObjectiveSteps).where(and(eq(workObjectiveSteps.tenantId, tenantId), eq(workObjectiveSteps.objectiveLoopId, loop.id))).orderBy(asc(workObjectiveSteps.stepNumber), asc(workObjectiveSteps.id));
    const recoveries = await db.select().from(workRecoveryDecisions).where(and(eq(workRecoveryDecisions.tenantId, tenantId), eq(workRecoveryDecisions.workId, workId))).orderBy(asc(workRecoveryDecisions.createdAt), asc(workRecoveryDecisions.id));
    const inspection = await inspectionTx(db, tenantId, workId);
    const activeSteps = steps.filter((step) => step.completedAt === null && step.objectiveRevision === loop.revision);
    const historicalEffects = await effectReplayEvidenceTx(db, tenantId, workId, plan.id, inspection);
    const readyFrontier = resolvePlanFrontier(graph(plan.planGraph), steps, inspection, {
      maxReady: loop.maxParallelNodes,
      maxConcurrent: loop.maxParallelNodes,
      activeClaims: activeSteps.length,
      remainingActions: Math.max(0, loop.maxActions - loop.actionCount),
      remainingQueries: Math.max(0, loop.maxQueries - loop.queryCount),
      remainingWaits: Math.max(0, loop.maxWaits - loop.waitCount),
      remainingAttempts: Math.max(0, loop.maxNodeAttempts - loop.nodeAttemptCount),
      remainingEstimatedCostMicros: Math.max(0, loop.maxEstimatedCostMicros - loop.reservedEstimatedCostMicros),
      planActive: true,
      workExecutable: EXECUTABLE_WORK_STATES.includes(work.status as (typeof EXECUTABLE_WORK_STATES)[number]),
      cancelled: work.status === "cancelled" || loop.state === "cancelled",
      now: new Date(),
      deadlineAt: loop.deadlineAt,
      objectiveRevision: loop.revision,
      activeResourceKeys: activeSteps.flatMap((step) => step.resourceKeys),
      historicalIrreversibleEffects: historicalEffects,
    });
    return {
      work,
      objectiveLoop: loop,
      activePlanRevision: plan,
      planGraph: plan.planGraph,
      readyFrontier,
      logicalAttempts: steps,
      activeClaims: activeSteps,
      waits: inspection.eventWaits,
      actions: inspection.actions,
      businessEffects: inspection.businessEffects,
      historicalIrreversibleEffects: historicalEffects,
      providerAndVerificationEvidence: inspection.receipts,
      recoveryDecisions: recoveries,
      deadlineBudget: {
        deadlineAt: loop.deadlineAt,
        attempts: { used: loop.nodeAttemptCount, max: loop.maxNodeAttempts },
        actions: { used: loop.actionCount, max: loop.maxActions },
        queries: { used: loop.queryCount, max: loop.maxQueries },
        waits: { used: loop.waitCount, max: loop.maxWaits },
        estimatedCostMicros: { reserved: loop.reservedEstimatedCostMicros, max: loop.maxEstimatedCostMicros },
      },
    };
  });
}
