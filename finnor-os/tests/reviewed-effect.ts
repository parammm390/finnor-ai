import { and, eq } from "drizzle-orm";
import { businessEffects, domainActions, withTenant } from "@finnor/db";

/** Synthetic reviewer reads the same exact persisted effect shown by the UI. */
export async function reviewedEffectHash(tenantId: string, actionId: string): Promise<string | undefined> {
  const [row] = await withTenant(tenantId, db => db.select({ hash: businessEffects.semanticHash })
    .from(domainActions)
    .leftJoin(businessEffects, and(eq(businessEffects.tenantId, tenantId),
      eq(businessEffects.id, domainActions.businessEffectId)))
    .where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, actionId))).limit(1));
  return row?.hash ?? undefined;
}
