import { requireContext } from "../../../../../../lib/auth";
import { actOnWorkforceAssignment } from "@finnor/orchestration/workforce-execution";
import { z } from "zod";
import { boundedJson, privateHeaders, workforceError } from "../../http";
export const runtime = "nodejs";
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireContext(req), id = z.string().uuid().parse((await context.params).id);
    return Response.json(await actOnWorkforceAssignment(ctx, id, await boundedJson(req)), { headers: privateHeaders });
  } catch (error) { return workforceError(error); }
}
