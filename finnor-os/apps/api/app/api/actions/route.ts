// POST /api/actions — submit a new instruction (voice transcript or text) (§8).

import { SubmitInstructionSchema } from "@finnor/policy-schema";
import { requireContext, errorResponse, enforceRouteRateLimit } from "../../../lib/auth";
import { getOrchestrator } from "../../../lib/orchestrator";
import { enforceBatchBackpressure } from "../../../lib/backpressure";
import { requireWorkerFleetReady } from "../../../lib/worker-readiness";
import { receiveWork, recordWorkResponse, transitionWork, workAggregate } from "@finnor/db";
import { classifyInstructionRoute, interactionAwareOperationalDecision, interpretOperationalQuery, isConversationalTurn, OperatingInteractionContextError, resolveOperatingInteractionContext } from "@finnor/orchestration";
import { linkEmployeeConversationTurnToWork, persistEmployeeAssistantTurn, prepareEmployeeConversationTurn } from "@finnor/orchestration";
import { randomUUID } from "node:crypto";

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
  const finalOutcome = (aggregate.work as { finalOutcome?: unknown }).finalOutcome;
  const outcome = finalOutcome && typeof finalOutcome === "object" && !Array.isArray(finalOutcome)
    ? finalOutcome as Record<string, unknown>
    : undefined;
  const actions = Array.isArray(aggregate.actions) ? aggregate.actions : [];
  const objectiveLoop = aggregate.objectiveLoop;
  if (actions.length === 0 && !objectiveLoop && !outcome) return undefined;
  return {
    planned: actions,
    ...(outcome?.query && typeof outcome.query === "object" ? { query: outcome.query } : {}),
    ...(objectiveLoop ? {
      objective: {
        objectiveLoopId: objectiveLoop.id,
        state: objectiveLoop.state,
        route: "OBJECTIVE",
      },
    } : {}),
    ...(outcome && !outcome.query ? { outcome } : {}),
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
      let replay = storedResponse(received.finalOutcome);
      if (!replay) {
        aggregate = await workAggregate(ctx.tenantId, received.workId).catch(() => null);
        replay = storedResponse(aggregate?.work && typeof aggregate.work === "object" ? (aggregate.work as { finalOutcome?: unknown }).finalOutcome : undefined);
        replay ??= aggregateReplay(received, aggregate);
      }
      if (!replay) {
        const aggregateStatus = aggregate?.work && typeof aggregate.work === "object" && typeof (aggregate.work as { status?: unknown }).status === "string"
          ? (aggregate.work as { status: string }).status
          : received.status;
        return duplicateWithoutReplay(received, aggregateStatus);
      }
      const replayResponse = {
        ...replay,
        ...(aggregate?.work ? { work: aggregate.work } : { work: { id: received.workId, status: received.status } }),
        duplicate: true,
      };
      const replayQuery = (replayResponse as Record<string, unknown>).query as { metadata?: { durationMs?: number } } | undefined;
      return Response.json(replayResponse, {
        status: received.status === "completed" || received.status === "failed" || received.status === "cancelled" ? 200 : 202,
        headers: replayQuery?.metadata?.durationMs === undefined ? undefined : { "Server-Timing": `query;dur=${Number(replayQuery.metadata.durationMs).toFixed(1)}` },
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
    if (!activeContext && prepared.context.resolution.resolvedReferences.length > 0) {
      activeContext = {
        version: 1,
        capturedAt: new Date().toISOString(),
        source: body.data.channel,
        selectedEntities: prepared.context.resolution.resolvedReferences.map(({ entityType, entityId }) => ({ entityType, entityId })),
        excludedEntities: [],
        surface: { id: "home", route: "/jarvis", spatialState: "canvas" },
        filters: [],
      };
    }
    let fastReadDecision;
    let instructionRouteDecision;
    try {
      // Classify once before planner-only gates. Authentication and the generic
      // authenticated-route limiter already ran in requireContext; this tighter
      // intake bucket and batch backpressure are reserved for planner work.
      fastReadDecision = interactionAwareOperationalDecision(interpretOperationalQuery(body.data.instruction), activeContext);
      instructionRouteDecision = classifyInstructionRoute({ instruction: body.data.instruction, fastReadDecision, activeContext, conversational: isConversationalTurn(body.data.instruction) });
      if (instructionRouteDecision.route !== "QUERY") {
        await enforceRouteRateLimit(`intake:${ctx.tenantId}`, Number(process.env.RATE_LIMIT_INTAKE_PER_MINUTE ?? 20));
      }
    } catch (error) {
      return await recoverableWorkError(error, ctx.tenantId, received);
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
      if (instructionRouteDecision.route === "ATOMIC_EFFECT" || instructionRouteDecision.route === "CONVERSATION") await enforceBatchBackpressure();
      result = await getOrchestrator().handleInstructionResult(body.data.instruction, humanCtx, {
        sessionId: body.data.sessionId,
        instructionId: received.instructionId,
        workId: received.workId,
        workInputId: received.workInputId,
        idempotencyKey: body.data.idempotencyKey,
        channel: body.data.channel,
        activeContext,
        conversationContext: prepared.context,
        fastReadDecision,
        instructionRouteDecision,
        skipFastReadClassification: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Instruction processing failed";
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
      }, { status: timeout ? 504 : 500 });
    }

    // Core orchestration has committed its own durable truth above. Assistant
    // messages, conversation links, and the exact response replay are ancillary
    // projections: a failure in one must be visible in logs but cannot turn a
    // successful Work into an HTTP/core failure or relabel it failed.
    const response = {
      planned: result.actions,
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
      });
      Object.assign(response, { assistantMessage });
    } catch (error) {
      reportAncillaryProjectionFailure(projectionWarnings, "assistant message", error);
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
      reportAncillaryProjectionFailure(projectionWarnings, "objective link", error);
    }
    try {
      await recordWorkResponse(ctx.tenantId, received.workId, response);
    } catch (error) {
      reportAncillaryProjectionFailure(projectionWarnings, "response", error);
    }
    return Response.json(response, {
      status: result.objective ? 202 : 201,
      headers: result.query ? { "Server-Timing": `query;dur=${result.query.metadata.durationMs.toFixed(1)}` } : undefined,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
