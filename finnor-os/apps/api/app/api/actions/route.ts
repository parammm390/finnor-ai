// POST /api/actions — submit a new instruction (voice transcript or text) (§8).

import { SubmitInstructionSchema } from "@finnor/policy-schema";
import { requireContext, errorResponse, enforceRouteRateLimit } from "../../../lib/auth";
import { getOrchestrator } from "../../../lib/orchestrator";
import { enforceBatchBackpressure } from "../../../lib/backpressure";
import { requireWorkerFleetReady } from "../../../lib/worker-readiness";
import { receiveWork, attachValidatedWorkInputContext, recordWorkResponse, readWorkInputResponse, transitionWork, workAggregate, withTenant, workEvents, domainActions, businessEffects, WorkQueryInProgressError } from "@finnor/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { EconomicReadReplySchema } from "@finnor/shared-types";
import { classifyInstructionRoute, interactionAwareOperationalDecision, interpretOperationalQuery, isConversationalTurn, OperatingInteractionContextError, resolveOperatingInteractionContext } from "@finnor/orchestration";
import { linkEmployeeConversationTurnToWork, persistEmployeeAssistantTurn, prepareEmployeeConversationTurn } from "@finnor/orchestration";
import { randomUUID } from "node:crypto";
import { assertEconomicReadReplyAccess, storedEconomicQuery, answerEconomicQuery, economicReadForInput } from "@finnor/orchestration";
import { PeDomainError } from "@finnor/private-equity/src/types";

function intakeAuthorityContext(ctx: {
  userId: string;
  employeeId?: string;
  authorityRevision?: number;
  authorityRoles?: string[];
  role: string;
}): Record<string, unknown> {
  if (!ctx.employeeId && ctx.userId.startsWith("system:")) return { principal: ctx.userId, kind: "service" };
  return {
    employeeId: ctx.employeeId ?? null,
    revision: ctx.authorityRevision ?? null,
    roles: ctx.authorityRoles ?? [ctx.role],
    principal: ctx.userId,
  };
}

function statusFromError(error: unknown, fallback = 500): number {
  const status = error && typeof error === "object" && "status" in error ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" && status >= 400 && status <= 599 ? status : fallback;
}

async function recoverableWorkError(
  error: unknown,
  tenantId: string,
  received: { workId: string; workInputId: string; instructionId: string },
  status = statusFromError(error),
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const message = error instanceof Error ? error.message : "Instruction processing failed";
  const failure = { message, recoverable: true, at: new Date().toISOString() };
  // Only a Work that is still at the intake boundary may be failed here. The
  // expected status prevents a late pre-orchestration error from relabelling a
  // Work whose core orchestration already committed progress.
  await transitionWork(tenantId, received.workId, "failed", "intake_pre_orchestration_failed", {
    message,
    recoverable: true,
  }, {
    failure,
    expectedWorkInputId: received.workInputId,
    expectedStatus: "received",
  }).catch(() => undefined);
  return Response.json({
    ...extra,
    error: message,
    recoverable: true,
    workId: received.workId,
    workInputId: received.workInputId,
    instructionId: received.instructionId,
  }, { status });
}

type ProjectionWarning = {
  stage: string;
  code: "projection_persistence_failed" | "projection_missing_on_replay";
};

function reportAncillaryProjectionFailure(warnings: ProjectionWarning[], stage: string, error: unknown): void {
  console.error(`[POST /api/actions] ${stage} projection failed`, error instanceof Error ? error.message : String(error));
  warnings.push({ stage, code: "projection_persistence_failed" });
}

function storedResponse(finalOutcome: unknown): Record<string, unknown> | undefined {
  if (!finalOutcome || typeof finalOutcome !== "object" || Array.isArray(finalOutcome)) return undefined;
  const response = (finalOutcome as { response?: unknown }).response;
  return response && typeof response === "object" && !Array.isArray(response) ? response as Record<string, unknown> : undefined;
}

function aggregateReplay(
  received: { workId: string; workInputId: string; instructionId: string },
  aggregate: Awaited<ReturnType<typeof workAggregate>>,
): Record<string, unknown> | undefined {
  if (!aggregate?.work || typeof aggregate.work !== "object") return undefined;
  const actions = Array.isArray(aggregate.actions) ? aggregate.actions.filter(action => action && typeof action === "object" && action.instructionId === received.instructionId) : [];
  // A Work's current loop/outcome may belong to a later input. Only children
  // carrying this input's instruction identity can support degraded replay.
  if (actions.length === 0) return undefined;
  return {
    planned: actions,
    workId: received.workId,
    workInputId: received.workInputId,
    instructionId: received.instructionId,
    replayDegraded: true,
    projectionWarnings: [{ stage: "response", code: "projection_missing_on_replay" } satisfies ProjectionWarning],
  };
}

function duplicateWithoutReplay(
  received: { workId: string; workInputId: string; instructionId: string },
  status: string,
): Response {
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  const failed = status === "failed";
  return Response.json({
    error: failed
      ? "Work failed before a replayable response was committed; retry the Work explicitly."
      : terminal
        ? "Work reached a terminal state without a replayable response."
        : "Work is already claimed and has no replayable response yet.",
    recoverable: failed,
    inProgress: !terminal,
    retryRequired: failed,
    workId: received.workId,
    workInputId: received.workInputId,
    instructionId: received.instructionId,
    status,
    duplicate: true,
  }, { status: failed ? 409 : terminal ? 500 : 202 });
}

function assistantText(result: Awaited<ReturnType<ReturnType<typeof getOrchestrator>["handleInstructionResult"]>>): string {
  if (result.answer?.spokenSummary) return result.answer.spokenSummary;
  const clarification = result.actions.find((action) => action.actionType === "clarification_request");
  if (clarification && typeof clarification.payload.question === "string") return clarification.payload.question;
  if (result.objective) return "I started durable Work for this objective. I’ll report progress from verified outcomes and ask before any required approval.";
  if (result.query) return "I completed the current-data query. The structured result is linked to this thread.";
  if (result.actions.length > 0) return `I prepared ${result.actions.length} action${result.actions.length === 1 ? "" : "s"} in Work. Nothing is represented as completed unless its execution receipt verifies it.`;
  return "I recorded this turn, but no business action was created.";
}

export async function POST(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const body = SubmitInstructionSchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) {
      // Invalid/unknown intake cannot be proven to be a deterministic read, so it
      // remains in the tighter intake bucket. This preserves the existing abuse
      // boundary while valid classified reads bypass planner-only throttling.
      await enforceRouteRateLimit(`intake:${ctx.tenantId}`, Number(process.env.RATE_LIMIT_INTAKE_PER_MINUTE ?? 20));
      return Response.json(
        { error: body.error.issues.map((i) => i.message).join("; ") },
        { status: 400 },
      );
    }
    const instructionId = body.data.instructionId ?? randomUUID();
    // The Work/Input claim is the first durable operation after auth and schema
    // validation. Everything below it is enrichment, policy, or orchestration and
    // must be recoverable from these identifiers if it fails.
    const received = await receiveWork({
      tenantId: ctx.tenantId,
      instruction: body.data.instruction,
      channel: body.data.channel,
      sessionId: body.data.sessionId,
      instructionId,
      workId: body.data.workId,
      userId: ctx.employeeId ?? ctx.userId,
      idempotencyKey: body.data.idempotencyKey,
      // The request context is structurally schema-validated above, but its
      // tenant ownership is only established by resolveOperatingInteractionContext.
      // Do not persist it on the initial claim before that check succeeds.
      activeContext: undefined,
      authorityContext: intakeAuthorityContext(ctx),
    });
    if (received.duplicate) {
      // A duplicate is already a durable claim. Replay its stored response (or a
      // bounded aggregate fallback) before context, conversation, classification,
      // rate limiting, or any other fallible/mutating enrichment can run again.
      let aggregate: Awaited<ReturnType<typeof workAggregate>> = null;
      const owned = await readWorkInputResponse({ tenantId: ctx.tenantId, userId: ctx.userId,
        workId: received.workId, workInputId: received.workInputId });
      const financial = owned.queryExecutions.length > 0 || economicReadForInput(owned.input.instructionText) !== null
        || /^Typed operational query:\s*(?:company_revenue|stock_quote)\b/.test(owned.input.instructionText);
      let replay = storedResponse(received.finalOutcome) ?? storedResponse({ response: owned.response });
      if (financial) {
        const query = storedEconomicQuery(owned.response);
        if (owned.response && !query) return Response.json({ code: "ECONOMIC_READ_UNAVAILABLE",
          error: "The complete original financial reply is unavailable." }, { status: 404, headers: { "Cache-Control": "no-store" } });
        if (query) {
          // A strict canonical reply is complete by design, not a lost HTTP
          // envelope. Only a real recorded ancillary failure degrades its replay.
          const canonical = EconomicReadReplySchema.safeParse(owned.response).success;
          const [warning] = await withTenant(ctx.tenantId, db => db.select({ id: workEvents.id }).from(workEvents).where(and(
            eq(workEvents.tenantId, ctx.tenantId), eq(workEvents.workId, received.workId),
            eq(workEvents.eventType, "economic_read_projection_degraded"),
            sql`${workEvents.payload}->>'workInputId'=${received.workInputId}`)).limit(1));
          replay = { ...replay, planned: [], query, answer: answerEconomicQuery(query),
            workId: received.workId, workInputId: received.workInputId, instructionId: received.instructionId,
            ...(warning || !canonical && (!replay || !("planned" in replay)) ? { replayDegraded: true,
              projectionWarnings: [{ stage: "response", code: warning ? "projection_persistence_failed" : "projection_missing_on_replay" }] } : {}) };
        }
      }
      if (!replay && !financial) {
        aggregate = await workAggregate(ctx.tenantId, received.workId).catch(() => null);
        replay = aggregateReplay(received, aggregate);
      }
      if (!replay) {
        const aggregateStatus = aggregate?.work && typeof aggregate.work === "object" && typeof (aggregate.work as { status?: unknown }).status === "string"
          ? (aggregate.work as { status: string }).status
          : received.status;
        return duplicateWithoutReplay(received, aggregateStatus);
      }
      try { await assertEconomicReadReplyAccess(ctx, replay, received); }
      catch (error) {
        if (error instanceof PeDomainError && error.code === "PE_ENTITY_NOT_FOUND")
          return Response.json({ code: "ECONOMIC_READ_UNAVAILABLE", error: "The economic read is unavailable under current source and permissions. Request a new read." },
            { status: 404, headers: { "Cache-Control": "no-store" } });
        throw error;
      }
      const replayResponse = {
        ...replay,
        ...(aggregate?.work ? { work: aggregate.work } : { work: { id: received.workId, status: received.status } }),
        duplicate: true,
      };
      const replayQuery = (replayResponse as Record<string, unknown>).query as { metadata?: { durationMs?: number } } | undefined;
      return Response.json(replayResponse, {
        status: received.status === "completed" || received.status === "failed" || received.status === "cancelled" ? 200 : 202,
        headers: { "Cache-Control": "no-store", ...(replayQuery?.metadata?.durationMs === undefined ? {}
          : { "Server-Timing": `query;dur=${Number(replayQuery.metadata.durationMs).toFixed(1)}` }) },
      });
    }
    let activeContext = body.data.activeContext;
    try {
      activeContext = await resolveOperatingInteractionContext({
        tenantId: ctx.tenantId,
        context: body.data.activeContext,
        channel: body.data.channel,
        workId: received.workId,
      });
    } catch (error) {
      if (error instanceof OperatingInteractionContextError) {
        return await recoverableWorkError(error, ctx.tenantId, received, error.status, { code: error.code });
      }
      return await recoverableWorkError(error, ctx.tenantId, received);
    }
    let prepared;
    try {
      prepared = await prepareEmployeeConversationTurn({
        ctx,
        threadId: body.data.threadId,
        instruction: body.data.instruction,
        instructionId: received.instructionId,
        workId: received.workId,
        workInputId: received.workInputId,
        idempotencyKey: body.data.idempotencyKey,
        channel: body.data.channel,
        transportSessionId: body.data.sessionId,
        activeContext,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "conversation_context_failed";
      const status = message === "conversation_thread_not_found" ? 404 : message.startsWith("canonical_human_principal") ? 403 : 500;
      return await recoverableWorkError(error, ctx.tenantId, received, status);
    }
    const humanCtx = { ...ctx, userId: prepared.employeeId, employeeId: prepared.employeeId };
    const projectionWarnings: ProjectionWarning[] = [];
    if (prepared.context.resolution.status !== "clarification_required" && prepared.context.resolution.resolvedReferences.length > 0) {
      // Persist canonical conversation resolution alongside an existing Deal
      // selection. Otherwise a later worker loses the named party while the
      // Thread still claims that identity was resolved.
      const base = activeContext ?? {
        version: 1 as const, capturedAt: new Date().toISOString(), source: body.data.channel,
        selectedEntities: [], excludedEntities: [],
        surface: { id: "home" as const, route: "/centropy", spatialState: "canvas" as const }, filters: [],
      };
      const excluded = new Set(base.excludedEntities.map((ref) => `${ref.entityType}:${ref.entityId}`));
      const selected = new Map(base.selectedEntities.map((ref) => [`${ref.entityType}:${ref.entityId}`, ref]));
      for (const { entityType, entityId } of prepared.context.resolution.resolvedReferences) {
        if (base.businessRoot?.entityType === entityType && base.businessRoot.entityId === entityId) continue;
        if (!excluded.has(`${entityType}:${entityId}`)) selected.set(`${entityType}:${entityId}`, { entityType, entityId });
      }
      try {
        activeContext = await resolveOperatingInteractionContext({ tenantId: ctx.tenantId,
          context: { ...base, selectedEntities: [...selected.values()] }, channel: body.data.channel, workId: received.workId });
      } catch (error) {
        return await recoverableWorkError(error, ctx.tenantId, received);
      }
    }
    if (activeContext) {
      try {
        await attachValidatedWorkInputContext({
          tenantId: ctx.tenantId,
          workId: received.workId,
          workInputId: received.workInputId,
          context: activeContext,
        });
      } catch (error) {
        return await recoverableWorkError(error, ctx.tenantId, received);
      }
    }
    let fastReadDecision;
    let instructionRouteDecision;
    try {
      // Classify once before planner-only gates. Authentication and the generic
      // authenticated-route limiter already ran in requireContext; this tighter
      // intake bucket and batch backpressure are reserved for planner work.
      fastReadDecision = interactionAwareOperationalDecision(interpretOperationalQuery(body.data.instruction), activeContext, body.data.instruction);
      instructionRouteDecision = classifyInstructionRoute({ instruction: body.data.instruction, fastReadDecision, activeContext,
        conversational: fastReadDecision.route === "fast_read" && (fastReadDecision.request.intent === "company_revenue" || fastReadDecision.request.intent === "stock_quote")
          ? false : isConversationalTurn(body.data.instruction, { conversationContext: prepared.context, instructionId: received.instructionId }) });
      if (instructionRouteDecision.route !== "QUERY") {
        await enforceRouteRateLimit(`intake:${ctx.tenantId}`, Number(process.env.RATE_LIMIT_INTAKE_PER_MINUTE ?? 20));
      }
    } catch (error) {
      return await recoverableWorkError(error, ctx.tenantId, received);
    }
    if (body.data.reviewBeforeExecution && instructionRouteDecision.route === "OBJECTIVE") {
      return recoverableWorkError(
        new Error("Exact-effect review is not available for a long-running objective."),
        ctx.tenantId,
        received,
        409,
        { code: "objective_review_unavailable" },
      );
    }
    if (instructionRouteDecision.route === "OBJECTIVE" || instructionRouteDecision.route === "ATOMIC_EFFECT") {
      try {
        await requireWorkerFleetReady();
      } catch (error) {
        return await recoverableWorkError(error, ctx.tenantId, received, 503, { code: "worker_fleet_unavailable" });
      }
    }
    try {
      await linkEmployeeConversationTurnToWork({
        tenantId: ctx.tenantId,
        employeeId: prepared.employeeId,
        threadId: prepared.threadId,
        userMessageId: prepared.userMessage.id,
        workId: received.workId,
        workInputId: received.workInputId,
      });
    } catch (error) {
      reportAncillaryProjectionFailure(projectionWarnings, "user-turn link", error);
    }
    let result: Awaited<ReturnType<ReturnType<typeof getOrchestrator>["handleInstructionResult"]>>;
    try {
      if (instructionRouteDecision.route === "ATOMIC_EFFECT" || instructionRouteDecision.route === "CONVERSATION") {
        // This Work is already durably accepted. Pressure may affect the worker or
        // governed provider schedule, but it must never turn into a 429/drop here.
        await enforceBatchBackpressure({
          tenantId: ctx.tenantId,
          workloadClass: "INTERACTIVE",
          phase: "after_acceptance",
          obligationKind: "required",
        });
      }
      result = await getOrchestrator().handleInstructionResult(body.data.instruction, humanCtx, {
        sessionId: body.data.sessionId,
        instructionId: received.instructionId,
        workId: received.workId,
        workInputId: received.workInputId,
        idempotencyKey: body.data.idempotencyKey,
        channel: body.data.channel,
        reviewBeforeExecution: body.data.reviewBeforeExecution,
        activeContext,
        conversationContext: prepared.context,
        fastReadDecision,
        instructionRouteDecision,
        skipFastReadClassification: true,
      });
    } catch (err) {
      if (err instanceof WorkQueryInProgressError) return Response.json({ error: err.message, workId: received.workId,
        workInputId: received.workInputId, instructionId: received.instructionId, duplicate: true, inProgress: true },
        { status: 202, headers: { "Cache-Control": "no-store" } });
      const financial = fastReadDecision.route === "fast_read" && (fastReadDecision.request.intent === "company_revenue" || fastReadDecision.request.intent === "stock_quote");
      const message = financial ? "The original economic read could not be completed; retry its original Work explicitly."
        : err instanceof Error ? err.message : "Instruction processing failed";
      const timeout = /\b(?:timeout|timed out|deadline|aborted?)\b/i.test(message) || (err instanceof Error && err.name === "AbortError");
      const failedWork = await workAggregate(ctx.tenantId, received.workId).catch(() => null);
      if ((failedWork?.work as { status?: string } | undefined)?.status !== "failed") {
        await transitionWork(ctx.tenantId, received.workId, "failed", "intake_processing_failed", {
          message,
          recoverable: true,
        }, { failure: { message, recoverable: true, at: new Date().toISOString() }, expectedWorkInputId: received.workInputId }).catch(() => undefined);
      }
      return Response.json({
        error: message,
        recoverable: true,
        workId: received.workId,
        workInputId: received.workInputId,
        instructionId: received.instructionId,
      }, { status: financial && err instanceof PeDomainError && err.code === "PE_ENTITY_NOT_FOUND" ? 404 : timeout ? 504 : statusFromError(err),
        headers: financial ? { "Cache-Control": "no-store" } : undefined });
    }

    // Core orchestration has committed its own durable truth above. Assistant
    // messages, conversation links, and the exact response replay are ancillary
    // projections: a failure in one must be visible in logs but cannot turn a
    // successful Work into an HTTP/core failure or relabel it failed.
    const preparedEffects = body.data.reviewBeforeExecution && result.actions.length ? await withTenant(ctx.tenantId, async (db) => {
      const actionIds = result.actions.map((action) => action.id);
      const [actionRows, effectRows] = await Promise.all([
        db.select({ id: domainActions.id, actionType: domainActions.actionType, status: domainActions.status, summary: domainActions.summary, businessEffectId: domainActions.businessEffectId })
          .from(domainActions).where(and(eq(domainActions.tenantId, ctx.tenantId), inArray(domainActions.id, actionIds))),
        db.select({ id: businessEffects.id, domainActionId: businessEffects.domainActionId, semanticHash: businessEffects.semanticHash, effect: businessEffects.effect })
          .from(businessEffects).where(and(eq(businessEffects.tenantId, ctx.tenantId), inArray(businessEffects.domainActionId, actionIds))),
      ]);
      const actionById = new Map(actionRows.map((action) => [action.id, action]));
      const effectByActionId = new Map(effectRows.flatMap((effect) => effect.domainActionId ? [[effect.domainActionId, effect] as const] : []));
      return actionIds.map((id) => {
        const action = actionById.get(id);
        const effect = effectByActionId.get(id);
        return { actionId: id, actionType: action?.actionType ?? null, status: action?.status ?? "unavailable", summary: action?.summary ?? null,
          businessEffectId: effect?.id ?? null, semanticHash: effect?.semanticHash ?? null, businessEffect: effect?.effect ?? null };
      });
    }) : undefined;
    const response = {
      planned: result.actions,
      ...(preparedEffects ? { prepared: preparedEffects } : {}),
      ...(result.answer ? { answer: result.answer } : {}),
      ...(result.query ? { query: result.query } : {}),
      ...(result.objective ? { objective: result.objective } : {}),
      workId: received.workId,
      workInputId: received.workInputId,
      instructionId: received.instructionId,
      threadId: prepared.threadId,
      projectionWarnings,
    };
    const responseText = assistantText(result);
    const financialResult = result.query?.request.intent === "company_revenue" || result.query?.request.intent === "stock_quote";
    const projectionError = (error: unknown) => financialResult ? new Error("Ancillary financial read projection failed") : error;
    const outcomeRefs: Array<Record<string, unknown>> = [
      { kind: "work", id: received.workId },
      { kind: "work_input", id: received.workInputId },
      ...result.actions.map((action) => ({ kind: "domain_action", id: action.id, status: action.status })),
      ...(result.objective ? [{ kind: "objective_loop", id: result.objective.objectiveLoopId, state: result.objective.state }] : []),
      ...(result.query ? [{ kind: "work_query", intent: result.query.request.intent, asOf: result.query.result.asOf }] : []),
    ];
    try {
      const assistantMessage = await persistEmployeeAssistantTurn({
        tenantId: ctx.tenantId,
        employeeId: prepared.employeeId,
        threadId: prepared.threadId,
        instructionId: received.instructionId,
        channel: body.data.channel,
        text: responseText,
        workId: received.workId,
        workInputId: received.workInputId,
        outcomeRefs,
        referenceText: `Outcome recorded for Work ${received.workId} (input ${received.workInputId}); ${outcomeRefs.length} reference(s). Financial detail is available after a current authorization check.`,
      });
      Object.assign(response, { assistantMessage });
    } catch (error) {
      reportAncillaryProjectionFailure(projectionWarnings, "assistant message", projectionError(error));
    }
    try {
      await linkEmployeeConversationTurnToWork({
        tenantId: ctx.tenantId,
        employeeId: prepared.employeeId,
        threadId: prepared.threadId,
        userMessageId: prepared.userMessage.id,
        workId: received.workId,
        workInputId: received.workInputId,
        ...(result.objective ? { objectiveLoopId: result.objective.objectiveLoopId } : {}),
      });
    } catch (error) {
      reportAncillaryProjectionFailure(projectionWarnings, "objective link", projectionError(error));
    }
    try {
      await recordWorkResponse({ tenantId: ctx.tenantId, workId: received.workId, workInputId: received.workInputId, userId: ctx.employeeId ?? ctx.userId }, response);
    } catch (error) {
      reportAncillaryProjectionFailure(projectionWarnings, "response", projectionError(error));
      if (financialResult) await transitionWork(ctx.tenantId, received.workId, "completed", "economic_read_projection_degraded",
        { workInputId: received.workInputId, stage: "response", code: "projection_persistence_failed" },
        { expectedWorkInputId: received.workInputId, expectedStatus: "completed" }).catch(() => undefined);
    }
    return Response.json(response, {
      status: result.objective ? 202 : 201,
      headers: result.query ? { "Server-Timing": `query;dur=${result.query.metadata.durationMs.toFixed(1)}`,
        ...(financialResult ? { "Cache-Control": "no-store" } : {}) } : undefined,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
