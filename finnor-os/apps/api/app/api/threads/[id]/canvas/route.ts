import { centropyCanvasPreferences, loadEmployeeConversationThread, withTenant } from "@finnor/db";
import { resolveCanonicalHumanPrincipal } from "@finnor/orchestration";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { errorResponse, requireContext } from "../../../../../lib/auth";
import { boundedJson, UUID } from "../../../../../lib/artifacts";

type RouteParams = { params: Promise<{ id: string }> };

const LayoutSchema = z.object({
  mode: z.literal("document"),
  blockIds: z.array(z.string().min(1).max(240)).max(100),
}).strict().refine((layout) => new Set(layout.blockIds).size === layout.blockIds.length, "Canvas block IDs must be unique");

const PutSchema = z.object({
  baseRevision: z.number().int().min(0),
  layout: LayoutSchema,
  selectedBlockId: z.string().min(1).max(240).nullable(),
}).strict().refine((value) => value.selectedBlockId === null || value.layout.blockIds.includes(value.selectedBlockId), "Selected block must be in the layout");

async function ownedThread(tenantId: string, employeeId: string, threadId: string): Promise<boolean> {
  return Boolean(await loadEmployeeConversationThread({ tenantId, ownerEmployeeId: employeeId, threadId, messageLimit: 1 }));
}

function presentation(row: typeof centropyCanvasPreferences.$inferSelect) {
  return {
    schemaVersion: row.schemaVersion,
    threadId: row.threadId,
    uiRevision: row.uiRevision,
    layout: row.layout,
    selectedBlockId: row.selectedBlockId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function GET(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id } = await params;
    if (!UUID.test(id)) return Response.json({ error: "Invalid thread ID" }, { status: 400 });
    const ctx = await requireContext(req);
    const employeeId = await resolveCanonicalHumanPrincipal(ctx);
    if (!(await ownedThread(ctx.tenantId, employeeId, id))) return Response.json({ error: "conversation_thread_not_found" }, { status: 404 });
    const [row] = await withTenant(ctx.tenantId, (db) => db.select().from(centropyCanvasPreferences).where(and(
      eq(centropyCanvasPreferences.tenantId, ctx.tenantId),
      eq(centropyCanvasPreferences.ownerEmployeeId, employeeId),
      eq(centropyCanvasPreferences.threadId, id),
    )).limit(1), employeeId);
    return Response.json({ state: row ? presentation(row) : null }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("canonical_human_principal")) return Response.json({ error: error.message }, { status: 403 });
    return errorResponse(error);
  }
}

export async function PUT(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id } = await params;
    if (!UUID.test(id)) return Response.json({ error: "Invalid thread ID" }, { status: 400 });
    const ctx = await requireContext(req);
    const employeeId = await resolveCanonicalHumanPrincipal(ctx);
    if (!(await ownedThread(ctx.tenantId, employeeId, id))) return Response.json({ error: "conversation_thread_not_found" }, { status: 404 });
    const parsed = PutSchema.safeParse(await boundedJson(req, 32_768));
    if (!parsed.success) return Response.json({ error: parsed.error.issues.map((issue) => issue.message).join("; ") }, { status: 400 });
    const input = parsed.data;
    const result = await withTenant(ctx.tenantId, async (db) => {
      const where = and(
        eq(centropyCanvasPreferences.tenantId, ctx.tenantId),
        eq(centropyCanvasPreferences.ownerEmployeeId, employeeId),
        eq(centropyCanvasPreferences.threadId, id),
      );
      const [saved] = input.baseRevision === 0
        ? await db.insert(centropyCanvasPreferences).values({
          tenantId: ctx.tenantId, ownerEmployeeId: employeeId, threadId: id,
          layout: input.layout, selectedBlockId: input.selectedBlockId,
        }).onConflictDoNothing().returning()
        : await db.update(centropyCanvasPreferences).set({
          layout: input.layout,
          selectedBlockId: input.selectedBlockId,
          uiRevision: sql`${centropyCanvasPreferences.uiRevision} + 1`,
          updatedAt: new Date(),
        }).where(and(where, eq(centropyCanvasPreferences.uiRevision, input.baseRevision))).returning();
      if (saved) return { state: presentation(saved), conflict: false };
      const [current] = await db.select().from(centropyCanvasPreferences).where(where).limit(1);
      return { state: current ? presentation(current) : null, conflict: true };
    }, employeeId);
    return Response.json(result, { status: result.conflict ? 409 : 200, headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("canonical_human_principal")) return Response.json({ error: error.message }, { status: 403 });
    return errorResponse(error);
  }
}
