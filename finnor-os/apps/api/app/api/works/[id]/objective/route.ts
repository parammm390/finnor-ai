import { receiveWork, WorkTransitionConflictError, workAggregate } from "@finnor/db";
import { ControlObjectiveSchema } from "@finnor/policy-schema";
import { errorResponse, requireContext } from "../../../../../lib/auth";
import { getOrchestrator } from "../../../../../lib/orchestrator";
import { parseObjectiveSuccessCondition } from "@finnor/orchestration";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await params;
    const ctx = await requireContext(req);
    const aggregate = await workAggregate(ctx.tenantId, id);
    if (!aggregate?.objectiveLoop) return Response.json({ error: "Work objective not found" }, { status: 404 });
    return Response.json({ objective: aggregate.objectiveLoop, iterations: aggregate.objectiveSteps, plannerAttempts: aggregate.objectivePlannerAttempts });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await params;
    const ctx = await requireContext(req);
    const parsed = ControlObjectiveSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: parsed.error.issues.map((issue) => issue.message).join("; ") }, { status: 400 });
    if (parsed.data.command === "redirect") {
      await receiveWork({
        tenantId: ctx.tenantId,
        instruction: parsed.data.objective,
        channel: parsed.data.channel,
        instructionId: parsed.data.instructionId,
        workId: id,
        userId: ctx.userId,
        idempotencyKey: parsed.data.idempotencyKey,
        authorityContext: { employeeId: ctx.employeeId ?? null, revision: ctx.authorityRevision ?? null, roles: ctx.authorityRoles ?? [], principal: ctx.userId },
      });
    }
    const objective = await getOrchestrator().controlObjective({
      tenantId: ctx.tenantId,
      workId: id,
      command: parsed.data.command,
      actorId: ctx.userId,
      objective: parsed.data.command === "redirect" ? parsed.data.objective : undefined,
      successCondition: parsed.data.command === "redirect" && parsed.data.successCondition
        ? parseObjectiveSuccessCondition(parsed.data.successCondition)
        : undefined,
      correlationId: ctx.correlationId,
    });
    return Response.json({ objective }, { status: objective.state === "continue" ? 202 : 200 });
  } catch (error) {
    if (error instanceof WorkTransitionConflictError) {
      return Response.json({ error: error.message, code: "work_recovery_required" }, { status: 409 });
    }
    return errorResponse(error);
  }
}
