import { createIcCase, listIcCases } from "@finnor/private-equity";
import { handleIcGet, handleIcPost, IcCreateCaseSchema } from "../../../../../lib/ic";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  return handleIcPost(req, IcCreateCaseSchema, createIcCase, 201);
}

export async function GET(req: Request): Promise<Response> {
  return handleIcGet(req, (ctx) => listIcCases(ctx));
}
