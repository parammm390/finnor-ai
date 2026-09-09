import { readMicrosoft365Coverage } from "@finnor/data-platform";
import { requireContext } from "../../../../../lib/auth";
import { firstQueryValue, microsoft365AdministrationErrorResponse } from "../../../../../lib/microsoft365-administration";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const url = new URL(req.url);
    const sourceScopeId = url.searchParams.has("sourceScopeId") ? firstQueryValue(url, "sourceScopeId", 64) : undefined;
    const rootType = url.searchParams.has("rootType") ? firstQueryValue(url, "rootType", 32) : undefined;
    const rootId = url.searchParams.has("rootId") ? firstQueryValue(url, "rootId", 64) : undefined;
    const at = url.searchParams.has("at") ? firstQueryValue(url, "at", 64) : undefined;
    const cursor = url.searchParams.has("cursor") ? firstQueryValue(url, "cursor", 64) : undefined;
    const limitRaw = url.searchParams.has("limit") ? firstQueryValue(url, "limit", 3) : undefined;
    const limit = limitRaw ? Number(limitRaw) : undefined;
    if ((rootType === undefined) !== (rootId === undefined)
        || (rootType && !["pe_strategy", "pe_opportunity", "pe_deal"].includes(rootType))
        || (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100))) {
      return Response.json({ error: "Invalid coverage query", code: "invalid_request" }, { status: 400 });
    }
    for (const [key, value] of [["sourceScopeId", sourceScopeId], ["at", at], ["cursor", cursor], ["limit", limitRaw]] as const) {
      if (url.searchParams.has(key) && value === undefined) return Response.json({ error: `${key} is invalid`, code: "invalid_request" }, { status: 400 });
    }
    const result = await readMicrosoft365Coverage({
      tenantId: ctx.tenantId,
      ...(sourceScopeId ? { sourceScopeId } : {}),
      ...(rootType && rootId ? { rootBinding: { type: rootType as "pe_strategy" | "pe_opportunity" | "pe_deal", id: rootId } } : {}),
      ...(at ? { at } : {}),
      ...(cursor ? { cursor } : {}),
      ...(limit ? { limit } : {}),
      includeDisabled: true,
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return microsoft365AdministrationErrorResponse(error);
  }
}
