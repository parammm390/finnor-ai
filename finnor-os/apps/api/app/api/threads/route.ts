import { createEmployeeConversationThread, pageEmployeeConversationThreads } from "@finnor/db";
import { resolveCanonicalHumanPrincipal } from "@finnor/orchestration";
import { errorResponse, requireContext } from "../../../lib/auth";
import { CreateThreadSchema } from "../../../lib/product-control-schemas";

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const employeeId = await resolveCanonicalHumanPrincipal(ctx);
    const url = new URL(req.url);
    const rawLimit = url.searchParams.get("limit");
    const requestedLimit = rawLimit === null ? 30 : Number(rawLimit);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
      return Response.json({ error: "Invalid Investigations page limit" }, { status: 400 });
    }
    const page = await pageEmployeeConversationThreads({
      tenantId: ctx.tenantId, ownerEmployeeId: employeeId,
      limit: Math.min(requestedLimit, 100),
      ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") ?? "" } : {}),
    });
    return Response.json(page, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_CONVERSATION_PAGE_CURSOR") return Response.json({ error: "Invalid Investigations page cursor" }, { status: 400 });
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
