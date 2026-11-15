import { requireContext } from "../../../../lib/auth";
import { proposeWorkforceParticipant, readWorkforceParticipants } from "@finnor/orchestration/workforce-execution";
import { boundedJson, privateHeaders, workforceError } from "../execution-programs/http";
export const runtime = "nodejs";
export async function GET(req: Request) {
  try { return Response.json(await readWorkforceParticipants(await requireContext(req)), { headers: privateHeaders }); }
  catch (error) { return workforceError(error); }
}
export async function POST(req: Request) {
  try { return Response.json(await proposeWorkforceParticipant(await requireContext(req), await boundedJson(req)),
    { status: 202, headers: privateHeaders }); } catch (error) { return workforceError(error); }
}
