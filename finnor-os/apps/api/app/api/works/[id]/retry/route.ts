import { claimWorkRecovery, WorkTransitionConflictError, workAggregate } from "@finnor/db";
import { z } from "zod";
import { errorResponse, requireContext } from "../../../../../lib/auth";
import { getOrchestrator } from "../../../../../lib/orchestrator";

const RetryWorkSchema = z.object({ idempotencyKey: z.string().min(1).max(200) });

function objectiveRecoveryKey(aggregate: Awaited<ReturnType<typeof workAggregate>>): string | null {
  if (!aggregate?.objectiveLoop || !aggregate.work || typeof aggregate.work !== "object") return null;
  const recovery = (aggregate.work as { recovery?: unknown }).recovery;
  if (!recovery || typeof recovery !== "object") return null;
  const key = (recovery as { attemptKey?: unknown }).attemptKey;
  return typeof key === "string" ? key : null;
}

/** Claims the same durable Work/input before retrying. Objectives resume their
 * existing loop; other Work re-enters the ordinary planner. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  let requestContext: Awaited<ReturnType<typeof requireContext>> | null = null;
  let workId: string | null = null;
  let attemptKey: string | null = null;
  try {
    const { id } = await params;
    workId = id;
    const ctx = await requireContext(req);
    requestContext = ctx;
    const body = RetryWorkSchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) return Response.json({ error: body.error.issues.map((issue) => issue.message).join("; ") }, { status: 400 });
    attemptKey = `retry:${body.data.idempotencyKey}`;
    const prior = await workAggregate(ctx.tenantId, id);
    if (objectiveRecoveryKey(prior) === attemptKey) {
      const status = prior?.work && typeof prior.work === "object"
        ? (prior.work as { status?: unknown }).status : null;
      return Response.json({ work: prior, duplicate: true, activeAttemptKey: attemptKey }, { status: status === "recovery" ? 202 : 200 });
    }
    const claim = await claimWorkRecovery({
      tenantId: ctx.tenantId,
      workId: id,
      requestedBy: ctx.userId,
      attemptKey,
    });
    if (!claim.claimed) return Response.json({
      work: await workAggregate(ctx.tenantId, id),
      duplicate: true,
      activeAttemptKey: claim.activeAttemptKey,
    }, { status: claim.status === "planning" ? 202 : 200 });
    const input = claim.input!;
    const aggregate = await workAggregate(ctx.tenantId, id);
    if (aggregate?.objectiveLoop) {
      const objective = await getOrchestrator().controlObjective({
        tenantId: ctx.tenantId,
        workId: id,
        command: "continue",
        actorId: ctx.userId,
        correlationId: ctx.correlationId,
      });
      return Response.json({ workId: id, instructionId: input.instructionId, recovery: true, objective }, { status: 202 });
    }
    const result = await getOrchestrator().handleInstructionResult(input.instructionText, ctx, {
      workId: id,
      workInputId: input.id,
      instructionId: input.instructionId,
      sessionId: input.sessionId ?? undefined,
      channel: input.channel,
      plannerAttemptKey: attemptKey,
    });
    return Response.json({
      planned: result.actions,
      ...(result.answer ? { answer: result.answer } : {}),
      workId: id,
      instructionId: input.instructionId,
      recovery: true,
    }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && err.name === "PlannerAttemptAlreadyClaimedError" && requestContext && workId) {
      return Response.json({ work: await workAggregate(requestContext.tenantId, workId), duplicate: true }, { status: 202 });
    }
    if (err instanceof WorkTransitionConflictError) {
      // An Objective may already have left recovery after this same request key
      // was accepted. Replay its canonical state instead of encouraging a new
      // retry claim that could schedule duplicate work.
      if (requestContext && workId && attemptKey) {
        const aggregate = await workAggregate(requestContext.tenantId, workId);
        if (objectiveRecoveryKey(aggregate) === attemptKey) {
          return Response.json({ work: aggregate, duplicate: true, activeAttemptKey: attemptKey }, { status: 200 });
        }
      }
      return Response.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof Error && err.message === "Work not found") return Response.json({ error: err.message }, { status: 404 });
    return errorResponse(err);
  }
}
