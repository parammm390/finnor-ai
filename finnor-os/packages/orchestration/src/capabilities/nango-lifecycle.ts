import { sql } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "@finnor/db";
import { NangoReadOnlyClient } from "@finnor/tools/nango";
import { CapabilityEngineError } from "@finnor/tools/capabilities/python-runner";
import type { CapabilityActor } from "./contracts";

/** Callers provide an authenticated server binding or an HMAC-routed identity.
 * Notifications are wakeups; current provider state decides connection health. */
export async function reconcileNangoConnection(actor: CapabilityActor, input: { providerConfigKey: string; connectionId: string; triggerDigest: string; deadlineAt: number }) {
  return withTenant(actor.tenantId, async db => {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`nango-connection:${input.providerConfigKey}:${input.connectionId}`},0))`);
    const selected = await db.execute(sql`SELECT b.source_scope_id,b.principal_id,b.intent_id,b.status,b.connection_epoch,u.status AS owner_status
      FROM finnor_os.capability_nango_bindings b JOIN finnor_os.users u ON u.tenant_id=b.tenant_id AND u.id=b.principal_id
      WHERE b.tenant_id=${actor.tenantId}::uuid AND b.provider_config_key=${input.providerConfigKey} AND b.connection_id=${input.connectionId}
      ORDER BY b.source_scope_id FOR UPDATE OF b`);
    const bindings = z.array(z.object({ source_scope_id: z.string().uuid(), principal_id: z.string().uuid(), intent_id: z.string().uuid(), status: z.enum(["ACTIVE", "DISABLED"]),
      connection_epoch: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER), owner_status: z.string() })).parse(selected.rows);
    if (!bindings.length) throw new CapabilityEngineError("NANGO_BOUND_CONNECTION_NOT_FOUND");
    const observed = await new NangoReadOnlyClient({ apiKey: process.env.NANGO_API_KEY ?? "", baseUrl: process.env.FINNOR_NANGO_BASE_URL }).connectionStatus(input);
    if (observed.tags && bindings.some(binding => observed.tags?.organization_id !== actor.tenantId || observed.tags?.end_user_id !== binding.principal_id || observed.tags?.finnor_binding_intent !== binding.intent_id))
      throw new CapabilityEngineError("NANGO_CURRENT_CONNECTION_IDENTITY_MISMATCH");
    if (Date.now() >= input.deadlineAt) throw new CapabilityEngineError("NANGO_CONNECTION_CHECK_DEADLINE");
    const changes = [];
    for (const binding of bindings) {
      const state = binding.owner_status === "active" ? observed.state : "INACTIVE_OWNER", status = state === "HEALTHY" ? "ACTIVE" : "DISABLED";
      const epoch = binding.connection_epoch + (status !== binding.status ? 1 : 0);
      if (!Number.isSafeInteger(epoch)) throw new CapabilityEngineError("NANGO_CONNECTION_EPOCH_EXHAUSTED");
      await db.execute(sql`UPDATE finnor_os.capability_nango_bindings SET status=${status},connection_epoch=${epoch},health_checked_at=clock_timestamp()
        WHERE tenant_id=${actor.tenantId}::uuid AND source_scope_id=${binding.source_scope_id}::uuid`);
      if (status !== binding.status) {
        await db.execute(sql`UPDATE finnor_os.capability_nango_checkpoints SET cursor=NULL,revision=revision+1,cache_enumeration_completed=false,history_limited=true,updated_at=clock_timestamp()
          WHERE tenant_id=${actor.tenantId}::uuid AND source_scope_id=${binding.source_scope_id}::uuid`);
        await db.execute(sql`UPDATE finnor_os.integration_source_scopes SET freshness_state='unknown',updated_at=clock_timestamp()
          WHERE tenant_id=${actor.tenantId}::uuid AND id=${binding.source_scope_id}::uuid`);
      }
      await db.execute(sql`INSERT INTO finnor_os.capability_nango_health_events(tenant_id,source_scope_id,principal_id,trigger_digest,status,connection_epoch,observed_state)
        VALUES(${actor.tenantId}::uuid,${binding.source_scope_id}::uuid,${binding.principal_id}::uuid,${input.triggerDigest},${status},${epoch},${state})`);
      changes.push({ sourceScopeId: binding.source_scope_id, status, connectionEpoch: epoch, state });
    }
    return { sources: changes, credentialsPersisted: false, basis: "FRESH_PROVIDER_READ_NOT_WEBHOOK_SUCCESS_FLAG" };
  }, actor.userId);
}
