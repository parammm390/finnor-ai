import { createHash, randomUUID } from "node:crypto";
import {
  applicationAccounts,
  authProfiles,
  enqueueJob,
  integrationSubscriptions,
  integrationSourceScopes,
  integrationSyncCheckpoints,
  resolveTenantVertical,
  tenantIntegrations,
  withTenant,
  type Db,
} from "@finnor/db";
import { appendSourceCoverageTx, materializeSourceRecord, recordBusinessEvent } from "@finnor/data-platform";
import {
  ProviderAuthError,
  resolveMicrosoftProviderAuthContext,
  resolveCredentialReferenceContext,
  TenantCredentialError,
  type TenantCredentialContext,
  type TenantCredentialProvider,
} from "@finnor/security";
import {
  Microsoft365ObservationAdapter,
  MicrosoftGraphError,
  microsoft365SourceCapability,
  type Microsoft365SourceScope,
  type MicrosoftSourceCursor,
} from "@finnor/provider-microsoft365";
import { recordPrivateEquityProviderEvidenceObservation, type PeMutationContext } from "@finnor/private-equity";
import { createSourceAdapterRegistry, IntegrationError, logWithTrace } from "@finnor/tools";
import type { Microsoft365SourceKind, SourceCoverageState, SourceSyncCursor } from "@finnor/shared-types";
import { and, eq, inArray, sql } from "drizzle-orm";
import { RetryableJobError, type JobHandler } from "../queue";

const MICROSOFT_PROVIDER = "microsoft_graph";
const MAX_MICROSOFT_SCOPE_FANOUT = 4;
const MAX_MICROSOFT_INTEGRATION_CONCURRENCY = 2;
const ARTIFACT_MEDIA_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/pdf",
]);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function cursorKey(cursor: SourceSyncCursor): string {
  return createHash("sha256").update(JSON.stringify(cursor, Object.keys(cursor).sort())).digest("hex").slice(0, 20);
}

function optionalDate(value: unknown): Date | null {
  if (!(typeof value === "string" || value instanceof Date)) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function minObservationAt(observations: readonly { observedAt: string }[]): Date | null {
  let earliest: Date | null = null;
  for (const observation of observations) {
    const parsed = optionalDate(observation.observedAt);
    if (parsed && (!earliest || parsed < earliest)) earliest = parsed;
  }
  return earliest;
}

async function recomputeMicrosoftIntegrationTx(db: Db, tenantId: string, integrationId: string): Promise<void> {
  const result = await db.execute<{
    total: number | string;
    fresh: number | string;
    blocked_auth: number | string;
    blocked_permission: number | string;
    initializing: number | string;
    impaired: number | string;
    unresolved: number | string;
    ambiguous: number | string;
    last_successful_at: Date | null;
    last_observed_at: Date | null;
  }>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (c.source_scope_id)
        c.source_scope_id,c.state,c.unresolved_observations,c.ambiguous_observations
      FROM finnor_os.integration_source_coverage_history c
      JOIN finnor_os.integration_source_scopes s
        ON s.tenant_id=c.tenant_id AND s.id=c.source_scope_id
      WHERE s.tenant_id=${tenantId}::uuid AND s.integration_id=${integrationId}::uuid AND s.enabled
      ORDER BY c.source_scope_id,c.coverage_revision DESC
    )
    SELECT
      count(*)::int total,
      count(*) FILTER (WHERE s.freshness_state='fresh')::int fresh,
      count(*) FILTER (WHERE l.state='BLOCKED_AUTH')::int blocked_auth,
      count(*) FILTER (WHERE l.state='BLOCKED_PERMISSION')::int blocked_permission,
      count(*) FILTER (WHERE l.state='INITIALIZING')::int initializing,
      count(*) FILTER (WHERE l.state IN ('PARTIAL','RECOVERING','BLOCKED_AUTH','BLOCKED_PERMISSION','NOT_CONFIGURED'))::int impaired,
      coalesce(sum(coalesce(l.unresolved_observations,0)),0)::int unresolved,
      coalesce(sum(coalesce(l.ambiguous_observations,0)),0)::int ambiguous,
      max(s.last_successful_sync_at) last_successful_at,
      max(s.last_observed_at) last_observed_at
    FROM finnor_os.integration_source_scopes s
    LEFT JOIN latest l ON l.source_scope_id=s.id
    WHERE s.tenant_id=${tenantId}::uuid AND s.integration_id=${integrationId}::uuid AND s.enabled
  `);
  const row = result.rows[0];
  const total = Number(row?.total ?? 0);
  const fresh = Number(row?.fresh ?? 0);
  const authBlocked = Number(row?.blocked_auth ?? 0);
  const permissionBlocked = Number(row?.blocked_permission ?? 0);
  const initializing = Number(row?.initializing ?? 0);
  const impaired = Number(row?.impaired ?? 0);
  const unresolved = Number(row?.unresolved ?? 0);
  const ambiguous = Number(row?.ambiguous ?? 0);
  const fullyAuthBlocked = total > 0 && authBlocked === total;
  const healthy = total > 0 && fresh === total && impaired === 0;
  const syncStatus = fullyAuthBlocked
    ? "blocked"
    : initializing > 0
      ? "initializing"
      : healthy
        ? "synced"
        : "degraded";
  const lastSuccessfulAt = optionalDate(row?.last_successful_at);
  const lastObservedAt = optionalDate(row?.last_observed_at);
  const now = new Date();
  await db.update(tenantIntegrations).set({
    health: fullyAuthBlocked ? "down" : healthy ? "ok" : "degraded",
    syncStatus,
    freshnessState: healthy ? "fresh" : lastSuccessfulAt ? "stale" : "unknown",
    reconciliationStatus: fullyAuthBlocked ? "blocked" : impaired > 0 || permissionBlocked > 0 || unresolved > 0 || ambiguous > 0 ? "degraded" : "healthy",
    unresolvedConflicts: unresolved + ambiguous,
    syncInitializedAt: healthy ? (lastSuccessfulAt ?? now) : undefined,
    lastSuccessfulSyncAt: lastSuccessfulAt,
    lastObservedAt,
    sourceLagMs: lastSuccessfulAt ? Math.max(0, now.getTime() - lastSuccessfulAt.getTime()) : null,
    lastError: healthy ? null : fullyAuthBlocked ? "Microsoft application authentication is blocked" : "One or more Microsoft source scopes is degraded",
    updatedAt: now,
  }).where(and(eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.id, integrationId)));
}

async function recordCoverageEventTx(
  db: Db,
  input: Parameters<typeof appendSourceCoverageTx>[1],
): Promise<void> {
  const result = await appendSourceCoverageTx(db, input);
  if (!result.created) return;
  await recordBusinessEvent(db, {
    tenantId: input.tenantId,
    entityType: "integration_source_scope",
    entityId: input.sourceScopeId,
    eventType: "source_coverage_changed",
    payload: {
      sourceScopeId: input.sourceScopeId,
      sourceKind: input.sourceKind,
      state: result.snapshot.state,
      recoveryStrength: result.snapshot.recoveryStrength,
      coverageRevision: result.revision,
      unresolvedObservations: result.snapshot.unresolvedObservations,
      ambiguousObservations: result.snapshot.ambiguousObservations,
      effectiveFrom: result.snapshot.effectiveFrom,
      reason: result.snapshot.reason,
    },
    source: MICROSOFT_PROVIDER,
  });
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
    if (binding.credentialProvider === "aws-iam-federated") {
      throw new IntegrationError(integration.binding, "federated workload auth requires a provider-observation adapter", false, "config");
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

async function claimCheckpoint(
  tenantId: string,
  integrationId: string,
  scope: string,
  owner: string,
  sourceScopeId?: string,
) {
  return withTenant(tenantId, async (db) => {
    await db.insert(integrationSyncCheckpoints).values({
      tenantId,
      integrationId,
      sourceScope: scope,
      sourceScopeId: sourceScopeId ?? null,
    }).onConflictDoNothing();
    if (sourceScopeId) {
      await db.update(integrationSyncCheckpoints).set({ sourceScopeId }).where(and(
        eq(integrationSyncCheckpoints.tenantId, tenantId),
        eq(integrationSyncCheckpoints.integrationId, integrationId),
        eq(integrationSyncCheckpoints.sourceScope, scope),
        sql`${integrationSyncCheckpoints.sourceScopeId} IS NULL`,
      ));
    }
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${integrationId}`},5123))`);
    const result = await db.execute<{
      id: string;
      cursor: SourceSyncCursor;
      cursor_version: number;
      recovery: Record<string, unknown>;
    }>(sql`
      UPDATE finnor_os.integration_sync_checkpoints
      SET status='running',lease_owner=${owner},lease_expires_at=now()+interval '2 minutes',error_code=NULL,updated_at=now()
      WHERE tenant_id=${tenantId}::uuid AND integration_id=${integrationId}::uuid AND source_scope=${scope}
        AND (lease_expires_at IS NULL OR lease_expires_at<now() OR lease_owner=${owner})
        AND (
          lease_owner=${owner}
          OR (SELECT count(*) FROM finnor_os.integration_sync_checkpoints active
               WHERE active.tenant_id=${tenantId}::uuid AND active.integration_id=${integrationId}::uuid
                 AND active.status='running' AND active.lease_expires_at>now()) < ${MAX_MICROSOFT_INTEGRATION_CONCURRENCY}
        )
      RETURNING id::text,cursor,cursor_version,recovery
    `);
    return result.rows[0] ?? null;
  });
}

async function markFailure(
  tenantId: string,
  integrationId: string,
  checkpointId: string,
  error: unknown,
  sourceScope?: typeof integrationSourceScopes.$inferSelect,
  leaseOwner?: string,
): Promise<void> {
  const authFailure = error instanceof TenantCredentialError
    || (error instanceof IntegrationError && error.kind === "auth")
    || (error instanceof ProviderAuthError && error.code === "blocked_auth")
    || (error instanceof MicrosoftGraphError && error.kind === "auth");
  const permissionFailure = (error instanceof ProviderAuthError && error.code === "blocked_permission")
    || (error instanceof MicrosoftGraphError && error.kind === "permission");
  const configFailure = (error instanceof ProviderAuthError && error.code === "blocked_config")
    || (error instanceof MicrosoftGraphError && error.kind === "blocked_config")
    || (error instanceof IntegrationError && error.kind === "config");
  const retryAfterMs = error instanceof MicrosoftGraphError && error.retryable ? error.retryAfterMs : undefined;
  const code = authFailure ? "auth_failure"
    : permissionFailure ? "permission_failure"
      : configFailure ? "blocked_config"
    : error instanceof IntegrationError && error.retryable ? "provider_retryable"
      : error instanceof MicrosoftGraphError && error.retryable ? error.kind
      : "sync_failure";
  const safeMessage = authFailure ? "Provider authentication is unavailable or revoked"
    : permissionFailure ? "Microsoft source permission or provider-side resource restriction is blocked"
      : configFailure ? "Microsoft source configuration is invalid or incomplete"
    : error instanceof IntegrationError ? `${error.integration}:${error.kind}`
      : error instanceof MicrosoftGraphError ? `microsoft_graph:${error.kind}`
      : "Source synchronization failed";
  await withTenant(tenantId, async (db) => {
    const failed = await db.update(integrationSyncCheckpoints).set({
      status: authFailure || permissionFailure || configFailure ? "blocked" : "degraded",
      leaseOwner: null,
      leaseExpiresAt: null,
      errorCode: code,
      recovery: {
        safeAction: authFailure ? "reauthenticate" : permissionFailure ? "verify_provider_permissions" : configFailure ? "repair_configuration" : "retry_with_backoff",
        ...(retryAfterMs ? { retryAfterMs } : {}),
      },
      updatedAt: new Date(),
    }).where(and(
      eq(integrationSyncCheckpoints.tenantId, tenantId),
      eq(integrationSyncCheckpoints.id, checkpointId),
      ...(leaseOwner ? [eq(integrationSyncCheckpoints.leaseOwner, leaseOwner)] : []),
    )).returning({ id: integrationSyncCheckpoints.id });
    // A stale worker must never clear or degrade a lease now owned by a retry.
    if (failed.length !== 1) return;
    if (sourceScope) {
      await db.update(integrationSourceScopes).set({
        freshnessState: authFailure || permissionFailure || configFailure ? "unknown" : "stale",
        updatedAt: new Date(),
      }).where(and(
        eq(integrationSourceScopes.tenantId, tenantId),
        eq(integrationSourceScopes.id, sourceScope.id),
      ));
      const capability = microsoft365SourceCapability(sourceScope.sourceKind);
      const coverageState: SourceCoverageState = authFailure
        ? "BLOCKED_AUTH"
        : permissionFailure
          ? "BLOCKED_PERMISSION"
          : configFailure
            ? "NOT_CONFIGURED"
            : "PARTIAL";
      await recordCoverageEventTx(db, {
        tenantId,
        sourceScopeId: sourceScope.id,
        sourceKind: sourceScope.sourceKind,
        state: coverageState,
        recoveryStrength: capability.recoveryStrength,
        region: object(sourceScope.coveragePolicy),
        reason: safeMessage,
        checkpointId,
        metadata: { errorCode: code, retryable: error instanceof MicrosoftGraphError ? error.retryable : error instanceof IntegrationError ? error.retryable : false },
      });
      await recomputeMicrosoftIntegrationTx(db, tenantId, integrationId);
    } else {
      await db.update(tenantIntegrations).set({
        health: authFailure ? "down" : "degraded",
        syncStatus: authFailure ? "blocked" : "degraded",
        reconciliationStatus: authFailure ? "blocked" : "degraded",
        lastError: safeMessage,
        updatedAt: new Date(),
      }).where(and(eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.id, integrationId)));
    }
  });
}

function microsoftScope(row: typeof integrationSourceScopes.$inferSelect): Microsoft365SourceScope {
  if (row.provider !== MICROSOFT_PROVIDER) throw new Error("Microsoft source scope has a mismatched provider");
  return {
    id: row.id,
    tenantId: row.tenantId,
    integrationId: row.integrationId,
    provider: MICROSOFT_PROVIDER,
    sourceKind: row.sourceKind,
    scopeKey: row.scopeKey,
    providerResourceId: row.providerResourceId,
    providerParentId: row.providerParentId,
    permissionMode: row.permissionMode,
    coveragePolicy: object(row.coveragePolicy),
    freshnessPolicy: object(row.freshnessPolicy),
    configuration: object(row.configuration),
  };
}

async function loadMicrosoftScope(
  tenantId: string,
  integrationId: string,
  payload: Record<string, unknown>,
): Promise<typeof integrationSourceScopes.$inferSelect | null> {
  const sourceScopeId = typeof payload.sourceScopeId === "string" ? payload.sourceScopeId : null;
  const scopeKey = typeof payload.scope === "string" ? payload.scope : null;
  if (!sourceScopeId && !scopeKey) throw new Error("Microsoft sync_source requires sourceScopeId or scope");
  const [scope] = await withTenant(tenantId, (db) => db.select().from(integrationSourceScopes).where(and(
    eq(integrationSourceScopes.tenantId, tenantId),
    eq(integrationSourceScopes.integrationId, integrationId),
    eq(integrationSourceScopes.provider, MICROSOFT_PROVIDER),
    sourceScopeId ? eq(integrationSourceScopes.id, sourceScopeId) : eq(integrationSourceScopes.scopeKey, scopeKey!),
  )).limit(1));
  return scope ?? null;
}

async function ensureMicrosoftSubscriptionReady(
  tenantId: string,
  integrationId: string,
  source: typeof integrationSourceScopes.$inferSelect,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const capability = microsoft365SourceCapability(source.sourceKind);
  if (!capability.supportsChangeNotifications) return true;
  const [subscription] = await withTenant(tenantId, (db) => db.select({ id: integrationSubscriptions.id }).from(integrationSubscriptions).where(and(
    eq(integrationSubscriptions.tenantId, tenantId),
    eq(integrationSubscriptions.integrationId, integrationId),
    eq(integrationSubscriptions.sourceScopeId, source.id),
    inArray(integrationSubscriptions.status, ["active", "renewing", "reauthorization_required"]),
    sql`${integrationSubscriptions.providerSubscriptionId} IS NOT NULL`,
    sql`${integrationSubscriptions.expirationAt}>now()`,
  )).limit(1));
  if (subscription) return true;
  await enqueueJob(
    "maintain_integration_subscriptions",
    { tenantId, integrationId, sourceScopeId: source.id, scope: source.scopeKey, reason: "subscription_required_before_sync" },
    `m365-subscription-required:${tenantId}:${source.id}:${new Date().toISOString().slice(0, 16)}`,
    typeof payload._correlationId === "string" ? payload._correlationId : undefined,
    "interactive",
    75,
  );
  return false;
}

async function processMicrosoftSourcePage(
  payload: Record<string, unknown>,
  integration: typeof tenantIntegrations.$inferSelect,
): Promise<void> {
  const tenantId = integration.tenantId;
  const integrationId = integration.id;
  const source = await loadMicrosoftScope(tenantId, integrationId, payload);
  if (!source || !source.enabled) return;
  const expectedPermissions = microsoft365SourceCapability(source.sourceKind).permissionProfiles[source.permissionMode];
  if (!source.permissionVerifiedAt || !expectedPermissions
      || !expectedPermissions.every((permission) => source.effectivePermissions.includes(permission))) {
    await withTenant(tenantId, async (db) => {
      await recordCoverageEventTx(db, {
        tenantId,
        sourceScopeId: source.id,
        sourceKind: source.sourceKind,
        state: "BLOCKED_PERMISSION",
        recoveryStrength: microsoft365SourceCapability(source.sourceKind).recoveryStrength,
        region: object(source.coveragePolicy),
        reason: "Microsoft source permission profile is not durably verified",
        metadata: { errorCode: "permission_not_verified" },
      });
      await db.update(tenantIntegrations).set({
        health: "degraded",
        syncStatus: "blocked",
        reconciliationStatus: "blocked",
        lastError: "Microsoft source permission profile is not durably verified",
        updatedAt: new Date(),
      }).where(and(eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.id, integrationId)));
    });
    return;
  }
  if (!await ensureMicrosoftSubscriptionReady(tenantId, integrationId, source, payload)) return;
  const scope = microsoftScope(source);
  const owner = `${process.pid}:${randomUUID()}`;
  const checkpoint = await claimCheckpoint(tenantId, integrationId, scope.scopeKey, owner, scope.id);
  if (!checkpoint) {
    throw new RetryableJobError("Microsoft source scope or integration concurrency lease is busy", 5_000);
  }
  const storedCursor = { ...object(checkpoint.cursor), version: 1 } as MicrosoftSourceCursor;
  const storedRecovery = object(checkpoint.recovery);
  const recoveryCursor = object(storedRecovery.cursor);
  const continuingRecovery = Object.keys(recoveryCursor).length > 0;
  const requestedRecovery = payload.forceRecovery === true;
  const cursor: MicrosoftSourceCursor = continuingRecovery
    ? { ...recoveryCursor, version: 1 } as MicrosoftSourceCursor
    : requestedRecovery
      ? { ...storedCursor, phase: "recovery" }
      : storedCursor;
  const traceId = typeof payload._correlationId === "string" ? payload._correlationId : randomUUID();
  const capability = microsoft365SourceCapability(scope.sourceKind);
  try {
    const startedAt = new Date();
    const baselineStartedAt = optionalDate(cursor.baselineStartedAt) ?? startedAt;
    await withTenant(tenantId, async (db) => {
      await db.update(integrationSyncCheckpoints).set({
        recovery: continuingRecovery
          ? storedRecovery
          : requestedRecovery
            ? { requestedBy: "durable_source_recovery", startedAt: startedAt.toISOString() }
            : {},
        updatedAt: startedAt,
      }).where(and(eq(integrationSyncCheckpoints.tenantId, tenantId), eq(integrationSyncCheckpoints.id, checkpoint.id)));
      await db.update(integrationSourceScopes).set({
        lastSyncStartedAt: startedAt,
        updatedAt: startedAt,
      }).where(and(eq(integrationSourceScopes.tenantId, tenantId), eq(integrationSourceScopes.id, scope.id)));
      await db.update(tenantIntegrations).set({
        syncStatus: integration.syncInitializedAt ? "syncing" : "initializing",
        lastSyncStartedAt: startedAt,
        updatedAt: startedAt,
      }).where(and(eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.id, integrationId)));
      if (!cursor.token && cursor.phase !== "incremental") {
        await recordCoverageEventTx(db, {
          tenantId,
          sourceScopeId: scope.id,
          sourceKind: scope.sourceKind,
          state: requestedRecovery || continuingRecovery ? "RECOVERING" : "INITIALIZING",
          recoveryStrength: capability.recoveryStrength,
          region: scope.coveragePolicy,
          reason: requestedRecovery || continuingRecovery ? "Durable recovery started" : "Initial provider enumeration started",
          checkpointId: checkpoint.id,
          baselineStartedAt,
          metadata: { syncStrategy: source.syncStrategy },
        });
      }
    });

    // Authentication and every Graph request remain outside a database transaction.
    const auth = await resolveMicrosoftProviderAuthContext({ tenantId, integrationId });
    const adapter = new Microsoft365ObservationAdapter(auth);
    const page = await adapter.readObservationPage(scope, cursor, {
      traceId,
      ...((requestedRecovery || continuingRecovery) ? { ingestionMode: "recovery" as const } : {}),
    });
    if (page.sourceScopeId !== scope.id || page.sourceScope !== scope.scopeKey) {
      throw new MicrosoftGraphError("blocked_config", "Microsoft adapter returned a mismatched source scope", null, false);
    }

    const mutationContext: PeMutationContext = {
      auth: { tenantId, userId: "system:microsoft-graph-worker", role: "owner" },
      provenance: { sourceSystem: MICROSOFT_PROVIDER, createdBy: "system:microsoft-graph-worker" },
    };
    for (const observation of page.observations) {
      if (observation.tenantId !== tenantId || observation.integrationId !== integrationId
          || observation.sourceScopeId !== scope.id || observation.provider !== MICROSOFT_PROVIDER) {
        throw new MicrosoftGraphError("blocked_config", "Microsoft adapter returned cross-tenant integration data", null, false);
      }
      const receipt = await recordPrivateEquityProviderEvidenceObservation(mutationContext, observation);
      const mimeType = typeof observation.payload.mimeType === "string" ? observation.payload.mimeType.toLowerCase() : "";
      const providerETag = typeof observation.payload.eTag === "string" ? observation.payload.eTag : observation.providerVersion;
      if (!observation.deleted && observation.resourceKind === "sharepoint_drive"
          && observation.payload.itemType === "file" && ARTIFACT_MEDIA_TYPES.has(mimeType)
          && receipt.documentId && receipt.persistence.sourceLinkId && providerETag) {
        await enqueueJob(
          "materialize_artifact_version",
          {
            tenantId,
            integrationId,
            sourceScopeId: observation.sourceScopeId,
            documentId: receipt.documentId,
            externalRefId: receipt.persistence.sourceLinkId,
            expectedETag: providerETag,
            evidenceVersionId: receipt.evidenceVersionId,
          },
          `artifact-materialize:${tenantId}:${receipt.documentId}:${receipt.persistence.sourceLinkId}:${providerETag}`,
          traceId,
          "batch",
          40,
        );
      }
    }

    const completedAt = new Date();
    const highWatermark = optionalDate(page.highWatermark) ?? completedAt;
    const baselineCompletedAt = optionalDate(page.nextCursor.baselineCompletedAt);
    const earliestProviderAt = optionalDate(page.nextCursor.historyBoundary) ?? minObservationAt(page.observations);
    const recoveryPage = requestedRecovery || continuingRecovery || page.coverage?.state === "RECOVERING";
    const recoveryContinues = recoveryPage && page.hasMore;
    await withTenant(tenantId, async (db) => {
      const committed = await db.update(integrationSyncCheckpoints).set({
        // Keep the last known stable provider cursor until the complete recovery
        // baseline and its immediate catch-up both reach a terminal page.
        cursor: recoveryContinues ? storedCursor : page.nextCursor,
        cursorVersion: 1,
        highWatermark,
        status: "idle",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastPageAt: completedAt,
        lastSuccessAt: completedAt,
        errorCode: null,
        recovery: recoveryContinues ? {
          ...storedRecovery,
          requestedBy: typeof storedRecovery.requestedBy === "string" ? storedRecovery.requestedBy : "provider_resynchronization",
          startedAt: typeof storedRecovery.startedAt === "string" ? storedRecovery.startedAt : startedAt.toISOString(),
          cursor: page.nextCursor,
        } : {},
        updatedAt: completedAt,
      }).where(and(
        eq(integrationSyncCheckpoints.tenantId, tenantId),
        eq(integrationSyncCheckpoints.id, checkpoint.id),
        eq(integrationSyncCheckpoints.leaseOwner, owner),
      )).returning({ id: integrationSyncCheckpoints.id });
      if (committed.length !== 1) throw new RetryableJobError("Microsoft checkpoint lease was lost before cursor commit", 5_000);
      await db.update(integrationSourceScopes).set({
        freshnessState: "fresh",
        lastSuccessfulSyncAt: completedAt,
        lastObservedAt: page.observations.length ? highWatermark : source.lastObservedAt,
        updatedAt: completedAt,
      }).where(and(eq(integrationSourceScopes.tenantId, tenantId), eq(integrationSourceScopes.id, scope.id)));
      await recordCoverageEventTx(db, {
        tenantId,
        sourceScopeId: scope.id,
        sourceKind: scope.sourceKind,
        state: page.coverage?.state ?? "PARTIAL",
        recoveryStrength: capability.recoveryStrength,
        region: page.coverage?.region ?? scope.coveragePolicy,
        reason: page.coverage?.reason ?? null,
        checkpointId: checkpoint.id,
        baselineStartedAt,
        baselineCompletedAt,
        earliestProviderAt,
        latestProviderAt: !page.hasMore && page.observations.length ? highWatermark : null,
        metadata: {
          syncStrategy: source.syncStrategy,
        },
      });
      await recomputeMicrosoftIntegrationTx(db, tenantId, integrationId);
    });

    if (page.hasMore) {
      await enqueueJob(
        "sync_source",
        { tenantId, integrationId, sourceScopeId: scope.id, scope: scope.scopeKey, ...(recoveryContinues ? { forceRecovery: true } : {}) },
        `source-sync:${tenantId}:${integrationId}:${scope.id}:${cursorKey(page.nextCursor)}`,
        traceId,
      );
    }
  } catch (error) {
    await markFailure(tenantId, integrationId, checkpoint.id, error, source, owner);
    if (error instanceof MicrosoftGraphError) {
      if (error.retryable) throw new RetryableJobError(`Microsoft Graph ${error.kind}`, error.retryAfterMs ?? 30_000, { cause: error });
      return;
    }
    if (error instanceof ProviderAuthError) return;
    throw error;
  }
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
  if (integration.binding === MICROSOFT_PROVIDER) {
    if (integration.mode !== "real") {
      await withTenant(tenantId, (db) => db.update(tenantIntegrations).set({
        syncStatus: "blocked", freshnessState: "unknown", reconciliationStatus: "blocked",
        lastError: "BLOCKED-CONFIG: Microsoft source truth requires a real provider binding", updatedAt: new Date(),
      }).where(and(eq(tenantIntegrations.tenantId, tenantId), eq(tenantIntegrations.id, integrationId))));
      return;
    }
    await processMicrosoftSourcePage(payload, integration);
    return;
  }
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
    await markFailure(tenantId, integrationId, checkpoint.id, error, undefined, owner);
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
  const legacyProviders = registry.providers();
  const providers = [...legacyProviders, MICROSOFT_PROVIDER];
  const integrations = await withTenant(tenantId, (db) => db.select().from(tenantIntegrations).where(and(
    eq(tenantIntegrations.tenantId, tenantId),
    inArray(tenantIntegrations.binding, providers),
  )));
  if (integrations.length === 0) {
    logWithTrace({ traceId: payload._correlationId as string | undefined }).info({ tenantId }, "[source-sync] no active vertical source mappings");
    return;
  }
  if (payload.microsoftOnly !== true) for (const integration of integrations.filter((item) => item.binding !== MICROSOFT_PROVIDER)) {
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

  const afterIntegrationId = typeof payload.afterIntegrationId === "string" ? payload.afterIntegrationId : "";
  const afterScopeId = typeof payload.afterScopeId === "string" ? payload.afterScopeId : "";
  const microsoftScopes = await withTenant(tenantId, async (db) => {
    const result = await db.execute<{
      id: string;
      integration_id: string;
      scope_key: string;
    }>(sql`
      SELECT s.id::text,s.integration_id::text,s.scope_key
      FROM finnor_os.integration_source_scopes s
      JOIN finnor_os.tenant_integrations i ON i.tenant_id=s.tenant_id AND i.id=s.integration_id
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN coalesce(s.freshness_policy->>'recoveryCadenceMinutes','') ~ '^[0-9]{1,4}$'
          THEN (s.freshness_policy->>'recoveryCadenceMinutes')::int
          ELSE NULL
        END AS minutes
      ) cadence
      WHERE s.tenant_id=${tenantId}::uuid AND s.provider=${MICROSOFT_PROVIDER} AND s.enabled
        AND s.permission_verified_at IS NOT NULL
        AND i.binding=${MICROSOFT_PROVIDER} AND i.mode='real'
        AND (
          s.source_kind='teams_transcript_organizer'
          OR EXISTS (
            SELECT 1 FROM finnor_os.integration_subscriptions subscription
            WHERE subscription.tenant_id=s.tenant_id
              AND subscription.integration_id=s.integration_id
              AND subscription.source_scope_id=s.id
              AND subscription.status IN ('active','renewing','reauthorization_required')
              AND subscription.provider_subscription_id IS NOT NULL
              AND subscription.expiration_at>now()
          )
        )
        AND (${afterIntegrationId}='' OR (s.integration_id::text,s.id::text)>(${afterIntegrationId},${afterScopeId}))
        AND (
          s.last_successful_sync_at IS NULL
          OR (cadence.minutes BETWEEN 5 AND 1440
              AND s.last_successful_sync_at <= now()-(cadence.minutes||' minutes')::interval)
        )
      ORDER BY s.integration_id,s.id
      LIMIT ${MAX_MICROSOFT_SCOPE_FANOUT + 1}
    `);
    return result.rows;
  });
  for (const scope of microsoftScopes.slice(0, MAX_MICROSOFT_SCOPE_FANOUT)) {
    await enqueueJob(
      "sync_source",
      { tenantId, integrationId: scope.integration_id, sourceScopeId: scope.id, scope: scope.scope_key },
      `source-sync:${tenantId}:${scope.integration_id}:${scope.id}:${new Date().toISOString().slice(0, 16)}`,
      typeof payload._correlationId === "string" ? payload._correlationId : undefined,
    );
  }
  if (microsoftScopes.length > MAX_MICROSOFT_SCOPE_FANOUT) {
    const lastScheduled = microsoftScopes[MAX_MICROSOFT_SCOPE_FANOUT - 1]!;
    await enqueueJob(
      "sync_sources",
      {
        tenantId,
        microsoftOnly: true,
        afterIntegrationId: lastScheduled.integration_id,
        afterScopeId: lastScheduled.id,
      },
      `source-sync-fanout:${tenantId}:${new Date().toISOString().slice(0, 16)}:${lastScheduled.integration_id}:${lastScheduled.id}`,
      typeof payload._correlationId === "string" ? payload._correlationId : undefined,
    );
  }
  logWithTrace({ traceId: payload._correlationId as string | undefined }).info({
    tenantId,
    integrations: integrations.length,
    microsoftScopesScheduled: Math.min(microsoftScopes.length, MAX_MICROSOFT_SCOPE_FANOUT),
  }, "[source-sync] scheduled tenant source truth refresh");
};
