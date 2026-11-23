import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenantTransaction, transitionWorkTx, receiveWork, type Db } from "@finnor/db";
import { canExerciseAuthorityTx } from "@finnor/authority";
import { createEvidenceSourceTx, appendEvidenceVersionTx } from "@finnor/memory/evidence";
import { ownerTransportHash, ownerTransportRoute, verifyOwnerDeliveryOrigin } from "../../../governed-execution/src/owner-transport";
import { referencePreimageDigest } from "../../../governed-execution/src/protocol";
import type { PeMutationContext } from "../types";
import { principal, unavailable } from "../owner-context";
import { readEnterpriseDurableObligation } from "../enterprise-obligations";
import { validateEnterpriseExperiment } from "../enterprise-experiments";
import { validateEnterpriseInterventionModel } from "../enterprise-interventions";
import { canonical, hash, bytesHash, same, sameScope, W4_BOUNDS, growthInputSchema, programSchema,
  type SourceRef, type NativeRef, type GrowthInput, type BuildIdentity, type ProgramCheck } from "./contracts";
import { growthEvidenceSchema, growthMandateSchema, growthOperationSchemas, writeGrowthSourceSchema,
  submitGrowthSchema, type GrowthJobPayload } from "./boundaries";
import { growthIdentity, requireGrowthProfile } from "./identity";

export interface GrowthRequestRow {
  id: string; tenant_id: string; principal_id: string; company_id: string; work_id: string; work_input_id: string;
  business_assignment_id: string; outcome_ref: SourceRef; mandate_ref: SourceRef;
  parent_policy: NativeRef; parent_allocation: NativeRef; budget_obligation_ref: NativeRef; s7_estimand_id: string | null;
  request_digest: string; identity: BuildIdentity; rights_revision: string; original_deadline: Date;
  compile_deadline: Date; generation: number; wake_revision: string; status: string; artifact_id: string | null;
  claim_token: string | null; claim_fence: string | null;
}
export interface GrowthSourceRow {
  source_id: string; version_id: string; content: string; content_digest: string; author_id: string;
  evidence_class: "CONTROLLED" | "REPLAYED"; purpose: string; kind: string; created_at: Date;
  latest: number; version_number: number; protocol_id: string | null;
}
export const growthTx = <T>(ctx: PeMutationContext, run: (c: PoolClient, db: Db) => Promise<T>, readOnly = false) =>
  withTenantTransaction(ctx.auth.tenantId, { userId: principal(ctx), readOnly }, (db, c) => run(c, db));
export async function lockGrowthParticipant(ctx: PeMutationContext, id: string, c: PoolClient, consent = true) {
  if (principal(ctx) !== ctx.auth.userId) throw unavailable();
  const row = (await c.query<{ locked: boolean }>(
    "SELECT finnor_os.w4_lock_self_protocol($1,$2) locked", [id, consent])).rows[0];
  if (!row?.locked) throw unavailable();
}
export async function authorizeGrowthWork(ctx: PeMutationContext, workId: string, c: PoolClient) {
  if (ctx.auth.role !== "owner" || ctx.auth.userId !== principal(ctx) || !await canExerciseAuthorityTx(ctx.auth, {
    operation: "query", capability: "query:pe_world_state", resource: { type: "work", id: workId }, risk: "low",
  }, c)) throw unavailable();
  const row = (await c.query<{ id: string; status: string; revision: string }>(`SELECT w.id,w.status,a.revision::text
   FROM finnor_os.works w JOIN finnor_os.users u ON u.tenant_id=w.tenant_id AND u.id=w.created_by
   JOIN finnor_os.authority_states a ON a.tenant_id=w.tenant_id
   WHERE w.tenant_id=$1 AND w.id=$2 AND w.created_by=$3 AND u.status='active' FOR SHARE OF w,u,a`,
  [ctx.auth.tenantId, workId, principal(ctx)])).rows[0];
  if (!row) throw unavailable();
  return row;
}
export async function intakeGrowthWork(ctx: PeMutationContext, raw: unknown) {
  requireGrowthProfile();
  const input = growthOperationSchemas.intake.parse(raw);
  await growthTx(ctx, async c => {
    if (ctx.auth.role !== "owner" || principal(ctx) !== ctx.auth.userId
      || !await canExerciseAuthorityTx(ctx.auth, { operation: "query", capability: "query:pe_world_state",
        resource: { type: "external_organization", id: input.companyId }, risk: "low" }, c)
      || !(await c.query(`SELECT id FROM finnor_os.external_organizations
       WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE`, [ctx.auth.tenantId, input.companyId])).rows[0])
      throw unavailable();
  });
  return receiveWork({ tenantId: ctx.auth.tenantId, userId: principal(ctx), instruction: input.instruction,
    channel: "text", idempotencyKey: "w4:" + input.idempotencyKey, requireExactIntake: true,
    entityAttachments: [{ entityType: "external_organization", entityId: input.companyId,
      relationship: "about", source: "POSTZ.W4.original_company" }],
    activeContext: { worldRoot: { entityType: "external_organization", entityId: input.companyId },
      originalBusinessAssignments: 1, compiler: "POSTZ.W4", executionAuthorityGranted: false } });
}
export async function growthRequest(ctx: PeMutationContext, id: string, c: PoolClient, lock = false) {
  const row = (await c.query<GrowthRequestRow>(`SELECT * FROM finnor_os.w4_business_requests
   WHERE tenant_id=$1 AND principal_id=$2 AND id=$3${lock ? " FOR UPDATE" : ""}`,
  [ctx.auth.tenantId, principal(ctx), id])).rows[0];
  if (!row) throw unavailable();
  await authorizeGrowthWork(ctx, row.work_id, c);
  return row;
}
export async function growthSourceOriginals(ctx: PeMutationContext, workId: string, refs: SourceRef[],
  c: PoolClient, current = true): Promise<GrowthSourceRow[]> {
  if (refs.length > W4_BOUNDS.events) throw Error("W4_ORIGINAL_SOURCE_READ_BOUND_INCOMPLETE");
  const key = (r: SourceRef) => `${r.sourceId.toLowerCase()}:${r.versionId.toLowerCase()}:${r.contentDigest}`;
  const unique = [...new Map(refs.map(ref => [key(ref), ref])).values()], originals = new Map<string, GrowthSourceRow>();
  for (let offset = 0; offset < unique.length; offset += 256) {
    const batch = unique.slice(offset, offset + 256);
    const rows = (await c.query<GrowthSourceRow>(`SELECT l.*,v.content,v.version_number,
     (SELECT max(h.version_number) FROM finnor_os.evidence_source_versions h
       WHERE h.tenant_id=v.tenant_id AND h.source_id=v.source_id) latest
     FROM finnor_os.w4_original_source_links l JOIN finnor_os.evidence_source_versions v
      ON v.tenant_id=l.tenant_id AND v.source_id=l.source_id AND v.id=l.version_id
     JOIN unnest($3::uuid[],$4::uuid[],$5::text[]) requested(source_id,version_id,content_digest)
      ON requested.source_id=l.source_id AND requested.version_id=l.version_id AND requested.content_digest=l.content_digest
     WHERE l.tenant_id=$1 AND l.work_id=$2 AND v.content_hash=l.content_digest FOR SHARE OF v`,
    [ctx.auth.tenantId, workId, batch.map(r => r.sourceId), batch.map(r => r.versionId), batch.map(r => r.contentDigest)])).rows;
    for (const r of rows) originals.set(key({ sourceId: r.source_id, versionId: r.version_id, contentDigest: r.content_digest }), r);
    for (const ref of batch) {
      const r = originals.get(key(ref));
      if (!r || bytesHash(r.content) !== ref.contentDigest || Buffer.byteLength(r.content) > W4_BOUNDS.sourceBytes)
        throw Error("W4_ORIGINAL_S1_SOURCE_UNAVAILABLE");
      if (current && Number(r.latest) !== Number(r.version_number)) throw Error("W4_SOURCE_REVISION_CHANGED");
    }
  }
  return refs.map(ref => originals.get(key(ref))!);
}
export async function growthSourceOriginal(ctx: PeMutationContext, workId: string, ref: SourceRef, c: PoolClient, current = true) {
  return (await growthSourceOriginals(ctx, workId, [ref], c, current))[0]!;
}
export async function persistGrowthSource(ctx: PeMutationContext, input: {
  workId: string; ownerId: string; idempotencyKey: string; purpose: string; protocolId: string | null;
  kind: "MANDATE" | "OUTCOME" | "EVIDENCE" | "NATIVE" | "EVENT"; body: unknown;
}, c: PoolClient, db: Db): Promise<SourceRef> {
  const content = canonical(input.body), contentDigest = bytesHash(content), actor = principal(ctx);
  if (Buffer.byteLength(content) > W4_BOUNDS.sourceBytes) throw Error("W4_SOURCE_BYTE_BOUND");
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    [`w4-source:${ctx.auth.tenantId}:${actor}:${input.workId}:${input.idempotencyKey}`]);
  const old = (await c.query<GrowthSourceRow>(`SELECT * FROM finnor_os.w4_original_source_links
   WHERE tenant_id=$1 AND author_id=$2 AND work_id=$3 AND idempotency_key=$4`,
  [ctx.auth.tenantId, actor, input.workId, input.idempotencyKey])).rows[0];
  if (old) {
    if (old.content_digest !== contentDigest || old.purpose !== input.purpose || old.kind !== input.kind
      || old.protocol_id !== input.protocolId) throw Error("W4_SOURCE_IDEMPOTENCY_CONFLICT");
    return { sourceId: old.source_id, versionId: old.version_id, contentDigest };
  }
  const metadata = { w4Private: true, w4PrincipalId: input.ownerId, w4AuthorId: actor, w4WorkId: input.workId,
    purpose: input.purpose, classification: "CONTROLLED" };
  const source = await createEvidenceSourceTx(db, ctx.auth.tenantId, {
    sourceKey: `w4:${input.workId}:${actor}:${input.idempotencyKey}`, sourceType: "W4_AUTHENTICATED_ORIGINAL",
    title: "Purpose-bound business original", publisher: actor, metadata,
  });
  const version = await appendEvidenceVersionTx(db, ctx.auth.tenantId, source.id, {
    content, snapshot: { ...metadata, worldRoot: { entityType: "work", entityId: input.workId } },
    asOf: new Date(), retrievedAt: new Date(),
  });
  await c.query(`INSERT INTO finnor_os.w4_original_source_links
   (tenant_id,principal_id,work_id,source_id,version_id,content_digest,author_id,kind,purpose,protocol_id,idempotency_key)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [ctx.auth.tenantId, input.ownerId, input.workId, source.id, version.versionId, contentDigest,
    actor, input.kind, input.purpose, input.protocolId, input.idempotencyKey]);
  return { sourceId: source.id, versionId: version.versionId, contentDigest };
}
export async function writeGrowthSource(ctx: PeMutationContext, raw: unknown) {
  requireGrowthProfile();
  const input = writeGrowthSourceSchema.parse(raw), body = input.body, actor = principal(ctx);
  return growthTx(ctx, async (c, db) => {
    if (body.scope.tenantId !== ctx.auth.tenantId || body.scope.workId !== input.workId) throw unavailable();
    if (body.scope.principalId === actor) {
      await authorizeGrowthWork(ctx, input.workId, c);
      if (input.protocolId || ctx.auth.role !== "owner") throw unavailable();
    } else {
      if (body.schema !== "finnor.growth-evidence.v1" || !input.protocolId) throw unavailable();
      await lockGrowthParticipant(ctx, input.protocolId, c);
      const p = (await c.query<{ purpose: string; operational_disclosure: { scope: unknown; evidenceKinds: string[] } }>(`SELECT p.*
       FROM finnor_os.w4_participant_protocols p JOIN finnor_os.users u ON u.tenant_id=p.tenant_id AND u.id=p.participant_id
       WHERE p.tenant_id=$1 AND p.id=$2 AND p.participant_id=$3 AND u.status='active'
        AND p.permitted_kinds ? 'EVIDENCE' AND p.consent_at IS NOT NULL AND p.revoked_at IS NULL
        AND p.expires_at>clock_timestamp()`,
      [ctx.auth.tenantId, input.protocolId, actor])).rows[0];
      if (!p || p.purpose !== input.purpose || !same(p.operational_disclosure.scope, body.scope)
        || !p.operational_disclosure.evidenceKinds.includes(body.kind)) throw unavailable();
    }
    const kind = body.schema === "finnor.growth-evidence.v1" ? "EVIDENCE"
      : body.schema === "finnor.growth-mandate.v1" ? "MANDATE"
        : body.schema === "finnor.growth-outcome.v1" ? "OUTCOME" : "NATIVE";
    const source = await persistGrowthSource(ctx, { ...input, protocolId: input.protocolId ?? null,
      body, ownerId: body.scope.principalId, kind }, c, db);
    if (kind === "NATIVE") {
      const rows = (await c.query<GrowthRequestRow>(`UPDATE finnor_os.w4_business_requests
       SET wake_revision=wake_revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2
        AND work_id=$3 AND business_assignment_id=$4 RETURNING *`,
      [ctx.auth.tenantId, actor, input.workId, body.scope.businessAssignmentId])).rows;
      for (const row of rows) if (row.artifact_id) await enqueueGrowth(c, row, false);
    }
    return { source, classification: "CONTROLLED", authorshipOnly: true, physicalTruthEstablished: false };
  });
}
/** Read the actual signed native-owner origin, not caller-supplied receipt bytes. */
export async function growthNativeOriginal(ctx: PeMutationContext, ref: NativeRef, c: PoolClient) {
  const identity = { semanticOwner: ref.owner, tenantId: ctx.auth.tenantId, principalId: principal(ctx) };
  const route = await ownerTransportRoute(identity);
  if (!route) throw Error("W4_NATIVE_OWNER_ORIGIN_UNAVAILABLE");
  const rows = (await c.query(`SELECT envelope,signature,payload_digest FROM finnor_os.s6_owner_delivery_origins
   WHERE tenant_id=$1 AND principal_id=$2 AND semantic_owner=$3 AND kind='REFERENCE'
    AND (envelope #>> '{payload,reference,id}'=$4 OR EXISTS(
     SELECT 1 FROM jsonb_array_elements(coalesce(envelope #> '{payload,relatedReferences}','[]'::jsonb)) r
      WHERE r->>'id'=$4)) ORDER BY created_at LIMIT 3`,
  [ctx.auth.tenantId, principal(ctx), ref.owner, ref.id])).rows;
  const found: Record<string, unknown>[] = [];
  for (const row of rows) {
    verifyOwnerDeliveryOrigin(route, row.envelope, row.signature);
    if (ownerTransportHash(row.envelope.payload) !== row.payload_digest) throw Error("W4_NATIVE_OWNER_STORAGE_BINDING_INVALID");
    for (const r of [row.envelope.payload.reference, ...(row.envelope.payload.relatedReferences ?? [])]) {
      const { content, digestEncoding, ...identityRef } = r;
      if (same(identityRef, ref) && referencePreimageDigest(r) === ref.contentDigest) {
        if (!content || typeof content !== "object" || Array.isArray(content)) throw Error("W4_NATIVE_OWNER_OBJECT_REQUIRED");
        found.push(content);
      }
    }
  }
  if (found.length !== 1) throw Error("W4_NATIVE_EXACT_ORIGINAL_REQUIRED");
  return found[0]!;
}
async function growthNativeProposal(ctx: PeMutationContext, ref: NativeRef, c: PoolClient) {
  const identity = { semanticOwner: ref.owner, tenantId: ctx.auth.tenantId, principalId: principal(ctx) };
  const route = await ownerTransportRoute(identity);
  if (!route) throw Error("W4_NATIVE_OWNER_ORIGIN_UNAVAILABLE");
  const rows = (await c.query(`SELECT envelope,signature,payload_digest FROM finnor_os.s6_owner_delivery_origins
   WHERE tenant_id=$1 AND principal_id=$2 AND semantic_owner=$3 AND kind='EVENT'
    AND envelope #>> '{payload,event,revisionRef}'=$4 AND envelope #>> '{payload,event,type}'='PROPOSAL'
   ORDER BY created_at LIMIT 3`, [ctx.auth.tenantId, principal(ctx), ref.owner, ref.id])).rows;
  if (rows.length !== 1) throw Error("W4_NATIVE_ORIGINAL_PREPARED_EVENT_REQUIRED");
  const row = rows[0]!;
  verifyOwnerDeliveryOrigin(route, row.envelope, row.signature);
  const event = row.envelope.payload.event;
  if (ownerTransportHash(row.envelope.payload) !== row.payload_digest || event.contentDigest !== ref.contentDigest
    || event.semanticOwner !== ref.owner || event.tenantId !== identity.tenantId || event.principalId !== identity.principalId)
    throw Error("W4_NATIVE_PREPARED_EVENT_STORAGE_BINDING_INVALID");
  return { event, receipt: null, status: "BLOCKED_EXTERNAL" };
}
async function originalEvidence(ctx: PeMutationContext, input: GrowthInput, ref: SourceRef, c: PoolClient,
  expectedKind: string, authorId: string | null, current: boolean) {
  const source = await growthSourceOriginal(ctx, input.scope.workId, ref, c, current);
  const body = growthEvidenceSchema.parse(JSON.parse(source.content));
  if (!sameScope(body.scope, input.scope) || body.kind !== expectedKind || source.kind !== "EVIDENCE"
    || source.purpose !== input.permittedPurpose || authorId && source.author_id !== authorId
    || Date.parse(body.validFrom) > source.created_at.getTime()
    || Date.parse(body.validUntil) < Date.parse(input.originalDeadlineAt))
    throw Error("W4_AUTHENTICATED_EVIDENCE_MEANING_MISMATCH");
  if (source.author_id !== input.scope.principalId) {
    const p = (await c.query<{ role: string }>(`SELECT role FROM finnor_os.w4_participant_protocols
     WHERE tenant_id=$1 AND id=$2 AND participant_id=$3 AND principal_id=$4 AND work_id=$5
      AND consent_at<=$6 AND expires_at>$6 AND (revoked_at IS NULL OR revoked_at>$6)
      AND ($7::boolean=false OR revoked_at IS NULL AND expires_at>clock_timestamp()) FOR SHARE`,
    [input.scope.tenantId, source.protocol_id, source.author_id, input.scope.principalId, input.scope.workId,
      source.created_at, current])).rows[0];
    const required = { CAPABILITY: ["OPERATOR"], DEMAND: ["BUYER", "INDEPENDENT_OBSERVER"],
      CONSENT: ["BUYER"], POPULATION: ["INDEPENDENT_OBSERVER"], TEST_PROTOCOL: ["INDEPENDENT_OBSERVER"],
      ACCOUNTING_POLICY: ["ACCOUNTANT"], INVOICE: ["ACCOUNTANT"], ACCOUNTING: ["ACCOUNTANT"] }[expectedKind];
    if (!p || !required?.includes(p.role)) throw Error("W4_EVIDENCE_ORIGINAL_PURPOSE_CONSENT_UNAVAILABLE");
  }
  for (const basis of body.basis) await growthSourceOriginal(ctx, input.scope.workId, basis, c, current);
  return { source, body };
}
export async function loadGrowthInput(ctx: PeMutationContext, row: GrowthRequestRow, c: PoolClient, current = true) {
  const source = await growthSourceOriginal(ctx, row.work_id, row.outcome_ref, c, current);
  const input = growthInputSchema.parse(JSON.parse(source.content));
  if (source.author_id !== row.principal_id || !sameScope(input.scope, {
    tenantId: row.tenant_id, principalId: row.principal_id, companyId: row.company_id, workId: row.work_id,
    businessAssignmentId: row.business_assignment_id }) || !same(input.mandateSource, row.mandate_ref)
    || !same(input.parentPolicy, row.parent_policy) || !same(input.parentAllocation, row.parent_allocation)
    || !same(input.budgetObligation, row.budget_obligation_ref)) throw Error("W4_ORIGINAL_SCOPE_MISMATCH");
  if (!current) return input;
  const m = await growthSourceOriginal(ctx, row.work_id, row.mandate_ref, c);
  const mandate = growthMandateSchema.parse(JSON.parse(m.content));
  if (m.author_id !== row.principal_id || mandate.authorizedByPrincipalId !== row.principal_id
    || !sameScope(mandate.scope, input.scope) || mandate.revoked || mandate.purpose !== input.permittedPurpose
    || Date.parse(mandate.validFrom) > Date.now() || Date.parse(mandate.expiresAt) < Date.parse(input.originalDeadlineAt)
    || Date.parse(mandate.expiresAt) <= Date.now()
    || input.permittedCapabilityIds.some(id => !mandate.permittedCapabilityIds.includes(id))
    || input.test.maxContacts > mandate.maximumContacts || input.test.maxHumanSeconds > mandate.maximumHumanSeconds
    || input.currency !== mandate.maximumMoney.currency || BigInt(input.test.maxMoney.minor) > BigInt(mandate.maximumMoney.minor))
    throw Error("W4_SEPARATE_ORIGINAL_MANDATE_REQUIRED");
  if (!(await c.query(`SELECT id FROM finnor_os.external_organizations
   WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE`, [row.tenant_id, row.company_id])).rows[0])
    throw Error("W4_CANONICAL_ENTERPRISE_SUBJECT_REQUIRED");
  for (const cap of input.capabilities) {
    const { source: ignored, ...expected } = cap;
    const evidence = await originalEvidence(ctx, input, cap.source, c, "CAPABILITY", cap.operatorId, true);
    if (cap.operatorId === row.principal_id || !same(evidence.body.data, expected))
      throw Error("W4_ACTUAL_OPERATOR_CAPABILITY_ORIGINAL_REQUIRED");
  }
  for (const demand of input.demands) {
    const { source: ignored, ...expected } = demand;
    const e = await originalEvidence(ctx, input, demand.source, c, "DEMAND", null, true);
    if (e.source.author_id === row.principal_id || !same(e.body.data, expected))
      throw Error("W4_DEMAND_ORIGINAL_NOT_PRODUCER_ASSERTION_REQUIRED");
  }
  for (const buyer of input.population) {
    const e = await originalEvidence(ctx, input, buyer.consentSource, c, "CONSENT", buyer.buyerId, true);
    const table = buyer.customerRef.owner === "external_contact" ? "external_contacts" : "external_organizations";
    const customer = (await c.query<{ id: string; tenant_id: string; active: boolean; updated_at: Date }>(
      `SELECT id,tenant_id,active,updated_at FROM finnor_os.${table} WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE`,
      [row.tenant_id, buyer.customerRef.id])).rows[0];
    const expected = { buyerId: buyer.buyerId, customerRef: buyer.customerRef, affiliation: buyer.affiliation,
      permittedPurpose: buyer.permittedPurpose, consentValidUntil: buyer.consentValidUntil };
    if (!customer || buyer.customerRef.version !== "w4-customer-identity-v1"
      || buyer.customerRef.contentDigest !== hash({ id: customer.id, tenantId: customer.tenant_id,
        active: customer.active, updatedAt: customer.updated_at.toISOString() }) || !same(e.body.data, expected))
      throw Error("W4_CANONICAL_CUSTOMER_SELF_CONSENT_REQUIRED");
  }
  const observer = input.test.independentObservationOwnerId;
  if (observer === row.principal_id || input.capabilities.some(cap => cap.operatorId === observer)
    || input.population.some(buyer => buyer.buyerId === observer)) throw Error("W4_INDEPENDENT_OBSERVATION_OWNER_REQUIRED");
  const population = await originalEvidence(ctx, input, input.test.populationSource, c, "POPULATION", observer, true);
  if (!same(population.body.data, { buyerIds: input.population.map(b => b.buyerId),
    affiliations: input.population.map(b => ({ buyerId: b.buyerId, affiliation: b.affiliation })) }))
    throw Error("W4_ORIGINAL_POPULATION_AND_AFFILIATION_REQUIRED");
  const protocol = await originalEvidence(ctx, input, input.test.protocolSource, c, "TEST_PROTOCOL", observer, true);
  const { populationSource: ignoredPopulation, protocolSource: ignoredProtocol, ...expectedTest } = input.test;
  if (!same(protocol.body.data, expectedTest)) throw Error("W4_INDEPENDENT_REGISTERED_TEST_PROTOCOL_REQUIRED");
  const accounting = await originalEvidence(ctx, input, input.terms.accountingPolicySource, c, "ACCOUNTING_POLICY", null, true);
  if (accounting.source.author_id === row.principal_id || input.population.some(b => b.buyerId === accounting.source.author_id)
    || input.capabilities.some(cap => cap.operatorId === accounting.source.author_id)
    || !same(accounting.body.data, { accountingCalendar: input.terms.accountingCalendar,
      taxTreatment: input.terms.taxTreatment, recognition: input.terms.recognition }))
    throw Error("W4_INDEPENDENT_ACCOUNTING_POLICY_REQUIRED");
  const s2 = await growthNativeOriginal(ctx, input.test.s2ProtocolRef, c);
  if (input.test.s2ProtocolRef.owner !== "S2") throw Error("W4_ORIGINAL_S2_PROTOCOL_REQUIRED");
  // Check the signed S2 original against the current S1 cut in this transaction.
  // W4 observations must not enqueue new S1/S2 deliveries while reading it.
  const checked = await validateEnterpriseExperiment(ctx, { ...s2, id: input.test.s2ProtocolRef.id,
    version: input.test.s2ProtocolRef.version, contentDigest: input.test.s2ProtocolRef.contentDigest,
    experience: await growthNativeProposal(ctx, input.test.s2ProtocolRef, c) }, c);
  if (checked.status !== "CURRENT") throw Error("W4_ORIGINAL_S2_PROTOCOL_NOT_CURRENT_" + checked.reason);
  const candidate = (s2.candidate ?? {}) as Record<string, unknown>;
  const timing = (candidate.timing ?? {}) as Record<string, unknown>;
  const assignment = (candidate.assignment ?? {}) as Record<string, unknown>;
  const populationRef = { owner: "S1", id: input.test.populationSource.versionId,
    version: "evidence-source-version-v1", contentDigest: input.test.populationSource.contentDigest };
  if (!same(candidate.populationRef, populationRef) || typeof candidate.samples !== "number"
    || candidate.samples > input.test.maxContacts || assignment.kind !== input.test.design
    || Date.parse(String(timing.startAt)) < Date.parse(input.validFrom)
    || Date.parse(String(timing.endAt)) > Date.parse(input.test.closesAt)
    || !Number.isFinite(Date.parse(String(timing.startAt))) || !Number.isFinite(Date.parse(String(timing.endAt))))
    throw Error("W4_S2_ORIGINAL_POPULATION_ASSIGNMENT_EXPOSURE_OR_WINDOW_MISMATCH");
  if (input.test.s3ModelRef) {
    if (input.test.s3ModelRef.owner !== "S3") throw Error("W4_ORIGINAL_S3_MODEL_REQUIRED");
    await growthNativeOriginal(ctx, input.test.s3ModelRef, c);
    if ((await validateEnterpriseInterventionModel(ctx, input.test.s3ModelRef)).status !== "CURRENT")
      throw Error("W4_ORIGINAL_S3_MODEL_NOT_CURRENT");
  }
  return input;
}
export async function currentGrowthCut(ctx: PeMutationContext, row: GrowthRequestRow, c: PoolClient) {
  const work = await authorizeGrowthWork(ctx, row.work_id, c);
  if (work.status === "cancelled" || row.status === "FAILED") throw Error("W4_ORIGINAL_WORK_REVOKED_RESPONSIBILITY_RETAINED");
  if (work.revision !== String(row.rights_revision)) throw Error("W4_ORIGINAL_RIGHTS_REVISION_CHANGED");
  const latest = (await c.query<{ id: string }>(`SELECT id FROM finnor_os.work_inputs
   WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`, [row.tenant_id, row.work_id])).rows[0];
  if (latest?.id !== row.work_input_id) throw Error("W4_WORK_INPUT_CHANGED");
  if (Date.now() >= row.original_deadline.getTime()) throw Error("W4_ORIGINAL_DEADLINE_EXPIRED_RESPONSIBILITY_RETAINED");
  if (!same(await growthIdentity(), row.identity)) throw Error("W4_METHOD_CHECKER_RUNTIME_CHANGED");
  return { input: await loadGrowthInput(ctx, row, c) };
}
export async function growthArtifact(ctx: PeMutationContext, row: GrowthRequestRow, c: PoolClient) {
  if (!row.artifact_id) return null;
  const artifact = (await c.query<{ id: string; generation: number; body: unknown; body_digest: string; check_result: ProgramCheck }>(`SELECT *
   FROM finnor_os.w4_business_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND request_id=$4 AND generation=$5`,
  [row.tenant_id, principal(ctx), row.artifact_id, row.id, row.generation])).rows[0];
  if (!artifact || hash(artifact.body) !== artifact.body_digest || artifact.check_result.candidateDigest !== artifact.body_digest
    || artifact.check_result.disposition !== "CHECKED_DEVELOPMENT") throw Error("W4_CHECKED_ARTIFACT_UNAVAILABLE");
  return { ...artifact, body: programSchema.parse(artifact.body) };
}
export async function enqueueGrowth(c: PoolClient, row: GrowthRequestRow, compile: boolean) {
  const payload: GrowthJobPayload = { tenantId: row.tenant_id, principalId: row.principal_id,
    requestId: row.id, generation: row.generation, wakeRevision: Number(row.wake_revision) };
  await c.query(`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety)
   VALUES($1,$2,$3::jsonb,$4,'interactive',1,$5) ON CONFLICT(idempotency_key) DO NOTHING`,
  [row.tenant_id, compile ? "compile_market_operating_program_v1" : "advance_market_operating_program_v1",
    canonical(payload), `w4:${row.id}:${row.generation}:${row.wake_revision}:${compile}`, compile ? "locally_idempotent" : "reconcilable"]);
}
export async function submitGrowthOutcome(ctx: PeMutationContext, raw: unknown) {
  requireGrowthProfile();
  const input = submitGrowthSchema.parse(raw), identity = await growthIdentity();
  return growthTx(ctx, async (c, db) => {
    const work = await authorizeGrowthWork(ctx, input.workId, c);
    if (["completed", "cancelled", "failed"].includes(work.status)) throw Error("W4_CURRENT_ORIGINAL_WORK_REQUIRED");
    const latest = (await c.query<{ id: string }>(`SELECT id FROM finnor_os.work_inputs
     WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`, [ctx.auth.tenantId, input.workId])).rows[0];
    if (latest?.id !== input.workInputId) throw Error("W4_WORK_INPUT_CHANGED");
    const original = await growthSourceOriginal(ctx, input.workId, input.outcomeSource, c);
    const outcome = growthInputSchema.parse(JSON.parse(original.content));
    if (original.author_id !== principal(ctx) || outcome.scope.workId !== input.workId
      || outcome.scope.tenantId !== ctx.auth.tenantId || outcome.scope.principalId !== principal(ctx)
      || !same(input.budgetObligationRef, outcome.budgetObligation)) throw Error("W4_ORIGINAL_SCOPE_MISMATCH");
    const budget = await readEnterpriseDurableObligation(ctx, input.budgetObligationRef);
    if (!same(budget.allocationRef, outcome.parentAllocation) || !same(budget.policyRef, outcome.parentPolicy)
      || budget.workLineage?.workId !== input.workId || budget.workLineage.workInputId !== input.workInputId)
      throw Error("W4_ORIGINAL_WORK_POLICY_ALLOCATION_REQUIRED");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`w4-submit:${ctx.auth.tenantId}:${principal(ctx)}:${input.idempotencyKey}`]);
    const existing = (await c.query<GrowthRequestRow>(`SELECT * FROM finnor_os.w4_business_requests
     WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3 FOR UPDATE`,
    [ctx.auth.tenantId, principal(ctx), input.idempotencyKey])).rows[0];
    if (existing) {
      if (existing.request_digest !== hash(input)) throw Error("W4_IDEMPOTENCY_CONFLICT");
      return { requestId: existing.id, status: existing.status, semanticReplay: true, executionAuthorityGranted: false };
    }
    const row = (await c.query<GrowthRequestRow>(`INSERT INTO finnor_os.w4_business_requests
     (id,tenant_id,principal_id,company_id,work_id,work_input_id,business_assignment_id,idempotency_key,request_digest,
      outcome_ref,mandate_ref,parent_policy,parent_allocation,budget_obligation_ref,s7_estimand_id,identity,
      rights_revision,original_deadline,compile_deadline)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,
      $15,$16::jsonb,$17,$18,LEAST($18::timestamptz,clock_timestamp()+interval '3600 seconds')) RETURNING *`,
    [randomUUID(), ctx.auth.tenantId, principal(ctx), outcome.scope.companyId, input.workId, input.workInputId,
      outcome.scope.businessAssignmentId, input.idempotencyKey, hash(input), canonical(input.outcomeSource),
      canonical(outcome.mandateSource), canonical(outcome.parentPolicy), canonical(outcome.parentAllocation),
      canonical(input.budgetObligationRef), input.s7EstimandId, canonical(identity), work.revision, outcome.originalDeadlineAt])).rows[0]!;
    await loadGrowthInput(ctx, row, c);
    await c.query(`INSERT INTO finnor_os.work_programme_occupations
     (tenant_id,work_id,owner,programme_id,status,revision) VALUES($1,$2,'POSTZ.W4',$3,'PROGRESS',1)`,
    [row.tenant_id, row.work_id, row.id]);
    await enqueueGrowth(c, row, true);
    await transitionWorkTx(db, row.tenant_id, row.work_id, "executing", "growth_outcome_submitted",
      { requestId: row.id, originalBusinessAssignments: 1, originalDeadlineAt: outcome.originalDeadlineAt,
        evidenceClass: "CONTROLLED", executionAuthorityGranted: false }, { expectedWorkInputId: row.work_input_id });
    return { requestId: row.id, status: row.status, semanticReplay: false, executionAuthorityGranted: false };
  });
}
