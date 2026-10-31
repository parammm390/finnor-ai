import { requireContext } from "../../../../../lib/auth";
import { intakeWorkforceExecution } from "@finnor/orchestration/workforce-execution";
import { boundedJson, privateHeaders, workforceError } from "../http";
export const runtime = "nodejs";
export async function POST(req: Request) {
  try {
    const ctx = await requireContext(req);
    return Response.json(await intakeWorkforceExecution(ctx, await boundedJson(req)),
      { status: 202, headers: privateHeaders });
  } catch (error) { return workforceError(error); }
}
