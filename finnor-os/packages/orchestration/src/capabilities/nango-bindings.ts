import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getPool, withTenant, type Db } from "@finnor/db";
import { evaluateAuthority } from "@finnor/authority";
import { NangoReadOnlyClient, NangoSourceBindingSchema, type NangoSourceBinding } from "@finnor/tools/nango";
import { reserveBudget } from "@finnor/tools/provider-budget";
import { CapabilityEngineError } from "@finnor/tools/capabilities/python-runner";
import { CapabilityProviderError } from "@finnor/tools/capabilities/provider-json";
import type { CapabilityActor } from "./contracts";
import { assertCapabilityAuthorityRevision, capabilityDigest, requireActiveCapabilityPrincipal } from "./policy";

const providerKey = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const catalogSchema = z.array(z.object({ providerConfigKey: providerKey, models: z.array(z.string().min(1).max(120)).min(1).max(32).refine(models => new Set(models).size === models.length), readOnly: z.literal(true) }).strict()).max(32);
export const NangoConnectInputSchema = z.object({ idempotencyKey: z.string().min(1).max(128), providerConfigKey: providerKey }).strict();
const intentSchema = z.object({ id: z.string().uuid(), tenant_id: z.string().uuid(), principal_id: z.string().uuid(), provider_config_key: providerKey,
  models: z.array(z.string()), status: z.enum(["AWAITING", "BOUND", "FAILED"]), connection_id: z.string().nullable(), expires_at: z.coerce.date(), request_digest: z.string() });

function catalog() {
  if (process.env.FINNOR_NANGO_ENABLED !== "1" || !process.env.NANGO_API_KEY) throw new CapabilityEngineError("NANGO_NOT_CONFIGURED");
  try { return catalogSchema.parse(JSON.parse(process.env.FINNOR_NANGO_PROVIDER_CATALOG ?? "[]")); }
  catch { throw new CapabilityEngineError("NANGO_CATALOG_INVALID"); }
}
async function authorizeConnect(actor: CapabilityActor) {
  const decision = await evaluateAuthority(actor, { operation: "execution", capability: "capability:nango_connect", resource: { type: "integration", id: "nango" }, risk: "low" });
  if (decision.outcome !== "allowed") throw new CapabilityEngineError("NANGO_CONNECT_DENIED");
  return decision;
}

export async function createNangoConnectSession(actor: CapabilityActor, input: unknown) {
  const request = NangoConnectInputSchema.parse(input), selected = catalog().find(p => p.providerConfigKey === request.providerConfigKey);
  if (!selected) throw new CapabilityEngineError("NANGO_PROVIDER_NOT_ALLOWED");
  const decision = await authorizeConnect(actor), id = randomUUID(), digest = capabilityDigest({ request, selected });
  await withTenant(actor.tenantId, async db => {
    await requireActiveCapabilityPrincipal(db, actor); await assertCapabilityAuthorityRevision(db, actor.tenantId, decision.authorityRevision);
    const inserted = await db.execute(sql`INSERT INTO finnor_os.capability_nango_intents(id,tenant_id,principal_id,idempotency_key,request_digest,provider_config_key,models,authority_decision_id,expires_at)
      VALUES(${id}::uuid,${actor.tenantId}::uuid,${actor.userId}::uuid,${request.idempotencyKey},${digest},${selected.providerConfigKey},ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(selected.models)}::jsonb)),${decision.id}::uuid,clock_timestamp()+interval '30 minutes')
      ON CONFLICT(tenant_id,principal_id,idempotency_key) DO NOTHING RETURNING id`);
    if (!inserted.rows.length) throw new CapabilityEngineError("NANGO_CONNECT_SESSION_IDEMPOTENCY_CONFLICT");
  }, actor.userId);
  const limit = Number(process.env.FINNOR_NANGO_MAX_CONNECT_SESSIONS_PER_TENANT_DAY ?? 3);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new CapabilityEngineError("NANGO_CONNECT_LIMIT_INVALID");
  const budget = await reserveBudget(actor.tenantId, "nango", "connect_sessions", limit, 1, undefined, id);
  if (!budget.allowed) throw new CapabilityEngineError("NANGO_CONNECT_DAILY_LIMIT");
  let session: { token: string; expires_at: string; connect_link?: string };
  try {
    session = await new NangoReadOnlyClient({ apiKey: process.env.NANGO_API_KEY ?? "", baseUrl: process.env.FINNOR_NANGO_BASE_URL }).createConnectSession({
      tenantId: actor.tenantId, principalId: actor.userId, bindingIntentId: id, providerConfigKey: selected.providerConfigKey, deadlineAt: Date.now() + 15_000,
    });
  } catch (error) {
    if (error instanceof CapabilityProviderError) throw new CapabilityEngineError(error.disposition === "UNKNOWN" ? "NANGO_CONNECT_OUTCOME_UNKNOWN" : "NANGO_CONNECT_REJECTED");
    throw error;
  }
  const publication = await authorizeConnect(actor);
  await withTenant(actor.tenantId, async db => { await requireActiveCapabilityPrincipal(db, actor); await assertCapabilityAuthorityRevision(db, actor.tenantId, publication.authorityRevision); }, actor.userId);
  // The short-lived session credential is returned once, never stored or logged.
  return { intentId: id, session, qualification: "CONNECT_SESSION_ONLY_NOT_SOURCE_PERMISSION_OR_COMPLETENESS_PROOF" };
}

export async function loadNangoBinding(db: Db, actor: CapabilityActor, integrationId: string, sourceScopeId: string, model: string): Promise<NangoSourceBinding> {
  const selected = await db.execute(sql`SELECT b.tenant_id,b.integration_id,b.source_scope_id,b.provider_config_key,b.connection_id,b.model,b.connection_epoch
    FROM finnor_os.capability_nango_bindings b JOIN finnor_os.integration_source_scopes s ON s.tenant_id=b.tenant_id AND s.id=b.source_scope_id
    JOIN finnor_os.tenant_integrations i ON i.tenant_id=b.tenant_id AND i.id=b.integration_id
    WHERE b.tenant_id=${actor.tenantId}::uuid AND b.integration_id=${integrationId}::uuid AND b.source_scope_id=${sourceScopeId}::uuid
    AND b.model=${model} AND b.status='ACTIVE' AND s.enabled AND i.binding='nango' FOR SHARE OF b,s,i`);
  const row = z.object({ tenant_id: z.string().uuid(), integration_id: z.string().uuid(), source_scope_id: z.string().uuid(), provider_config_key: z.string(), connection_id: z.string(), model: z.string(), connection_epoch: z.coerce.number().int().positive() }).safeParse(selected.rows[0]);
  if (!row.success) throw new CapabilityEngineError("NANGO_SOURCE_BINDING_NOT_FOUND");
  const allowed = catalog().find(item => item.providerConfigKey === row.data.provider_config_key);
  if (!allowed?.models.includes(model)) throw new CapabilityEngineError("NANGO_SOURCE_BINDING_DENIED");
  return NangoSourceBindingSchema.parse({ tenantId: row.data.tenant_id, integrationId: row.data.integration_id, sourceScopeId: row.data.source_scope_id,
    providerConfigKey: row.data.provider_config_key, connectionId: row.data.connection_id, models: [row.data.model], readOnly: true, connectionEpoch: row.data.connection_epoch });
}

export async function listNangoSources(actor: CapabilityActor) {
  const providers = catalog();
  const read = async (db: Db) => {
    await requireActiveCapabilityPrincipal(db, actor);
    const rows = await db.execute(sql`SELECT b.integration_id,b.source_scope_id,b.provider_config_key,b.model,b.status,c.revision,c.cache_enumeration_completed,c.history_limited,c.updated_at
      FROM finnor_os.capability_nango_bindings b JOIN finnor_os.capability_nango_checkpoints c ON c.tenant_id=b.tenant_id AND c.source_scope_id=b.source_scope_id
      WHERE b.tenant_id=${actor.tenantId}::uuid ORDER BY b.created_at,b.source_scope_id`);
    return z.array(z.object({ integration_id: z.string().uuid(), source_scope_id: z.string().uuid(), provider_config_key: z.string(), model: z.string(), status: z.enum(["ACTIVE", "DISABLED"]),
      revision: z.coerce.number().int().nonnegative(), cache_enumeration_completed: z.boolean(), history_limited: z.boolean(), updated_at: z.coerce.date() })).parse(rows.rows);
  };
  const rows = await withTenant(actor.tenantId, read, actor.userId);
  if (!rows.length) return { sources: [], providers };
  const decision = await evaluateAuthority(actor, { operation: "execution", capability: "capability:nango_sync", resources: rows.map(row => ({ type: "integration", id: row.integration_id })), risk: "low" });
  if (decision.outcome !== "allowed") throw new CapabilityEngineError("NANGO_SOURCE_CATALOG_DENIED");
  return withTenant(actor.tenantId, async db => { await assertCapabilityAuthorityRevision(db, actor.tenantId, decision.authorityRevision); return { sources: await read(db), providers }; }, actor.userId);
}

export async function bindPreparedNangoConnection(input: { intentId: string; tenantId: string; principalId: string; providerConfigKey: string; connectionId: string; webhookDigest: string }) {
  const route = await getPool().query("SELECT * FROM finnor_os.capability_nango_intent_owner($1::uuid)", [input.intentId]);
  const owner = z.object({ tenant_id: z.string().uuid(), principal_id: z.string().uuid() }).safeParse(route.rows[0]);
  if (!owner.success || owner.data.tenant_id !== input.tenantId || owner.data.principal_id !== input.principalId) throw new CapabilityEngineError("NANGO_PREPARED_INTENT_NOT_FOUND");
  const actor: CapabilityActor = { tenantId: owner.data.tenant_id, userId: owner.data.principal_id, employeeId: owner.data.principal_id, role: "owner" };
  const decision = await authorizeConnect(actor);
  return withTenant(actor.tenantId, async db => {
    await requireActiveCapabilityPrincipal(db, actor); await assertCapabilityAuthorityRevision(db, actor.tenantId, decision.authorityRevision);
    const selected = await db.execute(sql`SELECT * FROM finnor_os.capability_nango_intents WHERE tenant_id=${actor.tenantId}::uuid AND id=${input.intentId}::uuid FOR UPDATE`);
    const intent = intentSchema.parse(selected.rows[0]);
    if (intent.provider_config_key !== input.providerConfigKey) throw new CapabilityEngineError("NANGO_PREPARED_PROVIDER_MISMATCH");
    if (intent.status === "BOUND") {
      if (intent.connection_id !== input.connectionId) throw new CapabilityEngineError("NANGO_BOUND_CONNECTION_MISMATCH");
      return { intentId: intent.id, replayed: true };
    }
    if (intent.status !== "AWAITING" || intent.expires_at.getTime() <= Date.now()) throw new CapabilityEngineError("NANGO_PREPARED_INTENT_EXPIRED");
    const current = catalog().find(item => item.providerConfigKey === intent.provider_config_key);
    if (!current || !intent.models.every(model => current.models.includes(model))) throw new CapabilityEngineError("NANGO_CATALOG_CHANGED");
    const prior = await db.execute(sql`SELECT source_scope_id FROM finnor_os.capability_nango_bindings WHERE provider_config_key=${input.providerConfigKey} AND connection_id=${input.connectionId} LIMIT 1`);
    if (prior.rows.length) throw new CapabilityEngineError("NANGO_CONNECTION_ALREADY_BOUND");
    const integration = await db.execute(sql`INSERT INTO finnor_os.tenant_integrations(tenant_id,capability,binding,mode,config)
      VALUES(${actor.tenantId}::uuid,'connected_source','nango','real','{"transport":"nango","bindingProtocol":"signed-prepared-intent"}'::jsonb)
      ON CONFLICT(tenant_id,capability) DO UPDATE SET updated_at=clock_timestamp() WHERE tenant_integrations.binding='nango' RETURNING id`);
    if (!integration.rows[0]) throw new CapabilityEngineError("NANGO_INTEGRATION_CONFLICT");
    const integrationId = String(integration.rows[0].id), scopes: Array<{ sourceScopeId: string; model: string }> = [];
    for (const model of intent.models) {
      const id = randomUUID(), scopeKey = `nango:${capabilityDigest({ provider: input.providerConfigKey, connection: input.connectionId, model })}`;
      await db.execute(sql`INSERT INTO finnor_os.integration_source_scopes(id,tenant_id,integration_id,provider,source_kind,provider_scope_type,provider_resource_id,scope_key,
        sync_strategy,recovery_strategy,permission_mode,provider_restriction_method,coverage_policy,configuration,configured_by,metadata)
        VALUES(${id}::uuid,${actor.tenantId}::uuid,${integrationId}::uuid,'nango','nango_records','connection_model',${input.connectionId},${scopeKey},
        'bounded_enumeration','BOUNDED_RECONCILIATION','SCOPED','prepared-tenant-intent-and-model-binding','{"scope":"LATEST_STATE_CACHE_NOT_SOURCE_COMPLETENESS"}'::jsonb,
        ${JSON.stringify({ model, readOnly: true, bindingIntentId: intent.id })}::jsonb,${actor.userId},${JSON.stringify({ bindingWebhookDigest: input.webhookDigest })}::jsonb)`);
      await db.execute(sql`INSERT INTO finnor_os.capability_nango_bindings(tenant_id,source_scope_id,integration_id,principal_id,intent_id,provider_config_key,connection_id,model)
        VALUES(${actor.tenantId}::uuid,${id}::uuid,${integrationId}::uuid,${actor.userId}::uuid,${intent.id}::uuid,${input.providerConfigKey},${input.connectionId},${model})`);
      await db.execute(sql`INSERT INTO finnor_os.capability_nango_checkpoints(tenant_id,source_scope_id) VALUES(${actor.tenantId}::uuid,${id}::uuid)`);
      scopes.push({ sourceScopeId: id, model });
    }
    await db.execute(sql`UPDATE finnor_os.capability_nango_intents SET status='BOUND',connection_id=${input.connectionId},binding_webhook_digest=${input.webhookDigest},updated_at=clock_timestamp()
      WHERE tenant_id=${actor.tenantId}::uuid AND id=${intent.id}::uuid`);
    return { intentId: intent.id, integrationId, scopes, replayed: false };
  }, actor.userId);
}
