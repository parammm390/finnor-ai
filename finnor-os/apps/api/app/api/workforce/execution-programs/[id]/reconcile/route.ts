import { requireContext } from "../../../../../../lib/auth";
import { reconcileWorkforceExecution } from "@finnor/orchestration/workforce-execution";
import { z } from "zod";
import { boundedJson, privateHeaders, workforceError } from "../../http";
export const runtime = "nodejs";
const input = z.object({ idempotencyKey: z.string().min(1).max(160),
  expectedRevision: z.number().int().nonnegative() }).strict();
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(req), id = z.string().uuid().parse((await context.params).id);
    return Response.json(await reconcileWorkforceExecution(ctx, id, input.parse(await boundedJson(req))),
      { status: 202, headers: privateHeaders });
  } catch (error) { return workforceError(error); }
}
