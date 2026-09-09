import { getMicrosoftGraphConnectionStatus } from "@finnor/data-platform";
import { requireContext } from "../../../../../lib/auth";
import { firstQueryValue, microsoft365AdministrationErrorResponse } from "../../../../../lib/microsoft365-administration";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const url = new URL(req.url);
    const authProfileRef = url.searchParams.has("authProfileRef") ? firstQueryValue(url, "authProfileRef", 128) : undefined;
    if (url.searchParams.has("authProfileRef") && !authProfileRef) {
      return Response.json({ error: "authProfileRef must occur exactly once", code: "invalid_request" }, { status: 400 });
    }
    const status = await getMicrosoftGraphConnectionStatus({ tenantId: ctx.tenantId, ...(authProfileRef ? { authProfileRef } : {}) });
    return Response.json(status, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return microsoft365AdministrationErrorResponse(error);
  }
}
