import { z } from "zod";
import { configureAgentProfile, createDefaultPluginRegistry } from "@finnor/orchestration";
import { workforceStatus } from "@finnor/read-models";
import { AuthError, errorResponse, requireContext } from "../../../../lib/auth";

export const runtime = "nodejs";

const CapabilityGrantSchema = z.object({
  capability: z.string().trim().min(1).max(240),
  kind: z.enum(["query", "action", "wait", "check"]),
}).strict();

const ConfigureAgentSchema = z.object({
  profileId: z.string().uuid().optional(),
  key: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/),
  name: z.string().trim().min(1).max(160),
  status: z.enum(["enabled", "disabled"]).optional(),
  modelRoute: z.object({
    provider: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(240).nullable().optional(),
    purpose: z.literal("objective_execution"),
  }).strict().optional(),
  capabilityGrants: z.array(CapabilityGrantSchema).min(1).max(512),
  maxConcurrentAssignments: z.number().int().min(1).max(32).optional(),
  autonomyLimits: z.object({
    maxActions: z.number().int().min(1).max(4).optional(),
    maxQueries: z.number().int().min(1).max(11).optional(),
    maxReplans: z.number().int().min(1).max(8).optional(),
    maxPlannerCalls: z.number().int().min(1).max(11).optional(),
    maxWallClockMs: z.number().int().min(1_000).max(604_799_999).optional(),
    maxKnownCostUsd: z.number().nonnegative().finite().nullable().optional(),
    maxKnownTokens: z.number().int().nonnegative().nullable().optional(),
  }).strict().optional(),
  planningHints: z.record(z.string(), z.unknown()).optional(),
  learningRevisionId: z.string().uuid().nullable().optional(),
}).strict();

function governanceError(error: unknown): never {
  if (error instanceof Error && /human employee|human authority/i.test(error.message)) {
    throw new AuthError("Current employee lacks workforce governance authority", 403);
  }
  throw error;
}

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const searchParams = new URL(req.url).searchParams;
    const rawLimit = searchParams.get("limit");
    const cursor = searchParams.get("cursor") ?? undefined;
    const limit = rawLimit === null ? undefined : Number(rawLimit);
    const data = await workforceStatus(ctx.tenantId, { page: limit === undefined && cursor === undefined ? undefined : { ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) } });
    return Response.json({ data }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const parsed = ConfigureAgentSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "Invalid workforce profile configuration", issues: parsed.error.flatten() }, { status: 400, headers: { "cache-control": "no-store" } });
    }
    let result: Awaited<ReturnType<typeof configureAgentProfile>>;
    try {
      result = await configureAgentProfile(ctx.tenantId, createDefaultPluginRegistry(), { ...parsed.data, actor: ctx });
    } catch (error) {
      governanceError(error);
    }
    return Response.json(result, { status: parsed.data.profileId ? 200 : 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
