// D6.T4 — a real delta digest, scoped to the authenticated person's tenant and their
// own last_seen_at marker. First visits say so plainly instead of inventing a delta.

import { domainActions, userPrefs, withTenant } from "@finnor/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { errorResponse, requireContext } from "../../../../lib/auth";

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const now = new Date();
    const digest = await withTenant(ctx.tenantId, async (db) => {
      const [prefs] = await db.select({ lastSeenAt: userPrefs.lastSeenAt }).from(userPrefs).where(eq(userPrefs.userId, ctx.userId)).limit(1);
      const since = prefs?.lastSeenAt ?? null;
      const window = since ? gte(domainActions.createdAt, since) : undefined;
      const [newActions, pendingActions, latest] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(domainActions).where(and(eq(domainActions.tenantId, ctx.tenantId), window)).then(([row]) => Number(row?.count ?? 0)),
        db.select({ count: sql<number>`count(*)::int` }).from(domainActions).where(and(eq(domainActions.tenantId, ctx.tenantId), eq(domainActions.status, "pending"))).then(([row]) => Number(row?.count ?? 0)),
        db.select({ id: domainActions.id, actionType: domainActions.actionType, summary: domainActions.summary, createdAt: domainActions.createdAt }).from(domainActions).where(and(eq(domainActions.tenantId, ctx.tenantId), window)).orderBy(desc(domainActions.createdAt)).limit(3),
      ]);
      // Persist the marker only after the read completed, keeping the next comparison
      // window honest even when a request errors before reaching this point.
      await db.insert(userPrefs).values({ userId: ctx.userId, tenantId: ctx.tenantId, lastSeenAt: now }).onConflictDoUpdate({ target: userPrefs.userId, set: { lastSeenAt: now, updatedAt: now } });
      return { firstVisit: since === null, since, newActions, pendingActions, top: latest };
    }, ctx.userId);
    const greeting = digest.firstVisit
      ? "Welcome back. Your cockpit is ready with live tenant data."
      : digest.newActions === 0 ? "Welcome back. No new planned actions since you last checked."
      : `Welcome back. ${digest.newActions} planned action${digest.newActions === 1 ? "" : "s"} changed since you last checked.`;
    return Response.json({ ...digest, greeting });
  } catch (err) {
    return errorResponse(err);
  }
}
