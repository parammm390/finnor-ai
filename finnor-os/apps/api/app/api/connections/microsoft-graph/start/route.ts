import { beginMicrosoftGraphConnection } from "@finnor/data-platform";
import { z } from "zod";
import { requireContext } from "../../../../../lib/auth";
import { microsoft365AdministrationErrorResponse } from "../../../../../lib/microsoft365-administration";

export const runtime = "nodejs";

const workload = z.object({
  kind: z.literal("federated_workload"),
  awsRegion: z.string().trim().min(1).max(40),
  federationAudience: z.string().trim().min(1).max(512),
  federationConfigId: z.string().trim().min(1).max(256),
  signingAlgorithm: z.enum(["ES384", "RS256"]),
  identityTokenDurationSeconds: z.number().int().min(60).max(3_600).optional(),
}).strict();

const certificate = z.object({
  kind: z.literal("managed_certificate"),
  credentialRef: z.string().trim().min(1).max(1_024),
  credentialVersion: z.string().trim().min(1).max(256).optional(),
  certificateFallbackAcknowledged: z.literal(true),
}).strict();

const bodySchema = z.object({
  directoryTenantId: z.string().uuid(),
  applicationClientId: z.string().uuid(),
  requestedPermissions: z.array(z.string().trim().min(1).max(128)).min(1).max(32),
  auth: z.discriminatedUnion("kind", [workload, certificate]),
  redirectUri: z.string().url().max(2_048).optional(),
}).strict();

export async function POST(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Invalid Microsoft connection configuration", code: "invalid_request" }, { status: 400 });
    const redirectUri = parsed.data.redirectUri ?? new URL("/api/connections/microsoft-graph/callback", req.url).toString();
    const result = await beginMicrosoftGraphConnection({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      directoryTenantId: parsed.data.directoryTenantId,
      applicationClientId: parsed.data.applicationClientId,
      requestedPermissions: parsed.data.requestedPermissions,
      auth: parsed.data.auth,
      redirectUri,
      traceId: ctx.correlationId,
    });
    return Response.json(result, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return microsoft365AdministrationErrorResponse(error);
  }
}
