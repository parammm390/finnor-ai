import { StartObjectiveSchema } from "@finnor/policy-schema";
import { errorResponse, requireContext } from "../../../lib/auth";
import { getOrchestrator } from "../../../lib/orchestrator";
import { requireWorkerFleetReady } from "../../../lib/worker-readiness";
import { receiveWork, recordWorkResponse, transitionWork, workAggregate } from "@finnor/db";
import { ensureObjectiveIterationDelivery, linkEmployeeConversationTurnToWork, OperatingInteractionContextError, parseObjectiveSuccessCondition, persistEmployeeAssistantTurn, prepareEmployeeConversationTurn, resolveOperatingInteractionContext } from "@finnor/orchestration";
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
  const message = error instanceof Error ? error.message : "Objective processing failed";
  const failure = { message, recoverable: true, at: new Date().toISOString() };
  // Only a Work that is still at the intake boundary may be failed here. The
  // expected status prevents a late setup error from relabelling a Work whose
  // objective orchestration already committed progress.
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
    error: error instanceof Error ? error.message : "Objective processing failed",
    recoverable: true,
    workId: received.workId,
    workInputId: received.workInputId,
    instructionId: received.instructionId,
  }, { status });
}

type ProjectionWarning = {
  stage: string;
  code: "projection_persistence_failed";
};

function reportAncillaryProjectionFailure(warnings: ProjectionWarning[], stage: string, error: unknown): void {
  console.error(`[POST /api/objectives] ${stage} projection failed`, error instanceof Error ? error.message : String(error));
  warnings.push({ stage, code: "projection_persistence_failed" });
}

function storedResponse(finalOutcome: unknown): Record<string, unknown> | undefined {
  if (!finalOutcome || typeof finalOutcome !== "object" || Array.isArray(finalOutcome)) return undefined;
  const response = (finalOutcome as { response?: unknown }).response;
  return response && typeof response === "object" && !Array.isArray(response) ? response as Record<string, unknown> : undefined;
}

function duplicateWithoutObjectiveReplay(
  received: { workId: string; workInputId: string; instructionId: string },
  status: string,
): Response {
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  const failed = status === "failed";
  return Response.json({
    error: failed
      ? "Work failed before an objective loop or replayable response was committed; retry the Work explicitly."
      : terminal
        ? "Work reached a terminal state without an objective loop or replayable response."
        : "Work is already claimed and has no objective loop or replayable response yet.",
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

/** Accept responsibility for a persistent governed objective. The request only
 * commits Work/controller state and queues one bounded iteration; it never runs a
 * long autonomous loop inside the serverless request. */
export async function POST(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const parsed = StartObjectiveSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: parsed.error.issues.map((issue) => issue.message).join("; ") }, { status: 400 });
    const instructionId = parsed.data.instructionId ?? randomUUID();
    // Claim durable Work and its first input immediately after auth/schema
    // validation. Context, conversation, authority, and objective setup follow it.
    const received = await receiveWork({
      tenantId: ctx.tenantId,
      instruction: parsed.data.objective,
      channel: parsed.data.channel,
      sessionId: parsed.data.sessionId,
      instructionId,
      workId: parsed.data.workId,
      userId: ctx.employeeId ?? ctx.userId,
      idempotencyKey: parsed.data.idempotencyKey,
      // Tenant ownership is established by resolveOperatingInteractionContext
      // after this claim; the initial Work row must not store unverified refs.
      activeContext: undefined,
      authorityContext: intakeAuthorityContext(ctx),
    });
    if (received.duplicate) {
      // Replays must not create another conversation turn or re-enter objective
      // setup. The response projection is replayable from Work.finalOutcome; a
      // durable objective loop is the only other safe canonical fallback.
      let replay = storedResponse(received.finalOutcome);
      let aggregate: Awaited<ReturnType<typeof workAggregate>> = null;
      const replayObjective = replay?.objective && typeof replay.objective === "object" && !Array.isArray(replay.objective);
      if (!replayObjective) {
        aggregate = await workAggregate(ctx.tenantId, received.workId).catch(() => null);
        replay = storedResponse(aggregate?.work && typeof aggregate.work === "object" ? (aggregate.work as { finalOutcome?: unknown }).finalOutcome : undefined);
      }
      if (replay && replay.objective && typeof replay.objective === "object" && !Array.isArray(replay.objective)) {
        const objectiveLoopId = (replay.objective as { objectiveLoopId?: unknown }).objectiveLoopId;
        if (typeof objectiveLoopId === "string") {
          await ensureObjectiveIterationDelivery(ctx.tenantId, objectiveLoopId, ctx.correlationId);
        }
        replay = {
          ...replay,
          objective: { ...(replay.objective as Record<string, unknown>), duplicate: true },
        };
        return Response.json(replay, { status: 200 });
      }
      const objectiveLoop = aggregate?.objectiveLoop;
      if (objectiveLoop) {
        await ensureObjectiveIterationDelivery(ctx.tenantId, objectiveLoop.id, ctx.correlationId);
        return Response.json({
          objective: {
            workId: received.workId,
            workInputId: received.workInputId,
            instructionId: received.instructionId,
            objectiveLoopId: objectiveLoop.id,
            state: objectiveLoop.state,
            duplicate: true,
          },
        }, { status: 200 });
      }
      const aggregateStatus = aggregate?.work && typeof aggregate.work === "object" && typeof (aggregate.work as { status?: unknown }).status === "string"
        ? (aggregate.work as { status: string }).status
        : received.status;
      return duplicateWithoutObjectiveReplay(received, aggregateStatus);
    }
    try {
      await requireWorkerFleetReady();
    } catch (error) {
      return await recoverableWorkError(error, ctx.tenantId, received, 503, { code: "worker_fleet_unavailable" });
    }
    let activeContext = parsed.data.activeContext;
    try {
      activeContext = await resolveOperatingInteractionContext({
        tenantId: ctx.tenantId,
        context: parsed.data.activeContext,
        channel: parsed.data.channel,
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
        threadId: parsed.data.threadId,
        instruction: parsed.data.objective,
        instructionId: received.instructionId,
        idempotencyKey: parsed.data.idempotencyKey,
        channel: parsed.data.channel,
        transportSessionId: parsed.data.sessionId,
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
        source: parsed.data.channel,
        selectedEntities: prepared.context.resolution.resolvedReferences.map(({ entityType, entityId }) => ({ entityType, entityId })),
        excludedEntities: [],
        surface: { id: "home", route: "/jarvis", spatialState: "canvas" },
        filters: [],
      };
    }
    if (prepared.context.resolution.status === "clarification_required") {
      let clarified;
      try {
        clarified = await getOrchestrator().handleInstructionResult(parsed.data.objective, humanCtx, {
          channel: parsed.data.channel,
          sessionId: parsed.data.sessionId,
          instructionId: received.instructionId,
          workId: received.workId,
          workInputId: received.workInputId,
          idempotencyKey: parsed.data.idempotencyKey,
          activeContext,
          conversationContext: prepared.context,
          instructionRouteDecision: { version: 1, route: "ATOMIC_EFFECT", reasonCodes: ["phase6_reference_or_sender_ambiguous"] },
          skipFastReadClassification: true,
        });
      } catch (error) {
        return await recoverableWorkError(error, ctx.tenantId, received);
      }
      const clarifiedWorkId = clarified.workId ?? received.workId;
      const clarifiedWorkInputId = clarified.workInputId ?? received.workInputId;
      try {
        await linkEmployeeConversationTurnToWork({ tenantId: ctx.tenantId, employeeId: prepared.employeeId, threadId: prepared.threadId, userMessageId: prepared.userMessage.id, workId: clarifiedWorkId, workInputId: clarifiedWorkInputId });
      } catch (error) {
        reportAncillaryProjectionFailure(projectionWarnings, "clarification link", error);
      }
      const action = clarified.actions.find((candidate) => candidate.actionType === "clarification_request");
      const text = typeof action?.payload.question === "string" ? action.payload.question : prepared.context.resolution.clarificationQuestion ?? "Which current target should I use?";
      const clarificationResponse: Record<string, unknown> = { planned: clarified.actions, clarification: prepared.context.resolution, threadId: prepared.threadId, workId: clarifiedWorkId, workInputId: clarifiedWorkInputId, instructionId: received.instructionId, projectionWarnings };
      try {
        const assistantMessage = await persistEmployeeAssistantTurn({ tenantId: ctx.tenantId, employeeId: prepared.employeeId, threadId: prepared.threadId, instructionId: received.instructionId, channel: parsed.data.channel, text, workId: clarifiedWorkId, workInputId: clarifiedWorkInputId, outcomeRefs: clarified.actions.map((item) => ({ kind: "domain_action", id: item.id, status: item.status })) });
        clarificationResponse.assistantMessage = assistantMessage;
      } catch (error) {
        reportAncillaryProjectionFailure(projectionWarnings, "clarification assistant message", error);
      }
      try {
        await recordWorkResponse(ctx.tenantId, received.workId, clarificationResponse);
      } catch (error) {
        reportAncillaryProjectionFailure(projectionWarnings, "clarification response", error);
      }
      return Response.json(clarificationResponse, { status: 200 });
    }
    const budgets = parsed.data.budgets;
    let result;
    try {
      result = await getOrchestrator().startObjective(parsed.data.objective, humanCtx, {
        channel: parsed.data.channel,
        sessionId: parsed.data.sessionId,
        instructionId: received.instructionId,
        workId: received.workId,
        workInputId: received.workInputId,
        idempotencyKey: parsed.data.idempotencyKey,
        activeContext,
        successCondition: parsed.data.successCondition ? parseObjectiveSuccessCondition(parsed.data.successCondition) : undefined,
        maxSteps: budgets?.maxSteps,
        maxActions: budgets?.maxActions,
        maxQueries: budgets?.maxQueries,
        maxPlannerFailures: budgets?.maxPlannerFailures,
        maxConsecutiveNoProgress: budgets?.maxConsecutiveNoProgress,
        deadlineAt: budgets?.deadlineAt ? new Date(budgets.deadlineAt) : undefined,
      });
    } catch (error) {
      return await recoverableWorkError(error, ctx.tenantId, received);
    }
    try {
      await linkEmployeeConversationTurnToWork({ tenantId: ctx.tenantId, employeeId: prepared.employeeId, threadId: prepared.threadId, userMessageId: prepared.userMessage.id, workId: result.workId, workInputId: result.workInputId, objectiveLoopId: result.objectiveLoopId });
    } catch (error) {
      reportAncillaryProjectionFailure(projectionWarnings, "objective link", error);
    }
    const objectiveResponse = {
      objective: {
        ...result,
        workId: received.workId,
        workInputId: received.workInputId,
        instructionId: received.instructionId,
        duplicate: result.duplicate || received.duplicate,
      },
      threadId: prepared.threadId,
      projectionWarnings,
    };
    try {
      const assistantMessage = await persistEmployeeAssistantTurn({ tenantId: ctx.tenantId, employeeId: prepared.employeeId, threadId: prepared.threadId, instructionId: received.instructionId, channel: parsed.data.channel, text: "I started durable Work for this objective. I’ll report progress from verified outcomes and ask before any required approval.", workId: received.workId, workInputId: received.workInputId, outcomeRefs: [{ kind: "objective_loop", id: result.objectiveLoopId, state: result.state }, { kind: "work", id: received.workId }] });
      Object.assign(objectiveResponse, { assistantMessage });
    } catch (error) {
      reportAncillaryProjectionFailure(projectionWarnings, "assistant message", error);
    }
    try {
      await recordWorkResponse(ctx.tenantId, received.workId, objectiveResponse);
    } catch (error) {
      reportAncillaryProjectionFailure(projectionWarnings, "response", error);
    }
    return Response.json(objectiveResponse, { status: objectiveResponse.objective.duplicate ? 200 : 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
