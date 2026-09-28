// B8.T1: authenticated device opt-in. The browser supplies only its own Web Push
// subscription; tenant and user identity are always derived from the verified token.
import { pushSubscriptions, withTenant } from "@finnor/db";
import { and, eq } from "drizzle-orm";
import { errorResponse, requireContext } from "../../../lib/auth";
import { PushSubscriptionSchema as SubscriptionSchema, DeletePushSubscriptionSchema } from "../../../lib/product-control-schemas";

export async function POST(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const parsed = SubscriptionSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Invalid push subscription" }, { status: 400 });
    const sub = parsed.data;
    await withTenant(ctx.tenantId, async (db) => {
      await db.insert(pushSubscriptions).values({ tenantId: ctx.tenantId, userId: ctx.userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth })
        .onConflictDoUpdate({ target: [pushSubscriptions.userId, pushSubscriptions.endpoint], set: { p256dh: sub.keys.p256dh, auth: sub.keys.auth, updatedAt: new Date() } });
    }, ctx.userId);
    return Response.json({ subscribed: true }, { status: 201 });
  } catch (err) { return errorResponse(err); }
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const parsed = DeletePushSubscriptionSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Invalid push subscription" }, { status: 400 });
    await withTenant(ctx.tenantId, async (db) => {
      await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, ctx.userId), eq(pushSubscriptions.endpoint, parsed.data.endpoint)));
    }, ctx.userId);
    return new Response(null, { status: 204 });
  } catch (err) { return errorResponse(err); }
}
