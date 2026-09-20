import { z } from "zod";
import { initiateCompensation } from "@finnor/workflow-runtime";
import { authorizeRuntimeControl, errorResponse, requireContext } from "../../../../../../lib/auth";

const BodySchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(4_000),
  controlKey: z.string().trim().min(1).max(512).optional(),
});

const STATUS_BY_REASON: Record<string, number> = {
  not_found: 404,
  version_conflict: 409,
  illegal_state: 409,
  unsupported_compensation: 409,
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const ctx = await requireContext(req);
    if (!z.string().uuid().safeParse(id).success) return Response.json({ error: "Invalid workflow-step id" }, { status: 400 });
    const body = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) return Response.json({ error: "expectedVersion and a non-empty reason are required" }, { status: 400 });
    const authority = await authorizeRuntimeControl(ctx, "workflow_step", id);
    if (authority.outcome !== "allowed") {
      return Response.json({ error: `Your role (${ctx.role}) cannot initiate compensation` }, { status: 403 });
    }
    const result = await initiateCompensation(ctx.tenantId, id, {
      actorId: ctx.userId,
      authorityDecisionId: authority.id,
      expectedVersion: body.data.expectedVersion,
      reason: body.data.reason,
      ...(body.data.controlKey ? { controlKey: body.data.controlKey } : {}),
    });
    if (!result.initiated) {
      return Response.json({ error: result.reason }, { status: STATUS_BY_REASON[result.reason] ?? 409 });
    }
    return Response.json({ initiated: true, compensationCaseId: result.compensationCaseId });
  } catch (error) {
    return errorResponse(error);
  }
}
