import { createHash, randomUUID } from "node:crypto";
import {
  getPool,
  resolveTenantVertical,
  withTenantTransaction,
} from "@finnor/db";
import { appendSourceCoverageTx } from "@finnor/data-platform";
import {
  microsoft365NotificationMatchesScope,
  microsoft365SourceCapability,
  microsoft365SubscriptionChangeTypes,
  microsoft365SubscriptionResource,
  verifySubscriptionClientState,
  type Microsoft365SourceScope,
} from "@finnor/provider-microsoft365";
import type { Microsoft365SourceKind } from "@finnor/shared-types";
import { logWithTrace } from "@finnor/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const MAX_BODY_BYTES = 256 * 1024;
const MAX_NOTIFICATIONS = 100;
const MICROSOFT_PROVIDER = "microsoft_graph" as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/;

type LifecycleEvent = "reauthorizationRequired" | "subscriptionRemoved" | "missed";
type ChangeType = "created" | "updated" | "deleted";

interface Notification {
  subscriptionId: string;
  clientState: string;
  tenantId: string;
  resource: string | null;
  changeType: ChangeType | null;
  lifecycleEvent: LifecycleEvent | null;
}

interface ResolvedSubscription {
  subscription_id: string;
  tenant_id: string;
  integration_id: string;
  source_scope_id: string;
  scope_key: string;
  source_kind: Microsoft365SourceKind;
  subscription_status: string;
  expiration_at: Date | null;
  client_state_hash: string;
  registered_resource: string;
  change_types: string[];
  directory_tenant_id: string | null;
  scope_enabled: boolean;
  configuration: Record<string, unknown>;
  coverage_policy: Record<string, unknown>;
  recovery_strategy: "EXACT_DELTA" | "BOUNDED_RECONCILIATION" | "BEST_EFFORT_NOTIFICATION_RECOVERY";
  permission_mode: "SCOPED" | "BROAD";
}

interface ValidatedNotification {
  notification: Notification;
  resolved: ResolvedSubscription;
  scope: Microsoft365SourceScope;
}

class WebhookError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "WebhookError";
  }
}

function json(status: number, code: string): Response {
  return Response.json({ error: code }, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum && SAFE_TEXT.test(value)
    ? value
    : null;
}

async function readBoundedBody(request: Request): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0) throw new WebhookError(400, "invalid_content_length");
    if (size > MAX_BODY_BYTES) throw new WebhookError(413, "notification_envelope_too_large");
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let body = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new WebhookError(413, "notification_envelope_too_large");
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return body;
  } catch (error) {
    if (error instanceof WebhookError) throw error;
    throw new WebhookError(400, "invalid_utf8_notification_envelope");
  } finally {
    reader.releaseLock();
  }
}

function parseNotification(value: unknown): Notification {
  const row = object(value);
  if (!row || row.encryptedContent !== undefined) throw new WebhookError(400, "invalid_notification");
  const subscriptionId = boundedString(row.subscriptionId, 512);
  const clientState = boundedString(row.clientState, 128);
  const tenantId = boundedString(row.tenantId, 64);
  const resource = row.resource === undefined ? null : boundedString(row.resource, 4_096);
  const lifecycleEvent = row.lifecycleEvent === undefined
    ? null
    : (["reauthorizationRequired", "subscriptionRemoved", "missed"] as const).includes(row.lifecycleEvent as LifecycleEvent)
      ? row.lifecycleEvent as LifecycleEvent
      : null;
  const changeType = row.changeType === undefined
    ? null
    : (["created", "updated", "deleted"] as const).includes(row.changeType as ChangeType)
      ? row.changeType as ChangeType
      : null;
  if (!subscriptionId || !clientState || !tenantId || !UUID.test(tenantId)) {
    throw new WebhookError(400, "invalid_notification_identity");
  }
  if (row.lifecycleEvent !== undefined && !lifecycleEvent) throw new WebhookError(400, "unsupported_lifecycle_event");
  if (row.changeType !== undefined && !changeType) throw new WebhookError(400, "unsupported_change_type");
  if (!lifecycleEvent && (!resource || !changeType)) throw new WebhookError(400, "incomplete_change_notification");
  if (row.subscriptionExpirationDateTime !== undefined) {
    const expiration = boundedString(row.subscriptionExpirationDateTime, 128);
    if (!expiration || !Number.isFinite(Date.parse(expiration))) throw new WebhookError(400, "invalid_subscription_expiration");
  }
  return { subscriptionId, clientState, tenantId, resource, changeType, lifecycleEvent };
}

function parseEnvelope(value: unknown): Notification[] {
  const envelope = object(value);
  if (!envelope || envelope.validationTokens !== undefined || !Array.isArray(envelope.value)
      || envelope.value.length < 1 || envelope.value.length > MAX_NOTIFICATIONS) {
    throw new WebhookError(400, "invalid_notification_envelope");
  }
  return envelope.value.map(parseNotification);
}

async function resolveSubscriptions(subscriptionIds: readonly string[]): Promise<Map<string, ResolvedSubscription>> {
  const unique = [...new Set(subscriptionIds)];
  const result = await getPool().query<ResolvedSubscription & { requested_subscription_id: string }>(
    `SELECT requested.id AS requested_subscription_id,resolved.*
       FROM unnest($1::text[]) requested(id)
       CROSS JOIN LATERAL finnor_os.resolve_microsoft_graph_subscription(requested.id) resolved`,
    [unique],
  );
  return new Map(result.rows.map((row) => [row.requested_subscription_id, row]));
}

function sourceScope(row: ResolvedSubscription): Microsoft365SourceScope {
  return {
    id: row.source_scope_id,
    tenantId: row.tenant_id,
    integrationId: row.integration_id,
    provider: MICROSOFT_PROVIDER,
    sourceKind: row.source_kind,
    scopeKey: row.scope_key,
    providerResourceId: row.registered_resource,
    permissionMode: row.permission_mode,
    coveragePolicy: row.coverage_policy,
    freshnessPolicy: {},
    configuration: row.configuration,
  };
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && [...left].sort().every((entry, index) => entry === [...right].sort()[index]);
}

function sameResource(left: string, right: string): boolean {
  try {
    return decodeURIComponent(left).replace(/^\/+|\/+$/g, "").toLowerCase()
      === decodeURIComponent(right).replace(/^\/+|\/+$/g, "").toLowerCase();
  } catch {
    return false;
  }
}

function assertAuthentic(notification: Notification, row: ResolvedSubscription, now: Date): ValidatedNotification {
  if (!row.scope_enabled) throw new WebhookError(409, "source_scope_disabled");
  if (!row.directory_tenant_id || !UUID.test(row.directory_tenant_id)
      || notification.tenantId.toLowerCase() !== row.directory_tenant_id.toLowerCase()) {
    throw new WebhookError(401, "notification_directory_mismatch");
  }
  if (!verifySubscriptionClientState(notification.clientState, row.client_state_hash)) {
    throw new WebhookError(401, "notification_authentication_failed");
  }
  const scope = sourceScope(row);
  const capability = microsoft365SourceCapability(scope.sourceKind);
  if (!capability.supportsChangeNotifications
      || !sameResource(row.registered_resource, microsoft365SubscriptionResource(scope))
      || !sameSet(row.change_types, microsoft365SubscriptionChangeTypes(scope))) {
    throw new WebhookError(409, "registered_subscription_configuration_drift");
  }
  if (notification.resource && !microsoft365NotificationMatchesScope(scope, notification.resource)) {
    throw new WebhookError(401, "notification_resource_mismatch");
  }
  if (notification.changeType && !row.change_types.includes(notification.changeType)) {
    throw new WebhookError(401, "notification_change_type_mismatch");
  }
  if (!notification.lifecycleEvent) {
    if (!["active", "renewing", "reauthorization_required"].includes(row.subscription_status)) {
      throw new WebhookError(409, "subscription_not_active");
    }
    if (!row.expiration_at || row.expiration_at.getTime() <= now.getTime()) {
      throw new WebhookError(409, "subscription_expired");
    }
  } else {
    const supported = notification.lifecycleEvent === "reauthorizationRequired"
      ? capability.supportsLifecycleReauthorization
      : notification.lifecycleEvent === "subscriptionRemoved"
        ? capability.supportsLifecycleSubscriptionRemoved
        : capability.supportsLifecycleMissed;
    if (!supported) throw new WebhookError(400, "unsupported_lifecycle_event_for_source");
    if (["disabled", "deleting", "expired"].includes(row.subscription_status)) {
      throw new WebhookError(409, "subscription_not_active");
    }
  }
  return { notification, resolved: row, scope };
}

function idempotencySuffix(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, 32);
}

interface DurableWake {
  type: "sync_source" | "maintain_integration_subscriptions";
  payload: Record<string, unknown>;
  idempotencyKey: string;
  priority: number;
}

async function durableEnqueueMany(
  client: { query(query: string, values?: unknown[]): Promise<unknown> },
  wakes: readonly DurableWake[],
): Promise<void> {
  if (wakes.length === 0) return;
  await client.query(
    `INSERT INTO finnor_os.jobs(type,payload,idempotency_key,lane,priority)
     SELECT wake.type,wake.payload,wake.idempotency_key,'interactive',wake.priority
       FROM jsonb_to_recordset($1::jsonb)
         AS wake(type text,payload jsonb,idempotency_key text,priority integer)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [JSON.stringify(wakes.map((wake) => ({
      type: wake.type,
      payload: wake.payload,
      idempotency_key: wake.idempotencyKey,
      priority: wake.priority,
    })))],
  );
}

async function commitTenantBatch(
  tenantId: string,
  notifications: readonly ValidatedNotification[],
  receivedAt: Date,
  correlationId: string,
): Promise<void> {
  await resolveTenantVertical(tenantId);
  const subscriptionIds = [...new Set(notifications.map((item) => item.resolved.subscription_id))].sort();
  await withTenantTransaction(tenantId, {}, async (db, client) => {
    const locked = await client.query<ResolvedSubscription & { provider_subscription_id: string }>(
      `SELECT subscription.id AS subscription_id,subscription.tenant_id,subscription.integration_id,
              subscription.source_scope_id,source_scope.scope_key,source_scope.source_kind,
              subscription.status AS subscription_status,subscription.expiration_at,
              subscription.client_state_hash,subscription.resource AS registered_resource,
              subscription.change_types,application_account.metadata->>'directoryTenantId' AS metadata_directory_tenant_id,
              coalesce(nullif(application_account.metadata->>'directoryTenantId',''),application_account.provider_account_ref) AS directory_tenant_id,
              source_scope.enabled AS scope_enabled,source_scope.configuration,source_scope.coverage_policy,
              source_scope.recovery_strategy,source_scope.permission_mode,subscription.provider_subscription_id
         FROM finnor_os.integration_subscriptions subscription
         JOIN finnor_os.integration_source_scopes source_scope
           ON source_scope.tenant_id=subscription.tenant_id
          AND source_scope.integration_id=subscription.integration_id
          AND source_scope.id=subscription.source_scope_id
         JOIN finnor_os.tenant_integrations integration
           ON integration.tenant_id=subscription.tenant_id AND integration.id=subscription.integration_id
         JOIN finnor_os.application_accounts application_account
           ON application_account.tenant_id=integration.tenant_id AND application_account.id=integration.application_account_id
        WHERE subscription.tenant_id=$1::uuid AND subscription.id=ANY($2::uuid[])
        ORDER BY subscription.id
        FOR UPDATE OF subscription,source_scope`,
      [tenantId, subscriptionIds],
    );
    if (locked.rows.length !== subscriptionIds.length) throw new WebhookError(409, "subscription_changed_during_delivery");
    const current = new Map(locked.rows.map((row) => [row.subscription_id, row]));
    const minuteBucket = receivedAt.toISOString().slice(0, 16);
    const normal = new Map<string, ResolvedSubscription & { provider_subscription_id: string }>();
    const reauthorize = new Map<string, ResolvedSubscription & { provider_subscription_id: string }>();
    const removed = new Map<string, ResolvedSubscription & { provider_subscription_id: string }>();
    const missed = new Map<string, ResolvedSubscription & { provider_subscription_id: string }>();
    const wakes = new Map<string, DurableWake>();
    for (const item of notifications) {
      const row = current.get(item.resolved.subscription_id);
      if (!row || row.provider_subscription_id !== item.notification.subscriptionId) {
        throw new WebhookError(409, "subscription_changed_during_delivery");
      }
      assertAuthentic(item.notification, row, receivedAt);
      const commonPayload = {
        tenantId,
        integrationId: row.integration_id,
        sourceScopeId: row.source_scope_id,
        scope: row.scope_key,
        providerSubscriptionId: item.notification.subscriptionId,
        _correlationId: correlationId,
      };
      if (!item.notification.lifecycleEvent) {
        normal.set(row.subscription_id, row);
        const idempotencyKey = `m365-wake:${row.subscription_id}:${minuteBucket}`;
        wakes.set(idempotencyKey, { type: "sync_source", payload: { ...commonPayload, wake: "microsoft_graph_notification" }, idempotencyKey, priority: 75 });
        continue;
      }
      const lifecycle = item.notification.lifecycleEvent;
      if (lifecycle === "reauthorizationRequired") {
        reauthorize.set(row.subscription_id, row);
        const idempotencyKey = `m365-lifecycle:${row.subscription_id}:reauthorize:${minuteBucket}`;
        wakes.set(idempotencyKey, { type: "maintain_integration_subscriptions", payload: { ...commonPayload, reason: "reauthorization_required" }, idempotencyKey, priority: 100 });
      } else if (lifecycle === "subscriptionRemoved") {
        removed.set(row.subscription_id, row);
        const replaceKey = `m365-lifecycle:${row.subscription_id}:replace:${minuteBucket}`;
        wakes.set(replaceKey, { type: "maintain_integration_subscriptions", payload: { ...commonPayload, reason: "subscription_removed" }, idempotencyKey: replaceKey, priority: 100 });
        const recoveryKey = `m365-recovery:${row.source_scope_id}:${idempotencySuffix("removed", item.notification.subscriptionId, minuteBucket)}`;
        wakes.set(recoveryKey, { type: "sync_source", payload: { ...commonPayload, wake: "microsoft_graph_lifecycle", forceRecovery: true }, idempotencyKey: recoveryKey, priority: 90 });
      } else {
        missed.set(row.subscription_id, row);
        const recoveryKey = `m365-recovery:${row.source_scope_id}:${idempotencySuffix("missed", item.notification.subscriptionId, minuteBucket)}`;
        wakes.set(recoveryKey, { type: "sync_source", payload: { ...commonPayload, wake: "microsoft_graph_lifecycle", forceRecovery: true }, idempotencyKey: recoveryKey, priority: 90 });
      }
    }

    const ids = (values: Map<string, unknown>) => [...values.keys()];
    if (normal.size) await client.query(
      `UPDATE finnor_os.integration_subscriptions
          SET last_notification_at=GREATEST(coalesce(last_notification_at,'-infinity'::timestamptz),$3),updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])`,
      [tenantId, ids(normal), receivedAt],
    );
    if (reauthorize.size) await client.query(
      `UPDATE finnor_os.integration_subscriptions
          SET status=CASE WHEN status='removed' THEN status ELSE 'reauthorization_required' END,
              last_lifecycle_event_at=$3,failure_code='lifecycle_reauthorization_required',updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])`,
      [tenantId, ids(reauthorize), receivedAt],
    );
    if (missed.size) await client.query(
      `UPDATE finnor_os.integration_subscriptions
          SET recovery_state='required',last_lifecycle_event_at=$3,
              failure_code='missed_notifications',updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])`,
      [tenantId, ids(missed), receivedAt],
    );
    if (removed.size) await client.query(
      `UPDATE finnor_os.integration_subscriptions
          SET status='removed',recovery_state='required',last_lifecycle_event_at=$3,
              failure_code='subscription_removed',lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])`,
      [tenantId, ids(removed), receivedAt],
    );

    const lifecycleIntegrations = new Set([...reauthorize.values(), ...removed.values(), ...missed.values()].map((row) => row.integration_id));
    const healthyIntegrations = [...new Set([...normal.values()].map((row) => row.integration_id))]
      .filter((integrationId) => !lifecycleIntegrations.has(integrationId));
    if (healthyIntegrations.length) await client.query(
      `UPDATE finnor_os.tenant_integrations SET webhook_status='healthy',updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])`,
      [tenantId, healthyIntegrations],
    );
    if (lifecycleIntegrations.size) await client.query(
      `UPDATE finnor_os.tenant_integrations SET webhook_status='degraded',updated_at=clock_timestamp()
        WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[])`,
      [tenantId, [...lifecycleIntegrations]],
    );

    const recoveringScopes = new Map<string, { row: ResolvedSubscription; event: "missed" | "subscriptionRemoved" }>();
    for (const row of missed.values()) recoveringScopes.set(row.source_scope_id, { row, event: "missed" });
    for (const row of removed.values()) recoveringScopes.set(row.source_scope_id, { row, event: "subscriptionRemoved" });
    for (const { row, event } of recoveringScopes.values()) {
      await appendSourceCoverageTx(db, {
        tenantId,
        sourceScopeId: row.source_scope_id,
        sourceKind: row.source_kind,
        state: "RECOVERING",
        recoveryStrength: row.recovery_strategy,
        region: row.coverage_policy,
        effectiveFrom: receivedAt,
        reason: event === "subscriptionRemoved"
          ? "Microsoft Graph reported that the notification subscription was removed"
          : "Microsoft Graph reported missed notifications",
        metadata: { lifecycleEvent: event, provider: MICROSOFT_PROVIDER },
      });
    }
    await durableEnqueueMany(client, [...wakes.values()]);
  });
}

export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const validationTokens = url.searchParams.getAll("validationToken");
  if (validationTokens.length > 0) {
    if (validationTokens.length !== 1 || Buffer.byteLength(validationTokens[0]!, "utf8") > 4_096) {
      return json(400, "invalid_validation_token");
    }
    return new Response(validationTokens[0]!, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  const correlationId = request.headers.get("x-correlation-id")?.slice(0, 160) || randomUUID();
  const log = logWithTrace({ traceId: correlationId });
  try {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new WebhookError(415, "json_content_type_required");
    }
    const raw = await readBoundedBody(request);
    let decoded: unknown;
    try { decoded = JSON.parse(raw); } catch { throw new WebhookError(400, "invalid_json"); }
    const notifications = parseEnvelope(decoded);
    const subscriptions = await resolveSubscriptions(notifications.map((item) => item.subscriptionId));
    const now = new Date();
    const validated = notifications.map((notification) => {
      const subscription = subscriptions.get(notification.subscriptionId);
      if (!subscription) throw new WebhookError(404, "unknown_subscription");
      return assertAuthentic(notification, subscription, now);
    });
    const byTenant = new Map<string, ValidatedNotification[]>();
    for (const item of validated) {
      const group = byTenant.get(item.resolved.tenant_id) ?? [];
      group.push(item);
      byTenant.set(item.resolved.tenant_id, group);
    }
    for (const [tenantId, group] of byTenant) {
      await commitTenantBatch(tenantId, group, now, correlationId);
    }
    log.info({
      event: "m365_webhook_accepted",
      metric: "m365_webhook_duration_ms",
      durationMs: Date.now() - startedAt,
      notificationCount: notifications.length,
      tenantCount: byTenant.size,
    }, "Microsoft Graph notification wake durably queued");
    return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    const status = error instanceof WebhookError ? error.status : 503;
    const code = error instanceof WebhookError ? error.code : "durable_enqueue_unavailable";
    log.warn({
      event: "m365_webhook_rejected",
      code,
      status,
      durationMs: Date.now() - startedAt,
    }, "Microsoft Graph notification was not acknowledged");
    return json(status, code);
  }
}
