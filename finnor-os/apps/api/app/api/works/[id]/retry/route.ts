import { claimWorkRecovery, WorkTransitionConflictError, workAggregate } from "@finnor/db";
import { z } from "zod";
import { errorResponse, requireContext } from "../../../../../lib/auth";
import { getOrchestrator } from "../../../../../lib/orchestrator";

const RetryWorkSchema = z.object({ idempotencyKey: z.string().min(1).max(200) });

/** Re-enters the ordinary planner with the same durable Work/input. The retry key is
 * a unique planner-attempt claim, so repeated recovery clicks never execute twice. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  let requestContext: Awaited<ReturnType<typeof requireContext>> | null = null;
  let workId: string | null = null;
  try {
    const { id } = await params;
    workId = id;
    const ctx = await requireContext(req);
    requestContext = ctx;
    const body = RetryWorkSchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) return Response.json({ error: body.error.issues.map((issue) => issue.message).join("; ") }, { status: 400 });
    const attemptKey = `retry:${body.data.idempotencyKey}`;
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
    if (err instanceof WorkTransitionConflictError) return Response.json({ error: err.message }, { status: 409 });
    if (err instanceof Error && err.message === "Work not found") return Response.json({ error: err.message }, { status: 404 });
    return errorResponse(err);
  }
}
