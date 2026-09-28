import { beginGoogleConnection, ConnectionError } from "@finnor/security";
import { errorResponse, requireContext } from "../../../../../lib/auth";
import { GoogleConnectionStartSchema } from "../../../../../lib/product-control-schemas";

function connectionError(error: unknown): Response {
  if (error instanceof ConnectionError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
  return errorResponse(error);
}
export async function POST(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const parsed = GoogleConnectionStartSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: "Invalid Google connection request" }, { status: 400 });
    const body = parsed.data;
    const redirectUri = body.redirectUri
      ? body.redirectUri
      : new URL("/api/connections/google/callback", req.url).toString();
    const started = await beginGoogleConnection({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      authProfileRef: body.authProfileRef,
      redirectUri,
      traceId: ctx.correlationId,
    });
    const cookieValue = Buffer.from(JSON.stringify({ state: started.state, verifier: started.verifier }), "utf8").toString("base64url");
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    return Response.json(
      { authorizationUrl: started.authorizationUrl, expiresAt: started.expiresAt },
      {
        headers: {
          "cache-control": "no-store",
          "set-cookie": `finnor_google_oauth=${cookieValue}; HttpOnly${secure}; SameSite=Lax; Path=/api/connections/google/callback; Max-Age=600`,
        },
      },
    );
  } catch (error) {
    return connectionError(error);
  }
}
