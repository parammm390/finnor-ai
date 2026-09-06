// External-operation idempotency ledger — one row per (domain_action_id, operation_key)
// in the external_operations table (packages/db/migrations/0006_security_controls.sql),
// keyed by a real composite primary key so concurrent claims are enforced by Postgres
// itself, not app-level sequencing. Used by ScopedToolRegistry (registry.ts) so a
// retried execution (reflection retry, a resumed LangGraph thread) never re-fires an
// already-completed external side effect such as delivering a message twice.

import { withTenant, externalOperations, tenantIntegrations, authProfiles } from "@finnor/db";
import { and, eq, sql } from "drizzle-orm";
import { redactStructured } from "@finnor/security";

export type ExternalOperationRow = typeof externalOperations.$inferSelect;

export type ClaimResult = { claimed: true } | { claimed: false; existing: ExternalOperationRow };

export const ACCOUNT_BOUND_PROVIDERS = new Set([
  "ghl", "quickbooks", "stripe", "vapi", "docusign", "gmail", "resend", "meta_ads", "google_ads",
]);

export async function claimExternalOperation(
  tenantId: string,
  domainActionId: string,
  operationKey: string,
  requestHash: string,
  provider?: string,
  businessEffectId?: string,
  authProfileRef?: string,
): Promise<ClaimResult> {
  return withTenant(tenantId, async (db) => {
    let integrationId: string | null = null;
    if (provider && ACCOUNT_BOUND_PROVIDERS.has(provider)) {
      const candidates = authProfileRef
        ? await db.select({
            id: tenantIntegrations.id,
            health: tenantIntegrations.health,
            syncStatus: tenantIntegrations.syncStatus,
            reconciliationStatus: tenantIntegrations.reconciliationStatus,
            syncInitializedAt: tenantIntegrations.syncInitializedAt,
            lastSuccessfulSyncAt: tenantIntegrations.lastSuccessfulSyncAt,
            sourcePolicy: tenantIntegrations.sourcePolicy,
            freshnessPolicy: tenantIntegrations.freshnessPolicy,
          }).from(tenantIntegrations).innerJoin(authProfiles, and(
            eq(authProfiles.tenantId, tenantId),
            eq(authProfiles.id, tenantIntegrations.authProfileId),
            eq(authProfiles.authProfileRef, authProfileRef),
          )).where(and(eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.binding, provider))).limit(2)
        : await db.select({
            id: tenantIntegrations.id,
            health: tenantIntegrations.health,
            syncStatus: tenantIntegrations.syncStatus,
            reconciliationStatus: tenantIntegrations.reconciliationStatus,
            syncInitializedAt: tenantIntegrations.syncInitializedAt,
            lastSuccessfulSyncAt: tenantIntegrations.lastSuccessfulSyncAt,
            sourcePolicy: tenantIntegrations.sourcePolicy,
            freshnessPolicy: tenantIntegrations.freshnessPolicy,
          }).from(tenantIntegrations).where(and(
            eq(tenantIntegrations.tenantId, tenantId),
            eq(tenantIntegrations.binding, provider),
          )).limit(2);
      if (candidates.length !== 1) throw new Error(`External operation requires one exact tenant integration/account for ${provider}`);
      const integration = candidates[0]!;
      if (integration.health === "down" || integration.syncStatus === "blocked" || integration.reconciliationStatus === "blocked") {
        throw new Error(`External operation refused because ${provider} source truth is blocked or unavailable`);
      }
      const source = integration.sourcePolicy && typeof integration.sourcePolicy === "object" && !Array.isArray(integration.sourcePolicy)
        ? integration.sourcePolicy as Record<string, unknown> : {};
      const freshness = integration.freshnessPolicy && typeof integration.freshnessPolicy === "object" && !Array.isArray(integration.freshnessPolicy)
        ? integration.freshnessPolicy as Record<string, unknown> : {};
      const requiresFresh = source.requireFreshBeforeEffect === true
        || freshness.requireFreshBeforeEffect === true
        || freshness.criticality === "consequential"
        || freshness.staleBehavior === "refresh_then_block";
      const maxAgeSeconds = typeof freshness.maxAgeSeconds === "number" && freshness.maxAgeSeconds > 0
        ? freshness.maxAgeSeconds : null;
      if (requiresFresh && (!integration.syncInitializedAt || !integration.lastSuccessfulSyncAt)) {
        throw new Error(`External operation refused because ${provider} has not completed its required initial synchronization`);
      }
      if (requiresFresh && maxAgeSeconds !== null && integration.lastSuccessfulSyncAt
          && Date.now() - integration.lastSuccessfulSyncAt.getTime() > maxAgeSeconds * 1000) {
        await db.update(tenantIntegrations).set({ freshnessState: "stale", syncStatus: "degraded", updatedAt: new Date() }).where(and(
          eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.id, integration.id),
        ));
        throw new Error(`External operation refused because ${provider} source truth is stale`);
      }
      integrationId = integration.id;
    }
    let existing: ExternalOperationRow | undefined;
    for (let attempt = 0; attempt < 2 && !existing; attempt += 1) {
      const [row] = await db
        .insert(externalOperations)
        .values({ tenantId, domainActionId, businessEffectId: businessEffectId ?? null, integrationId, operationKey, provider: provider ?? null, requestHash, status: "running" })
        .onConflictDoNothing({ target: [externalOperations.domainActionId, externalOperations.operationKey] })
        .returning();
      if (row) return { claimed: true } as const;
      [existing] = await db
        .select()
        .from(externalOperations)
        .where(and(eq(externalOperations.domainActionId, domainActionId), eq(externalOperations.operationKey, operationKey)));
    }
    // Never execute a consequential provider call without owning a durable claim.
    // READ COMMITTED should reveal a conflict winner to the following SELECT; if an
    // administrative delete or an unexpected visibility fault prevents that, fail
    // closed instead of letting two callers dispatch the same effect.
    if (!existing) throw new Error("External operation claim could not be established safely");
    if ((existing.businessEffectId ?? null) !== (businessEffectId ?? null)) {
      throw new Error("External operation effect conflict: refusing to reuse an idempotency claim for a different Business Effect");
    }
    // Idempotency protects against re-doing a SUCCESSFUL side effect (never send the
    // same SMS twice) — it must NOT block a legitimate reflection retry after a
    // genuine failure, since retrying a failed send is exactly reflection's job, and a
    // failed attempt didn't actually deliver anything. Re-claim atomically: the
    // conditional WHERE status='failed' means only one concurrent retrier can win it.
    if (existing.status === "failed") {
      const [reclaimed] = await db
        .update(externalOperations)
        .set({ status: "running", requestHash, ...(provider ? { provider } : {}), updatedAt: new Date() })
        .where(and(eq(externalOperations.domainActionId, domainActionId), eq(externalOperations.operationKey, operationKey), eq(externalOperations.status, "failed")))
        .returning();
      if (reclaimed) return { claimed: true } as const;
      const [refetched] = await db
        .select()
        .from(externalOperations)
        .where(and(eq(externalOperations.domainActionId, domainActionId), eq(externalOperations.operationKey, operationKey)));
      return { claimed: false, existing: refetched ?? existing } as const;
    }
    return { claimed: false, existing } as const;
  });
}

/**
 * A losing concurrent claim can observe the winner's row while it's still `status:
 * "running"` — that's not a failure, the winner just hasn't finished yet. Poll briefly
 * for it to settle rather than reporting a false "not ok" for a call that's actually
 * still in progress. Bounded (2s) so a genuinely stuck row (e.g. the winner's process
 * crashed mid-call) doesn't hang the loser forever.
 */
export async function awaitExternalOperationResolution(
  tenantId: string,
  domainActionId: string,
  operationKey: string,
  row: ExternalOperationRow,
): Promise<ExternalOperationRow> {
  let current = row;
  const deadline = Date.now() + 2_000;
  while (current.status === "running" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    const fresh = await withTenant(tenantId, (db) =>
      db
        .select()
        .from(externalOperations)
        .where(and(eq(externalOperations.domainActionId, domainActionId), eq(externalOperations.operationKey, operationKey))),
    );
    if (fresh[0]) current = fresh[0];
  }
  return current;
}

export async function recordExternalOperationResult(
  tenantId: string,
  domainActionId: string,
  operationKey: string,
  status: "succeeded" | "failed" | "unknown",
  response: Record<string, unknown>,
): Promise<ExternalOperationRow | null> {
  const redacted = redactStructured(response) as Record<string, unknown>;
  // Opaque provider/native record identifiers are required for safe crash replay.
  // Preserve only vertical-neutral identifiers after structural redaction.
  for (const key of ["id", "contactId", "messageId", "callId", "communicationIdentityId", "documentId", "taskId", "dealId", "companyId", "partyId", "externalRecordId", "linkId", "envelopeId"]) {
    if (typeof response[key] === "string") redacted[key] = response[key];
  }
  return withTenant(tenantId, async (db) => {
    const [operation] = await db.select({ integrationId: externalOperations.integrationId }).from(externalOperations).where(and(
      eq(externalOperations.tenantId, tenantId),
      eq(externalOperations.domainActionId, domainActionId),
      eq(externalOperations.operationKey, operationKey),
    )).limit(1);
    const requiresObservation = Boolean(operation?.integrationId);
    const [row] = await db
      .update(externalOperations)
      // Cached results are replayed internally, but they are still durable business
      // data. Keep only the minimum structured result and redact direct identifiers
      // before persisting the ledger.
      .set({
        status,
        response: redacted,
        providerAcknowledgedAt: status === "succeeded" && requiresObservation ? new Date() : null,
        externalObservedAt: status === "succeeded" && !requiresObservation ? new Date() : null,
        verificationStatus: status === "succeeded"
          ? requiresObservation ? "awaiting_observation" : "verified"
          : status === "unknown" ? "unknown" : "not_required",
        updatedAt: new Date(),
      })
      .where(and(eq(externalOperations.domainActionId, domainActionId), eq(externalOperations.operationKey, operationKey)))
      .returning();
    return row ?? null;
  });
}

/** Explicit provider reconciliation is the only way an unknown operation becomes a
 * known success/failure. The caller supplies provider evidence, which is redacted by
 * the same persistence path as ordinary results. */
export async function reconcileExternalOperation(
  tenantId: string,
  domainActionId: string,
  operationKey: string,
  status: "succeeded" | "failed",
  evidence: Record<string, unknown>,
): Promise<ExternalOperationRow> {
  const redacted = redactStructured(evidence) as Record<string, unknown>;
  return withTenant(tenantId, async (db) => {
    const [row] = await db
      .update(externalOperations)
      .set({ status, response: redacted, updatedAt: new Date() })
      .where(and(
        eq(externalOperations.domainActionId, domainActionId),
        eq(externalOperations.operationKey, operationKey),
        // A stale running row can represent a process crash after provider dispatch;
        // reconciliation may settle it too, but normal succeeded/failed rows are final.
        sql`${externalOperations.status} IN ('unknown','running')`,
      ))
      .returning();
    if (!row) throw new Error("External operation is not awaiting reconciliation");
    return row;
  });
}

export async function markExternalOperationUnknown(
  tenantId: string,
  domainActionId: string,
  operationKey: string,
  evidence: Record<string, unknown> = {},
): Promise<void> {
  await recordExternalOperationResult(tenantId, domainActionId, operationKey, "unknown", evidence);
}
