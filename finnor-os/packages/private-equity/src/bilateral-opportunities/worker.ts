import { attachWorkEntityTx, reconcileWorkStatus } from "@finnor/db";
import { authorizeBeliefResources } from "../enterprise-beliefs";
import {
  BilateralTermsSchema, type BilateralTerms, type QualifiedBilateralOpportunity,
  type SignedBilateralCheck, type VReference, type PrimaryCostReceipt,
} from "@finnor/shared-types";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import type { PeMutationContext } from "../types";
import { bilateralMechanics, preliminaryBilateralFit, searchBilateralStructures } from "../../../epistemic-runtime/src/bilateral-mechanics";
import { bilateralContactPayload } from "../../../authority/src/bilateral-template";
import { checkRelationshipContact, relationshipLock, type ContactIntent } from "../../../authority/src/relationship-policy";
import { chooseBilateralNext } from "../enterprise-control";
import { createOpportunityTx, qualifyOpportunityTx } from "../world-repository";
import { ownerBindings, type OwnerBindings } from "./governance";
import { cpuCost, remainingGrant, reserve, settle } from "./costs";
import { independentCheck } from "./native";
import { acceptParticipantEvent, parseTransport, participantEvents, readInterface, storeObservationTx, validateSnapshot } from "./observations";
import {
  actor, assertClaim, assertDependencies, authorize, candidateDependencies, candidates, canonical, companyRecord,
  costs, enqueue, event, exactWork, hash, methodIdentity, newId, programme, reference, revisions, tx,
  type Candidate, type Programme, type FrozenManifest,
} from "./store";

const safe = (error: unknown) => String((error as Error).message).match(/^[A-Z][A-Z0-9_:]{0,159}$/)?.[0] ?? "BILATERAL_OWNER_PREDICATE_UNPASSED";
const terminalCandidates = new Set(["QUALIFIED", "DECLINED", "ALREADY_ACTIVE", "PREEXISTING_UNRESOLVED",
  "DISQUALIFIED", "EXPIRED", "STOPPED", "INVALIDATED", "ESCALATION_REQUIRED", "CHECK_REJECTED"]);
async function ownerLocks(c: import("pg").PoolClient, tenant: string) {
  await relationshipLock(c, tenant);
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["s5-portfolio:" + tenant]);
}
async function disposition(ctx: PeMutationContext, p: Programme, candidate: Candidate, state: string, reason: string) {
  await tx(ctx, async c => {
    await c.query("UPDATE finnor_os.v1_candidates SET disposition=$4,reason=$5 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [p.tenant_id, actor(ctx), candidate.id, state, reason]);
    await event(ctx, p, "S4", "CANDIDATE_DISPOSITION", { candidateId: candidate.id, disposition: state, reason,
      createdOpportunityCredit: state === "QUALIFIED" ? "INDEPENDENT_ARTIFACT_ONLY" : "NONE" }, c);
  });
}
async function progress(ctx: PeMutationContext, p: Programme, status: Programme["status"], reason: string,
  execution: Readonly<JobExecutionContext>, b?: OwnerBindings, schedule = false) {
  await tx(ctx, async c => {
    await ownerLocks(c, p.tenant_id);
    const current = await programme(ctx, p.id, c, true); await assertClaim(ctx, current, execution, c, true);
    if (current.revision !== p.revision) return;
    const next = ["WAITING", "RECONCILING", "BLOCKED"].includes(status) ?
      [reference("S4", p.id + ":continuation", p.revision, { reason, originalGrantRef: p.intake.budgetGrantRef,
        originalDeadline: b?.mandate.deadline ?? null, permissionToExecute: false })] : [];
    const approvals: VReference[] = [];
    if (status === "BLOCKED") {
      const body = { reason, originalMandate: p.intake.mandateRef, originalAuthority: p.intake.authorityProfileRef,
        originalGrant: p.intake.budgetGrantRef, designatedActorId: b?.authority.escalationActorId ?? null,
        ownerPacketRequired: true, approvalOrProfessionalReceiptGranted: false };
      const saved = await event(ctx, p, "S6", "CURRENT_ACTIVITY_OWNER_PACKET_REQUIRED", body, c);
      approvals.push(reference("S6", saved.rows[0].id, 1, body));
      const exact = (await c.query(`SELECT id,body FROM finnor_os.v1_events WHERE tenant_id=$1 AND principal_id=$2
        AND programme_id=$3 AND kind='EXACT_NEW_TERMS_AUTHORITY_REQUIRED' ORDER BY id LIMIT 64`,
      [p.tenant_id, actor(ctx), p.id])).rows;
      approvals.push(...exact.map(packet => reference("S6", packet.id, 1, packet.body)));
    }
    await c.query(`UPDATE finnor_os.v1_programmes SET status=$4,reason=$5,next_obligations=$6::jsonb,
      required_approvals=$7::jsonb,revision=revision+1,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
    [p.tenant_id, actor(ctx), p.id, status, reason, canonical(next), canonical(approvals)]);
    const updated = await programme(ctx, p.id, c);
    await event(ctx, updated, "S4", "DURABLE_PROGRESSION", { status, reason, nextObligationRefs: next,
      requiredApprovalRefs: approvals, originalGrantRef: p.intake.budgetGrantRef, deadlineReset: false }, c);
    if (["COMPLETE", "BLOCKED", "FAILED", "STOPPED"].includes(status)) {
      const expiry = (await c.query(`SELECT min((body->'validityAndExpiry'->>'expiresAt')::timestamptz) at
        FROM finnor_os.v1_artifacts a WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3
        AND NOT EXISTS(SELECT 1 FROM finnor_os.v1_events e WHERE e.tenant_id=a.tenant_id AND e.programme_id=a.programme_id
          AND e.kind='ORIGINAL_HANDOFF_VALIDITY_EXHAUSTED' AND e.body->>'artifactId'=a.id::text)`,
      [p.tenant_id, actor(ctx), p.id])).rows[0]?.at;
      if (expiry) await enqueue(ctx, updated, c, new Date(expiry));
    }
    if (schedule && b && Date.now() < Math.min(Date.parse(b.mandate.deadline), Date.parse(b.grant.originalProgrammeDeadline))) {
      const delay = status === "PROGRESS" ? 1000 : Math.min(10000, Math.max(1000, b.mandate.responseWaitMs / 10));
      await enqueue(ctx, updated, c, new Date(Date.now() + delay));
    }
  });
  await reconcileWorkStatus(p.tenant_id, p.work_id);
}
async function freeze(ctx: PeMutationContext, p: Programme, b: OwnerBindings, execution: Readonly<JobExecutionContext>): Promise<Programme> {
  const acquired = await readInterface(ctx, p, b, "SNAPSHOT"), signed = validateSnapshot(p, b, acquired.value);
  await authorizeBeliefResources(ctx, [{ type: "external_organization", id: b.mandate.buyerEntityId },
    ...signed.body.companies.flatMap(co => [{ type: "external_organization", id: co.companyId },
      { type: "external_contact", id: co.counterpartyId }])]);
  const identity = await methodIdentity(ctx);
  return tx(ctx, async (c, db) => {
    await ownerLocks(c, p.tenant_id);
    const current = await programme(ctx, p.id, c, true); await assertClaim(ctx, current, execution, c);
    if (current.frozen_manifest) return current;
    await ownerBindings(ctx, current, c);
    const snapshotRef = await storeObservationTx(ctx, p, b, c, db, "SNAPSHOT", "original-snapshot", signed);
    const pipeline = (await c.query<{ id: string; target: string; state: string; buyer: string | null }>(`
      SELECT id::text,target_organization_id::text target,state,buyer_entity_id::text buyer
      FROM finnor_os.pe_opportunities WHERE tenant_id=$1 AND target_organization_id=ANY($2::uuid[]) AND state<>'rejected'
      UNION ALL SELECT id::text,target_organization_id::text,'active' state,NULL buyer FROM finnor_os.pe_deals
      WHERE tenant_id=$1 AND target_organization_id=ANY($2::uuid[]) AND status='active' LIMIT 1025`,
    [p.tenant_id, p.intake.eligibleCompanyIds])).rows;
    if (pipeline.length > 1024) throw Error("S1_CANONICAL_PIPELINE_CENSUS_COVERAGE_BOUND");
    const buyer = (await c.query("SELECT to_jsonb(o) body FROM finnor_os.external_organizations o WHERE tenant_id=$1 AND id=$2",
      [p.tenant_id, b.mandate.buyerEntityId])).rows[0]?.body;
    if (!buyer) throw Error("S1_CANONICAL_BUYER_IDENTITY_UNAVAILABLE");
    const reservation = (await c.query(`SELECT p.problem FROM finnor_os.s5_reservations s JOIN finnor_os.s5_proposals p
      ON p.tenant_id=s.tenant_id AND p.content_digest=s.allocation_digest WHERE s.tenant_id=$1 AND s.reservation_id=$2`,
    [p.tenant_id, b.grant.reservationRef.id])).rows[0];
    const keys = ["rights:tenant", "work-inputs:" + p.work_id, "canonical:external_organization:" + b.mandate.buyerEntityId,
      ...[p.intake.mandateRef, p.intake.authorityProfileRef, p.intake.domainProfileRef, p.intake.budgetGrantRef,
        p.intake.sourceProfileRef, p.intake.relationshipPolicyRef].map(ref => "primary-governance:" + ref.id),
      ...reservation.problem.resources.map((r: { resourceId: string }) => "s5-resource:" + r.resourceId),
      "primary-reservation-authority:" + b.grant.reservationRef.id];
    const dependencies = (await revisions(ctx, keys, c, true)).map(d => ({ key: d.key, revision: d.revision }));
    const candidateDeps: FrozenManifest["candidateDependencies"] = {}, companyRefs: Record<string, VReference> = {}, personRefs: Record<string, VReference> = {};
    for (const company of signed.body.companies) {
      const org = (await c.query("SELECT to_jsonb(o) body FROM finnor_os.external_organizations o WHERE tenant_id=$1 AND id=$2",
        [p.tenant_id, company.companyId])).rows[0]?.body;
      const person = (await c.query("SELECT to_jsonb(o) body FROM finnor_os.external_contacts o WHERE tenant_id=$1 AND id=$2",
        [p.tenant_id, company.counterpartyId])).rows[0]?.body;
      if (!org || !person || person.external_organization_id !== company.companyId)
        throw Error("S1_INDEPENDENT_COMPANY_PERSON_CANONICAL_JOIN_UNAVAILABLE");
      companyRefs[company.companyId] = reference("S1", company.companyId, org.version ?? 1, org);
      personRefs[company.companyId] = reference("S1", company.counterpartyId, person.version ?? 1, person);
      const candidateId = newId(), dependencyKeys = ["canonical:external_organization:" + company.companyId,
        "canonical:external_contact:" + company.counterpartyId, "bilateral-participant:" + company.counterpartyId,
        "s6-relationship-identity:company:" + company.companyId, "s6-relationship-identity:person:" + company.counterpartyId];
      const companyDependencies = (await revisions(ctx, dependencyKeys, c, true)).map(d => ({ key: d.key, revision: d.revision }));
      candidateDeps[company.companyId] = companyDependencies;
      const already = pipeline.some(e => e.target === company.companyId && (!e.buyer || e.buyer === b.mandate.buyerEntityId)) ||
        signed.body.pipeline.entries.some(e => e.companyId === company.companyId && e.buyerEntityId === b.mandate.buyerEntityId &&
          !["rejected", "closed", "lost", "withdrawn", "cancelled", "archived"].includes(e.state));
      const eligible = company.identityStatus === "ESTABLISHED" && org.name === company.legalName &&
        ["OWNER", "AUTHORIZED_REPRESENTATIVE"].includes(company.role) && company.representationActivities.includes("CONSIDER_NONBINDING_TRANSACTION");
      const state = already ? "ALREADY_ACTIVE" : !eligible ? "DISQUALIFIED" : "PRELIMINARY";
      await c.query(`INSERT INTO finnor_os.v1_candidates(tenant_id,principal_id,programme_id,id,company_id,counterparty_id,disposition,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [p.tenant_id, actor(ctx), p.id, candidateId, company.companyId, company.counterpartyId,
        state, already ? "FROZEN_CANONICAL_OR_AUTHORITATIVE_PIPELINE_ALREADY_ACTIVE" : !eligible ? "INDEPENDENT_IDENTITY_OR_ROLE_UNESTABLISHED" : null]);
      for (const d of companyDependencies) await c.query(`INSERT INTO finnor_os.v1_dependencies
        (tenant_id,principal_id,programme_id,candidate_id,node_id,key,revision) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [p.tenant_id, actor(ctx), p.id, candidateId, "candidate:" + candidateId, d.key, d.revision]);
    }
    const cut = (await c.query("SELECT clock_timestamp() at")).rows[0].at.toISOString();
    const manifest: FrozenManifest = {
      knowledgeCut: cut, snapshot: signed, snapshotRef, canonicalPipeline: pipeline, companyRefs, counterpartyRefs: personRefs,
      buyerRef: reference("S1", buyer.id, buyer.version ?? 1, buyer), dependencies, candidateDependencies: candidateDeps,
      baselinePipelineDigest: hash({ independent: signed.body.pipeline, canonical: pipeline }),
      producerDigest: identity.producerDigest, lockDigest: identity.lockDigest, schemaDigest: identity.schemaDigest!,
      rightsRevision: b.rights.rightsRevision, eligibleCompanyIds: p.intake.eligibleCompanyIds, universeDefinition: p.intake.universeDefinition,
    };
    await c.query("UPDATE finnor_os.v1_programmes SET frozen_manifest=$4::jsonb,frozen_digest=$5 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [p.tenant_id, actor(ctx), p.id, canonical(manifest), hash(manifest)]);
    for (const d of dependencies) await c.query(`INSERT INTO finnor_os.v1_dependencies
      (tenant_id,principal_id,programme_id,node_id,key,revision) VALUES($1,$2,$3,'programme',$4,$5)`,
    [p.tenant_id, actor(ctx), p.id, d.key, d.revision]);
    await event(ctx, p, "S1", "ELIGIBLE_UNIVERSE_AND_PIPELINE_FROZEN", {
      frozenDigest: hash(manifest), knowledgeCut: cut, sourceKnowledgeCut: signed.body.knowledgeCut, snapshotRef,
      baselinePipelineDigest: manifest.baselinePipelineDigest, eligibleCompanyIds: p.intake.eligibleCompanyIds,
      existingAndDisqualifiedRecordsRetained: true, atomicAcrossExternalSystemsClaim: false,
    }, c);
    return programme(ctx, p.id, c);
  });
}
async function prepareTerms(ctx: PeMutationContext, p: Programme, candidate: Candidate, b: OwnerBindings, terms: BilateralTerms,
  basedOnEventId: string | null, execution: Readonly<JobExecutionContext>) {
  const reasons = [...bilateralMechanics(terms, b.mandate.bounds, b.mandate.buyerEntityId, b.mandate.currency),
    ...bilateralMechanics(terms, b.authority.negotiationBounds, b.mandate.buyerEntityId, b.mandate.currency)];
  if (terms.companyId !== candidate.company_id || reasons.length) {
    await event(ctx, p, "S6", "EXACT_NEW_TERMS_AUTHORITY_REQUIRED", { candidateId: candidate.id, requestedTerms: terms,
      originalBounds: b.mandate.bounds, reasons, originalAuthorityProfileRef: p.intake.authorityProfileRef,
      designatedActorId: b.authority.escalationActorId, basedOnParticipantEventId: basedOnEventId,
      approvalOrProfessionalReceiptGranted: false });
    await disposition(ctx, p, candidate, "ESCALATION_REQUIRED", "EXACT_NEW_TERMS_AUTHORITY_REQUIRED"); return false;
  }
  await tx(ctx, async c => {
    await ownerLocks(c, p.tenant_id);
    const current = await programme(ctx, p.id, c, true); await assertClaim(ctx, current, execution, c); await ownerBindings(ctx, current, c);
    const row = (await c.query("SELECT current_terms_id,revision FROM finnor_os.v1_candidates WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 FOR UPDATE",
      [p.tenant_id, actor(ctx), candidate.id])).rows[0];
    const old = row.current_terms_id ? (await c.query("SELECT digest FROM finnor_os.v1_terms WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [p.tenant_id, actor(ctx), row.current_terms_id])).rows[0] : null;
    if (old?.digest === hash(terms)) return;
    const revision = row.current_terms_id ? Number(row.revision) + 1 : 1;
    if (revision > b.mandate.maximumRevisionsPerCompany) throw Error("BILATERAL_ORIGINAL_STRUCTURE_REVISION_LIMIT_EXHAUSTED");
    const id = newId();
    await c.query(`INSERT INTO finnor_os.v1_terms(tenant_id,principal_id,programme_id,candidate_id,id,revision,body,digest,based_on_event_id)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`, [p.tenant_id, actor(ctx), p.id, candidate.id, id, revision, canonical(terms), hash(terms), basedOnEventId]);
    await c.query("SELECT finnor_os.p4_touch_source($1,$2)", [p.tenant_id, "bilateral-terms:" + candidate.id]);
    await c.query("UPDATE finnor_os.v1_candidates SET current_terms_id=$4,current_action_id=NULL,revision=$5,disposition=$6,reason=NULL WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [p.tenant_id, actor(ctx), candidate.id, id, revision, basedOnEventId ? "READY_TO_CONFIRM" : "PRELIMINARY"]);
    await event(ctx, p, "S4", "SUPPORTED_STRUCTURE_REVISION", { candidateId: candidate.id, termsRef: reference("V1", id, revision, terms),
      basedOnParticipantEventId: basedOnEventId, originalGrantRef: p.intake.budgetGrantRef, originalDeadline: b.mandate.deadline,
      managementContinuity: "PROPOSED_CONTRACTUAL_CONDITION_NOT_ACCOMPLISHED_FACT" }, c);
  });
  return true;
}
async function prepareContact(ctx: PeMutationContext, p: Programme, candidate: Candidate, b: OwnerBindings,
  kind: "INQUIRE" | "APPROACH" | "CONFIRM", execution: Readonly<JobExecutionContext>) {
  const prepared = await tx(ctx, async c => {
    await ownerLocks(c, p.tenant_id);
    const current = await programme(ctx, p.id, c, true); await assertClaim(ctx, current, execution, c); await ownerBindings(ctx, current, c);
    await assertDependencies(ctx, candidateDependencies(p, candidate.company_id).map(d => ({ ...d, nodeIds: [], digest: null })), c, true);
    const co = (await c.query("SELECT * FROM finnor_os.v1_candidates WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 FOR UPDATE",
      [p.tenant_id, actor(ctx), candidate.id])).rows[0] as Candidate;
    const terms = (await c.query("SELECT * FROM finnor_os.v1_terms WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [p.tenant_id, actor(ctx), co.current_terms_id])).rows[0];
    if (!terms) throw Error("BILATERAL_EXACT_CONTACT_TERMS_UNAVAILABLE");
    const previous = (await c.query("SELECT * FROM finnor_os.s6_contact_intents WHERE tenant_id=$1 AND programme_id=$2 AND candidate_id=$3 AND terms_revision=$4 AND kind=$5",
      [p.tenant_id, p.id, co.id, terms.revision, kind])).rows[0] as ContactIntent | undefined;
    if (previous) return previous;
    const person = (await c.query("SELECT business_email FROM finnor_os.external_contacts WHERE tenant_id=$1 AND id=$2 AND external_organization_id=$3",
      [p.tenant_id, co.counterparty_id, co.company_id])).rows[0];
    const sender = (await c.query("SELECT address FROM finnor_os.communication_identities WHERE tenant_id=$1 AND id=$2",
      [p.tenant_id, b.authority.communicationIdentityId])).rows[0];
    if (!person?.business_email || !sender?.address) throw Error("S6_INDEPENDENT_CANONICAL_CONTACT_ENDPOINT_OR_SENDER_UNAVAILABLE");
    const actionId = newId(), payload = bilateralContactPayload({ authority: b.authority, terms: terms.body, workId: p.work_id,
      programmeId: p.id, candidateId: co.id, counterpartyId: co.counterparty_id, actionId, revision: terms.revision, kind });
    const intent: ContactIntent = {
      id: newId(), tenant_id: p.tenant_id, principal_id: actor(ctx), work_id: p.work_id, programme_owner: "V1",
      programme_id: p.id, candidate_id: co.id, company_id: co.company_id, counterparty_id: co.counterparty_id,
      action_id: actionId, member_key: "primary", channel: "email", subject_keys: [],
      activity_binding: { authorityRef: p.intake.authorityProfileRef, termsRef: reference("V1", terms.id, terms.revision, terms.body),
        grantRef: p.intake.budgetGrantRef, sourceProfileRef: p.intake.sourceProfileRef,
        dependencies: candidateDependencies(p, co.company_id), recipientAddressDigest: hash(person.business_email.trim().toLowerCase()),
        senderAddressDigest: hash(sender.address.trim().toLowerCase()), originalDeadline: b.mandate.deadline },
      payload, payload_digest: hash(payload), terms_digest: terms.digest, terms_revision: terms.revision, kind,
      policy_id: b.policy.profileId, policy_revision: b.policy.revision, status: "INTENDED", possible_egress_at: null, created_at: new Date(),
    };
    intent.subject_keys = await checkRelationshipContact(c, p.tenant_id, intent, person.business_email);
    await reserve(ctx, p, b.grant, "v1-contact:" + actionId, "CONTACT", b.source.transportReadback.maximumContactMicroUsd, "0", c);
    await c.query(`INSERT INTO finnor_os.s6_contact_intents(tenant_id,id,principal_id,work_id,programme_owner,programme_id,
      candidate_id,company_id,counterparty_id,action_id,channel,subject_keys,activity_binding,payload,payload_digest,
      terms_digest,terms_revision,kind,policy_id,policy_revision) VALUES($1,$2,$3,$4,'V1',$5,$6,$7,$8,$9,'email',
      $10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18)`, [p.tenant_id, intent.id, actor(ctx), p.work_id, p.id, co.id,
      co.company_id, co.counterparty_id, actionId, intent.subject_keys, canonical(intent.activity_binding), canonical(payload),
      intent.payload_digest, terms.digest, terms.revision, kind, b.policy.profileId, b.policy.revision]);
    await c.query("UPDATE finnor_os.v1_candidates SET current_action_id=$4,disposition='AWAITING_DISPATCH',reason=NULL WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [p.tenant_id, actor(ctx), co.id, actionId]);
    await event(ctx, p, "S6", "EXACT_CONTACT_INTENDED", { actionRef: reference("S6", actionId, 1, payload),
      candidateId: co.id, termsRef: intent.activity_binding.termsRef, possibleEgress: false, humanApprovalInvented: false }, c);
    return intent;
  });
  await draftAndAuthorize(ctx, p, prepared);
}
async function draftAndAuthorize(ctx: PeMutationContext, p: Programme, intent: ContactIntent) {
  if (!["INTENDED", "AUTHORIZED"].includes(intent.status)) return;
  const { FinnorOrchestrator } = await import("@finnor/orchestration");
  const { authorizeStandingContact } = await import("../../../orchestration/src/standing-contact");
  const orchestrator = new FinnorOrchestrator();
  await orchestrator.draftKnownAction("send_message", intent.payload, p.tenant_id, {
    source: "V1:bilateral-programme", actionId: intent.action_id, workId: p.work_id, initiatedBy: actor(ctx),
    authorityContext: { principalId: actor(ctx), standingAuthorityRef: p.intake.authorityProfileRef, programmeId: p.id },
    reviewBeforeExecution: true,
  });
  await authorizeStandingContact(ctx.auth, intent.action_id);
}
async function observeContact(ctx: PeMutationContext, p: Programme, co: Candidate, b: OwnerBindings) {
  if (!co.current_action_id) return false;
  const intent = await tx(ctx, async c => (await c.query<ContactIntent>(
    "SELECT * FROM finnor_os.s6_contact_intents WHERE tenant_id=$1 AND action_id=$2", [p.tenant_id, co.current_action_id])).rows[0], true);
  if (!intent) throw Error("S6_ORIGINAL_CONTACT_INTENT_MISSING");
  if (["INTENDED", "AUTHORIZED"].includes(intent.status)) {
    if (!p.cancellation_requested_at) await draftAndAuthorize(ctx, p, intent);
    return false;
  }
  if (intent.status === "CANCELLED_BEFORE_DISPATCH") return true;
  const actual = await readInterface(ctx, p, b, "TRANSPORT_STATUS", co), signed = parseTransport(b, actual.value);
  const { observeBilateralTransport } = await import("../../../orchestration/src/bilateral-transport");
  const result = await observeBilateralTransport(ctx.auth, {
    publicKeyPem: b.source.responsePublicKeyPem, maximumAgeMs: b.source.transportReadback.maximumObservationAgeMs,
    validUntil: b.source.transportReadback.validUntil,
  }, signed);
  await event(ctx, p, "S6", "ORIGINAL_TRANSPORT_OUTCOME_OBSERVED", {
    actionId: co.current_action_id, signedObservationDigest: hash(signed), outcome: result.outcome,
    observationMeaning: b.source.transportReadback.meaning, retryAuthorized: false,
  });
  if (result.outcome !== "ACCEPTED") return false;
  if (!p.cancellation_requested_at && !p.invalidated) await tx(ctx, async (c, db) => {
    await storeObservationTx(ctx, p, b, c, db, "TRANSPORT_STATUS", "transport:" + signed.body.actionId + ":accepted", signed, co.company_id);
  });
  await settle(ctx, p, b.grant, { key: "v1-contact:" + co.current_action_id, kind: "CONTACT",
    microUsd: b.source.transportReadback.maximumContactMicroUsd, reservedMicroUsd: b.source.transportReadback.maximumContactMicroUsd,
    reasons: ["REGISTERED_DEVELOPMENT_TRANSPORT_TARIFF_NOT_PROVIDER_INVOICE",
      "SEPARATE_TRANSPORT_WORKER_CPU_AND_IDLE_CAPACITY_METER_GAP"] });
  await tx(ctx, c => c.query("UPDATE finnor_os.v1_candidates SET disposition='AWAITING_EVENT' WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND disposition='AWAITING_DISPATCH'",
    [p.tenant_id, actor(ctx), co.id]));
  return true;
}
async function publish(ctx: PeMutationContext, p: Programme, co: Candidate, b: OwnerBindings,
  signed: SignedBilateralCheck, execution: Readonly<JobExecutionContext>) {
  if (signed.body.result !== "ACCEPT" || !p.frozen_manifest) throw Error("S8_ALL_SIX_INDEPENDENT_CONJUNCTS_REQUIRED");
  const checked = signed.body, source = companyRecord(p, co.company_id), replies = await participantEvents(ctx, p, co);
  const interest = replies.find(r => r.signed.body.kind === "INTEREST" && r.signed.body.actionId === co.current_action_id &&
    r.signed.body.termsDigest === checked.termsRef.contentDigest);
  if (!interest || !interest.signed.body.nextStep) throw Error("S1_CHECKED_ORIGINAL_INTEREST_EVENT_UNAVAILABLE");
  const nextStep = interest.signed.body.nextStep;
  const companyRef = p.frozen_manifest.companyRefs[co.company_id], counterpartyRef = p.frozen_manifest.counterpartyRefs[co.company_id];
  if (!companyRef || !counterpartyRef) throw Error("S1_CHECKED_CANONICAL_IDENTITY_REFERENCE_UNAVAILABLE");
  const identity = await methodIdentity(ctx), currentCosts = await costs(ctx, p);
  await tx(ctx, async (c, db) => {
    await ownerLocks(c, p.tenant_id);
    const current = await programme(ctx, p.id, c, true); await assertClaim(ctx, current, execution, c);
    await ownerBindings(ctx, current, c); await exactWork(ctx, current, c);
    const row = (await c.query("SELECT * FROM finnor_os.v1_candidates WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 FOR UPDATE",
      [p.tenant_id, actor(ctx), co.id])).rows[0] as Candidate;
    if (row.artifact_id && row.disposition === "QUALIFIED") return;
    if (row.current_terms_id !== checked.termsRef.id || row.current_action_id !== co.current_action_id ||
      row.disposition === "DECLINED" || row.disposition === "INVALIDATED" || Date.now() >= Date.parse(checked.expiresAt))
      throw Error("S8_QUALIFICATION_RECEIPT_CURRENT_CANDIDATE_FENCED");
    await assertDependencies(ctx, candidateDependencies(p, co.company_id).map(d => ({ ...d, nodeIds: [], digest: null })), c, true);
    if (identity.producerDigest !== p.frozen_manifest!.producerDigest || identity.schemaDigest !== p.frozen_manifest!.schemaDigest)
      throw Error("S8_BILATERAL_LOADED_METHOD_OR_SCHEMA_CHANGED");
    const termsRow = (await c.query("SELECT * FROM finnor_os.v1_terms WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [p.tenant_id, actor(ctx), row.current_terms_id])).rows[0];
    const terms = BilateralTermsSchema.parse(termsRow.body);
    const intents = (await c.query("SELECT * FROM finnor_os.s6_contact_intents WHERE tenant_id=$1 AND programme_id=$2 AND candidate_id=$3 ORDER BY created_at",
      [p.tenant_id, p.id, co.id])).rows as ContactIntent[];
    if (intents.some(i => ["POSSIBLE_EGRESS", "UNKNOWN", "INTENDED", "AUTHORIZED"].includes(i.status)))
      throw Error("S6_MATERIAL_CONTACT_OUTCOME_OR_OCCUPATION_UNRECONCILED");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))", ["opportunity-company:" + p.tenant_id + ":" + co.company_id]);
    const existing = (await c.query(`SELECT id FROM finnor_os.pe_opportunities WHERE tenant_id=$1
      AND target_organization_id=$2 AND state<>'rejected' AND (buyer_entity_id=$3 OR buyer_entity_id IS NULL)
      UNION ALL SELECT id FROM finnor_os.pe_deals WHERE tenant_id=$1 AND target_organization_id=$2 AND status='active' LIMIT 1`,
    [p.tenant_id, co.company_id, b.mandate.buyerEntityId])).rows[0];
    if (existing) throw Error("CANONICAL_COMPANY_BUYER_OPPORTUNITY_ALREADY_ACTIVE");
    const opportunityId = newId();
    await createOpportunityTx(c, { ...ctx, provenance: { ...ctx.provenance, sourceSystem: "V1:independently-confirmed-bilateral" } },
      { id: opportunityId, strategyId: b.mandate.strategyId, targetOrganizationId: co.company_id, buyerEntityId: b.mandate.buyerEntityId,
        name: source.legalName + " bilateral opportunity", summary: "Development-confirmed nonbinding interest. Not underwritten, funded, legally effective or domain-admitted." });
    await qualifyOpportunityTx(c, ctx, opportunityId);
    await attachWorkEntityTx(db, { tenantId: p.tenant_id, workId: p.work_id,
      entity: { entityType: "pe_opportunity", entityId: opportunityId, source: "V1:immutable-qualified-handoff" } });
    const termsDeps = (await revisions(ctx, ["bilateral-terms:" + co.id], c, true)).map(d => ({ key: d.key, revision: d.revision }));
    const deps = [...candidateDependencies(p, co.company_id), ...termsDeps];
    const checkRef = reference("S8", checked.id, 1, signed), id = newId(), now = new Date().toISOString();
    const obligations = intents.map(i => reference("S6", i.action_id, 1, i.payload));
    const gaps = p.intake.underwritingGapAssertions.filter(a => a.semantics.legalEntityId === co.company_id);
    const preimage: Omit<QualifiedBilateralOpportunity, "contentDigest"> = {
      artifactId: id, artifactKind: "QualifiedBilateralOpportunity", schemaRevision: "finnor.v1.opportunity.v1",
      tenantRef: p.tenant_id, workRef: p.work_id, workRevision: p.work_input_id, producerDigest: identity.producerDigest,
      dependencyLockDigest: identity.lockDigest, admissionRef: null,
      baselineManifestRef: reference("V1", "baseline:bd43f7a31862f5528d87fa522816c4a7fb0c6e3a", 1,
        { baseCommit: "bd43f7a31862f5528d87fa522816c4a7fb0c6e3a", mainCommit: "517003a4396bc8101a90be4b425ee01de9446740", B_R: "NOT_ESTABLISHED" }),
      domainProfileRef: p.intake.domainProfileRef, mandateRef: p.intake.mandateRef,
      authorityProfileRef: p.intake.authorityProfileRef, budgetGrantRef: p.intake.budgetGrantRef,
      sourceRefs: [p.frozen_manifest!.snapshotRef, interest.ref], sourceRevisionVector: deps, rightsRevision: b.rights.rightsRevision,
      effectiveTime: checked.checkedAt, knowledgeTime: now, observationTime: interest.signed.body.observedAt,
      acceptedClaims: [checked.termsRef, interest.ref], unresolvedClaims: gaps.map(a => reference("V2", a.assertionId, a.revision, a)),
      contradictionRefs: [], independentCheckRefs: [checkRef, checked.checkerIdentity], effectObligationRefs: obligations,
      externalEventRefs: [interest.ref], costReceipts: currentCosts, humanInterventionReceipts: [],
      invalidationDependencies: deps, lifecycleEvents: [
        { state: "proposed", at: p.frozen_manifest!.knowledgeCut, evidenceRef: reference("V1", co.id, 1,
          { companyId: co.company_id, programmeId: p.id }) },
        { state: "development-verified", at: checked.checkedAt, evidenceRef: checkRef },
      ],
      opportunityId, companyRef, buyerEntityRef: p.frozen_manifest!.buyerRef, counterpartyRef,
      counterpartyRoleAndChannelEvidence: [source.companySource, source.roleSource],
      sourcingMandateRef: p.intake.mandateRef, baselinePipelineDigest: p.frozen_manifest!.baselinePipelineDigest,
      originationClass: source.origination === "PREEXISTING_PROCESS" ? "NEW_TO_FIRM_PREEXISTING_PROCESS"
        : source.origination === "NO_KNOWN_PROCESS_AT_CUT" ? "CREATED_BILATERAL" : "UNRESOLVED",
      priorRelationshipEvidence: source.priorRelationshipEvidence, originationEvidence: source.originationEvidence,
      communicatedTermsRevision: checked.termsRef, terms,
      confirmedInterestStatementAndSource: { statement: interest.signed.body.statement, source: interest.ref, participantEvent: interest.signed.body },
      preliminaryFitChecks: preliminaryBilateralFit(b.mandate, source, checked.checkedAt).map(f => ({ id: f.id, evidence: f.evidence!, status: "SUPPORTED" })),
      remainingUnderwritingGaps: gaps, indicationBindingStatus: "NONBINDING", agreedNextStep: nextStep,
      validityAndExpiry: { validFrom: checked.checkedAt, expiresAt: checked.expiresAt }, communicationObligationRefs: obligations,
      evidenceLabels: ["SOURCE_ASSERTED", "EXTERNALLY_CONFIRMED", "COMPUTATION_CHECKED"],
      environment: "DEVELOPMENT", qualification: "DEVELOPMENT_ACCEPTED_NOT_DOMAIN_ADMITTED", causalIncrementalCreation: "NOT_ESTABLISHED",
    };
    const artifact: QualifiedBilateralOpportunity = { ...preimage, contentDigest: hash(preimage) };
    await c.query(`INSERT INTO finnor_os.v1_artifacts(tenant_id,principal_id,programme_id,candidate_id,id,opportunity_id,body,digest)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [p.tenant_id, actor(ctx), p.id, co.id, id, opportunityId, canonical(artifact), hash(artifact)]);
    await c.query(`INSERT INTO finnor_os.work_programme_occupations(tenant_id,work_id,owner,programme_id,status,revision)
      VALUES($1,$2,'V1_HANDOFF',$3,'WAITING',1)`, [p.tenant_id, p.work_id, id]);
    for (const d of deps) await c.query(`INSERT INTO finnor_os.v1_dependencies
      (tenant_id,principal_id,programme_id,candidate_id,artifact_id,node_id,key,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [p.tenant_id, actor(ctx), p.id, co.id, id, "artifact:" + id, d.key, d.revision]);
    await c.query("UPDATE finnor_os.v1_candidates SET disposition='QUALIFIED',reason=NULL,artifact_id=$4 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [p.tenant_id, actor(ctx), co.id, id]);
    await c.query("UPDATE finnor_os.v1_programmes SET principal_artifact_id=COALESCE(principal_artifact_id,$4) WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [p.tenant_id, actor(ctx), p.id, id]);
    // Opportunity lifecycle history emits the canonical PE BusinessEvents.
    // V1 records its separate checked provenance on the immutable Work artifact.
    await event(ctx, p, "S8", "IMMUTABLE_CANONICAL_OPPORTUNITY_PUBLISHED", {
      artifactRef: reference("V1", id, 1, artifact), opportunityId, checkRef, countedIdentity: opportunityId,
      originationClass: artifact.originationClass, liveActivation: false, underwritingEstablished: false,
    }, c);
  });
}
export async function advanceBilateralProgrammeJob(payload: Record<string, unknown>, execution?: Readonly<JobExecutionContext>): Promise<void> {
  if (!execution || execution.protocolVersion !== 1 || typeof payload.tenantId !== "string" ||
    execution.tenantId !== payload.tenantId || typeof payload.principalId !== "string" ||
    typeof payload.programmeId !== "string" || typeof payload.revision !== "number")
    throw Error("ACTUAL_BILATERAL_QUEUE_CLAIM_REQUIRED");
  const ctx: PeMutationContext = { auth: { tenantId: payload.tenantId, userId: payload.principalId,
    employeeId: payload.principalId, role: "owner" }, provenance: { sourceSystem: "V1:durable-bilateral-worker", createdBy: payload.principalId } };
  let p = await programme(ctx, payload.programmeId);
  if (p.revision !== payload.revision) return;
  await tx(ctx, async c => {
    await ownerLocks(c, p.tenant_id);
    if ((await c.query("SELECT current_user AS role")).rows[0]?.role !== "finnor_worker")
      throw Error("S6_ACTUAL_BILATERAL_WORKER_CUSTODY_REQUIRED");
    const current = await programme(ctx, p.id, c, true);
    const claim = (await c.query(`SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2 AND status='running'
      AND claim_token=$3 AND claim_fence=$4 AND lease_expires_at>clock_timestamp()
      AND payload->>'principalId'=$5 AND payload->>'programmeId'=$6`,
      [p.tenant_id, execution.jobId, execution.claimToken, execution.claimFence, p.principal_id, p.id])).rows[0];
    if (!claim || current.revision !== payload.revision) throw Error("BILATERAL_CURRENT_JOB_REVISION_FENCED");
    await c.query("UPDATE finnor_os.v1_programmes SET active_claim_token=$4,active_claim_fence=$5 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [p.tenant_id, actor(ctx), p.id, execution.claimToken, execution.claimFence]);
    await event(ctx, p, "S6", "ACTUAL_QUEUE_CLAIM_STARTED", { jobId: execution.jobId, claimFence: execution.claimFence,
      workerId: execution.workerId, originalGrantRef: p.intake.budgetGrantRef }, c);
  });
  p.active_claim_token = execution.claimToken; p.active_claim_fence = execution.claimFence;
  if (["COMPLETE", "BLOCKED", "FAILED", "STOPPED"].includes(p.status) && p.principal_artifact_id) {
    await tx(ctx, async c => {
      await ownerLocks(c, p.tenant_id); await assertClaim(ctx, p, execution, c, true);
      const expired = (await c.query(`SELECT a.id FROM finnor_os.v1_artifacts a WHERE a.tenant_id=$1
        AND a.principal_id=$2 AND a.programme_id=$3 AND (a.body->'validityAndExpiry'->>'expiresAt')::timestamptz<=clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM finnor_os.v1_events e WHERE e.tenant_id=a.tenant_id AND e.programme_id=a.programme_id
          AND e.kind='ORIGINAL_HANDOFF_VALIDITY_EXHAUSTED' AND e.body->>'artifactId'=a.id::text)`,
      [p.tenant_id, actor(ctx), p.id])).rows;
      for (const a of expired) {
        await c.query(`UPDATE finnor_os.work_programme_occupations SET status='BLOCKED',revision=revision+1,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND owner='V1_HANDOFF' AND programme_id=$2 AND status='WAITING'`, [p.tenant_id, a.id]);
        await c.query("SELECT finnor_os.p4_touch_source($1,$2)", [p.tenant_id, "bilateral-artifact:" + a.id]);
        await event(ctx, p, "S1", "ORIGINAL_HANDOFF_VALIDITY_EXHAUSTED", { artifactId: a.id,
          originalGrantRef: p.intake.budgetGrantRef, newInterestOrAuthorityRequired: true, deadlineReset: false }, c);
      }
    });
    await reconcileWorkStatus(p.tenant_id, p.work_id);
    if (p.status === "COMPLETE") return;
  }
  if (["FAILED", "STOPPED"].includes(p.status)) {
    const pending = await tx(ctx, async c => (await c.query(`SELECT id FROM finnor_os.s6_contact_intents
      WHERE tenant_id=$1 AND programme_id=$2 AND status IN('POSSIBLE_EGRESS','UNKNOWN') LIMIT 1`, [p.tenant_id, p.id])).rows[0], true);
    if (!pending) return;
  }
  let bindings: OwnerBindings | undefined;
  const usage = process.resourceUsage(), start = performance.now(), nativeKey = "v1-orchestration:" + execution.jobId + ":" + execution.claimFence;
  let nativeHeld = "0", nativeReserved = false;
  try {
    try {
      if (["FAILED", "STOPPED"].includes(p.status)) throw Error("BILATERAL_TERMINAL_RESPONSIBILITY_ONLY");
      await authorize(ctx, p.root, p.work_id); bindings = await ownerBindings(ctx, p);
    }
    catch (error) {
      const intents = await tx(ctx, async c => (await c.query<ContactIntent>("SELECT * FROM finnor_os.s6_contact_intents WHERE tenant_id=$1 AND programme_id=$2",
        [p.tenant_id, p.id])).rows, true);
      if (!p.cancellation_requested_at && !intents.some(i => ["POSSIBLE_EGRESS", "UNKNOWN"].includes(i.status))) throw error;
      bindings = await ownerBindings(ctx, p, undefined, true);
    }
    if (!bindings.retained) {
      const micros = "5000000"; nativeHeld = cpuCost(bindings.grant, BigInt(micros));
      await reserve(ctx, p, bindings.grant, nativeKey, "ORCHESTRATION", nativeHeld, micros); nativeReserved = true;
    }
    if (!p.frozen_manifest && !p.cancellation_requested_at) p = await freeze(ctx, p, bindings, execution);
    if (p.cancellation_requested_at || bindings.retained) {
      await tx(ctx, async c => {
        await ownerLocks(c, p.tenant_id);
        await c.query("UPDATE finnor_os.s6_contact_intents SET status='CANCELLED_BEFORE_DISPATCH' WHERE tenant_id=$1 AND programme_id=$2 AND status IN('INTENDED','AUTHORIZED')",
          [p.tenant_id, p.id]);
      });
      let unresolved = false;
      for (const co of await candidates(ctx, p)) {
        const intent = co.current_action_id ? await tx(ctx, async c => (await c.query<ContactIntent>("SELECT * FROM finnor_os.s6_contact_intents WHERE tenant_id=$1 AND action_id=$2",
          [p.tenant_id, co.current_action_id])).rows[0], true) : null;
        if (intent && ["POSSIBLE_EGRESS", "UNKNOWN"].includes(intent.status)) {
          // Recovery cannot spend an expired data grant. Nonzero status cost
          // requires exact new recovery authority, while occupation survives.
          if (bindings.source.maximumReadMicroUsd !== "0") { unresolved = true; continue; }
          try { if (!await observeContact(ctx, p, co, bindings)) unresolved = true; } catch { unresolved = true; }
        }
        if (p.frozen_manifest && bindings.source.maximumReadMicroUsd === "0" &&
          Date.now() < Date.parse(bindings.source.retentionUntil)) {
          try {
            const late = await readInterface(ctx, p, bindings, "EVENTS", co);
            const events = (late.value as { events?: unknown[] }).events;
            if (!Array.isArray(events) || events.length > 128) throw Error("S1_LATE_PARTICIPANT_EVENT_BOUND");
            for (const value of events) await acceptParticipantEvent(ctx, p, bindings, value);
          } catch {
            await event(ctx, p, "S1", "LATE_ORIGINAL_OBSERVATION_UNAVAILABLE", { candidateId: co.id,
              noQualificationOrRedispatchPermitted: true });
          }
        }
      }
      await progress(ctx, p, unresolved ? "RECONCILING" : p.cancellation_requested_at ? "STOPPED" : "BLOCKED",
        unresolved ? "ORIGINAL_PHYSICAL_CONTACT_OUTCOME_UNRESOLVED" : p.cancellation_requested_at ? "CANCELLED_RESPONSIBILITY_RECONCILED_HISTORY_RETAINED"
          : "CURRENT_PERMISSION_UNAVAILABLE_ORIGINAL_RESPONSIBILITY_RETAINED", execution, bindings, unresolved);
      return;
    }
    const list = await candidates(ctx, p);
    // S4 explicitly records evidence-backed hypotheses. No seller-propensity
    // model, retirement stereotype or unsupported economic score is used.
    const choices: Parameters<typeof chooseBilateralNext>[0]["candidates"] = [];
    for (const co of list) {
      if (terminalCandidates.has(co.disposition)) continue;
      const original = companyRecord(p, co.company_id), fit = preliminaryBilateralFit(bindings.mandate, original, new Date().toISOString());
      if (co.current_action_id && !["READY_TO_CONFIRM"].includes(co.disposition)) {
        choices.push({ id: co.id, activity: "RECONCILE", eligible: true, requiredInformation: 6,
          costMicroUsd: bindings.source.maximumReadMicroUsd, delayMs: null }); continue;
      }
      const structures = searchBilateralStructures(bindings.mandate, original, p.frozen_manifest!.knowledgeCut);
      await event(ctx, p, "S4", "SOURCE_BOUND_FIT_AND_OBJECTIVES_HYPOTHESIS", {
        candidateId: co.id, sourceRef: p.frozen_manifest!.snapshotRef, preliminaryFit: fit.map(f => ({ id: f.id, status: f.status })),
        ownerObjectivesSource: original.ownerObjectives.source, feasibleStructureDigests: structures.map(hash),
        conditionalMechanicsOnly: true, inferredWillingnessToSell: false,
      });
      if (!structures.length) { await disposition(ctx, p, co, "ESCALATION_REQUIRED", "NO_SUPPORTED_STRUCTURE_WITHIN_ORIGINAL_OBJECTIVES_AND_AUTHORITY"); continue; }
      if (!co.current_terms_id) {
        if (!await prepareTerms(ctx, p, co, bindings, structures[0]!, null, execution)) continue;
        Object.assign(co, (await candidates(ctx, p)).find(row => row.id === co.id));
      }
      const activity = co.disposition === "READY_TO_CONFIRM" ? "CONFIRM" :
        fit.some(f => f.status !== "SUPPORTED") || original.ownerObjectives.majoritySaleConsidered === null ? "INQUIRE" : "APPROACH";
      choices.push({ id: co.id, activity, eligible: true, requiredInformation: activity === "CONFIRM" ? 4 : 3,
        costMicroUsd: bindings.source.transportReadback.maximumContactMicroUsd, delayMs: null });
    }
    const remaining = await remainingGrant(ctx, bindings.grant);
    const choice = chooseBilateralNext({ candidates: choices, ...remaining, at: new Date().toISOString(),
      deadline: new Date(Math.min(Date.parse(bindings.mandate.deadline), Date.parse(bindings.grant.originalProgrammeDeadline))).toISOString(), cancelled: false });
    await event(ctx, p, "S4", "REGISTERED_NEXT_ACTION_CHOSEN", { choice, originalGrantRef: p.intake.budgetGrantRef, remaining,
      originalDeadline: bindings.mandate.deadline, candidates: choices });
    if (!choice.selected) {
      const all = await candidates(ctx, p), accepted = all.filter(co => co.disposition === "QUALIFIED").length;
      const terminal = all.every(co => terminalCandidates.has(co.disposition));
      const escalation = all.some(co => co.disposition === "ESCALATION_REQUIRED");
      await progress(ctx, p, terminal ? escalation ? "BLOCKED" : accepted ? "COMPLETE" : "STOPPED" : choice.status,
        terminal ? escalation ? "EXACT_NEW_ACTIVITY_AUTHORITY_REQUIRED" : accepted ? "INDEPENDENT_BILATERAL_OPPORTUNITY_BRANCHES_COMPLETE" : "NO_QUALIFIED_OPPORTUNITY_CORRECT_STOPS_RETAINED" : choice.reason,
        execution, bindings, !terminal && choice.status === "WAITING"); return;
    }
    const co = (await candidates(ctx, p)).find(row => row.id === choice.selected!.id)!;
    if (["APPROACH", "INQUIRE", "CONFIRM"].includes(choice.selected.activity)) {
      try { await prepareContact(ctx, p, co, bindings, choice.selected.activity as "APPROACH" | "INQUIRE" | "CONFIRM", execution); }
      catch (error) {
        const reason = safe(error);
        if (reason === "S6_ORIGINAL_CONTACT_SPACING_WAIT") {
          await progress(ctx, p, "WAITING", reason, execution, bindings, true); return;
        }
        if (/SUPPRESSED|CAP_EXHAUSTED|DUPLICATE_OR_CONTRADICTORY/.test(reason)) {
          await disposition(ctx, p, co, "STOPPED", reason);
          await progress(ctx, p, "PROGRESS", reason, execution, bindings, true); return;
        }
        throw error;
      }
      await progress(ctx, p, "WAITING", "EXACT_GOVERNED_CONTACT_QUEUED_NOT_INTEREST", execution, bindings, true); return;
    }
    if (!await observeContact(ctx, p, co, bindings)) {
      await progress(ctx, p, "RECONCILING", "ORIGINAL_CONTACT_PENDING_OR_UNKNOWN_NO_BLIND_RETRY", execution, bindings, true); return;
    }
    const received = await readInterface(ctx, p, bindings, "EVENTS", co);
    const array = (received.value as { events?: unknown[] }).events;
    if (!Array.isArray(array) || array.length > 128) throw Error("S1_PARTICIPANT_EVENT_COVERAGE_BOUND");
    for (const value of array) await acceptParticipantEvent(ctx, p, bindings, value);
    const refreshed = (await candidates(ctx, p)).find(row => row.id === co.id)!;
    if (terminalCandidates.has(refreshed.disposition)) {
      await progress(ctx, p, "PROGRESS", "OBSERVED_REFUSAL_OR_WITHDRAWAL_BRANCH_RETIRED", execution, bindings, true); return;
    }
    const seen = await participantEvents(ctx, p, refreshed);
    const currentEvents = seen.filter(r => r.signed.body.actionId === refreshed.current_action_id &&
      r.signed.body.eventId !== refreshed.last_event_id);
    const counterproposal = currentEvents.find(r => ["COUNTERPROPOSAL", "CONSTRAINTS"].includes(r.signed.body.kind) && r.signed.body.terms);
    if (counterproposal) {
      await tx(ctx, c => c.query("UPDATE finnor_os.v1_candidates SET last_event_id=$4 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
        [p.tenant_id, actor(ctx), co.id, counterproposal.signed.body.eventId]));
      await prepareTerms(ctx, p, refreshed, bindings, counterproposal.signed.body.terms!, counterproposal.signed.body.eventId, execution);
      await progress(ctx, p, "PROGRESS", "AUTHENTICATED_CONSTRAINTS_ADAPTED_WITHIN_ORIGINAL_ENVELOPE", execution, bindings, true); return;
    }
    const interest = currentEvents.find(r => r.signed.body.kind === "INTEREST");
    if (interest) {
      const receipt = await independentCheck(ctx, p, refreshed, bindings);
      if (receipt.body.result === "ACCEPT") await publish(ctx, p, refreshed, bindings, receipt, execution);
      else await disposition(ctx, p, refreshed, "CHECK_REJECTED", receipt.body.reasons[0] ?? "S8_INDEPENDENT_CHECK_REJECTED");
      await progress(ctx, p, "PROGRESS", receipt.body.result === "ACCEPT" ? "INDEPENDENT_IMMUTABLE_ARTIFACT_RECORDED" :
        "INVALID_QUALIFICATION_REJECTED_NOT_BUSINESS_SUCCESS", execution, bindings, true); return;
    }
    const actionTime = await tx(ctx, async c => (await c.query("SELECT possible_egress_at,created_at FROM finnor_os.s6_contact_intents WHERE tenant_id=$1 AND action_id=$2",
      [p.tenant_id, refreshed.current_action_id])).rows[0], true);
    if (Date.now() - new Date(actionTime.possible_egress_at ?? actionTime.created_at).getTime() >= bindings.mandate.responseWaitMs)
      await disposition(ctx, p, refreshed, "EXPIRED", "NO_EXACT_POSITIVE_CONFIRMATION_WITHIN_ORIGINAL_RESPONSE_WINDOW");
    await progress(ctx, p, "WAITING", "DIRECT_RESPONSE_NOT_YET_EXACT_POSITIVE_INTEREST", execution, bindings, true);
  } catch (error) {
    const reason = safe(error);
    await event(ctx, p, "S6", "DURABLE_BRANCH_FAILURE", { reason, possibleEgressHistoryRetained: true, grantReset: false });
    const possible = await tx(ctx, async c => (await c.query(`SELECT id FROM finnor_os.s6_contact_intents
      WHERE tenant_id=$1 AND programme_id=$2 AND status IN('POSSIBLE_EGRESS','UNKNOWN') LIMIT 1`, [p.tenant_id, p.id])).rows[0], true);
    await progress(ctx, p, possible ? "RECONCILING" : /GRANT|AUTHORITY|PERMISSION|RIGHTS|EXPIRED|REVISION|FENCED|DOMAIN|ADMISSION|PROFILE|ALREADY_ACTIVE/.test(reason) ? "BLOCKED" : "FAILED",
      reason, execution, bindings, false);
  } finally {
    if (bindings && nativeReserved) {
      const end = process.resourceUsage(), cpu = BigInt(end.userCPUTime + end.systemCPUTime - usage.userCPUTime - usage.systemCPUTime);
      const memory = BigInt(end.maxRSS) * 1024n;
      const receipt: Pick<PrimaryCostReceipt, "reasons"> = { reasons: ["ACTUAL_WORKER_PROCESS_CPU_DELTA_CONSERVATIVE_SHARED_PROCESS_METER",
        "ELAPSED_WAIT_INCLUDED_SEPARATELY_NOT_ACTIVE_HUMAN_LABOR", "NO_MODEL_INVOCATION"] };
      await settle(ctx, p, bindings.grant, { key: nativeKey, kind: "ORCHESTRATION", microUsd: cpuCost(bindings.grant, cpu),
        reservedMicroUsd: nativeHeld, cpuMicros: cpu.toString(), wallMs: performance.now() - start,
        peakMemoryBytes: memory.toString(), reasons: receipt.reasons });
      if (cpu > 5000000n || memory > BigInt(bindings.grant.maximumMemoryBytes)) {
        await event(ctx, p, "P2", "ORIGINAL_NATIVE_ENVELOPE_EXCEEDED", { cpuMicros: cpu.toString(), peakMemoryBytes: memory.toString(),
          budgetExpanded: false, furtherExecutionPermitted: false });
        await tx(ctx, c => c.query("UPDATE finnor_os.v1_programmes SET status='BLOCKED',reason='ORIGINAL_NATIVE_RESOURCE_GRANT_EXCEEDED' WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
          [p.tenant_id, actor(ctx), p.id]));
      }
    }
  }
}
