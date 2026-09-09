import { randomUUID } from "node:crypto";
import {
  enqueueJob,
  resolveTenantVertical,
  withTenant,
  withTenantTransaction,
} from "@finnor/db";
import { appendSourceCoverageTx } from "@finnor/data-platform";
import {
  Microsoft365SubscriptionTransport,
  MicrosoftGraphClient,
  MicrosoftGraphError,
  generateSubscriptionClientState,
  microsoft365SourceCapability,
  microsoft365SubscriptionChangeTypes,
  microsoft365SubscriptionResource,
  subscriptionRenewAt,
  type Microsoft365SourceScope,
  type MicrosoftGraphLogger,
  type MicrosoftGraphSubscription,
} from "@finnor/provider-microsoft365";
import {
  ProviderAuthError,
  resolveMicrosoftProviderAuthContext,
} from "@finnor/security";
import type { Microsoft365SourceKind, SourceRecoveryStrength } from "@finnor/shared-types";
import { logWithTrace } from "@finnor/tools";
import { sql } from "drizzle-orm";
import { RetryableJobError, type JobHandler } from "../queue";

const MICROSOFT_PROVIDER = "microsoft_graph" as const;
const CURRENT_STATUSES = ["provisioning", "active", "renewing", "degraded", "reauthorization_required", "deleting"] as const;
const NOTIFICATION_SOURCE_KINDS: readonly Microsoft365SourceKind[] = [
  "outlook_mail_folder",
  "outlook_calendar_view",
  "teams_channel",
  "teams_chat",
  "teams_user_chat_feed",
  "sharepoint_drive",
  "sharepoint_list",
];
const FANOUT = 8;
const LEASE_MS = 2 * 60_000;

interface ScopeRow {
  id: string;
  tenant_id: string;
  integration_id: string;
  provider: string;
  source_kind: Microsoft365SourceKind;
  scope_key: string;
  provider_resource_id: string;
  provider_parent_id: string | null;
  enabled: boolean;
  permission_mode: "SCOPED" | "BROAD";
  required_permissions: string[];
  effective_permissions: string[];
  permission_verified_at: Date | null;
  coverage_policy: Record<string, unknown>;
  freshness_policy: Record<string, unknown>;
  configuration: Record<string, unknown>;
  recovery_strategy: SourceRecoveryStrength;
  last_successful_sync_at: Date | null;
  auth_profile_id: string | null;
}

interface SubscriptionRow {
  id: string;
  provider_subscription_id: string | null;
  status: typeof CURRENT_STATUSES[number];
  expiration_at: Date | null;
  renew_at: Date | null;
  created_at_provider: Date | null;
  client_state_hash: string;
  recovery_state: "none" | "required" | "running" | "converged" | "partial" | "failed";
  lease_owner: string | null;
  lease_expires_at: Date | null;
  created_at: Date;
}

interface ActionBase {
  rowId: string;
  tenantId: string;
  integrationId: string;
  sourceScopeId: string;
  scope: Microsoft365SourceScope;
  authProfileId: string | null;
  needsRecovery: boolean;
  owner: string;
}

type MaintenanceAction =
  | (ActionBase & { kind: "create"; clientState: string; requestedAt: Date })
  | (ActionBase & { kind: "reconcile_create"; clientStateHash: string })
  | (ActionBase & { kind: "renew"; providerSubscriptionId: string; requestedAt: Date })
  | (ActionBase & { kind: "delete"; providerSubscriptionId: string | null; clientStateHash?: string; providerAlreadyExpired: boolean });

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const expected = [...right].sort();
  return left.length === expected.length && [...left].sort().every((value, index) => value === expected[index]);
}

function scopeFromRow(row: ScopeRow): Microsoft365SourceScope {
  if (row.provider !== MICROSOFT_PROVIDER) throw new Error("Microsoft subscription scope has a mismatched provider");
  return {
    id: row.id,
    tenantId: row.tenant_id,
    integrationId: row.integration_id,
    provider: MICROSOFT_PROVIDER,
    sourceKind: row.source_kind,
    scopeKey: row.scope_key,
    providerResourceId: row.provider_resource_id,
    providerParentId: row.provider_parent_id,
    permissionMode: row.permission_mode,
    coveragePolicy: object(row.coverage_policy),
    freshnessPolicy: object(row.freshness_policy),
    configuration: object(row.configuration),
  };
}

function requestedExpiration(scope: Microsoft365SourceScope, now: Date): string {
  const minutes = microsoft365SourceCapability(scope.sourceKind).maxSubscriptionMinutes;
  if (!minutes) throw new MicrosoftGraphError("blocked_config", "Microsoft source does not support subscriptions", null, false);
  return new Date(now.getTime() + Math.max(1, minutes - 5) * 60_000).toISOString();
}

function safeFailure(error: unknown): { code: string; state: "BLOCKED_AUTH" | "BLOCKED_PERMISSION" | "NOT_CONFIGURED" | "PARTIAL"; retryMs?: number } {
  if (error instanceof ProviderAuthError) {
    if (error.code === "blocked_auth") return { code: "blocked_auth", state: "BLOCKED_AUTH" };
    if (error.code === "blocked_permission") return { code: "blocked_permission", state: "BLOCKED_PERMISSION" };
    return { code: "blocked_config", state: "NOT_CONFIGURED" };
  }
  if (error instanceof MicrosoftGraphError) {
    if (error.kind === "auth") return { code: "graph_auth", state: "BLOCKED_AUTH" };
    if (error.kind === "permission") return { code: "graph_permission", state: "BLOCKED_PERMISSION" };
    if (error.kind === "blocked_config") return { code: "blocked_config", state: "NOT_CONFIGURED" };
    return { code: `graph_${error.kind}`, state: "PARTIAL", ...(error.retryable ? { retryMs: error.retryAfterMs ?? 30_000 } : {}) };
  }
  return { code: "subscription_maintenance_failure", state: "PARTIAL", retryMs: 30_000 };
}

function graphLogger(payload: Record<string, unknown>): MicrosoftGraphLogger {
  const log = logWithTrace({
    traceId: typeof payload._correlationId === "string" ? payload._correlationId : undefined,
    tenantId: typeof payload.tenantId === "string" ? payload.tenantId : undefined,
    jobType: "maintain_integration_subscriptions",
  });
  return (event) => log.info({
    event: "m365_graph_request",
    metric: "m365_graph_request_duration_ms",
    ...event,
  }, "Microsoft Graph subscription control request completed");
}

async function discoverDue(payload: Record<string, unknown>, tenantId: string): Promise<void> {
  const afterScopeId = typeof payload.afterScopeId === "string" ? payload.afterScopeId : "";
  const rows = await withTenant(tenantId, async (db) => {
    const result = await db.execute<{ id: string; integration_id: string; scope_key: string }>(sql`
      SELECT source_scope.id::text,source_scope.integration_id::text,source_scope.scope_key
      FROM finnor_os.integration_source_scopes source_scope
      JOIN finnor_os.tenant_integrations integration
        ON integration.tenant_id=source_scope.tenant_id AND integration.id=source_scope.integration_id
      LEFT JOIN LATERAL (
        SELECT subscription.id,subscription.status,subscription.expiration_at,subscription.renew_at,
               subscription.provider_subscription_id,subscription.lease_expires_at
        FROM finnor_os.integration_subscriptions subscription
        WHERE subscription.tenant_id=source_scope.tenant_id
          AND subscription.source_scope_id=source_scope.id
          AND subscription.status IN ('provisioning','active','renewing','degraded','reauthorization_required','deleting')
        LIMIT 1
      ) current_subscription ON true
      WHERE source_scope.tenant_id=${tenantId}::uuid
        AND source_scope.provider=${MICROSOFT_PROVIDER}
        AND source_scope.source_kind=ANY(${NOTIFICATION_SOURCE_KINDS as string[]}::text[])
        AND integration.binding=${MICROSOFT_PROVIDER} AND integration.mode='real'
        AND (${afterScopeId}='' OR source_scope.id::text>${afterScopeId})
        AND (
          (source_scope.enabled AND source_scope.permission_verified_at IS NOT NULL AND (
            current_subscription.id IS NULL
            OR current_subscription.status IN ('provisioning','degraded','reauthorization_required')
            OR current_subscription.expiration_at IS NULL
            OR current_subscription.expiration_at<=now()
            OR current_subscription.renew_at<=now()
          ))
          OR (NOT source_scope.enabled AND current_subscription.id IS NOT NULL)
        )
        AND (current_subscription.lease_expires_at IS NULL OR current_subscription.lease_expires_at<=now())
      ORDER BY source_scope.id
      LIMIT ${FANOUT + 1}
    `);
    return result.rows;
  });
  const bucket = new Date().toISOString().slice(0, 16);
  for (const row of rows.slice(0, FANOUT)) {
    await enqueueJob(
      "maintain_integration_subscriptions",
      { tenantId, integrationId: row.integration_id, sourceScopeId: row.id, scope: row.scope_key },
      `m365-subscription-maintenance:${tenantId}:${row.id}:${bucket}`,
      typeof payload._correlationId === "string" ? payload._correlationId : undefined,
      "batch",
      25,
    );
  }
  if (rows.length > FANOUT) {
    const last = rows[FANOUT - 1]!;
    await enqueueJob(
      "maintain_integration_subscriptions",
      { tenantId, afterScopeId: last.id },
      `m365-subscription-maintenance-fanout:${tenantId}:${last.id}:${bucket}`,
      typeof payload._correlationId === "string" ? payload._correlationId : undefined,
    );
  }
}

async function prepareAction(
  tenantId: string,
  sourceScopeId: string,
  owner: string,
  reason: string | null,
): Promise<MaintenanceAction | null> {
  return withTenantTransaction(tenantId, {}, async (db, client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,5114))", [`${tenantId}:${sourceScopeId}`]);
    const scopeResult = await client.query<ScopeRow>(
      `SELECT source_scope.id,source_scope.tenant_id,source_scope.integration_id,source_scope.provider,
              source_scope.source_kind,source_scope.scope_key,source_scope.provider_resource_id,
              source_scope.provider_parent_id,source_scope.enabled,source_scope.permission_mode,
              source_scope.required_permissions,source_scope.effective_permissions,source_scope.permission_verified_at,
              source_scope.coverage_policy,source_scope.freshness_policy,source_scope.configuration,
              source_scope.recovery_strategy,source_scope.last_successful_sync_at,integration.auth_profile_id
         FROM finnor_os.integration_source_scopes source_scope
         JOIN finnor_os.tenant_integrations integration
           ON integration.tenant_id=source_scope.tenant_id AND integration.id=source_scope.integration_id
        WHERE source_scope.tenant_id=$1::uuid AND source_scope.id=$2::uuid
          AND source_scope.provider='microsoft_graph' AND integration.binding='microsoft_graph' AND integration.mode='real'
        FOR UPDATE OF source_scope`,
      [tenantId, sourceScopeId],
    );
    const row = scopeResult.rows[0];
    if (!row) return null;
    const scope = scopeFromRow(row);
    const capability = microsoft365SourceCapability(scope.sourceKind);
    if (!capability.supportsChangeNotifications) return null;
    const expectedPermissions = capability.permissionProfiles[scope.permissionMode];
    // Permission verification gates provider reads and active subscriptions. A
    // disabled scope must still be allowed through to the cleanup branch below,
    // otherwise clearing its verification proof would strand the remote
    // subscription indefinitely.
    if (row.enabled && (!expectedPermissions || !row.permission_verified_at || !sameSet(row.required_permissions, expectedPermissions)
        || !expectedPermissions.every((permission) => row.effective_permissions.includes(permission)))) {
      throw new MicrosoftGraphError("blocked_config", "Microsoft source permission profile is not durably verified", null, false);
    }
    const currentResult = await client.query<SubscriptionRow>(
      `SELECT id,provider_subscription_id,status,expiration_at,renew_at,created_at_provider,
              client_state_hash,recovery_state,lease_owner,lease_expires_at,created_at
         FROM finnor_os.integration_subscriptions
        WHERE tenant_id=$1::uuid AND source_scope_id=$2::uuid
          AND status=ANY($3::text[])
        ORDER BY created_at DESC
        FOR UPDATE`,
      [tenantId, sourceScopeId, CURRENT_STATUSES],
    );
    if (currentResult.rows.length > 1) throw new Error("Multiple current subscriptions exist for one Microsoft source scope");
    let current = currentResult.rows[0] ?? null;
    const now = new Date();
    if (current?.lease_owner && current.lease_owner !== owner && current.lease_expires_at && current.lease_expires_at > now) {
      throw new RetryableJobError("Microsoft subscription lease is busy", 5_000);
    }
    const prior = await client.query<{ recovery: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM finnor_os.integration_subscriptions
          WHERE tenant_id=$1::uuid AND source_scope_id=$2::uuid
            AND (recovery_state IN ('required','running','partial','failed') OR status IN ('removed','expired'))
       ) AS recovery`,
      [tenantId, sourceScopeId],
    );
    let needsRecovery = prior.rows[0]?.recovery === true
      || reason === "subscription_removed"
      || reason === "subscription_expired";
    const base = {
      tenantId,
      integrationId: row.integration_id,
      sourceScopeId,
      scope,
      authProfileId: row.auth_profile_id,
      needsRecovery,
      owner,
    };

    if (!row.enabled) {
      if (!current) return null;
      await client.query(
        `UPDATE finnor_os.integration_subscriptions
            SET status='deleting',lease_owner=$3,lease_expires_at=$4,failure_code=NULL,updated_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenantId, current.id, owner, new Date(now.getTime() + LEASE_MS)],
      );
      return {
        ...base,
        rowId: current.id,
        kind: "delete",
        providerSubscriptionId: current.provider_subscription_id,
        ...(!current.provider_subscription_id ? { clientStateHash: current.client_state_hash } : {}),
        providerAlreadyExpired: !current.expiration_at || current.expiration_at <= now,
      };
    }

    if (current && current.expiration_at && current.expiration_at <= now && current.status !== "provisioning") {
      await client.query(
        `UPDATE finnor_os.integration_subscriptions
            SET status='expired',recovery_state='required',failure_code='provider_expired',
                lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenantId, current.id],
      );
      await appendSourceCoverageTx(db, {
        tenantId,
        sourceScopeId,
        sourceKind: row.source_kind,
        state: "RECOVERING",
        recoveryStrength: row.recovery_strategy,
        region: row.coverage_policy,
        effectiveFrom: now,
        reason: "Microsoft Graph subscription expired before renewal converged",
        metadata: { provider: MICROSOFT_PROVIDER, failureCode: "provider_expired" },
      });
      needsRecovery = true;
      current = null;
    }

    if (current?.provider_subscription_id) {
      if (current.status === "active" && current.renew_at && current.renew_at > now && reason !== "reauthorization_required") {
        return null;
      }
      if (current.status === "deleting") {
        await client.query(
          `UPDATE finnor_os.integration_subscriptions SET lease_owner=$3,lease_expires_at=$4,updated_at=clock_timestamp()
            WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          [tenantId, current.id, owner, new Date(now.getTime() + LEASE_MS)],
        );
        return { ...base, rowId: current.id, kind: "delete", providerSubscriptionId: current.provider_subscription_id, providerAlreadyExpired: false };
      }
      await client.query(
        `UPDATE finnor_os.integration_subscriptions
            SET status='renewing',lease_owner=$3,lease_expires_at=$4,failure_code=NULL,updated_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenantId, current.id, owner, new Date(now.getTime() + LEASE_MS)],
      );
      return { ...base, rowId: current.id, kind: "renew", providerSubscriptionId: current.provider_subscription_id, requestedAt: now };
    }

    if (current) {
      await client.query(
        `UPDATE finnor_os.integration_subscriptions
            SET status='provisioning',lease_owner=$3,lease_expires_at=$4,updated_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        [tenantId, current.id, owner, new Date(now.getTime() + LEASE_MS)],
      );
      return { ...base, rowId: current.id, kind: "reconcile_create", clientStateHash: current.client_state_hash };
    }

    const generated = generateSubscriptionClientState();
    const created = await client.query<{ id: string }>(
      `INSERT INTO finnor_os.integration_subscriptions(
         tenant_id,integration_id,source_scope_id,provider,resource,change_types,status,
         client_state_hash,recovery_state,lease_owner,lease_expires_at,metadata
       ) VALUES ($1::uuid,$2::uuid,$3::uuid,'microsoft_graph',$4,$5::text[],'provisioning',$6,$7,$8,$9,$10::jsonb)
       RETURNING id`,
      [
        tenantId,
        row.integration_id,
        sourceScopeId,
        microsoft365SubscriptionResource(scope),
        microsoft365SubscriptionChangeTypes(scope),
        generated.hash,
        needsRecovery ? "required" : "none",
        owner,
        new Date(now.getTime() + LEASE_MS),
        JSON.stringify({ provisioningGeneration: 1 }),
      ],
    );
    return { ...base, needsRecovery, rowId: created.rows[0]!.id, kind: "create", clientState: generated.plaintext, requestedAt: now };
  });
}

async function resetProvisioning(action: Extract<MaintenanceAction, { kind: "reconcile_create" }>): Promise<Extract<MaintenanceAction, { kind: "create" }>> {
  const generated = generateSubscriptionClientState();
  const requestedAt = new Date();
  await withTenantTransaction(action.tenantId, {}, async (_db, client) => {
    const updated = await client.query(
      `UPDATE finnor_os.integration_subscriptions
          SET status='provisioning',client_state_hash=$4,provider_subscription_id=NULL,
              expiration_at=NULL,renew_at=NULL,created_at_provider=NULL,last_renewed_at=NULL,
              lease_expires_at=$5,failure_code=NULL,
              metadata=jsonb_set(metadata,'{provisioningGeneration}',to_jsonb(
                CASE WHEN coalesce(metadata->>'provisioningGeneration','') ~ '^[0-9]{1,6}$'
                  THEN LEAST((metadata->>'provisioningGeneration')::int+1,999999) ELSE 2 END
              ),true),
              updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND lease_owner=$3 AND provider_subscription_id IS NULL`,
      [action.tenantId, action.rowId, action.owner, generated.hash, new Date(requestedAt.getTime() + LEASE_MS)],
    );
    if (updated.rowCount !== 1) throw new Error("Microsoft provisioning lease was lost before retry");
  });
  return { ...action, kind: "create", clientState: generated.plaintext, requestedAt };
}

async function persistCreated(
  action: Extract<MaintenanceAction, { kind: "create" | "reconcile_create" }>,
  subscription: MicrosoftGraphSubscription,
  startedAt: Date,
): Promise<void> {
  const expiration = new Date(subscription.expirationDateTime);
  const renewAt = new Date(subscriptionRenewAt(startedAt.toISOString(), subscription.expirationDateTime));
  await withTenantTransaction(action.tenantId, {}, async (_db, client) => {
    const updated = await client.query(
      `UPDATE finnor_os.integration_subscriptions
          SET provider_subscription_id=$4,resource=$5,change_types=$6::text[],status='active',
              expiration_at=$7,renew_at=$8,created_at_provider=coalesce(created_at_provider,$9),
              last_renewed_at=$9,failure_code=NULL,recovery_state=$10,
              lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND lease_owner=$3 AND status='provisioning'`,
      [
        action.tenantId,
        action.rowId,
        action.owner,
        subscription.id,
        microsoft365SubscriptionResource(action.scope),
        microsoft365SubscriptionChangeTypes(action.scope),
        expiration,
        renewAt,
        startedAt,
        action.needsRecovery ? "running" : "none",
      ],
    );
    if (updated.rowCount !== 1) throw new Error("Microsoft subscription lease was lost before create commit");
    await client.query(
      `UPDATE finnor_os.tenant_integrations
          SET webhook_status='healthy',sync_status=CASE WHEN sync_initialized_at IS NULL THEN 'initializing' ELSE sync_status END,
              last_error=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [action.tenantId, action.integrationId],
    );
    const payload = {
      tenantId: action.tenantId,
      integrationId: action.integrationId,
      sourceScopeId: action.sourceScopeId,
      scope: action.scope.scopeKey,
      subscriptionEstablished: true,
      ...(action.needsRecovery ? { forceRecovery: true } : {}),
    };
    await client.query(
      `INSERT INTO finnor_os.jobs(type,payload,idempotency_key,lane,priority)
       VALUES ('sync_source',$1::jsonb,$2,'batch',50)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [JSON.stringify(payload), `source-sync:${action.tenantId}:${action.sourceScopeId}:subscription:${subscription.id}`],
    );
  });
}

async function persistRenewed(
  action: Extract<MaintenanceAction, { kind: "renew" }>,
  subscription: MicrosoftGraphSubscription,
): Promise<void> {
  const expiration = new Date(subscription.expirationDateTime);
  const renewAt = new Date(subscriptionRenewAt(action.requestedAt.toISOString(), subscription.expirationDateTime));
  await withTenantTransaction(action.tenantId, {}, async (_db, client) => {
    const updated = await client.query(
      `UPDATE finnor_os.integration_subscriptions
          SET status='active',expiration_at=$5,renew_at=$6,last_renewed_at=$7,
              failure_code=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND lease_owner=$3 AND provider_subscription_id=$4`,
      [action.tenantId, action.rowId, action.owner, action.providerSubscriptionId, expiration, renewAt, action.requestedAt],
    );
    if (updated.rowCount !== 1) throw new Error("Microsoft subscription lease was lost before renewal commit");
    await client.query(
      `UPDATE finnor_os.tenant_integrations SET webhook_status='healthy',last_error=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [action.tenantId, action.integrationId],
    );
  });
}

async function persistDisabled(action: Extract<MaintenanceAction, { kind: "delete" }>): Promise<void> {
  await withTenantTransaction(action.tenantId, {}, async (db, client) => {
    const updated = await client.query(
      `UPDATE finnor_os.integration_subscriptions
          SET status='disabled',recovery_state='none',failure_code=NULL,
              lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND lease_owner=$3`,
      [action.tenantId, action.rowId, action.owner],
    );
    if (updated.rowCount !== 1) throw new Error("Microsoft subscription lease was lost before disable commit");
    await appendSourceCoverageTx(db, {
      tenantId: action.tenantId,
      sourceScopeId: action.sourceScopeId,
      sourceKind: action.scope.sourceKind,
      state: "DISABLED",
      recoveryStrength: microsoft365SourceCapability(action.scope.sourceKind).recoveryStrength,
      region: action.scope.coveragePolicy,
      reason: "Microsoft source scope disabled; retained observations and evidence remain queryable",
      metadata: { provider: MICROSOFT_PROVIDER, remoteDelete: action.providerAlreadyExpired ? "provider_expired" : "completed" },
    });
    await client.query(
      `UPDATE finnor_os.tenant_integrations integration
          SET webhook_status=CASE WHEN EXISTS(
            SELECT 1 FROM finnor_os.integration_source_scopes source_scope
            JOIN finnor_os.integration_subscriptions subscription
              ON subscription.tenant_id=source_scope.tenant_id AND subscription.source_scope_id=source_scope.id
            WHERE source_scope.tenant_id=integration.tenant_id AND source_scope.integration_id=integration.id
              AND source_scope.enabled AND subscription.status IN ('active','renewing','reauthorization_required')
              AND subscription.expiration_at>now()
          ) THEN webhook_status ELSE 'disabled' END,
          updated_at=clock_timestamp()
        WHERE integration.tenant_id=$1::uuid AND integration.id=$2::uuid`,
      [action.tenantId, action.integrationId],
    );
  });
}

async function markFailure(action: MaintenanceAction, error: unknown): Promise<void> {
  const failure = safeFailure(error);
  await withTenantTransaction(action.tenantId, {}, async (db, client) => {
    const status = action.kind === "delete"
      ? "deleting"
      : action.kind === "renew"
        ? failure.state === "BLOCKED_AUTH" ? "reauthorization_required" : "degraded"
        : "provisioning";
    await client.query(
      `UPDATE finnor_os.integration_subscriptions
          SET status=$4,failure_code=$5,lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND lease_owner=$3`,
      [action.tenantId, action.rowId, action.owner, status, failure.code],
    );
    await client.query(
      `UPDATE finnor_os.tenant_integrations
          SET webhook_status='degraded',health=CASE WHEN $3='BLOCKED_AUTH' THEN 'down' ELSE 'degraded' END,
              last_error=$4,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [action.tenantId, action.integrationId, failure.state, `Microsoft subscription control: ${failure.code}`],
    );
    if (action.authProfileId && failure.state === "BLOCKED_AUTH") {
      await client.query(
        `UPDATE finnor_os.auth_profiles
            SET connection_status='reauth_required',reauth_required_at=coalesce(reauth_required_at,clock_timestamp()),
                last_connection_error_code=$3,connection_revision=connection_revision+1,updated_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='active' AND connection_status<>'reauth_required'`,
        [action.tenantId, action.authProfileId, failure.code],
      );
    }
    if (action.needsRecovery || action.kind === "create" || action.kind === "reconcile_create") {
      await appendSourceCoverageTx(db, {
        tenantId: action.tenantId,
        sourceScopeId: action.sourceScopeId,
        sourceKind: action.scope.sourceKind,
        state: failure.state,
        recoveryStrength: microsoft365SourceCapability(action.scope.sourceKind).recoveryStrength,
        region: action.scope.coveragePolicy,
        reason: `Microsoft subscription control is ${failure.code}`,
        metadata: { provider: MICROSOFT_PROVIDER, failureCode: failure.code, retryable: failure.retryMs !== undefined },
      });
    }
  });
}

async function markProviderSubscriptionRemoved(
  action: Extract<MaintenanceAction, { kind: "renew" }>,
): Promise<void> {
  const now = new Date();
  await withTenantTransaction(action.tenantId, {}, async (db, client) => {
    const updated = await client.query(
      `UPDATE finnor_os.integration_subscriptions
          SET status='removed',recovery_state='required',failure_code='provider_subscription_missing',
              lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=$2::uuid AND lease_owner=$3 AND provider_subscription_id=$4`,
      [action.tenantId, action.rowId, action.owner, action.providerSubscriptionId],
    );
    if (updated.rowCount !== 1) throw new Error("Microsoft subscription lease was lost before missing-subscription recovery");
    await appendSourceCoverageTx(db, {
      tenantId: action.tenantId,
      sourceScopeId: action.sourceScopeId,
      sourceKind: action.scope.sourceKind,
      state: "RECOVERING",
      recoveryStrength: microsoft365SourceCapability(action.scope.sourceKind).recoveryStrength,
      region: action.scope.coveragePolicy,
      effectiveFrom: now,
      reason: "Microsoft Graph no longer has the registered subscription",
      metadata: { provider: MICROSOFT_PROVIDER, failureCode: "provider_subscription_missing" },
    });
  });
}

async function maintainOne(payload: Record<string, unknown>, tenantId: string, sourceScopeId: string): Promise<void> {
  const owner = `${process.pid}:${randomUUID()}`;
  const reason = typeof payload.reason === "string" ? payload.reason : null;
  let action = await prepareAction(tenantId, sourceScopeId, owner, reason);
  if (!action) return;
  const log = logWithTrace({
    traceId: typeof payload._correlationId === "string" ? payload._correlationId : undefined,
    tenantId,
    jobType: "maintain_integration_subscriptions",
  });
  try {
    const auth = await resolveMicrosoftProviderAuthContext({ tenantId, integrationId: action.integrationId });
    const expectedPermissions = microsoft365SourceCapability(action.scope.sourceKind).permissionProfiles[action.scope.permissionMode];
    if (!expectedPermissions || !expectedPermissions.every((permission) => auth.consentedPermissions.includes(permission))) {
      throw new ProviderAuthError("blocked_permission", "Microsoft app consent does not cover the source subscription profile");
    }
    const transport = new Microsoft365SubscriptionTransport(new MicrosoftGraphClient(auth, { logger: graphLogger(payload) }));
    if (action.kind === "delete") {
      let providerSubscriptionId = action.providerSubscriptionId;
      if (!providerSubscriptionId && action.clientStateHash) {
        providerSubscriptionId = (await transport.findCreatedByClientStateHash(action.scope, action.clientStateHash))?.id ?? null;
      }
      if (providerSubscriptionId && (!action.providerAlreadyExpired || !action.providerSubscriptionId)) {
        await transport.delete(providerSubscriptionId);
      }
      await persistDisabled(action);
      log.info({ event: "m365_subscription_disabled", sourceScopeId }, "Microsoft Graph subscription disabled");
      return;
    }
    if (action.kind === "reconcile_create") {
      const existing = await transport.findCreatedByClientStateHash(action.scope, action.clientStateHash);
      if (existing && Date.parse(existing.expirationDateTime) > Date.now()) {
        await persistCreated(action, existing, new Date());
        log.info({ event: "m365_subscription_create_reconciled", sourceScopeId }, "Recovered Microsoft Graph create result after local uncertainty");
        return;
      }
      action = await resetProvisioning(action);
    }
    if (action.kind === "create") {
      let created: MicrosoftGraphSubscription | null = null;
      try {
        created = await transport.create(action.scope, {
          changeTypes: microsoft365SubscriptionChangeTypes(action.scope),
          notificationUrl: process.env.MICROSOFT_GRAPH_WEBHOOK_URL ?? "",
          lifecycleNotificationUrl: process.env.MICROSOFT_GRAPH_WEBHOOK_URL ?? "",
          requestedExpirationAt: requestedExpiration(action.scope, action.requestedAt),
          clientState: action.clientState,
        }, action.requestedAt);
        await persistCreated(action, created, action.requestedAt);
      } catch (error) {
        if (created) await transport.delete(created.id).catch(() => undefined);
        throw error;
      }
      log.info({
        event: "m365_subscription_created",
        metric: "m365_subscription_expiry_margin",
        sourceScopeId,
        expiryMarginMs: Date.parse(created.expirationDateTime) - Date.now(),
      }, "Microsoft Graph subscription created before initial synchronization");
      return;
    }
    const renewed = await transport.renew(
      action.providerSubscriptionId,
      action.scope,
      requestedExpiration(action.scope, action.requestedAt),
      action.requestedAt,
    );
    await persistRenewed(action, renewed);
    log.info({
      event: "m365_subscription_renewal_success",
      metric: "m365_subscription_expiry_margin",
      sourceScopeId,
      expiryMarginMs: Date.parse(renewed.expirationDateTime) - Date.now(),
    }, "Microsoft Graph subscription renewed and reauthorized through one PATCH");
  } catch (error) {
    if (action.kind === "renew" && error instanceof MicrosoftGraphError
        && (error.kind === "not_found" || error.kind === "resync_required")) {
      await markProviderSubscriptionRemoved(action);
      await maintainOne({ ...payload, reason: "subscription_removed" }, tenantId, sourceScopeId);
      return;
    }
    await markFailure(action, error);
    const failure = safeFailure(error);
    log.warn({ event: "m365_subscription_maintenance_failed", sourceScopeId, failureCode: failure.code }, "Microsoft Graph subscription maintenance did not converge");
    if (failure.retryMs !== undefined) throw new RetryableJobError("Microsoft subscription maintenance is retryable", failure.retryMs, { cause: error });
  }
}

export const maintainIntegrationSubscriptions: JobHandler = async (payload) => {
  const tenantId = typeof payload.tenantId === "string" ? payload.tenantId : "";
  if (!tenantId) throw new Error("maintain_integration_subscriptions requires tenantId");
  await resolveTenantVertical(tenantId);
  const sourceScopeId = typeof payload.sourceScopeId === "string" ? payload.sourceScopeId : "";
  if (!sourceScopeId) {
    await discoverDue(payload, tenantId);
    return;
  }
  await maintainOne(payload, tenantId, sourceScopeId);
};
