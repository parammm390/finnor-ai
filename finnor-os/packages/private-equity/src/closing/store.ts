import { verify } from "node:crypto";
import {assertEvidenceRunTransactionCurrent} from '../evidence-execution/consumer';
import type { PoolClient } from "pg";
import type { Db } from "@finnor/db";
import { appendEvidenceVersionTx, createEvidenceSourceTx } from "@finnor/memory";
import { ClosingObservationSchema, type ClosingObservation, type ClosingProjection, type VerifiedClosedTransaction } from "@finnor/shared-types";
import type { PeMutationContext } from "../types";
import { authorize, principal, revisions, sameRevisions, closingTx as tx } from "../owner-context";
import { ClosingError, ClosingProfileSchema, type ClosingProgrammeRow, type ClosingProfile } from "./contracts";
import { closingCanonical, closingDigest } from "./compiler";

export async function closingProgramme(ctx: PeMutationContext, id: string, c?: PoolClient, lock = false): Promise<ClosingProgrammeRow> {
  const read = async (client: PoolClient) => {
    const q = (await client.query<ClosingProgrammeRow>(
      "SELECT * FROM finnor_os.pe_closing_programmes WHERE tenant_id=$1 AND id=$2" + (lock ? " FOR UPDATE" : ""),
      [ctx.auth.tenantId, id],
    )).rows[0];
    if (!q) throw new ClosingError("CLOSING_RESOURCE_UNAVAILABLE", 404);
    return q;
  };
  const q = c ? await read(c) : await tx(ctx, read, true);
  await authorize(ctx, { entityType: "pe_deal", entityId: q.transaction_id }, [{ type: "work", id: q.work_id }]);
  return q;
}
export async function closingProfile(ctx: PeMutationContext, q: Pick<ClosingProgrammeRow, "profile_id" | "profile_digest" | "spec">, responsibilityOnly = false) {
  const row = await tx(ctx, async c => (await c.query(
    "SELECT * FROM finnor_os.pe_closing_profiles WHERE tenant_id=$1 AND id=$2", [ctx.auth.tenantId, q.profile_id],
  )).rows[0], true);
  if (!row || !responsibilityOnly && (row.status !== "ACTIVE" || new Date(row.valid_until).getTime() <= Date.now())
      || row.digest !== q.profile_digest) throw new ClosingError("CLOSING_PROFILE_REVOKED_CHANGED_OR_EXPIRED");
  const profile = ClosingProfileSchema.parse(row.body);
  const { admission: _admission, ...preimage } = profile;
  if (closingDigest(preimage) !== row.digest || profile.environment !== q.spec.environment) throw new ClosingError("CLOSING_PROFILE_PREIMAGE_OR_ENVIRONMENT_CHANGED");
  return profile;
}
export async function closingEvent(ctx: PeMutationContext, q: ClosingProgrammeRow, kind: string, body: unknown, c?: PoolClient, idempotencyKey?: string) {
  const write = (client: PoolClient) => client.query(
    "INSERT INTO finnor_os.pe_closing_events(tenant_id,programme_id,generation,kind,body,idempotency_key) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(tenant_id,programme_id,idempotency_key) DO NOTHING",
    [ctx.auth.tenantId, q.id, q.generation, kind, closingCanonical(body), idempotencyKey ?? null],
  );
  return c ? write(c) : tx(ctx, write);
}
export async function enqueueClosing(ctx: PeMutationContext, q: ClosingProgrammeRow, reason: string, c?: PoolClient, delayMs = 0) {
  const write = (client: PoolClient) => client.query(
    "INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety,run_at) VALUES($1,'advance_closing_programme_v1',$2::jsonb,$3,'interactive',1,'durably_effect_guarded',clock_timestamp()+$4::int*interval '1 millisecond') ON CONFLICT(idempotency_key) DO NOTHING",
    [q.tenant_id, closingCanonical({ tenantId: q.tenant_id, programmeId: q.id, generation: q.generation }),
      `v3:${q.id}:${q.generation}:${reason}`, delayMs],
  );
  return c ? write(c) : tx(ctx, write);
}
export async function assertClosingCurrent(ctx: PeMutationContext, q: ClosingProgrammeRow, c?: PoolClient) {
  await authorize(ctx, { entityType: "pe_deal", entityId: q.transaction_id }, [{ type: "work", id: q.work_id }]);
  const profile = await closingProfile(ctx, q);
  const read = async (client: PoolClient) => {
    const work = (await client.query("SELECT id,status,current_owner_id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE", [q.tenant_id, q.work_id])).rows[0];
    if (!work || work.status === "cancelled" || work.current_owner_id !== q.principal_id) throw new ClosingError("CLOSING_CANONICAL_WORK_OWNER_CHANGED_OR_CANCELLED");
    const input = (await client.query("SELECT id,to_jsonb(w) body FROM finnor_os.work_inputs w WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [q.tenant_id, q.work_id])).rows[0];
    const actor = (await client.query("SELECT status,role FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 FOR SHARE", [q.tenant_id, q.principal_id])).rows[0];
    const auth = (await client.query("SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1 FOR SHARE", [q.tenant_id])).rows[0];
    if (actor?.status !== "active" || actor.role !== "owner" || Number(auth?.revision ?? 1) !== q.authority_revision) throw new ClosingError("CLOSING_AUTHORITY_REVOKED_OR_CHANGED");
    if (input?.id !== q.work_input_id || closingDigest(input.body) !== q.work_input_digest) throw new ClosingError("CLOSING_EXACT_WORK_INPUT_CHANGED");
    const reviewedAcquisition=(await client.query("SELECT 1 FROM finnor_os.outcome_pack_runs WHERE tenant_id=$1 AND work_id=$2 AND input ? 'acquisitionRequest'",[q.tenant_id,q.work_id])).rowCount;
    if(reviewedAcquisition){
      const intake=(await client.query("SELECT body->'acquisitionApproval' approval FROM finnor_os.pe_closing_events WHERE tenant_id=$1 AND programme_id=$2 AND kind='LEGAL_SPEC_INTAKE' AND idempotency_key='legal-intake'",[q.tenant_id,q.id])).rows[0];
      if(!intake?.approval?.icCaseId||!intake.approval.acquisition?.runId||!q.dependency_pins.some(d=>d.key==='ic-approval:'+intake.approval.icCaseId))throw new ClosingError("CLOSING_REVIEWED_ACQUISITION_APPROVAL_REQUIRED",409);
      await assertEvidenceRunTransactionCurrent(client,q.tenant_id,intake.approval.acquisition.runId);
    }
    const pins = await revisions(ctx, q.dependency_pins.map(p => p.key), client, true);
    if (!sameRevisions(q.dependency_pins, pins)) throw new ClosingError("CLOSING_SOURCE_RIGHTS_OR_SPEC_DEPENDENCY_CHANGED");
    if (q.plan_revision_id) {
      const plan = (await client.query("SELECT status,work_input_id FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND id=$2 FOR SHARE", [q.tenant_id, q.plan_revision_id])).rows[0];
      if (!plan || !["active", "completed"].includes(plan.status) || plan.work_input_id !== q.work_input_id) throw new ClosingError("CLOSING_CANONICAL_PLAN_SUPERSEDED");
    }
    if (q.original_deadline_at.getTime() <= Date.now()) throw new ClosingError("CLOSING_ORIGINAL_DEADLINE_EXPIRED");
    if (q.stopped_at) throw new ClosingError("CLOSING_FUTURE_EXECUTION_STOPPED");
    if (["CLOSED", "REOPENED", "FAILED"].includes(q.status)) throw new ClosingError("CLOSING_TERMINAL_PROGRAMME_HAS_NO_NEW_EFFECT_AUTHORITY");
  };
  if (c) await read(c); else await tx(ctx, read);
  return profile;
}

export function verifyClosingObservation(o: ClosingObservation, profile: ClosingProfile,
  q: Pick<ClosingProgrammeRow, "tenant_id" | "transaction_id" | "spec_digest" | "approved_terms_revision" | "spec">, responsibilityOnly = false) {
  const issuer = profile.issuers.find(i => i.id === o.issuerId), { signature, ...body } = o;
  let valid = false;
  try { valid = Boolean(issuer && verify(null, Buffer.from(closingCanonical(body)), issuer.publicKeyPem, Buffer.from(signature, "base64"))); } catch { /* Fail closed. */ }
  const now = Date.now();
  if (!valid || !issuer || issuer.status !== "ACTIVE" || issuer.actorId !== o.actorId
      || issuer.environment !== q.spec.environment || !issuer.kinds.includes(o.kind) || !issuer.channels.includes(o.channel)
      || Date.parse(issuer.validUntil) <= (responsibilityOnly ? Date.parse(o.observedAt) : now)
      || Date.parse(o.validUntil) <= (responsibilityOnly ? Date.parse(o.observedAt) : now) || Date.parse(o.observedAt) > now
      || o.tenantId !== q.tenant_id || o.transactionId !== q.transaction_id || o.specDigest !== q.spec_digest
      || o.approvedTermsRevision !== q.approved_terms_revision
      || (["PROFESSIONAL_CONDITION", "LEGAL_EFFECTIVENESS", "LEGAL_SPEC_ACCEPTANCE"].includes(o.kind)
        && (!o.professionalScope || !issuer.qualifiedScopes.includes(o.professionalScope)))) {
    throw new ClosingError("CLOSING_OBSERVATION_SIGNATURE_IDENTITY_ROLE_SCOPE_OR_REVISION_INVALID");
  }
}
export async function appendClosingObservationTx(ctx: PeMutationContext, q: ClosingProgrammeRow, o: ClosingObservation,
  profile: ClosingProfile, c: PoolClient, db: Db, authenticatedProfessional = false, wake = true, responsibilityOnly = false) {
  verifyClosingObservation(o, profile, q, responsibilityOnly);
  if (authenticatedProfessional && o.actorId !== principal(ctx)) throw new ClosingError("CLOSING_PROFESSIONAL_CANNOT_IMPERSONATE_ANOTHER_ACTOR", 403);
    await c.query("SELECT id FROM finnor_os.pe_closing_programmes WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [q.tenant_id, q.id]);
    if (responsibilityOnly) {
      const original = (await c.query(
        "SELECT node_key FROM finnor_os.pe_closing_node_links WHERE tenant_id=$1 AND programme_id=$2 AND business_effect_id::text=$3",
        [q.tenant_id, q.id, o.claims.businessEffectId],
      )).rows[0];
      const step = q.spec.steps.find(s => s.key === original?.node_key);
      const requirement = [q.spec.documents, q.spec.funding, q.spec.fundsFlows, q.spec.rightsTransfers, q.spec.legalEffectiveness]
        .flatMap(rs => rs.filter(r => r.key === step?.requirementKey))[0];
      if (!step || !requirement || o.requirementKey !== requirement.key || o.kind !== requirement.evidence.kind
          || o.predicateDigest !== requirement.evidence.predicateDigest
          || !requirement.evidence.issuerIds.includes(o.issuerId) || !requirement.evidence.channels.includes(o.channel)) {
        throw new ClosingError("CLOSING_HISTORICAL_OBSERVATION_REQUIRES_EXACT_ORIGINAL_OPERATION");
      }
    }
    const duplicate = (await c.query(
      "SELECT v.source_id,v.id,v.version_number,v.content_hash,v.content FROM finnor_os.evidence_source_versions v JOIN finnor_os.pe_closing_evidence_bindings b ON b.tenant_id=v.tenant_id AND b.source_id=v.source_id WHERE b.tenant_id=$1 AND b.programme_id=$2 AND v.snapshot->'closingObservation'->>'factId'=$3",
      [q.tenant_id, q.id, o.factId],
    )).rows[0];
    if (duplicate) {
      if (duplicate.content !== closingCanonical(o)) throw new ClosingError("CLOSING_FACT_IDEMPOTENCY_CONFLICT", 409);
      return { sourceId: duplicate.source_id as string, versionId: duplicate.id as string,
        versionNumber: duplicate.version_number as number, contentHash: duplicate.content_hash as string, appended: false };
    }
    const actor = (await c.query("SELECT status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 FOR SHARE", [q.tenant_id, o.actorId])).rows[0];
    if (!responsibilityOnly && actor?.status !== "active") throw new ClosingError("CLOSING_EVIDENCE_ACTOR_REVOKED", 403);
    const source = await createEvidenceSourceTx(db, q.tenant_id, {
      sourceKey: `v3:${q.transaction_id}:${q.spec_digest}:${o.requirementKey}:${o.issuerId}:${o.channel}`,
      sourceType: "independently_signed_closing_observation",
      title: `Closing evidence: ${o.requirementKey}`,
      metadata: { transactionId: q.transaction_id, requirementKey: o.requirementKey, issuerId: o.issuerId, environment: q.spec.environment },
    });
    const version = await appendEvidenceVersionTx(db, q.tenant_id, source.id, {
      content: closingCanonical(o), snapshot: { closingObservation: o },
      asOf: new Date(o.observedAt),
      entityRefs: [{ type: "pe_deal", id: q.transaction_id }],
    });
    await c.query("INSERT INTO finnor_os.pe_closing_evidence_bindings(tenant_id,programme_id,source_id,requirement_key) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [q.tenant_id, q.id, source.id, o.requirementKey]);
    await closingEvent(ctx, q, "INDEPENDENT_SOURCE_OBSERVATION", {
      factId: o.factId, requirementKey: o.requirementKey, sourceRef: version, environment: q.spec.environment,
      promotionClaimed: false, humanSeconds: null, costUsd: null,
    }, c, `fact:${o.factId}`);
    if (wake) await enqueueClosing(ctx, q, `evidence:${version.versionId}`, c);
    return { ...version, appended: true };
}
export async function appendClosingObservation(ctx: PeMutationContext, programmeId: string, body: unknown, authenticatedProfessional = false, responsibilityOnly = false) {
  const q = await closingProgramme(ctx, programmeId), o = ClosingObservationSchema.parse(body), profile = await closingProfile(ctx, q, responsibilityOnly);
  return tx(ctx, (c, db) => appendClosingObservationTx(ctx, q, o, profile, c, db, authenticatedProfessional, true, responsibilityOnly));
}

export async function readClosingProgramme(ctx: PeMutationContext, id: string): Promise<ClosingProjection> {
  const q = await closingProgramme(ctx, id);
  return tx(ctx, async c => {
    const check = (await c.query("SELECT id,programme_id,spec_digest,accepted,body,checker_digest,observation_cut_digest,valid_until FROM finnor_os.pe_closing_checks WHERE tenant_id=$1 AND id=$2", [q.tenant_id, q.last_check_id])).rows[0] ?? null;
    const certificate = (await c.query<{ id: string; body: VerifiedClosedTransaction; post_publication_cut_digest: string }>("SELECT * FROM finnor_os.pe_closed_transaction_certificates WHERE tenant_id=$1 AND programme_id=$2", [q.tenant_id, q.id])).rows[0] ?? null;
    const cut = (await c.query("WITH cut AS MATERIALIZED(SELECT finnor_os.pe_closing_cut($1,$2) body) SELECT body,encode(sha256(convert_to(body::text,'UTF8')),'hex') digest FROM cut", [q.tenant_id, q.id])).rows[0];
    const physicalClose = (await c.query("SELECT status FROM finnor_os.pe_deals WHERE tenant_id=$1 AND id=$2", [q.tenant_id, q.transaction_id])).rows[0]?.status === "closed";
    let status = q.status;
    const publicationProof = certificate && certificate.body.transactionIdentity.tenantId === q.tenant_id
      && certificate.body.transactionIdentity.transactionId === q.transaction_id
      && certificate.body.transactionIdentity.workId === q.work_id
      && certificate.body.closingSpecRef.contentDigest === q.spec_digest
      && certificate.body.programmeRef.id === q.id && physicalClose
      && check?.accepted && check.programme_id === q.id && check.spec_digest === q.spec_digest
      && certificate.body.receiptAndCurrentness.checkId === check.id;
    if (status === "CLOSED" && !publicationProof) status = "BLOCKED";
    if (certificate && status === "CLOSED" && (cut.digest !== certificate.post_publication_cut_digest
        || !check || new Date(check.valid_until).getTime() <= Date.now())) {
      status = "REOPENED";
      await c.query("UPDATE finnor_os.pe_closing_programmes SET status='REOPENED',reason='MATERIAL_CURRENTNESS_CORRECTION',generation=generation+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND status='CLOSED'", [q.tenant_id, q.id]);
      await closingEvent(ctx, q, "REOPENED", { historicalCertificateId: certificate.id, priorCut: certificate.post_publication_cut_digest, currentCut: cut.digest, effectsAndLiabilitiesRetained: true }, c);
    }
    const checkCurrent = check && new Date(check.valid_until).getTime() > Date.now()
      && (check.observation_cut_digest === cut.digest
        || status === "CLOSED" && certificate && certificate.body.receiptAndCurrentness.checkId === check.id
          && certificate.post_publication_cut_digest === cut.digest);
    const proven = new Set<string>(checkCurrent ? (check.body.verifiedOperationSettlements ?? []).map((o: { businessEffectId: string }) => o.businessEffectId) : []);
    const unresolved = cut.body.operations.filter((r: { operation: { business_effect_id: string }; invocations: Record<string, unknown>[] }) =>
      !proven.has(r.operation.business_effect_id) && r.invocations.some(i => i.closing_provider_egress_at));
    const budget = (await c.query("SELECT step_count,max_steps,action_count,max_actions,query_count,max_queries,deadline_at,state FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2", [q.tenant_id, q.work_id])).rows[0];
    const actions = (await c.query("SELECT a.id,a.status FROM finnor_os.domain_actions a JOIN finnor_os.pe_closing_node_links l ON l.tenant_id=a.tenant_id AND l.domain_action_id=a.id WHERE l.tenant_id=$1 AND l.programme_id=$2", [q.tenant_id, q.id])).rows;
    return {
      schema: "finnor.v3.closing-projection.v1", programmeId: q.id, transactionId: q.transaction_id,
      workId: q.work_id, workInputId: q.work_input_id, planRevisionId: q.plan_revision_id,
      specDigest: q.spec_digest, approvedTermsRevision: q.approved_terms_revision, status,
      spec: q.spec, graph: q.graph, check: check?.body ?? null, checkCurrent: Boolean(checkCurrent),
      certificate: certificate ? { id: certificate.id, historical: true, currentlyValid: status === "CLOSED" && Boolean(publicationProof), body: certificate.body } : null,
      pendingPredicates: check?.body?.reasons ?? ["INDEPENDENT_CLOSE_CHECK_PENDING"],
      unresolvedEffects: unresolved.map((r: Record<string, any>) => ({
        effectId: r.operation.business_effect_id, operationId: r.operation.id,
        programmeId: r.link.programme_id, nodeKey: r.link.node_key,
        status: "RECONCILIATION_REQUIRED" as const, nativeVerificationStatus: r.operation.verification_status,
        money: [...r.originalSpec.funding, ...r.originalSpec.fundsFlows].find((f: { key: string }) =>
          f.key === r.originalSpec.steps.find((s: { key: string }) => s.key === r.link.node_key)?.requirementKey)?.money ?? null,
        retryPermitted: false as const, reservationRetained: true as const,
      })),
      children: cut.body.children.map((r: Record<string, any>) => ({ nodeKey: r.link.node_key, actionId: r.action.id, actionStatus: actions.find(a => a.id === r.action.id)?.status ?? "unknown", effectId: r.effect?.id, effectStatus: r.effect?.status })),
      continuingDuties: cut.body.duties.map((r: Record<string, any>) => ({
        key: r.handoff.duty_key, taskId: r.task.id, ownerPrincipalId: r.handoff.body.ownerPrincipalId,
        dueAt: r.handoff.body.dueAt, liability: r.handoff.body.liability,
        taskStatus: r.task.status, obligationRef: r.handoff.body.obligationRef,
      })),
      nativeBudget: budget ? { stepCount: budget.step_count, maxSteps: budget.max_steps,
        actionCount: budget.action_count, maxActions: budget.max_actions, queryCount: budget.query_count,
        maxQueries: budget.max_queries, deadlineAt: new Date(budget.deadline_at).toISOString(), state: budget.state } : null,
      reason: q.status === "CLOSED" && !publicationProof ? "INDEPENDENT_CANONICAL_PUBLICATION_PROOF_REQUIRED" : q.reason, environment: q.spec.environment,
      qualification: { engineering: "REQUIRES_RUNTIME_PROOF", protectedAdmission: q.spec.environment === "DEVELOPMENT" ? "NOT_ADMITTED" : "INDEPENDENT_EXACT_RECEIPT_REQUIRED", liveCountsEligible: status === "CLOSED" && q.spec.environment === "LIVE", economicGain: "NOT_ESTABLISHED" },
      costs: { usd: null, status: "UNMETERED", financingPrincipalIsProfit: false },
    };
  });
}

export async function readVerifiedClosing(ctx: PeMutationContext, transactionId: string) {
  await authorize(ctx, { entityType: "pe_deal", entityId: transactionId });
  const latest = await tx(ctx, async c => {
    if (!(await c.query("SELECT to_regclass('finnor_os.pe_closing_programmes') ready")).rows[0]?.ready) {
      return { unavailable: true as const };
    }
    return (await c.query<{ id: string }>("SELECT id FROM finnor_os.pe_closing_programmes WHERE tenant_id=$1 AND transaction_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [ctx.auth.tenantId, transactionId])).rows[0];
  }, true);
  if (!latest) return { status: "NOT_REGISTERED" as const, specDigest: null, programme: null, reasons: ["ACCEPTED_CLOSING_SPEC_REQUIRED"] };
  if ("unavailable" in latest) return { status: "UNAVAILABLE" as const, specDigest: null, programme: null, reasons: ["V3_MIGRATION_NOT_INSTALLED"] };
  const programme = await readClosingProgramme(ctx, latest.id);
  return { status: programme.status, specDigest: programme.specDigest, programme,
    reasons: programme.pendingPredicates };
}
export async function closingProgrammesFor(ctx: PeMutationContext, filter: { workId?: string; transactionId?: string }) {
  if (!filter.workId && !filter.transactionId) throw new ClosingError("CLOSING_EXACT_ROOT_OR_WORK_REQUIRED", 400);
  const rows = await tx(ctx, async c => (await c.query<{ id: string }>(
    "SELECT id FROM finnor_os.pe_closing_programmes WHERE tenant_id=$1 AND ($2::uuid IS NULL OR work_id=$2) AND ($3::uuid IS NULL OR transaction_id=$3) ORDER BY created_at DESC LIMIT 21",
    [ctx.auth.tenantId, filter.workId ?? null, filter.transactionId ?? null],
  )).rows, true);
  if (rows.length > 20) throw new ClosingError("CLOSING_HISTORY_READ_BOUND_EXCEEDED", 413);
  const programmes = [];
  for (const r of rows) programmes.push(await readClosingProgramme(ctx, r.id));
  return programmes;
}
