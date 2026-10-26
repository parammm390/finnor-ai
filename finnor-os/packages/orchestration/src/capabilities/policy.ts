import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@finnor/db";
import { evaluateAuthority } from "@finnor/authority";
import { CapabilityEngineError } from "@finnor/tools/capabilities/python-runner";
import { documentSources, type CapabilityActor, type CapabilityRequest, type FrozenDocumentSource } from "./contracts";
import { resolveEnterpriseInterventionModelForControl } from "../../../private-equity/src/enterprise-interventions";

export function capabilityDigest(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, canonical(value)])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export async function requireActiveCapabilityPrincipal(db: Db, actor: CapabilityActor): Promise<void> {
  const r = await db.execute(sql`SELECT id FROM finnor_os.users WHERE tenant_id=${actor.tenantId}::uuid AND id=${actor.userId}::uuid AND status='active' AND role='owner' FOR SHARE`);
  if (!r.rows.length) throw new CapabilityEngineError("CAPABILITY_PRINCIPAL_DENIED");
}

export async function authorizeCapability(actor: CapabilityActor, request: CapabilityRequest, frozenSources?: FrozenDocumentSource[]) {
  const sources = frozenSources ?? documentSources(request);
  const decision = await evaluateAuthority(actor, { operation: "execution", capability: `capability:${request.kind}`,
    ...(sources.length ? { resources: sources.map(s => ({ type: "document", id: s.documentId })) }
      : request.kind === "nango_sync" ? { resource: { type: "integration", id: request.integrationId } }
      : request.kind === "modal_control" ? { resource: { type: "capability_run", id: request.executionRunId } }
      : request.kind === "parallel_monitor_control" ? { resource: { type: "capability_run", id: request.monitorRunId } }
      : { resource: { type: "capability", id: request.kind } }),
    risk: request.kind === "modal_execute" || request.kind === "shinka_evolve" ? "high" : "low" });
  if (decision.outcome !== "allowed") throw new CapabilityEngineError("CAPABILITY_AUTHORITY_DENIED");
  let ownerValidUntil: string | null = null;
  if (request.kind === "pywhy_assess" && request.interventionModelRef) {
    try {
      const model = await resolveEnterpriseInterventionModelForControl({ auth: { ...actor, employeeId: actor.userId } }, request.interventionModelRef);
      // S3's belief-age comparison is inclusive at integer millisecond precision.
      const cutoff = Math.min(Date.parse(model.request.validity.validUntil), ...model.beliefBindings.map(binding =>
        Date.parse(binding.pin.knowledgeAt) + model.request.validity.maxBeliefAgeMs + 1));
      ownerValidUntil = new Date(cutoff).toISOString();
    }
    catch { throw new CapabilityEngineError("PYWHY_S3_CURRENT_MODEL_NOT_FOUND"); }
  }
  return { ...decision, ownerValidUntil };
}

export async function assertCapabilityOwnerValidity(db: Db, validUntil: string | null): Promise<void> {
  if (validUntil === null) return;
  const result = await db.execute(sql`SELECT clock_timestamp() < ${validUntil}::timestamptz AS valid`);
  if (result.rows[0]?.valid !== true) throw new CapabilityEngineError("PYWHY_S3_CURRENT_MODEL_EXPIRED");
}

export async function assertCapabilityAuthorityRevision(db: Db, tenantId: string, expected: number): Promise<void> {
  const selected = await db.execute(sql`SELECT revision FROM finnor_os.authority_states WHERE tenant_id=${tenantId}::uuid FOR SHARE`);
  if (selected.rows.length !== 1 || Number(selected.rows[0]!.revision) !== expected) throw new CapabilityEngineError("CAPABILITY_AUTHORITY_REVOKED_OR_CHANGED");
}
