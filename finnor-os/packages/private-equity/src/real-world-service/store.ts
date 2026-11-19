import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { withTenantTransaction, transitionWorkTx, receiveWork, type Db } from "@finnor/db";
import { canExerciseAuthorityTx } from "@finnor/authority";
import { createEvidenceSourceTx, appendEvidenceVersionTx } from "@finnor/memory/evidence";
import type { PeMutationContext } from "../types";
import { principal, unavailable } from "../owner-context";
import {
  canonical, hash, bytesHash, W3_BOUNDS, OutcomeContractSchema, ProviderEvidenceSchema, sameScope,
  type SourceRef, type OutcomeContract, type ProviderOriginal, type RealWorldServiceProgram, type ProgramCheck,
} from "./contracts";
import { SourceBodySchema, WriteSourceSchema, SubmitServiceSchema, MandateSchema, TriggerSchema, QualificationSchema, ServiceOperationSchemas, type ServiceJobPayload } from "./boundaries";
import { serviceIdentity, requireServiceProfile } from "./identity";
import { readEnterpriseDurableObligation } from "../enterprise-obligations";

export interface ServiceRequestRow {
  id: string; tenant_id: string; principal_id: string; company_id: string; work_id: string; work_input_id: string;
  business_assignment_id: string; outcome_ref: SourceRef; provider_refs: SourceRef[]; mandate_ref: SourceRef;
  parent_policy: OutcomeContract["parentPolicy"]; parent_allocation: OutcomeContract["parentAllocation"];
  budget_obligation_ref: OutcomeContract["parentPolicy"]; s7_estimand_id: string | null;
  request_digest: string; identity: Awaited<ReturnType<typeof serviceIdentity>>;
  rights_revision: string; original_deadline: Date; compile_deadline: Date; generation: number;
  wake_revision: string; status: string; artifact_id: string | null; claim_token: string | null; claim_fence: string | null;
}
export type SourceRow = {
  source_id: string; version_id: string; content: string; content_digest: string; author_id: string;
  evidence_class: "CONTROLLED" | "REPLAYED"; purpose: string; created_at: Date; latest: number; version_number: number;
  protocol_id: string | null;
};
export const serviceTx = <T>(ctx: PeMutationContext, run: (c: PoolClient, db: Db) => Promise<T>, readOnly = false) =>
  withTenantTransaction(ctx.auth.tenantId, { userId: principal(ctx), readOnly }, (db, c) => run(c, db));
export async function intakeServiceWork(ctx: PeMutationContext, raw: unknown) {
  requireServiceProfile();
  const input = ServiceOperationSchemas.intake.parse(raw);
  await serviceTx(ctx, async c => {
    if (ctx.auth.role !== "owner" || principal(ctx) !== ctx.auth.userId
      || !await canExerciseAuthorityTx(ctx.auth, { operation: "query", capability: "query:pe_world_state",
        resource: { type: "external_organization", id: input.companyId }, risk: "low" }, c)
      || !(await c.query(`SELECT id FROM finnor_os.external_organizations
       WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE`, [ctx.auth.tenantId, input.companyId])).rows[0])
      throw unavailable();
  });
  return receiveWork({ tenantId: ctx.auth.tenantId, userId: principal(ctx), instruction: input.instruction,
    channel: "text", idempotencyKey: "w3:" + input.idempotencyKey, requireExactIntake: true,
    entityAttachments: [{ entityType: "external_organization", entityId: input.companyId,
      relationship: "about", source: "POSTZ.W3.original_company" }],
    activeContext: { worldRoot: { entityType: "external_organization", entityId: input.companyId },
      originalBusinessAssignments: 1, compiler: "POSTZ.W3", executionAuthorityGranted: false } });
}
export async function authorizeServiceWork(ctx: PeMutationContext, workId: string, c: PoolClient) {
  if (ctx.auth.userId !== principal(ctx)) throw unavailable();
  if (!await canExerciseAuthorityTx(ctx.auth, {
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
export async function serviceRequest(ctx: PeMutationContext, id: string, c: PoolClient, lock = false) {
  const row = (await c.query<ServiceRequestRow>(`SELECT * FROM finnor_os.w3_service_requests
   WHERE tenant_id=$1 AND principal_id=$2 AND id=$3${lock ? " FOR UPDATE" : ""}`,
  [ctx.auth.tenantId, principal(ctx), id])).rows[0];
  if (!row) throw unavailable();
  await authorizeServiceWork(ctx, row.work_id, c);
  return row;
}
export async function sourceOriginal(ctx: PeMutationContext, workId: string, ref: SourceRef, c: PoolClient, current = true): Promise<SourceRow> {
  return (await sourceOriginals(ctx, workId, [ref], c, current))[0]!;
}
export async function sourceOriginals(ctx: PeMutationContext, workId: string, refs: SourceRef[], c: PoolClient, current = true): Promise<SourceRow[]> {
  if (refs.length > W3_BOUNDS.observations) throw Error("W3_ORIGINAL_SOURCE_READ_BOUND_INCOMPLETE");
  const key = (ref: SourceRef) => `${ref.sourceId.toLowerCase()}:${ref.versionId.toLowerCase()}:${ref.contentDigest}`;
  const unique = [...new Map(refs.map(ref => [key(ref), ref])).values()], originals = new Map<string, SourceRow>();
  for (let offset = 0; offset < unique.length; offset += 256) {
    const batch = unique.slice(offset, offset + 256);
    const rows = (await c.query<SourceRow>(`SELECT l.source_id,l.version_id,v.content,l.content_digest,l.author_id,
   l.evidence_class,l.purpose,l.created_at,l.protocol_id,v.version_number,
   (SELECT max(h.version_number) FROM finnor_os.evidence_source_versions h WHERE h.tenant_id=v.tenant_id AND h.source_id=v.source_id) latest
   FROM finnor_os.w3_original_source_links l JOIN finnor_os.evidence_source_versions v
    ON v.tenant_id=l.tenant_id AND v.source_id=l.source_id AND v.id=l.version_id
   JOIN unnest($3::uuid[],$4::uuid[],$5::text[]) requested(source_id,version_id,content_digest)
    ON requested.source_id=l.source_id AND requested.version_id=l.version_id AND requested.content_digest=l.content_digest
   WHERE l.tenant_id=$1 AND l.work_id=$2 AND v.content_hash=l.content_digest FOR SHARE OF v`,
    [ctx.auth.tenantId, workId, batch.map(ref => ref.sourceId), batch.map(ref => ref.versionId),
      batch.map(ref => ref.contentDigest)])).rows;
    for (const row of rows) originals.set(key({ sourceId: row.source_id, versionId: row.version_id,
      contentDigest: row.content_digest }), row);
    for (const ref of batch) {
      const row = originals.get(key(ref));
      if (!row || bytesHash(row.content) !== ref.contentDigest || Buffer.byteLength(row.content) > W3_BOUNDS.sourceBytes)
        throw Error("W3_ORIGINAL_S1_SOURCE_UNAVAILABLE");
      if (current && Number(row.latest) !== Number(row.version_number)) throw Error("W3_SOURCE_REVISION_CHANGED");
    }
  }
  return refs.map(ref => originals.get(key(ref))!);
}
export async function loadOutcome(ctx: PeMutationContext, row: ServiceRequestRow, c: PoolClient) {
  const source = await sourceOriginal(ctx, row.work_id, row.outcome_ref, c);
  const outcome = OutcomeContractSchema.parse(JSON.parse(source.content));
  if (source.author_id !== row.principal_id || outcome.scope.tenantId !== row.tenant_id
    || outcome.scope.principalId !== row.principal_id || outcome.scope.companyId !== row.company_id
    || outcome.scope.workId !== row.work_id || outcome.scope.businessAssignmentId !== row.business_assignment_id)
    throw Error("W3_ORIGINAL_SCOPE_MISMATCH");
  if (!(await c.query(`SELECT id FROM finnor_os.external_organizations
   WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE`, [row.tenant_id, row.company_id])).rows[0])
    throw Error("W3_CANONICAL_ENTERPRISE_SUBJECT_REQUIRED");
  const mandateOriginal = await sourceOriginal(ctx, row.work_id, row.mandate_ref, c);
  const mandate = MandateSchema.parse(JSON.parse(mandateOriginal.content));
  if (!sameScope(mandate.scope, outcome.scope) || mandateOriginal.author_id !== outcome.scope.principalId
    || mandate.authorizedByPrincipalId !== mandateOriginal.author_id || mandate.revoked
    || mandate.originalTrigger !== outcome.trigger.kind || Date.parse(mandate.validFrom) > Date.now()
    || Date.parse(mandate.expiresAt) < Date.parse(outcome.originalDeadlineAt)
    || Date.parse(mandate.expiresAt) <= Date.now()
    || outcome.permittedOperations.some(op => !mandate.permittedOperations.includes(op)))
    throw Error("W3_SEPARATE_ORIGINAL_MANDATE_REQUIRED");
  if (outcome.trigger.kind === "EXPLICIT_OUTCOME") {
    const source = await sourceOriginal(ctx, row.work_id, outcome.trigger.originalSource, c);
    const trigger = TriggerSchema.parse(JSON.parse(source.content));
    if (outcome.trigger.requesterId !== row.principal_id || source.author_id !== row.principal_id
      || !sameScope(trigger.scope, outcome.scope) || trigger.kind !== "EXPLICIT_OUTCOME")
      throw Error("W3_ORIGINAL_REQUESTER_REQUIRED");
  }
  if (outcome.trigger.kind === "STANDING_EVENT") {
    const event = await sourceOriginal(ctx, row.work_id, outcome.trigger.eventSource, c);
    const trigger = TriggerSchema.parse(JSON.parse(event.content));
    if (!mandate.eventSource || canonical(mandate.eventSource) !== canonical(outcome.trigger.eventSource)
      || event.author_id !== row.principal_id || !sameScope(trigger.scope, outcome.scope)
      || trigger.kind !== "STANDING_EVENT" || trigger.basis.length === 0
      || canonical(outcome.trigger.mandateSource) !== canonical(row.mandate_ref))
      throw Error("W3_SEPARATELY_ROOTED_EVENT_REQUIRED");
    for (const ref of trigger.basis) await sourceOriginal(ctx, row.work_id, ref, c);
  }
  return outcome;
}
export async function loadProviders(ctx: PeMutationContext, row: ServiceRequestRow, c: PoolClient): Promise<ProviderOriginal[]> {
  const providers: ProviderOriginal[] = [];
  for (const ref of row.provider_refs) {
    const source = await sourceOriginal(ctx, row.work_id, ref, c, false);
    const body = ProviderEvidenceSchema.parse(JSON.parse(source.content));
    if (body.reportingPrincipalId !== source.author_id || body.providerId !== body.reportingPrincipalId)
      throw Error("W3_ACTUAL_PROVIDER_AUTHORED_AVAILABILITY_REQUIRED");
    const author = (await c.query("SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND status='active' FOR SHARE",
      [ctx.auth.tenantId, source.author_id])).rows[0];
    const invalidationReasons: string[] = [];
    if (!author) invalidationReasons.push("PROVIDER_REVOKED");
    if (Number(source.version_number) !== Number(source.latest)) invalidationReasons.push("PROVIDER_SOURCE_REVISED");
    if (source.author_id !== row.principal_id) {
      const protocol = source.protocol_id ? (await c.query(`SELECT p.id FROM finnor_os.w3_participant_protocols p
       WHERE p.tenant_id=$1 AND p.id=$2 AND p.request_id=$3 AND p.participant_id=$4 AND p.provider_id=$4
        AND p.role='PROVIDER' AND p.permitted_kinds ? 'PROVIDER_EVIDENCE' AND p.purpose=$5
        AND p.consent_at IS NOT NULL AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp() FOR SHARE`,
      [row.tenant_id, source.protocol_id, row.id, source.author_id, source.purpose])).rows[0] : null;
      if (!protocol) invalidationReasons.push("PROVIDER_CONSENT_NOT_CURRENT");
    }
    for (const qualification of body.qualifications) {
      try {
        const evidence = await sourceOriginal(ctx, row.work_id, qualification.evidence, c);
        const qualified = QualificationSchema.parse(JSON.parse(evidence.content));
        if (evidence.author_id !== qualification.verifiedByPrincipalId || evidence.author_id === source.author_id
          || qualified.verifiedByPrincipalId !== evidence.author_id || qualified.subjectPrincipalId !== source.author_id
          || qualified.qualificationId !== qualification.id || !sameScope(qualified.scope, body.scope)
          || Date.parse(qualified.expiresAt) < Date.parse(qualification.validUntil)
          || Date.parse(qualified.expiresAt) <= Date.now())
          throw Error("W3_INDEPENDENT_QUALIFICATION_SOURCE_REQUIRED");
        for (const basis of qualified.evidence) await sourceOriginal(ctx, row.work_id, basis, c);
      } catch (error) {
        if (!(error instanceof z.ZodError) && !(error instanceof SyntaxError)
          && !(error instanceof Error && [
            "W3_ORIGINAL_S1_SOURCE_UNAVAILABLE", "W3_SOURCE_REVISION_CHANGED",
            "W3_INDEPENDENT_QUALIFICATION_SOURCE_REQUIRED",
          ].includes(error.message))) throw error;
        invalidationReasons.push("PROVIDER_QUALIFICATION_NOT_CURRENT");
        break;
      }
    }
    providers.push({ ref, body, authorId: source.author_id, classification: source.evidence_class,
      current: invalidationReasons.length === 0, invalidationReasons });
  }
  return providers;
}
export async function persistServiceSource(
  ctx: PeMutationContext, input: { workId: string; ownerId: string; idempotencyKey: string; purpose: string;
    protocolId: string | null; body: unknown; private: boolean }, c: PoolClient, db: Db,
): Promise<SourceRef> {
  const content = canonical(input.body), contentDigest = bytesHash(content), actor = principal(ctx);
  if (Buffer.byteLength(content) > W3_BOUNDS.sourceBytes) throw Error("W3_SOURCE_BYTE_BOUND");
  const old = (await c.query<SourceRow>(`SELECT * FROM finnor_os.w3_original_source_links
   WHERE tenant_id=$1 AND author_id=$2 AND work_id=$3 AND idempotency_key=$4`,
  [ctx.auth.tenantId, actor, input.workId, input.idempotencyKey])).rows[0];
  if (old) {
    if (old.content_digest !== contentDigest || old.purpose !== input.purpose) throw Error("W3_SOURCE_IDEMPOTENCY_CONFLICT");
    return { sourceId: old.source_id, versionId: old.version_id, contentDigest };
  }
  const metadata = { w3Private: input.private, w3PrincipalId: input.ownerId, w3AuthorId: actor,
    w3WorkId: input.workId, purpose: input.purpose, classification: "CONTROLLED" };
  const source = await createEvidenceSourceTx(db, ctx.auth.tenantId, {
    sourceKey: `w3:${input.workId}:${actor}:${input.idempotencyKey}`, sourceType: "W3_AUTHENTICATED_ORIGINAL",
    title: "Purpose-bound service original", publisher: actor, metadata,
  });
  const version = await appendEvidenceVersionTx(db, ctx.auth.tenantId, source.id, {
    content, snapshot: { ...metadata, worldRoot: { entityType: "work", entityId: input.workId } },
    asOf: new Date(), retrievedAt: new Date(),
  });
  await c.query(`INSERT INTO finnor_os.w3_original_source_links
   (tenant_id,principal_id,work_id,source_id,version_id,content_digest,author_id,purpose,evidence_class,idempotency_key,protocol_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,'CONTROLLED',$9,$10)`,
  [ctx.auth.tenantId, input.ownerId, input.workId, source.id, version.versionId, contentDigest,
    actor, input.purpose, input.idempotencyKey, input.protocolId]);
  return { sourceId: source.id, versionId: version.versionId, contentDigest };
}
export async function writeServiceSource(ctx: PeMutationContext, raw: unknown) {
  requireServiceProfile();
  const input = WriteSourceSchema.parse(raw), body = SourceBodySchema.parse(input.body), actor = principal(ctx);
  return serviceTx(ctx, async (c, db) => {
    if (body.scope.tenantId !== ctx.auth.tenantId || body.scope.workId !== input.workId) throw unavailable();
    if (body.schema === "finnor.service-provider-evidence.v1") {
      if (body.reportingPrincipalId !== actor || body.providerId !== actor) throw Error("W3_PROVIDER_SELF_AUTHORSHIP_REQUIRED");
      if (body.scope.principalId !== actor) {
        if (!input.protocolId) throw unavailable();
        const protocol = (await c.query<{ operational_disclosure: { scope: unknown }; purpose: string }>(`SELECT operational_disclosure,purpose
         FROM finnor_os.w3_participant_protocols WHERE tenant_id=$1 AND id=$2 AND participant_id=$3
          AND provider_id=$3 AND role='PROVIDER' AND permitted_kinds ? 'PROVIDER_EVIDENCE'
          AND consent_at IS NOT NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
        [ctx.auth.tenantId, input.protocolId, actor])).rows[0];
        if (!protocol || canonical(protocol.operational_disclosure.scope) !== canonical(body.scope)
          || protocol.purpose !== input.purpose) throw unavailable();
      } else await authorizeServiceWork(ctx, input.workId, c);
    } else {
      await authorizeServiceWork(ctx, input.workId, c);
      if (body.scope.principalId !== actor) throw unavailable();
      if (body.schema === "finnor.service-qualification.v1" && body.verifiedByPrincipalId !== actor)
        throw Error("W3_QUALIFICATION_AUTHENTICATED_AUTHOR_REQUIRED");
    }
    const source = await persistServiceSource(ctx, { ...input, ownerId: body.scope.principalId, private: true }, c, db);
    if (input.protocolId && body.schema === "finnor.service-provider-evidence.v1")
      await c.query("SELECT finnor_os.w3_wake_from_source($1,$2,$3,$4,true)",
        [input.protocolId, source.sourceId, source.versionId, source.contentDigest]);
    if (body.schema === "finnor.service-native-execution.v1") {
      const rows = (await c.query<ServiceRequestRow>(`UPDATE finnor_os.w3_service_requests
       SET wake_revision=wake_revision+1,updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND business_assignment_id=$4
        AND status NOT IN('CANCELLED','INVALIDATED','FAILED') RETURNING *`,
      [ctx.auth.tenantId, actor, input.workId, body.scope.businessAssignmentId])).rows;
      for (const row of rows) await enqueueService(c, row, false);
    }
    return { source, classification: "CONTROLLED", authorshipOnly: true, physicalTruthEstablished: false };
  });
}
export async function enqueueService(c: PoolClient, row: ServiceRequestRow, compile: boolean) {
  const payload: ServiceJobPayload = {
    tenantId: row.tenant_id, principalId: row.principal_id, requestId: row.id,
    generation: row.generation, wakeRevision: Number(row.wake_revision),
  };
  await c.query(`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety)
   VALUES($1,$2,$3::jsonb,$4,'interactive',1,$5) ON CONFLICT(idempotency_key) DO NOTHING`,
  [row.tenant_id, compile ? "compile_real_world_service_v1" : "advance_real_world_service_v1", canonical(payload),
    `w3:${row.id}:${row.generation}:${row.wake_revision}:${compile}`, compile ? "locally_idempotent" : "reconcilable"]);
}
export async function submitServiceOutcome(ctx: PeMutationContext, raw: unknown) {
  requireServiceProfile();
  const input = SubmitServiceSchema.parse(raw), identity = await serviceIdentity();
  return serviceTx(ctx, async (c, db) => {
    const work = await authorizeServiceWork(ctx, input.workId, c);
    if (["completed", "cancelled", "failed"].includes(work.status)) throw Error("W3_CURRENT_ORIGINAL_WORK_REQUIRED");
    const currentInput = (await c.query<{ id: string }>(`SELECT id FROM finnor_os.work_inputs
     WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
    [ctx.auth.tenantId, input.workId])).rows[0];
    if (currentInput?.id !== input.workInputId) throw Error("W3_WORK_INPUT_CHANGED");
    const source = await sourceOriginal(ctx, input.workId, input.outcomeSource, c);
    const outcome = OutcomeContractSchema.parse(JSON.parse(source.content));
    if (source.author_id !== principal(ctx) || outcome.scope.workId !== input.workId
      || outcome.scope.tenantId !== ctx.auth.tenantId || outcome.scope.principalId !== principal(ctx))
      throw Error("W3_ORIGINAL_SCOPE_MISMATCH");
    const budget = await readEnterpriseDurableObligation(ctx, input.budgetObligationRef);
    if (canonical(budget.allocationRef) !== canonical(outcome.parentAllocation)
      || canonical(budget.policyRef) !== canonical(outcome.parentPolicy)
      || budget.workLineage?.workId !== input.workId || budget.workLineage.workInputId !== input.workInputId)
      throw Error("W3_ORIGINAL_WORK_POLICY_ALLOCATION_REQUIRED");
    const digest = hash(input);
    const existing = (await c.query<ServiceRequestRow>(`SELECT * FROM finnor_os.w3_service_requests
     WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3 FOR UPDATE`,
    [ctx.auth.tenantId, principal(ctx), input.idempotencyKey])).rows[0];
    if (existing) {
      if (existing.request_digest !== digest) throw Error("W3_IDEMPOTENCY_CONFLICT");
      return { requestId: existing.id, status: existing.status, semanticReplay: true, executionAuthorityGranted: false };
    }
    const row = (await c.query<ServiceRequestRow>(`INSERT INTO finnor_os.w3_service_requests
     (id,tenant_id,principal_id,company_id,work_id,work_input_id,business_assignment_id,idempotency_key,
      request_digest,outcome_ref,provider_refs,mandate_ref,parent_policy,parent_allocation,budget_obligation_ref,
      s7_estimand_id,identity,rights_revision,original_deadline,compile_deadline)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,
      $16,$17::jsonb,$18,$19,LEAST($19::timestamptz,clock_timestamp()+interval '3600 seconds')) RETURNING *`,
    [randomUUID(), ctx.auth.tenantId, principal(ctx), outcome.scope.companyId, input.workId, input.workInputId,
      outcome.scope.businessAssignmentId, input.idempotencyKey, digest, canonical(input.outcomeSource),
      canonical(input.providerSources), canonical(outcome.mandateSource), canonical(outcome.parentPolicy),
      canonical(outcome.parentAllocation), canonical(input.budgetObligationRef), input.s7EstimandId,
      canonical(identity), work.revision, outcome.originalDeadlineAt])).rows[0]!;
    await loadOutcome(ctx, row, c);
    // A completed S6 transport is not a completed service. Occupy the existing
    // Work owner interface atomically, before any transport can be scheduled.
    await c.query(`INSERT INTO finnor_os.work_programme_occupations
     (tenant_id,work_id,owner,programme_id,status,revision)
     VALUES($1,$2,'POSTZ.W3',$3,'PROGRESS',1)`, [row.tenant_id, row.work_id, row.id]);
    await enqueueService(c, row, true);
    await transitionWorkTx(db, row.tenant_id, row.work_id, "executing", "real_world_service_submitted",
      { requestId: row.id, originalBusinessAssignments: 1, originalDeadlineAt: outcome.originalDeadlineAt,
        evidenceClass: "CONTROLLED", executionAuthorityGranted: false }, { expectedWorkInputId: row.work_input_id });
    return { requestId: row.id, status: row.status, semanticReplay: false, executionAuthorityGranted: false };
  });
}
export async function currentServiceCut(ctx: PeMutationContext, row: ServiceRequestRow, c: PoolClient) {
  const work = await authorizeServiceWork(ctx, row.work_id, c);
  if (work.status === "cancelled"
    || ["CANCELLED", "INVALIDATED", "FAILED"].includes(row.status)) throw Error("W3_ORIGINAL_AUTHORITY_OR_WORK_REVOKED");
  const currentInput = (await c.query<{ id: string }>(`SELECT id FROM finnor_os.work_inputs
   WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
  [ctx.auth.tenantId, row.work_id])).rows[0];
  if (currentInput?.id !== row.work_input_id) throw Error("W3_WORK_INPUT_CHANGED");
  if (Date.now() >= row.original_deadline.getTime()) throw Error("W3_ORIGINAL_DEADLINE_EXPIRED_RESPONSIBILITY_RETAINED");
  if (canonical(await serviceIdentity()) !== canonical(row.identity)) throw Error("W3_METHOD_CHECKER_RUNTIME_CHANGED");
  const outcome = await loadOutcome(ctx, row, c), providers = await loadProviders(ctx, row, c);
  return { outcome, providers };
}
export async function serviceArtifact(ctx: PeMutationContext, row: ServiceRequestRow, c: PoolClient) {
  if (!row.artifact_id) return null;
  const artifact = (await c.query<{ id: string; body: RealWorldServiceProgram; body_digest: string; check_result: ProgramCheck }>(`SELECT *
   FROM finnor_os.w3_service_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND request_id=$4`,
  [ctx.auth.tenantId, principal(ctx), row.artifact_id, row.id])).rows[0];
  if (!artifact || hash(artifact.body) !== artifact.body_digest || artifact.check_result.candidateDigest !== artifact.body_digest
    || artifact.check_result.disposition !== "CHECKED_DEVELOPMENT") throw Error("W3_CHECKED_ARTIFACT_UNAVAILABLE");
  return artifact;
}
