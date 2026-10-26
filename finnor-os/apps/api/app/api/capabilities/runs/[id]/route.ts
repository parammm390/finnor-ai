import { z } from "zod";
import { readCapabilityRun } from "../../../../../../../packages/orchestration/src/capabilities/repository";
import { requireContext } from "../../../../../lib/auth";
import { capabilityError } from "../../../../../lib/capabilities";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireContext(request), { id } = await context.params;
    const run = await readCapabilityRun(actor, z.string().uuid().parse(id));
    return Response.json(run ? { run } : { code: "CAPABILITY_RUN_NOT_FOUND" }, { status: run ? 200 : 404, headers: { "cache-control": "no-store" } });
  } catch (error) { return capabilityError(error); }
}
