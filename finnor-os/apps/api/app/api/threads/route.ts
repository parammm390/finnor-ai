import { createEmployeeConversationThread, listEmployeeConversationThreads } from "@finnor/db";
import { resolveCanonicalHumanPrincipal } from "@finnor/orchestration";
import { errorResponse, requireContext } from "../../../lib/auth";
import { CreateThreadSchema } from "../../../lib/product-control-schemas";

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const employeeId = await resolveCanonicalHumanPrincipal(ctx);
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 30) || 30, 100));
    const threads = await listEmployeeConversationThreads(ctx.tenantId, employeeId, limit);
    return Response.json({ threads });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("canonical_human_principal")) return Response.json({ error: error.message }, { status: 403 });
    return errorResponse(error);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const employeeId = await resolveCanonicalHumanPrincipal(ctx);
    const parsed = CreateThreadSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: parsed.error.issues.map((issue) => issue.message).join("; ") }, { status: 400 });
    const thread = await createEmployeeConversationThread({ tenantId: ctx.tenantId, ownerEmployeeId: employeeId, title: parsed.data.title, workId: parsed.data.workId });
    return Response.json({ thread }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "conversation_work_not_found") return Response.json({ error: "Work not found" }, { status: 404 });
    if (error instanceof Error && error.message.startsWith("canonical_human_principal")) return Response.json({ error: error.message }, { status: 403 });
    return errorResponse(error);
  }
}
