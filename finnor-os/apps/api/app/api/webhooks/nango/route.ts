import { acceptNangoWebhook } from "../../../../../../packages/orchestration/src/capabilities/nango-webhook";
import { ensureSecretsLoaded } from "@finnor/security";
import { capabilityError, capabilityRawBody } from "../../../../lib/capabilities";

export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  try {
    const raw = await capabilityRawBody(request);
    await ensureSecretsLoaded();
    return Response.json(await acceptNangoWebhook(raw, request.headers.get("x-nango-hmac-sha256")), { status: 202, headers: { "cache-control": "no-store" } });
  }
  catch (error) { return capabilityError(error); }
}
