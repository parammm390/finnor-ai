import { requireContext, errorResponse } from "../../../../../../lib/auth";
import { UpsertPolicySchema } from "@finnor/policy-schema";
import { simulatePolicy } from "@finnor/orchestration";

export async function POST(req: Request, { params }: { params: Promise<{ operation: string; actionType: string }> }): Promise<Response> {
  try {
    const { operation: tenantId, actionType } = await params;
    const ctx = await requireContext(req);
    if (ctx.tenantId !== tenantId || ctx.role !== "owner") return Response.json({ error: "Only this tenant's owner can simulate a policy" }, { status: 403 });
    const body = UpsertPolicySchema.safeParse(await req.json().catch(() => null));
    if (!body.success) return Response.json({ error: "Invalid candidate policy" }, { status: 400 });
    return Response.json({ report: await simulatePolicy(tenantId, actionType, body.data) });
  } catch (err) { return errorResponse(err); }
}
