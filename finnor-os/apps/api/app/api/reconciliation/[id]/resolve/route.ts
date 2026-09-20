import { z } from "zod";
import { resolveReconciliationCase } from "@finnor/workflow-runtime";
import { authorizeRuntimeControl, errorResponse, requireContext } from "../../../../../lib/auth";

const BodySchema = z.object({
  expectedVersion: z.number().int().positive(),
  outcome: z.enum([
    "happened_as_intended",
    "definitely_did_not_happen",
    "happened_differently",
    "still_unknowable",
    "legally_compensatable",
  ]),
  evidence: z.object({}).passthrough().refine((value) => Object.keys(value).length > 0, "resolution evidence is required"),
  reason: z.string().trim().min(1).max(4_000),
  provider: z.string().trim().min(1).max(160).optional(),
  integrationId: z.string().uuid().optional(),
  controlKey: z.string().trim().min(1).max(512).optional(),
});

const STATUS_BY_REASON: Record<string, number> = {
  not_found: 404,
  not_open: 409,
  version_conflict: 409,
  evidence_required: 400,
  account_mismatch: 409,
  still_unresolved: 409,
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    const ctx = await requireContext(req);
    if (!z.string().uuid().safeParse(id).success) return Response.json({ error: "Invalid reconciliation case id" }, { status: 400 });
    const body = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) return Response.json({ error: "Invalid evidence-bearing reconciliation resolution" }, { status: 400 });
    const authority = await authorizeRuntimeControl(ctx, "reconciliation_case", id);
    if (authority.outcome !== "allowed") {
      return Response.json({ error: `Your role (${ctx.role}) cannot resolve reconciliation cases` }, { status: 403 });
    }
    const result = await resolveReconciliationCase(ctx.tenantId, id, {
      actorId: ctx.userId,
      authorityDecisionId: authority.id,
      expectedVersion: body.data.expectedVersion,
      outcome: body.data.outcome,
      evidence: body.data.evidence,
      reason: body.data.reason,
      ...(body.data.provider ? { provider: body.data.provider } : {}),
      ...(body.data.integrationId ? { integrationId: body.data.integrationId } : {}),
      ...(body.data.controlKey ? { controlKey: body.data.controlKey } : {}),
    });
    if (!result.resolved) {
      return Response.json({ error: result.reason }, { status: STATUS_BY_REASON[result.reason] ?? 409 });
    }
    return Response.json({ resolved: true, version: result.version });
  } catch (error) {
    return errorResponse(error);
  }
}
