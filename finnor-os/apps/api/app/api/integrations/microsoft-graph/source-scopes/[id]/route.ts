import { disableMicrosoft365Source, getMicrosoft365SourceScopeStatus } from "@finnor/data-platform";
import { requireContext } from "../../../../../../lib/auth";
import { firstQueryValue, microsoft365AdministrationErrorResponse } from "../../../../../../lib/microsoft365-administration";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const [ctx, route] = await Promise.all([requireContext(req), params]);
    const url = new URL(req.url);
    const at = url.searchParams.has("at") ? firstQueryValue(url, "at", 64) : undefined;
    if (url.searchParams.has("at") && !at) return Response.json({ error: "at is invalid", code: "invalid_request" }, { status: 400 });
    const result = await getMicrosoft365SourceScopeStatus({ tenantId: ctx.tenantId, sourceScopeId: route.id, ...(at ? { at } : {}) });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return microsoft365AdministrationErrorResponse(error);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const [ctx, route] = await Promise.all([requireContext(req), params]);
    const result = await disableMicrosoft365Source({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      sourceScopeId: route.id,
      traceId: ctx.correlationId,
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return microsoft365AdministrationErrorResponse(error);
  }
}
