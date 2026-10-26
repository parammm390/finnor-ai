import { createHash } from "node:crypto";
import { z } from "zod";
import { getPool } from "@finnor/db";
import { NangoWebhookSchema, verifyNangoWebhook } from "@finnor/tools/nango";
import { CapabilityEngineError } from "@finnor/tools/capabilities/python-runner";
import { bindPreparedNangoConnection } from "./nango-bindings";
import { createCapabilityRun } from "./repository";
import { reconcileNangoConnection } from "./nango-lifecycle";

export async function acceptNangoWebhook(raw: Buffer, signature: string | null) {
  if (!verifyNangoWebhook(raw, signature, process.env.NANGO_WEBHOOK_SIGNING_KEY ?? "")) throw new CapabilityEngineError("NANGO_WEBHOOK_SIGNATURE_DENIED");
  let json: unknown; try { json = JSON.parse(raw.toString("utf8")); } catch { throw new CapabilityEngineError("NANGO_WEBHOOK_INVALID_JSON"); }
  const payload = NangoWebhookSchema.parse(json), digest = createHash("sha256").update(raw).digest("hex");
  if (payload.type === "auth" && payload.operation === "creation" && payload.success === true) {
    const prepared = z.object({ intentId: z.string().uuid(), tenantId: z.string().uuid(), principalId: z.string().uuid(), providerConfigKey: z.string().min(1).max(512), connectionId: z.string().min(1).max(512) }).parse({
      intentId: payload.tags?.finnor_binding_intent, tenantId: payload.tags?.organization_id, principalId: payload.tags?.end_user_id,
      providerConfigKey: payload.providerConfigKey, connectionId: payload.connectionId,
    });
    const bound = await bindPreparedNangoConnection({ ...prepared, webhookDigest: digest });
    return { accepted: true, bound: true, replayed: bound.replayed };
  }
  if (payload.type === "auth" && ["refresh", "override", "deletion"].includes(payload.operation ?? "") && payload.providerConfigKey && payload.connectionId) {
    const routed = await getPool().query("SELECT * FROM finnor_os.capability_nango_connection_owner($1,$2)", [payload.providerConfigKey, payload.connectionId]);
    const owner = z.object({ tenant_id: z.string().uuid(), principal_id: z.string().uuid() }).safeParse(routed.rows[0]);
    if (!owner.success) return { accepted: true, reconciled: false, reason: "NO_BOUND_CONNECTION" };
    const health = await reconcileNangoConnection({ tenantId: owner.data.tenant_id, userId: owner.data.principal_id, employeeId: owner.data.principal_id, role: "owner" }, {
      providerConfigKey: payload.providerConfigKey, connectionId: payload.connectionId, triggerDigest: digest, deadlineAt: Date.now() + 15_000,
    });
    return { accepted: true, reconciled: true, health };
  }
  if (payload.type === "sync" && payload.success === true && payload.providerConfigKey && payload.connectionId && payload.model) {
    const routed = await getPool().query("SELECT * FROM finnor_os.capability_nango_binding_owner($1,$2,$3)", [payload.providerConfigKey, payload.connectionId, payload.model]);
    const owner = z.object({ tenant_id: z.string().uuid(), principal_id: z.string().uuid(), source_scope_id: z.string().uuid(), integration_id: z.string().uuid() }).safeParse(routed.rows[0]);
    if (!owner.success) return { accepted: true, woken: false, reason: "NO_ACTIVE_BOUND_SOURCE" };
    const row = owner.data;
    await createCapabilityRun({ tenantId: row.tenant_id, userId: row.principal_id, employeeId: row.principal_id, role: "owner" }, {
      kind: "nango_sync", idempotencyKey: `nango-webhook:${digest}`, timeoutMs: 300_000, integrationId: row.integration_id, sourceScopeId: row.source_scope_id, model: payload.model,
    });
    return { accepted: true, woken: true, recordPayloadApplied: false };
  }
  return { accepted: true, ignored: true };
}
