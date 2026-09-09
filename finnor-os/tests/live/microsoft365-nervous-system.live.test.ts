import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  closePool,
  externalRefObservations,
  integrationSourceCoverageHistory,
  integrationSourceScopes,
  integrationSyncCheckpoints,
  withTenant,
} from "@finnor/db";
import {
  generateSubscriptionClientState,
  inspectMicrosoftGraphAppOnlyToken,
  Microsoft365SubscriptionTransport,
  MicrosoftGraphClient,
  microsoft365SourceCapability,
  microsoft365SubscriptionChangeTypes,
  type Microsoft365SourceScope,
} from "@finnor/provider-microsoft365";
import { loadPrivateEquityWorldState, type PeMutationContext } from "@finnor/private-equity";
import { resolveMicrosoftProviderAuthContext } from "@finnor/security";
import { maintainIntegrationSubscriptions } from "../../apps/worker/src/handlers/maintain-integration-subscriptions";
import { syncSource } from "../../apps/worker/src/handlers/sync-source";

const enabled = process.env.P2_M365_LIVE_CERTIFICATION === "1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the opt-in Microsoft 365 live certification`);
  return value;
}

function sourceScopeIds(): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(required("P2_M365_LIVE_SOURCE_SCOPE_IDS")); } catch {
    throw new Error("P2_M365_LIVE_SOURCE_SCOPE_IDS must be a JSON array of configured source-scope UUIDs");
  }
  if (!Array.isArray(parsed) || parsed.length < 4 || parsed.length > 16
      || parsed.some((value) => typeof value !== "string" || !UUID.test(value))) {
    throw new Error("P2_M365_LIVE_SOURCE_SCOPE_IDS must contain 4-16 source-scope UUIDs");
  }
  return [...new Set(parsed)];
}

function sourceScope(row: typeof integrationSourceScopes.$inferSelect): Microsoft365SourceScope {
  return {
    id: row.id,
    tenantId: row.tenantId,
    integrationId: row.integrationId,
    provider: "microsoft_graph",
    sourceKind: row.sourceKind,
    scopeKey: row.scopeKey,
    providerResourceId: row.providerResourceId,
    providerParentId: row.providerParentId,
    permissionMode: row.permissionMode,
    coveragePolicy: row.coveragePolicy as Record<string, unknown>,
    freshnessPolicy: row.freshnessPolicy as Record<string, unknown>,
    configuration: row.configuration as Record<string, unknown>,
  };
}

/**
 * Explicit opt-in production-certification path. It reads only preconfigured
 * test-tenant source scopes, persists observations through the real sync worker,
 * and creates one temporary Graph subscription that is always deleted. No token,
 * clientState, tenant content, provider object ID, or subscription ID is logged.
 */
describe.skipIf(!enabled)("Microsoft 365 live nervous-system certification", () => {
  afterAll(async () => {
    await closePool();
  });

  it("proves real app identity, source reads, subscription lifecycle, evidence, cursor, and no-hindsight state", async () => {
    const tenantId = required("P2_M365_LIVE_TENANT_ID");
    const webhookUrl = required("P2_M365_LIVE_WEBHOOK_URL");
    expect(UUID.test(tenantId)).toBe(true);
    expect(new URL(webhookUrl).protocol).toBe("https:");
    const ids = sourceScopeIds();
    const scopes = await withTenant(tenantId, (db) => db.select().from(integrationSourceScopes).where(and(
      eq(integrationSourceScopes.tenantId, tenantId),
      inArray(integrationSourceScopes.id, ids),
      eq(integrationSourceScopes.provider, "microsoft_graph"),
      eq(integrationSourceScopes.enabled, true),
    )));
    expect(scopes).toHaveLength(ids.length);
    expect(scopes.every((scope) => scope.permissionVerifiedAt instanceof Date)).toBe(true);

    const kinds = new Set(scopes.map((scope) => scope.sourceKind));
    expect(kinds.has("outlook_mail_folder")).toBe(true);
    expect(kinds.has("outlook_calendar_view")).toBe(true);
    expect(kinds.has("teams_channel") || kinds.has("teams_chat") || kinds.has("teams_user_chat_feed")).toBe(true);
    expect(kinds.has("sharepoint_drive")).toBe(true);

    const authByIntegration = new Map<string, Awaited<ReturnType<typeof resolveMicrosoftProviderAuthContext>>>();
    for (const scope of scopes) {
      if (authByIntegration.has(scope.integrationId)) continue;
      const auth = await resolveMicrosoftProviderAuthContext({ tenantId, integrationId: scope.integrationId });
      const inspected = await inspectMicrosoftGraphAppOnlyToken(auth);
      expect(inspected).toMatchObject({
        tokenType: "application",
        directoryTenantId: auth.directoryTenantId,
        applicationClientId: auth.applicationClientId,
        roles: expect.arrayContaining([...auth.requiredPermissions]),
      });
      expect(JSON.stringify(inspected)).not.toMatch(/access[_-]?token|client[_-]?assertion/i);
      authByIntegration.set(scope.integrationId, auth);
    }

    let provedDeltaCursor = false;
    for (const row of scopes) {
      const capability = microsoft365SourceCapability(row.sourceKind);
      if (capability.supportsChangeNotifications) {
        await maintainIntegrationSubscriptions({
          tenantId,
          integrationId: row.integrationId,
          sourceScopeId: row.id,
          scope: row.scopeKey,
          _correlationId: randomUUID(),
        });
      }
      let terminal = false;
      for (let page = 0; page < 32; page += 1) {
        await syncSource({
          tenantId,
          integrationId: row.integrationId,
          sourceScopeId: row.id,
          scope: row.scopeKey,
          _correlationId: randomUUID(),
        });
        const [checkpoint, coverage] = await withTenant(tenantId, async (db) => Promise.all([
          db.select().from(integrationSyncCheckpoints)
            .where(eq(integrationSyncCheckpoints.sourceScopeId, row.id)).then((values) => values[0]),
          db.select().from(integrationSourceCoverageHistory)
            .where(eq(integrationSourceCoverageHistory.sourceScopeId, row.id))
            .orderBy(desc(integrationSourceCoverageHistory.coverageRevision)).limit(1).then((values) => values[0]),
        ]));
        expect(checkpoint?.errorCode).toBeNull();
        const cursor = checkpoint?.cursor as Record<string, unknown> | undefined;
        if (capability.supportsDelta && typeof cursor?.token === "string" && cursor.phase === "incremental") {
          expect(cursor.token).toMatch(/^https:\/\/graph\.microsoft\.com\/v1\.0\//i);
          provedDeltaCursor = true;
        }
        terminal = coverage?.state === "COMPLETE" || coverage?.state === "HISTORY_LIMITED" || coverage?.state === "PARTIAL";
        if (terminal) break;
      }
      expect(terminal).toBe(true);
    }
    expect(provedDeltaCursor).toBe(true);

    const observations = await withTenant(tenantId, (db) => db.select({
      id: externalRefObservations.id,
      sourceScopeId: externalRefObservations.sourceScopeId,
      evidenceSourceId: externalRefObservations.evidenceSourceId,
      evidenceVersionId: externalRefObservations.evidenceVersionId,
      observedAt: externalRefObservations.observedAt,
      retrievedAt: externalRefObservations.retrievedAt,
    }).from(externalRefObservations).where(and(
      eq(externalRefObservations.tenantId, tenantId),
      inArray(externalRefObservations.sourceScopeId, ids),
      eq(externalRefObservations.provider, "microsoft_graph"),
    )));
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.every((item) => item.evidenceSourceId && item.evidenceVersionId
      && item.observedAt instanceof Date && item.retrievedAt instanceof Date)).toBe(true);

    const [temporalProof] = await withTenant(tenantId, (db) => db.execute<{
      evidence_version_id: string;
      retrieved_at: Date;
      recorded_at: Date;
      root_type: "pe_strategy" | "pe_opportunity" | "pe_deal";
      root_id: string;
    }>(sql`
      SELECT observation.evidence_version_id::text,
             observation.retrieved_at,
             observation.recorded_at,
             scope.root_binding_type root_type,
             scope.root_binding_id::text root_id
        FROM finnor_os.external_ref_observations observation
        JOIN finnor_os.integration_source_scopes scope
          ON scope.tenant_id=observation.tenant_id AND scope.id=observation.source_scope_id
        JOIN finnor_os.pe_evidence_links evidence_link
          ON evidence_link.tenant_id=observation.tenant_id
         AND evidence_link.evidence_version_id=observation.evidence_version_id
         AND evidence_link.entity_type=scope.root_binding_type
         AND evidence_link.entity_id=scope.root_binding_id
       WHERE observation.tenant_id=${tenantId}::uuid
         AND observation.source_scope_id=ANY(${ids}::uuid[])
         AND scope.root_binding_type IS NOT NULL
       ORDER BY observation.recorded_at DESC
       LIMIT 1
    `).then((result) => result.rows));
    expect(temporalProof).toBeTruthy();
    const ctx: PeMutationContext = {
      auth: { tenantId, userId: "system:m365-live-certification", role: "owner" },
      provenance: { sourceSystem: "certification:microsoft365-live", createdBy: "system:m365-live-certification" },
    };
    const root = { entityType: temporalProof!.root_type, entityId: temporalProof!.root_id };
    const before = await loadPrivateEquityWorldState(ctx, root,
      new Date(temporalProof!.retrieved_at.getTime() - 1));
    const after = await loadPrivateEquityWorldState(ctx, root,
      new Date(temporalProof!.recorded_at.getTime() + 1_000));
    expect(before.observedEvidence.map((item) => item.evidenceVersionId)).not.toContain(temporalProof!.evidence_version_id);
    expect(after.observedEvidence.map((item) => item.evidenceVersionId)).toContain(temporalProof!.evidence_version_id);

    const subscriptionScopeRow = scopes.find((scope) => microsoft365SourceCapability(scope.sourceKind).supportsChangeNotifications);
    expect(subscriptionScopeRow).toBeTruthy();
    const liveScope = sourceScope(subscriptionScopeRow!);
    const auth = authByIntegration.get(liveScope.integrationId)!;
    const transport = new Microsoft365SubscriptionTransport(new MicrosoftGraphClient(auth));
    const state = generateSubscriptionClientState();
    const createdAt = new Date();
    let temporarySubscriptionId: string | null = null;
    try {
      const created = await transport.create(liveScope, {
        changeTypes: microsoft365SubscriptionChangeTypes(liveScope),
        notificationUrl: webhookUrl,
        lifecycleNotificationUrl: webhookUrl,
        requestedExpirationAt: new Date(createdAt.getTime() + 24 * 60 * 60_000).toISOString(),
        clientState: state.plaintext,
      }, createdAt);
      temporarySubscriptionId = created.id;
      expect(Date.parse(created.expirationDateTime)).toBeGreaterThan(createdAt.getTime());
      const renewed = await transport.renew(
        created.id,
        liveScope,
        new Date(Date.now() + 36 * 60 * 60_000).toISOString(),
      );
      expect(renewed.id).toBe(created.id);
      expect(Date.parse(renewed.expirationDateTime)).toBeGreaterThan(Date.now());
    } finally {
      if (temporarySubscriptionId) await transport.delete(temporarySubscriptionId);
    }
  }, 300_000);
});
