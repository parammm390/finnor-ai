import { z } from "zod";
import { requireContext } from "../../../../../lib/auth";
import { respondWorkforceParticipant } from "@finnor/orchestration/workforce-execution";
import { boundedJson, privateHeaders, workforceError } from "../../execution-programs/http";
export const runtime = "nodejs";
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const id = z.string().uuid().parse((await context.params).id);
    return Response.json(await respondWorkforceParticipant(await requireContext(req), id, await boundedJson(req)), { headers: privateHeaders });
  } catch (error) { return workforceError(error); }
}
