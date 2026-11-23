import { isDeepStrictEqual } from "node:util";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  readWorkInputResponse, users, withTenant, workInputs, workObjectiveLoops,
  workObjectiveSteps, workPlanRevisions, workQueryExecutions, works,
} from "@finnor/db";
import {
  EconomicReadReplySchema, EconomicReadRequestSchema, economicReadAcceptanceRequests,
  type EconomicReadRequest, type Role, type TenantContext,
} from "@finnor/shared-types";
import { PeDomainError } from "@finnor/private-equity/src/types";
import { assertEconomicReadReplayAccess } from "@finnor/private-equity/src/economic-reads/reader";
import { requestsPositiveInstructionEffect } from "./instruction-effects";

const unavailable = () => new PeDomainError("PE_ENTITY_NOT_FOUND", "The original authenticated Objective read is unavailable.");

export function economicObjectiveRequestsPositiveEffect(instruction: string, requests: readonly EconomicReadRequest[] | null): boolean {
  const names = (requests ?? []).flatMap(request => request.intent === "company_revenue"
    ? request.company.kind === "NAME" ? [request.company.name] : []
    : request.instrument.kind === "NAME" ? [request.instrument.name] : []);
  const spans: Array<readonly [number, number]> = [];
  for (const name of names) {
    // A short entity name must not erase letters inside a positive effect verb.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu");
    for (const match of instruction.matchAll(pattern)) spans.push([match.index, match.index + match[0].length]);
  }
  return requestsPositiveInstructionEffect(instruction, spans);
}

/** Resolve the original human from the canonical accepted input/loop, not the
 * current Work owner, a queued actor field, or a service-role fallback. */
export async function originalEconomicObjectiveContext(tenantId: string, workId: string, loopId: string) {
  return withTenant(tenantId, async db => {
    const [loop] = await db.select().from(workObjectiveLoops).where(and(
      eq(workObjectiveLoops.tenantId, tenantId), eq(workObjectiveLoops.id, loopId), eq(workObjectiveLoops.workId, workId))).limit(1);
    const [input] = await db.select().from(workInputs).where(and(
      eq(workInputs.tenantId, tenantId), eq(workInputs.workId, workId)))
      .orderBy(desc(workInputs.createdAt), desc(workInputs.id)).limit(1);
    const [work] = await db.select().from(works).where(and(eq(works.tenantId, tenantId), eq(works.id, workId))).limit(1);
    const [principal] = input?.createdBy ? await db.select({ id: users.id, role: users.role }).from(users).where(and(
      eq(users.tenantId, tenantId), eq(users.id, input.createdBy), eq(users.status, "active"))).limit(1) : [];
    if (!loop || !work || !input || !principal || loop.createdBy !== principal.id || input.instructionText !== loop.objective
        || !economicReadAcceptanceRequests(loop.successCondition)
        || economicObjectiveRequestsPositiveEffect(input.instructionText, economicReadAcceptanceRequests(loop.successCondition))) throw unavailable();
    const ctx: TenantContext = { tenantId, userId: principal.id, employeeId: principal.id,
      role: principal.role as Role, correlationId: workId };
    return { ctx, input, work, loop };
  });
}

/** Authenticated private retrieval. An ID is only a selector; the existing owner
 * checks the original principal, entire native origin and complete receipt. */
export async function readObjectiveEconomicQueryReply(
  ctx: TenantContext,
  scope: { workId: string; workInputId: string; objectiveStepId: string },
) {
  try {
    const owned = await readWorkInputResponse({ tenantId: ctx.tenantId, userId: ctx.userId, ...scope });
    const reply = EconomicReadReplySchema.parse(owned.response), receipt = owned.queryExecutions[0];
    if (!owned.origin || !isDeepStrictEqual(reply.objective, owned.origin) || owned.queryExecutions.length !== 1
        || !receipt || receipt.status !== "succeeded" || receipt.objectiveStepId !== scope.objectiveStepId
        || reply.workId !== scope.workId || reply.workInputId !== scope.workInputId
        || reply.instructionId !== owned.input.instructionId || reply.objective?.originalPrincipalId !== ctx.userId
        || receipt.id !== reply.query.result.execution.id || receipt.executionKey !== reply.query.result.execution.executionKey
        || receipt.workId !== scope.workId || receipt.workInputId !== scope.workInputId
        || receipt.intent !== reply.query.request.intent || !isDeepStrictEqual(receipt.request, reply.query.request)) throw unavailable();
    await assertEconomicReadReplayAccess({ auth: ctx, provenance: { sourceSystem: "POSTZ.W1:objective-private-replay" } },
      reply.query.request, reply.query.result.economicRead);
    return reply;
  } catch { throw unavailable(); }
}

/** Verification reuses a completed native query, never executes another query
 * under the human's input-only slot or copies its private facts into evidence. */
export async function economicObjectiveQueryObservation(params: {
  tenantId: string; workId: string; loopId: string; request: EconomicReadRequest; criterionIndex: number;
}) {
  const original = await originalEconomicObjectiveContext(params.tenantId, params.workId, params.loopId);
  const request = EconomicReadRequestSchema.parse(params.request);
  const accepted = economicReadAcceptanceRequests(original.loop.successCondition);
  if (!Number.isSafeInteger(params.criterionIndex) || params.criterionIndex < 0
      || !accepted || !isDeepStrictEqual(accepted[params.criterionIndex], request)) throw unavailable();
  const rows = await withTenant(params.tenantId, db => db.select({
    stepId: workObjectiveSteps.id, inputId: workPlanRevisions.workInputId,
  }).from(workObjectiveSteps)
    .innerJoin(workPlanRevisions, and(eq(workPlanRevisions.tenantId, params.tenantId),
      eq(workPlanRevisions.id, workObjectiveSteps.planRevisionId)))
    .innerJoin(workQueryExecutions, and(eq(workQueryExecutions.tenantId, params.tenantId),
      eq(workQueryExecutions.id, workObjectiveSteps.queryExecutionId),
      eq(workQueryExecutions.objectiveStepId, workObjectiveSteps.id)))
    .where(and(eq(workObjectiveSteps.tenantId, params.tenantId), eq(workObjectiveSteps.workId, params.workId),
      eq(workObjectiveSteps.objectiveLoopId, params.loopId), eq(workObjectiveSteps.objectiveRevision, original.loop.revision),
      eq(workObjectiveSteps.executionState, "completed"), isNotNull(workObjectiveSteps.completedAt),
      eq(workPlanRevisions.objectiveLoopId, params.loopId), eq(workPlanRevisions.workInputId, original.input.id),
      inArray(workPlanRevisions.status, ["active", "completed"]), eq(workQueryExecutions.status, "succeeded"),
      eq(workQueryExecutions.intent, request.intent), eq(workQueryExecutions.request, request),
      sql`EXISTS(SELECT 1 FROM jsonb_array_elements(${workPlanRevisions.planGraph}->'nodes') n
        WHERE n->>'id'=${workObjectiveSteps.planNodeId} AND n->>'kind'='query'
          AND (n->'supports') ? (${workPlanRevisions.goalSpec}->'criteria'->${params.criterionIndex}::int->>'id'))`))
      .orderBy(desc(workPlanRevisions.revision), desc(workObjectiveSteps.stepNumber)).limit(1));
  if (rows.length !== 1) throw unavailable();
  const reply = await readObjectiveEconomicQueryReply(original.ctx, { workId: params.workId,
    workInputId: rows[0]!.inputId, objectiveStepId: rows[0]!.stepId });
  if (!isDeepStrictEqual(reply.query.request, request)) throw unavailable();
  return { status: reply.query.result.status, execution: { id: reply.query.result.execution.id, status: "succeeded" as const } };
}
