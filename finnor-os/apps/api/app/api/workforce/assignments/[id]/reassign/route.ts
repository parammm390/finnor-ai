import { z } from "zod";
import { reassignWorkforceAssignment } from "@finnor/orchestration";
import { AuthError, errorResponse, requireContext } from "../../../../../../lib/auth";

export const runtime = "nodejs";

const IdSchema = z.string().uuid();
const ReassignSchema = z.object({ note: z.string().trim().min(1).max(2_000).optional() }).strict();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const id = IdSchema.safeParse((await params).id);
    const body = ReassignSchema.safeParse(await req.json().catch(() => ({})));
    if (!id.success || !body.success) {
      return Response.json({ error: "A valid assignment id and optional bounded note are required" }, { status: 400, headers: { "cache-control": "no-store" } });
    }
    try {
      const assignment = await reassignWorkforceAssignment({ tenantId: ctx.tenantId, assignmentId: id.data, actor: ctx, ...body.data });
      return Response.json({ assignment }, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof Error && /human employee|human authority/i.test(error.message)) {
        throw new AuthError("Current employee lacks workforce reassignment authority", 403);
      }
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}
