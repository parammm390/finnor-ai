import type { PoolClient } from "pg";
import type { Db } from "@finnor/db";
import { createEvidenceSourceTx, appendEvidenceVersionTx } from "@finnor/memory";
import {
  SignedBilateralReplySchema, SignedBilateralSnapshotSchema, SignedBilateralTransportSchema,
  type BilateralSourceRead, type SignedBilateralReply, type VReference,
} from "@finnor/shared-types";
import { verifySigned } from "../../../governed-execution/src/canonical";
import { relationshipLock, suppressRelationship } from "../../../authority/src/relationship-policy";
import type { PeMutationContext } from "../types";
import { invokeBilateralInterface } from "../interface-synthesis/bilateral-adapter";
import { chargeRead } from "./costs";
import { ownerBindings, type OwnerBindings } from "./governance";
import { actor, canonical, companyRecord, event, hash, newId, programme, reference, tx, type Programme, type Candidate } from "./store";

export function sourceRequest(p: Programme, b: OwnerBindings, operation: BilateralSourceRead["operation"],
  candidate: Candidate | null = null): BilateralSourceRead {
  return { schema: "finnor.bilateral-read.v1", tenantId: p.tenant_id, principalId: p.principal_id, programmeId: p.id,
    buyerEntityId: b.mandate.buyerEntityId, mandateDigest: p.intake.mandateRef.contentDigest,
    eligibleCompanyIds: p.intake.eligibleCompanyIds, universeDefinition: p.intake.universeDefinition,
    sourceProfileDigest: p.intake.sourceProfileRef.contentDigest, operation,
    candidateId: candidate?.id ?? null, actionId: candidate?.current_action_id ?? null, afterEventId: candidate?.last_event_id ?? null };
}
export async function readInterface(ctx: PeMutationContext, p: Programme, b: OwnerBindings,
  operation: BilateralSourceRead["operation"], candidate: Candidate | null = null) {
  if (b.retained) {
    if (!["TRANSPORT_STATUS", "EVENTS"].includes(operation) || b.source.maximumReadMicroUsd !== "0" ||
      b.grant.pricebook.storageMicroUsdPerByte.numerator !== "0" ||
      Date.now() >= Math.min(Date.parse(b.source.retentionUntil), Date.parse(b.source.transportReadback.validUntil)))
      throw Error("S6_EXACT_RECOVERY_ACCESS_AND_COST_AUTHORITY_REQUIRED");
    const result = await invokeBilateralInterface(b.source, sourceRequest(p, b, operation, candidate));
    await event(ctx, p, "S6", "RETAINED_ORIGINAL_RESPONSIBILITY_READ", { operation, bytes: result.bytes,
      sourceProfileRef: p.intake.sourceProfileRef, originalGrantRef: p.intake.budgetGrantRef,
      noNewContactPermission: true, microUsd: "0", resourceMeterGap: "SYSTEM_RECOVERY_CPU_IDLE_CAPACITY" });
    return result;
  }
  const charge = await chargeRead(ctx, p, b.grant, b.source.maximumReadMicroUsd);
  await event(ctx, p, "P5", "DIRECT_READ_INTENDED", { operation, sourceProfileRef: p.intake.sourceProfileRef,
    candidateId: candidate?.id ?? null, originalGrantRef: p.intake.budgetGrantRef, chargeKey: charge.key });
  const result = await invokeBilateralInterface(b.source, sourceRequest(p, b, operation, candidate));
  await charge.settle(result.bytes);
  return result;
}
export async function storeObservationTx(ctx: PeMutationContext, p: Programme, b: OwnerBindings, c: PoolClient, db: Db,
  kind: "SNAPSHOT" | "PARTICIPANT_EVENT" | "TRANSPORT_STATUS", eventKey: string, body: unknown, entityId?: string): Promise<VReference> {
  const previous = (await c.query("SELECT id,body,digest FROM finnor_os.s1_bilateral_observations WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 AND event_key=$4",
    [ctx.auth.tenantId, actor(ctx), p.id, eventKey])).rows[0];
  if (previous) {
    if (previous.digest !== hash(body)) throw Error("S1_CONFLICTING_BILATERAL_ORIGINAL_EVENT");
    return reference("S1", previous.id, 1, previous.body);
  }
  const bytes = Buffer.byteLength(canonical(body));
  const used = (await c.query("SELECT COALESCE(sum(octet_length(body::text)),0)::text n FROM finnor_os.s1_bilateral_observations WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3",
    [ctx.auth.tenantId, actor(ctx), p.id])).rows[0].n;
  if (bytes > 262144 || BigInt(used) + BigInt(bytes) > BigInt(b.grant.maximumStoredBytes))
    throw Error("BILATERAL_ORIGINAL_EVIDENCE_STORAGE_GRANT_EXHAUSTED");
  await c.query("SELECT set_config('app.bilateral_programme_id',$1,true)", [p.id]);
  const source = await createEvidenceSourceTx(db, ctx.auth.tenantId, {
    sourceKey: "bilateral:" + p.id + ":" + eventKey, sourceType: "bilateral_record",
    title: "Authenticated bilateral " + kind.toLowerCase(), publisher: b.source.issuer, canonicalUrl: b.source.endpoint,
    metadata: { sourceProfileRef: p.intake.sourceProfileRef, programmeId: p.id, instructionEligible: false, evidenceTrust: "untrusted_evidence" },
  });
  const version = await appendEvidenceVersionTx(db, ctx.auth.tenantId, source.id, {
    content: canonical(body), snapshot: { kind, eventKey, instructionEligible: false },
    ...(entityId ? { entityRefs: [{ type: "external_organization", id: entityId }] } : {}),
  });
  const id = newId();
  await c.query(`INSERT INTO finnor_os.s1_bilateral_observations(tenant_id,principal_id,programme_id,id,kind,
    event_key,evidence_source_id,evidence_version_id,body,digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
  [ctx.auth.tenantId, actor(ctx), p.id, id, kind, eventKey, source.id, version.versionId, canonical(body), hash(body)]);
  const ref = reference("S1", id, 1, body);
  await event(ctx, p, "S1", "AUTHENTICATED_ORIGINAL_OBSERVATION_RETAINED", {
    kind, observationRef: ref, evidenceSourceId: source.id, evidenceVersionId: version.versionId, instructionEligible: false,
  }, c);
  return ref;
}
export function validateSnapshot(p: Programme, b: OwnerBindings, value: unknown) {
  const signed = SignedBilateralSnapshotSchema.parse(value), s = signed.body;
  if (!verifySigned(s, signed.signature, b.source.responsePublicKeyPem)) throw Error("S1_INDEPENDENT_SNAPSHOT_AUTHENTICATION_FAILED");
  if (s.tenantId !== p.tenant_id || s.buyerEntityId !== b.mandate.buyerEntityId || s.mandateDigest !== p.intake.mandateRef.contentDigest ||
    s.sourceProfileDigest !== p.intake.sourceProfileRef.contentDigest ||
    hash(s.eligibleCompanyIds.slice().sort()) !== hash(p.intake.eligibleCompanyIds.slice().sort()) ||
    s.universeDefinition !== p.intake.universeDefinition || new Set(s.companies.map(v => v.companyId)).size !== s.companies.length ||
    hash(s.companies.map(v => v.companyId).sort()) !== hash(s.eligibleCompanyIds.slice().sort()) ||
    Date.parse(s.knowledgeCut) > Date.now() || Date.now() >= Date.parse(s.expiresAt))
    throw Error("S1_FROZEN_UNIVERSE_SOURCE_OR_TIME_BINDING_MISMATCH");
  if (!s.pipeline.authoritative || !s.pipeline.completeAuthorizedVisibility ||
    !s.pipeline.coveredBuyerEntityIds.includes(s.buyerEntityId) ||
    !s.eligibleCompanyIds.every(id => s.pipeline.coveredCompanyIds.includes(id)))
    throw Error("S1_AUTHORITATIVE_AUTHORIZED_PIPELINE_COVERAGE_INCOMPLETE");
  return signed;
}
export async function acceptParticipantEvent(ctx: PeMutationContext, p: Programme, b: OwnerBindings, value: unknown) {
  const signed = SignedBilateralReplySchema.parse(value), reply = signed.body, company = companyRecord(p, reply.companyId);
  if (!verifySigned(reply, signed.signature, company.participantPublicKeyPem) || reply.tenantId !== p.tenant_id ||
    reply.programmeId !== p.id || reply.participantId !== company.counterpartyId ||
    Date.parse(reply.observedAt) > Date.now() + 1000) throw Error("S1_DIRECT_PARTICIPANT_AUTHENTICATION_OR_SCOPE_FAILED");
  return tx(ctx, async (c, db) => {
    await relationshipLock(c, p.tenant_id);
    const current = await programme(ctx, p.id, c, true);
    await ownerBindings(ctx, current, c, true);
    if (Date.now() >= Date.parse(b.source.retentionUntil)) throw Error("S1_BILATERAL_ORIGINAL_RETENTION_EXPIRED");
    const ref = await storeObservationTx(ctx, p, b, c, db, "PARTICIPANT_EVENT", "participant:" + reply.eventId, signed, reply.companyId);
    if (["REFUSAL", "OPT_OUT", "WITHDRAWAL"].includes(reply.kind)) {
      await suppressRelationship(c, { tenantId: p.tenant_id, companyId: reply.companyId, personId: reply.participantId,
        kind: reply.kind as "REFUSAL" | "OPT_OUT" | "WITHDRAWAL", sourceRef: ref, observedAt: reply.observedAt });
      await c.query("SELECT finnor_os.p4_touch_source($1,$2)", [p.tenant_id, "bilateral-participant:" + reply.participantId]);
      await c.query("UPDATE finnor_os.v1_candidates SET disposition='DECLINED',reason=$4,last_event_id=$5 WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 AND company_id=$6",
        [p.tenant_id, p.principal_id, p.id, reply.kind, reply.eventId, reply.companyId]);
      await event(ctx, p, "S6", "FIRM_WIDE_CONTACT_BRANCH_SUPPRESSED", { eventRef: ref, kind: reply.kind, futureContactPermitted: false }, c);
    }
    return { ref, signed };
  });
}
export async function participantEvents(ctx: PeMutationContext, p: Programme, candidate: Candidate): Promise<Array<{ ref: VReference; signed: SignedBilateralReply }>> {
  return tx(ctx, async c => (await c.query(`SELECT id,body,digest FROM finnor_os.s1_bilateral_observations
    WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 AND kind='PARTICIPANT_EVENT'
    AND body->'body'->>'companyId'=$4 ORDER BY retrieved_at,id LIMIT 129`,
  [ctx.auth.tenantId, actor(ctx), p.id, candidate.company_id])).rows.map(row => {
    if (hash(row.body) !== row.digest) throw Error("S1_BILATERAL_ORIGINAL_PREIMAGE_CHANGED");
    return { ref: reference("S1", row.id, 1, row.body), signed: SignedBilateralReplySchema.parse(row.body) };
  }), true);
}
export const parseTransport = (b: OwnerBindings, value: unknown) => {
  const signed = SignedBilateralTransportSchema.parse(value);
  if (!verifySigned(signed.body, signed.signature, b.source.responsePublicKeyPem))
    throw Error("S6_ORIGINAL_TRANSPORT_OBSERVATION_SIGNATURE_INVALID");
  return signed;
};
