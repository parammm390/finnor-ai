// D6.T1 — the authenticated user's own cockpit-preference CRUD. No route parameter
// exists deliberately: identity comes only from the verified bearer context, and the
// DB policy independently enforces that same user_id within the tenant transaction.

import { userPrefs, withTenant } from "@finnor/db";
import { eq } from "drizzle-orm";
import { UserPreferencesPatchSchema } from "../../../lib/user-preferences";
import { errorResponse, requireContext } from "../../../lib/auth";

function defaultPrefs() {
  return {
    homepage: null,
    density: "comfortable" as const,
    pinnedPanels: [] as string[],
    accent: null,
    soundEnabled: false,
    notificationPreferences: {} as Record<string, boolean>,
    quietHoursStart: null,
    quietHoursEnd: null,
  };
}

function responsePrefs(row: typeof userPrefs.$inferSelect | undefined) {
  if (!row) return defaultPrefs();
  return {
    homepage: row.homepage,
    density: row.density,
    pinnedPanels: row.pinnedPanels as string[],
    accent: row.accent,
    soundEnabled: row.soundEnabled,
    notificationPreferences: row.notificationPreferences as Record<string, boolean>,
    quietHoursStart: row.quietHoursStart,
    quietHoursEnd: row.quietHoursEnd,
  };
}

async function ownPrefs(tenantId: string, userId: string) {
  return withTenant(tenantId, async (db) => {
    const [prefs] = await db.select().from(userPrefs).where(eq(userPrefs.userId, userId)).limit(1);
    return prefs;
  }, userId);
}

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    return Response.json({ prefs: responsePrefs(await ownPrefs(ctx.tenantId, ctx.userId)) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const parsed = UserPreferencesPatchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: parsed.error.issues.map((issue) => issue.message).join("; ") }, { status: 400 });
    const patch = parsed.data;
    const prefs = await withTenant(ctx.tenantId, async (db) => {
      const [existing] = await db.select().from(userPrefs).where(eq(userPrefs.userId, ctx.userId)).limit(1);
      const values = {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        ...responsePrefs(existing),
        ...patch,
        updatedAt: new Date(),
      };
      const [saved] = await db.insert(userPrefs).values(values).onConflictDoUpdate({ target: userPrefs.userId, set: values }).returning();
      return saved;
    }, ctx.userId);
    return Response.json({ prefs: responsePrefs(prefs) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    await withTenant(ctx.tenantId, async (db) => { await db.delete(userPrefs).where(eq(userPrefs.userId, ctx.userId)); }, ctx.userId);
    return Response.json({ prefs: defaultPrefs() });
  } catch (err) {
    return errorResponse(err);
  }
}
