import { requireContext } from "../../../../lib/auth";
import { submitWorkforceExecution, listWorkforceExecutions } from "@finnor/orchestration/workforce-execution";
import { z } from "zod";
import { boundedJson, privateHeaders, workforceError } from "./http";
export const runtime = "nodejs";
export async function POST(req: Request) {
  try {
    const ctx = await requireContext(req);
    return Response.json(await submitWorkforceExecution(ctx, await boundedJson(req)), { status: 202, headers: privateHeaders });
  } catch (error) { return workforceError(error); }
}
export async function GET(req: Request) {
  try {
    const ctx = await requireContext(req), workId = z.string().uuid().parse(new URL(req.url).searchParams.get("workId"));
    return Response.json(await listWorkforceExecutions(ctx, workId), { headers: privateHeaders });
  } catch (error) { return workforceError(error); }
}
