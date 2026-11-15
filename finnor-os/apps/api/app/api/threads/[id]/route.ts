import { loadEmployeeConversationThread } from "@finnor/db";
import { resolveCanonicalHumanPrincipal, hydrateEmployeeConversationAnswers } from "@finnor/orchestration";
import { errorResponse, requireContext } from "../../../../lib/auth";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const employeeId = await resolveCanonicalHumanPrincipal(ctx);
    const { id } = await params;
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 200));
    const before = Number(url.searchParams.get("beforeSequence") ?? 0) || undefined;
    const loaded = await loadEmployeeConversationThread({
      tenantId: ctx.tenantId,
      ownerEmployeeId: employeeId,
      threadId: id,
      messageLimit: limit,
      beforeSequence: before,
    });
    if (!loaded) return Response.json({ error: "conversation_thread_not_found" }, { status: 404 });
    return Response.json(await hydrateEmployeeConversationAnswers(ctx, loaded, req.signal),
      { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("canonical_human_principal")) return Response.json({ error: error.message }, { status: 403 });
    return errorResponse(error);
  }
}
