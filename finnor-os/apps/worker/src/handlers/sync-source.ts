import { createHash, randomUUID } from "node:crypto";
import {
  applicationAccounts,
  authProfiles,
  enqueueJob,
  integrationSyncCheckpoints,
  resolveTenantVertical,
  tenantIntegrations,
  withTenant,
} from "@finnor/db";
import { materializeSourceRecord } from "@finnor/data-platform";
import {
  resolveCredentialReferenceContext,
  TenantCredentialError,
  type TenantCredentialContext,
  type TenantCredentialProvider,
} from "@finnor/security";
import { createSourceAdapterRegistry, IntegrationError, logWithTrace } from "@finnor/tools";
import type { SourceSyncCursor } from "@finnor/shared-types";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { JobHandler } from "../queue";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function cursorKey(cursor: SourceSyncCursor): string {
  return createHash("sha256").update(JSON.stringify(cursor, Object.keys(cursor).sort())).digest("hex").slice(0, 20);
}

export async function loadSourceCredentialContext(
  tenantId: string,
  integration: {
    id: string;
    capability: string;
    binding: string;
    mode: string;
    config: unknown;
    credentialProvider: "aws-secrets-manager" | "legacy-env" | null;
    credentialRef: string | null;
    credentialVersion: string | null;
    credentialMetadata: unknown;
    applicationAccountId: string | null;
    authProfileId: string | null;
  },
): Promise<TenantCredentialContext> {
  let credentialProvider = integration.credentialProvider;
  let credentialRef = integration.credentialRef;
  let credentialVersion = integration.credentialVersion;
  let publicMetadata = { ...object(integration.config), ...object(integration.credentialMetadata) };

  if (integration.authProfileId || integration.applicationAccountId) {
    if (!integration.authProfileId || !integration.applicationAccountId) {
      throw new IntegrationError(integration.binding, "source binding has a partial account/auth-profile link", false, "config");
    }
    const [binding] = await withTenant(tenantId, (db) => db.select({
      profileId: authProfiles.id,
      profileStatus: authProfiles.status,
      connectionStatus: authProfiles.connectionStatus,
      profileAccountId: authProfiles.applicationAccountId,
      credentialProvider: authProfiles.credentialProvider,
      credentialRef: authProfiles.credentialRef,
      credentialVersion: authProfiles.credentialVersion,
      accountId: applicationAccounts.id,
      accountProvider: applicationAccounts.provider,
      accountStatus: applicationAccounts.status,
      accountMetadata: applicationAccounts.metadata,
    }).from(authProfiles).innerJoin(applicationAccounts, and(
      eq(applicationAccounts.tenantId, tenantId),
      eq(applicationAccounts.id, authProfiles.applicationAccountId),
    )).where(and(
      eq(authProfiles.tenantId, tenantId),
      eq(authProfiles.id, integration.authProfileId!),
      eq(applicationAccounts.id, integration.applicationAccountId!),
    )).limit(1));
    if (!binding || binding.profileAccountId !== integration.applicationAccountId || binding.accountProvider !== integration.binding) {
      throw new IntegrationError(integration.binding, "source account/auth-profile does not match provider binding", false, "auth");
    }
    if (binding.profileStatus !== "active" || binding.accountStatus !== "active" || binding.connectionStatus !== "active") {
      throw new IntegrationError(integration.binding, "source account/auth-profile is not active", false, "auth");
    }
    if (binding.credentialProvider === "os-keychain") {
      throw new IntegrationError(integration.binding, "OS-keychain auth profiles cannot run on the production worker", false, "config");
    }
    credentialProvider = binding.credentialProvider;
    credentialRef = binding.credentialRef;
    credentialVersion = binding.credentialVersion;
    publicMetadata = { ...publicMetadata, ...object(binding.accountMetadata) };
  }

  return resolveCredentialReferenceContext(tenantId, integration.binding as TenantCredentialProvider, {
    credentialProvider,
    credentialRef,
    credentialVersion,
    publicMetadata,
    integration: { id: integration.id, capability: integration.capability, binding: integration.binding, mode: integration.mode },
  });
}

async function claimCheckpoint(tenantId: string, integrationId: string, scope: string, owner: string) {
  return withTenant(tenantId, async (db) => {
    await db.insert(integrationSyncCheckpoints).values({ tenantId, integrationId, sourceScope: scope }).onConflictDoNothing();
    const result = await db.execute<{
      id: string;
      cursor: SourceSyncCursor;
      cursor_version: number;
    }>(sql`
      UPDATE finnor_os.integration_sync_checkpoints
      SET status='running',lease_owner=${owner},lease_expires_at=now()+interval '2 minutes',error_code=NULL,updated_at=now()
      WHERE tenant_id=${tenantId}::uuid AND integration_id=${integrationId}::uuid AND source_scope=${scope}
        AND (lease_expires_at IS NULL OR lease_expires_at<now() OR lease_owner=${owner})
      RETURNING id::text,cursor,cursor_version
    `);
    return result.rows[0] ?? null;
  });
}

async function markFailure(
  tenantId: string,
  integrationId: string,
  checkpointId: string,
  error: unknown,
): Promise<void> {
  const authFailure = error instanceof TenantCredentialError
    || (error instanceof IntegrationError && error.kind === "auth");
  const code = authFailure ? "auth_failure"
    : error instanceof IntegrationError && error.retryable ? "provider_retryable"
      : "sync_failure";
  const safeMessage = authFailure ? "Provider authentication is unavailable or revoked"
    : error instanceof IntegrationError ? `${error.integration}:${error.kind}`
      : "Source synchronization failed";
  await withTenant(tenantId, async (db) => {
    await db.update(integrationSyncCheckpoints).set({
      status: authFailure ? "blocked" : "degraded",
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCode: code,
      recovery: { safeAction: authFailure ? "reauthenticate" : "retry_with_backoff" },
      updatedAt: new Date(),
    }).where(and(eq(integrationSyncCheckpoints.tenantId, tenantId), eq(integrationSyncCheckpoints.id, checkpointId)));
    await db.update(tenantIntegrations).set({
      health: authFailure ? "down" : "degraded",
      syncStatus: authFailure ? "blocked" : "degraded",
      reconciliationStatus: authFailure ? "blocked" : "degraded",
      lastError: safeMessage,
      updatedAt: new Date(),
    }).where(and(eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.id, integrationId)));
  });
}

async function processSourcePage(payload: Record<string, unknown>): Promise<void> {
  const tenantId = typeof payload.tenantId === "string" ? payload.tenantId : "";
  const integrationId = typeof payload.integrationId === "string" ? payload.integrationId : "";
  const scope = typeof payload.scope === "string" ? payload.scope : "";
  const remainingScopes = stringArray(payload.remainingScopes);
  if (!tenantId || !integrationId || !scope) throw new Error("sync_source requires tenantId, integrationId, and scope");
  await resolveTenantVertical(tenantId);

  const [integration] = await withTenant(tenantId, (db) => db.select().from(tenantIntegrations).where(and(
    eq(tenantIntegrations.tenantId, tenantId),
    eq(tenantIntegrations.id, integrationId),
  )).limit(1));
  if (!integration) return;
  const adapter = createSourceAdapterRegistry().get(integration.binding);
  if (integration.mode === "emulator") {
    await withTenant(tenantId, (db) => db.update(tenantIntegrations).set({
      syncStatus: "blocked", freshnessState: "unknown", reconciliationStatus: "blocked",
      lastError: "BLOCKED-CONFIG: internal emulator cannot certify live source truth", updatedAt: new Date(),
    }).where(and(eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.id, integrationId))));
    return;
  }

  const owner = `${process.pid}:${randomUUID()}`;
  const checkpoint = await claimCheckpoint(tenantId, integrationId, scope, owner);
  if (!checkpoint) return;
  try {
    await withTenant(tenantId, (db) => db.update(tenantIntegrations).set({
      syncStatus: integration.syncInitializedAt ? "syncing" : "initializing",
      lastSyncStartedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.id, integrationId))));

    const credentialContext = await loadSourceCredentialContext(tenantId, {
      ...integration,
      binding: integration.binding,
    });
    if (!adapter.scopes.includes(scope)) throw new IntegrationError(integration.binding, `source scope ${scope} is not supported`, false, "config");
    const cursor = object(checkpoint.cursor) as SourceSyncCursor;
    const page = await adapter.readPage(scope, { ...cursor, version: 1 }, {
      tenantId,
      integrationId,
      config: object(integration.config),
      credentialContext,
    });

    // A registered vertical adapter owns any dependency ordering inside its page.
    for (const record of page.records) {
      if (record.tenantId !== tenantId || record.integrationId !== integrationId || record.provider !== integration.binding) {
        throw new IntegrationError(integration.binding, "adapter returned cross-tenant/account source identity", false, "auth");
      }
      await withTenant(tenantId, (db) => materializeSourceRecord(db, record));
    }

    const completedAt = new Date();
    const nextInitialScope = !page.hasMore ? remainingScopes[0] : undefined;
    const initialChainComplete = !page.hasMore && remainingScopes.length === 0;
    await withTenant(tenantId, async (db) => {
      await db.update(integrationSyncCheckpoints).set({
        cursor: page.hasMore ? page.nextCursor : { version: 1 },
        cursorVersion: 1,
        highWatermark: page.highWatermark ? new Date(page.highWatermark) : completedAt,
        status: "idle",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastPageAt: completedAt,
        lastSuccessAt: completedAt,
        errorCode: null,
        recovery: {},
        updatedAt: completedAt,
      }).where(and(eq(integrationSyncCheckpoints.tenantId, tenantId), eq(integrationSyncCheckpoints.id, checkpoint.id)));
      await db.update(tenantIntegrations).set({
        health: "ok",
        syncStatus: page.hasMore || nextInitialScope ? "syncing" : "synced",
        freshnessState: "fresh",
        reconciliationStatus: "healthy",
        syncInitializedAt: integration.syncInitializedAt ?? (initialChainComplete ? completedAt : null),
        lastSuccessfulSyncAt: completedAt,
        lastObservedAt: completedAt,
        sourceLagMs: page.highWatermark ? Math.max(0, completedAt.getTime() - new Date(page.highWatermark).getTime()) : 0,
        lastError: null,
        updatedAt: completedAt,
      }).where(and(eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.id, integrationId)));
    });

    if (page.hasMore) {
      await enqueueJob(
        "sync_source",
        { tenantId, integrationId, scope, ...(remainingScopes.length ? { remainingScopes } : {}) },
        `source-sync:${tenantId}:${integrationId}:${scope}:${cursorKey(page.nextCursor)}`,
        typeof payload._correlationId === "string" ? payload._correlationId : undefined,
      );
    } else if (nextInitialScope) {
      await enqueueJob(
        "sync_source",
        { tenantId, integrationId, scope: nextInitialScope, remainingScopes: remainingScopes.slice(1) },
        `source-sync:${tenantId}:${integrationId}:${nextInitialScope}:initial`,
        typeof payload._correlationId === "string" ? payload._correlationId : undefined,
      );
    }
  } catch (error) {
    await markFailure(tenantId, integrationId, checkpoint.id, error);
    throw error;
  }
}

export const syncSource: JobHandler = processSourcePage;

/** Fan-out only. Persistent page work, retry, backoff and DLQ all remain on the
 * existing jobs queue rather than inside this scheduler tick. */
export const syncSources: JobHandler = async (payload) => {
  const tenantId = typeof payload.tenantId === "string" ? payload.tenantId : "";
  if (!tenantId) throw new Error("sync_sources requires tenantId");
  await resolveTenantVertical(tenantId);
  const registry = createSourceAdapterRegistry();
  const providers = registry.providers();
  if (providers.length === 0) {
    logWithTrace({ traceId: payload._correlationId as string | undefined }).info({ tenantId }, "[source-sync] no active vertical source mappings");
    return;
  }
  const integrations = await withTenant(tenantId, (db) => db.select().from(tenantIntegrations).where(and(
    eq(tenantIntegrations.tenantId, tenantId),
    inArray(tenantIntegrations.binding, providers),
  )));
  for (const integration of integrations) {
    const provider = integration.binding;
    const adapter = registry.get(provider);
    const sourcePolicy = object(integration.sourcePolicy);
    const configuredScopes = integration.syncScopes.length > 0 ? integration.syncScopes : stringArray(sourcePolicy.syncScopes);
    const scopes = configuredScopes.filter((scope) => adapter.scopes.includes(scope));
    for (const scope of scopes) {
      await enqueueJob(
        "sync_source",
        {
          tenantId,
          integrationId: integration.id,
          scope,
        },
        `source-sync:${tenantId}:${integration.id}:${scope}:${new Date().toISOString().slice(0, 16)}`,
        typeof payload._correlationId === "string" ? payload._correlationId : undefined,
      );
    }
  }
  logWithTrace({ traceId: payload._correlationId as string | undefined }).info({ tenantId, integrations: integrations.length }, "[source-sync] scheduled tenant source truth refresh");
};
