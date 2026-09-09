import { configureMicrosoft365Source, listMicrosoft365SourceScopes } from "@finnor/data-platform";
import { z } from "zod";
import { requireContext } from "../../../../../lib/auth";
import { firstQueryValue, microsoft365AdministrationErrorResponse } from "../../../../../lib/microsoft365-administration";

export const runtime = "nodejs";

const rootBinding = z.object({
  type: z.enum(["pe_strategy", "pe_opportunity", "pe_deal"]),
  id: z.string().uuid(),
}).strict();

const bodySchema = z.object({
  sourceKind: z.enum([
    "outlook_mail_folder",
    "outlook_calendar_view",
    "teams_channel",
    "teams_chat",
    "teams_user_chat_feed",
    "teams_transcript_organizer",
    "sharepoint_drive",
    "sharepoint_list",
  ]),
  permissionMode: z.enum(["SCOPED", "BROAD"]),
  configuration: z.record(z.unknown()),
  negativeProbeConfiguration: z.record(z.unknown()).nullable().optional(),
  acknowledgeBroadAccess: z.boolean().optional(),
  rootBinding: rootBinding.nullable().optional(),
  freshnessPolicy: z.record(z.unknown()).optional(),
}).strict();

function booleanQuery(url: URL, key: string): boolean | undefined {
  if (!url.searchParams.has(key)) return undefined;
  const value = firstQueryValue(url, key, 5);
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const url = new URL(req.url);
    const limitRaw = firstQueryValue(url, "limit", 3);
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (url.searchParams.has("limit") && (!Number.isInteger(limit) || limit! < 1 || limit! > 100)) {
      return Response.json({ error: "limit must be an integer from 1 to 100", code: "invalid_request" }, { status: 400 });
    }
    const cursor = url.searchParams.has("cursor") ? firstQueryValue(url, "cursor", 64) : undefined;
    if (url.searchParams.has("cursor") && !cursor) return Response.json({ error: "cursor is invalid", code: "invalid_request" }, { status: 400 });
    const includeDisabled = booleanQuery(url, "includeDisabled");
    if (url.searchParams.has("includeDisabled") && includeDisabled === undefined) {
      return Response.json({ error: "includeDisabled must be true or false exactly once", code: "invalid_request" }, { status: 400 });
    }
    const result = await listMicrosoft365SourceScopes({
      tenantId: ctx.tenantId,
      ...(limit ? { limit } : {}),
      ...(cursor ? { cursor } : {}),
      ...(includeDisabled !== undefined ? { includeDisabled } : {}),
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return microsoft365AdministrationErrorResponse(error);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Invalid Microsoft source-scope configuration", code: "invalid_request" }, { status: 400 });
    const result = await configureMicrosoft365Source({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      ...parsed.data,
      traceId: ctx.correlationId,
    });
    return Response.json(result, { status: result.status === "initializing" ? 201 : 409, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return microsoft365AdministrationErrorResponse(error);
  }
}
