import { requireContext } from "../../../../../../lib/auth";
import { reconcileWorkforceExecution, reconcileWorkforceExecutionSchema } from "@finnor/orchestration/workforce-execution";
import { z } from "zod";
import { boundedJson, privateHeaders, workforceError } from "../../http";
export const runtime = "nodejs";
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(req), id = z.string().uuid().parse((await context.params).id);
    return Response.json(await reconcileWorkforceExecution(ctx, id, reconcileWorkforceExecutionSchema.parse(await boundedJson(req))),
      { status: 202, headers: privateHeaders });
  } catch (error) { return workforceError(error); }
}
