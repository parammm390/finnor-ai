import { requireContext } from "../../../../../lib/auth";
import { readWorkforceExecution } from "@finnor/orchestration/workforce-execution";
import { z } from "zod";
import { privateHeaders, workforceError } from "../http";
export const runtime = "nodejs";
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(req), id = z.string().uuid().parse((await context.params).id);
    return Response.json(await readWorkforceExecution(ctx, id), { headers: privateHeaders });
  } catch (error) { return workforceError(error); }
}
