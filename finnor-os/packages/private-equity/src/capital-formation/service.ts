import { createPublicKey, randomUUID, verify } from "node:crypto";
import type { PoolClient } from "pg";
import type { CapitalFormationView } from "@finnor/shared-types";
import { ExperimentRational } from "@finnor/epistemic-runtime";
import { parseExact } from "../evidence-execution/exact";
import type { PeMutationContext } from "../types";
import { principal, resolveDecisionWork } from "../decision-slice/adapters";
import { persistEconomicRecordTx } from "../economic-store";
import {
  CAPITAL_FORMATION_OPERATIONS, CapitalFormationError, FinancingMandateSchema, SignedAuthoritySchema,
  SignedEventSchema, ProfessionalActivityReviewSchema, capitalDigest, canonicalCapital, requireDisposableCapitalRuntime, type FinancingMandate, type AuthorityProfile, type Terms, type InstrumentProfile,
} from "./contracts";
import {
  capitalTx, capitalProgramme, authorizeCapitalWork, lockCapitalWork, capitalApproval, capitalOwnerSnapshot,
  checkCapitalSnapshot, loadCapitalEnrolments, recordCapitalEvidence, appendCapitalSourceTx, capitalTransition,
  enqueueCapitalJob, readCapitalPublicationTx, capitalMethod, type CapitalProgrammeRow, type CapitalPublication,
} from "./store";

export const CAPITAL_FORMATION_OPERATION_NAMES = new Set(Object.keys(CAPITAL_FORMATION_OPERATIONS));
export const capitalQualification: CapitalFormationView["qualification"] = {
  engineering: "DEVELOPMENT_RUNTIME", admission: "NOT_ESTABLISHED", activation: "DISABLED",
  componentGain: "NOT_EVALUATED", fieldEconomic: "NOT_EVALUATED", protectedGate: "NOT_ESTABLISHED",
};
export async function validateCapitalBudgetTx(ctx: PeMutationContext, mandate: FinancingMandate, c: PoolClient) {
  if (mandate.budgetGrantRef.owner !== "S5") throw new CapitalFormationError("CANONICAL_S5_EPISODE_GRANT_REQUIRED");
  const row = (await c.query<{ problem: Record<string, any>; certificate: Record<string, any>; status: string; revocation_reason: string | null }>(
    `SELECT p.problem,p.certificate,r.status,r.revocation_reason FROM finnor_os.s5_proposals p
     JOIN finnor_os.s5_reservations r ON r.tenant_id=p.tenant_id AND r.allocation_digest=p.content_digest
     WHERE p.tenant_id=$1 AND p.principal_id=$2 AND p.content_digest=$3 FOR SHARE OF r`,
    [ctx.auth.tenantId, principal(ctx), mandate.budgetGrantRef.contentDigest])).rows[0];
  if (!row || capitalDigest(row.certificate.ref) !== capitalDigest(mandate.budgetGrantRef) || row.status === "RELEASED"
    || row.revocation_reason || Date.parse(row.certificate.validUntil) <= Date.now()
    || !row.certificate.check.feasible || !row.certificate.policyBindings.some((p: any) => capitalDigest(p.policyRef) === capitalDigest(mandate.approvedProgrammeRef))) {
    throw new CapitalFormationError("EXACT_CURRENT_S5_EPISODE_GRANT_REQUIRED");
  }
  const originalProgramme = row.problem.policies?.find((p: any) => capitalDigest(p.ref) === capitalDigest(mandate.approvedProgrammeRef));
  if (!originalProgramme || capitalDigest(originalProgramme.problem) !== mandate.approvedTermsDigest) {
    throw new CapitalFormationError("EXACT_APPROVED_S4_PROGRAMME_TERMS_REQUIRED");
  }
  const quantities = (resourceClass: string, unit: string, scale: number): bigint => {
    let total = 0n;
    for (const envelope of row.certificate.check.envelopes) {
      const resource = row.problem.resources.find((r: any) => r.resourceId === envelope.resourceId);
      if (resource?.resourceClass !== resourceClass || envelope.unit !== unit) continue;
      for (const value of envelope.quantities) {
        if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) throw new CapitalFormationError("EPISODE_BUDGET_QUANTITY_UNSUPPORTED");
        const parsed = parseExact(value), denominator = 10n ** BigInt(parsed.s), scaled = parsed.n * 10n ** BigInt(scale);
        if (scaled % denominator) throw new CapitalFormationError("EPISODE_BUDGET_QUANTITY_INEXACT");
        total += scaled / denominator;
      }
    }
    return total;
  };
  const siblings = (await c.query<{ contacts: string; steps: string; cost: string; human: string }>(`SELECT
    coalesce(sum((body->>'contactGrant')::numeric),0)::text contacts,
    coalesce(sum((body->>'maxSteps')::numeric),0)::text steps,
    coalesce(sum((body->>'maxCostMicroUSD')::numeric),0)::text cost,
    coalesce(sum((body->>'maxHumanSeconds')::numeric),0)::text human FROM finnor_os.s4_financing_mandates
    WHERE tenant_id=$1 AND principal_id=$2 AND body->'budgetGrantRef'->>'contentDigest'=$3 AND programme_id<>$4`,
  [ctx.auth.tenantId, principal(ctx), mandate.budgetGrantRef.contentDigest, mandate.programmeId])).rows[0]!;
  if (quantities("INQUIRY_EXPOSURE", "contact", 0) < BigInt(mandate.contactGrant) + BigInt(siblings.contacts)
    || quantities("COMPUTE", "request", 0) < BigInt(mandate.maxSteps) + BigInt(siblings.steps)
    || quantities("CASH", "USD", 6) < BigInt(mandate.maxCostMicroUSD) + BigInt(siblings.cost)
    || quantities("HUMAN_ATTENTION", "seconds", 0) < BigInt(mandate.maxHumanSeconds) + BigInt(siblings.human)) {
    throw new CapitalFormationError("ORIGINAL_S5_GRANT_DOES_NOT_COVER_FINANCING_EPISODE");
  }
}
export function assertCapitalActivity(authority: AuthorityProfile, mandate: FinancingMandate,
  input: { activity: AuthorityProfile["activities"][number]["activity"]; providerId: string; recipientId: string; channelId: string; actorId: string; terms?: Terms | null; professionalReviewEstablished?: boolean },
  now = Date.now()) {
  const activity = authority.activities.find(a => a.activity === input.activity && a.actorIds.includes(input.actorId) && a.channelIds.includes(input.channelId));
  if (authority.revoked || Date.parse(authority.validFrom) > now || Date.parse(authority.validUntil) <= now + 5000
    || !activity || !authority.legalEntityIds.includes(mandate.legalEntityId) || !authority.permittedProviderIds.includes(input.providerId)
    || authority.suppressedProviderIds.includes(input.providerId) || !authority.permittedRecipientIds.includes(input.recipientId)
    || !mandate.providerIds.includes(input.providerId)) throw new CapitalFormationError("CAPITAL_ACTIVITY_AUTHORITY_REQUIRED");
  if ((activity.professionalRequired || authority.approvalConditions.length) && input.professionalReviewEstablished !== true) throw new CapitalFormationError("PROFESSIONAL_ACTIVITY_REVIEW_REQUIRED");
  if (input.terms) {
    const t = input.terms, compare = (a: { numerator: string; denominator: string }, b: { numerator: string; denominator: string }) =>
      new ExperimentRational(BigInt(a.numerator), BigInt(a.denominator)).compare(new ExperimentRational(BigInt(b.numerator), BigInt(b.denominator)));
    if (t.programmeId !== mandate.programmeId || t.providerEntityId !== input.providerId || !authority.instruments.includes(t.instrument)
      || t.offeringAuthorityDigest !== capitalDigest(authority) || BigInt(t.amount.amountMinor) > BigInt(authority.maxExposureMinor)
      || t.amount.legalEntityId !== mandate.legalEntityId || t.amount.currency !== mandate.requirement.currency || t.amount.minorUnits !== mandate.requirement.minorUnits
      || t.fixedRate && (compare(t.fixedRate, authority.pricingBounds.minRate) < 0 || compare(t.fixedRate, authority.pricingBounds.maxRate) > 0)
      || t.guarantees.some(g => !authority.permittedGuaranteeIds.includes(g.id))
      || t.guarantees.some(g => !authority.legalEntityIds.includes(g.guarantorEntityId)
        || g.maximum.legalEntityId !== g.guarantorEntityId || g.maximum.currency !== mandate.requirement.currency || g.maximum.minorUnits !== mandate.requirement.minorUnits)
      || t.fees.some(f => f.amount.legalEntityId !== mandate.legalEntityId || f.amount.currency !== mandate.requirement.currency
        || f.amount.minorUnits !== mandate.requirement.minorUnits || f.amount.rounding !== "EXACT")
      || t.guarantees.reduce((sum, g) => sum + BigInt(g.maximum.amountMinor), BigInt(t.amount.amountMinor)) > BigInt(authority.maxExposureMinor)
      || t.fees.reduce((sum, f) => sum + BigInt(f.amount.amountMinor), 0n) > BigInt(authority.pricingBounds.maxFeesMinor)) {
      throw new CapitalFormationError("NEGOTIATION_MATERIAL_TERMS_OUTSIDE_GRANT", "Changed price, exposure, guarantee or instrument requires a current exact grant");
    }
  }
}
export async function capitalActivityReviewTx(ctx: PeMutationContext, m: FinancingMandate, authority: AuthorityProfile,
  input: { activity: AuthorityProfile["activities"][number]["activity"]; providerId: string; recipientId: string; channelId: string; instrument?: string }, c: PoolClient) {
  if (!authority.activities.find(a => a.activity === input.activity)?.professionalRequired && !authority.approvalConditions.length) return false;
  const row = (await c.query<{ content: string; content_hash: string; source_id: string }>(
    `SELECT v.content,v.content_hash,v.source_id::text FROM finnor_os.evidence_source_versions v
     JOIN finnor_os.evidence_sources s ON s.id=v.source_id AND s.tenant_id=v.tenant_id
     AND v.version_number=(SELECT max(head.version_number) FROM finnor_os.evidence_source_versions head WHERE head.source_id=s.id AND head.tenant_id=s.tenant_id)
     WHERE v.tenant_id=$1 AND v.id::text=$2 FOR SHARE OF s`, [ctx.auth.tenantId, authority.legalReviewEvidenceRef])).rows[0];
  if (!row || capitalDigest(row.content) !== row.content_hash || !m.sourceRevisionVector.some(r => r.key === "evidence:" + row.source_id)) throw new CapitalFormationError("CURRENT_PROFESSIONAL_ACTIVITY_REVIEW_REQUIRED");
  const review = ProfessionalActivityReviewSchema.parse(JSON.parse(row.content)), { issuers, profiles } = await loadCapitalEnrolments(ctx, c),
    i = issuers.find(i => i.id === review.body.issuerId), b = review.body;
  if (!i || i.revoked || !i.purposes.includes("PROFESSIONAL") || !i.activities.includes("DETERMINE_LEGAL_STATUS")
    || i.actorId === principal(ctx) || i.actorId === input.recipientId || i.legalEntityId === input.providerId
    || issuers.some(provider => provider.purposes.includes("PROVIDER") && provider.legalEntityId === input.providerId
      && (provider.actorId === i.actorId || capitalDigest(createPublicKey(provider.publicKey).export({ type: "spki", format: "der" }))
        === capitalDigest(createPublicKey(i.publicKey).export({ type: "spki", format: "der" }))))
    || Date.parse(i.validFrom) > Date.now() || Date.parse(i.validUntil) <= Date.now()
    || !input.instrument || !i.instruments.includes(input.instrument as Terms["instrument"])
    || !b.instruments.includes(input.instrument as Terms["instrument"])
    || !profiles.some(p => m.domainProfileIds.includes(p.id) && (!input.instrument || p.instrument === input.instrument)
      && p.professionalIssuerIds.includes(i.id) && p.legalBasisDigest === b.legalBasisDigest)
    || b.tenantId !== ctx.auth.tenantId || b.programmeId !== m.programmeId || b.principalId !== principal(ctx)
    || b.legalEntityId !== m.legalEntityId || b.authorityDigest !== capitalDigest(authority)
    || !b.activities.includes(input.activity) || !b.providerIds.includes(input.providerId)
    || !b.recipientIds.includes(input.recipientId) || !b.channels.includes(input.channelId)
    || authority.approvalConditions.some(id => !b.satisfiedApprovalConditionIds.includes(id))
    || Date.parse(b.validFrom) > Date.now() || Date.parse(b.validUntil) <= Date.now() + 5000
    || !verify(null, Buffer.from(canonicalCapital(b)), createPublicKey(i.publicKey), Buffer.from(review.signature, "base64"))) {
    throw new CapitalFormationError("EXACT_PROFESSIONAL_ACTIVITY_SCOPE_UNESTABLISHED");
  }
  return true;
}
export async function capitalDisclosures(ctx: PeMutationContext, m: FinancingMandate, providerId: string, channelId: string,
  c: PoolClient, includeContent: boolean) {
  await c.query("SELECT set_config('app.capital_programme_id',$1,true),set_config('app.capital_purpose',$2,true)",
    [m.programmeId, m.disclosureRefs[0]!.purpose]);
  const result: Array<{ evidenceVersionId: string; contentDigest: string; content: string; purpose: string; consentRef: string }> = [];
  const rights = (await c.query<{ revision: number }>("SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1 FOR SHARE", [ctx.auth.tenantId])).rows[0];
  let total = 0;
  for (const requested of m.disclosureRefs.filter(r => r.permittedProviderIds.includes(providerId))) {
    const row = (await c.query<{ body: FinancingMandate["disclosureRefs"][number]; content_digest: string; revoked: boolean; valid_until: Date;
      retention_until: Date; content_hash: string; content: string; source_id: string; source_revision: string }>(
      `SELECT g.body,g.content_digest,g.revoked,g.valid_until,g.retention_until,v.content_hash,v.content,g.source_id,
       coalesce(r.revision,0)::text source_revision FROM finnor_os.s1_capital_disclosures g
       JOIN finnor_os.evidence_source_versions v ON v.id=g.evidence_version_id AND v.tenant_id=g.tenant_id
       LEFT JOIN finnor_os.p4_source_revisions r ON r.tenant_id=g.tenant_id AND r.key='evidence:'||g.source_id
       WHERE g.tenant_id=$1 AND g.principal_id=$2 AND g.programme_id=$3 AND g.work_id=$4 AND g.evidence_version_id=$5 FOR SHARE OF g`,
      [ctx.auth.tenantId, principal(ctx), m.programmeId, m.workId, requested.evidenceVersionId])).rows[0];
    if (!row || row.revoked || row.valid_until.getTime() <= Date.now() + 5000 || row.retention_until.getTime() <= Date.now() + 5000
      || row.content_digest !== capitalDigest(requested) || capitalDigest(row.body) !== capitalDigest(requested)
      || row.content_hash !== requested.contentDigest || capitalDigest(row.content) !== row.content_hash
      || Number(row.source_revision) !== requested.sourceRevision || requested.purpose !== m.disclosureRefs[0]!.purpose
      || requested.principalId !== principal(ctx) || requested.programmeId !== m.programmeId
      || !requested.permittedChannels.includes(channelId)) throw new CapitalFormationError("CURRENT_DISCLOSURE_PRINCIPAL_PURPOSE_CONSENT_OR_RETENTION_REQUIRED");
    if (rights?.revision !== requested.rightsRevision) throw new CapitalFormationError("DISCLOSURE_RIGHTS_REVISION_CHANGED");
    total += Buffer.byteLength(row.content);
    if (total > 32768) throw new CapitalFormationError("DISCLOSURE_BOUND_EXCEEDED", undefined, 413);
    result.push({ evidenceVersionId: requested.evidenceVersionId, contentDigest: requested.contentDigest,
      content: includeContent ? row.content : "", purpose: requested.purpose, consentRef: requested.consentRef });
  }
  if (!result.length) throw new CapitalFormationError("EXACT_PROVIDER_DISCLOSURE_GRANT_REQUIRED");
  return result;
}
async function submitCapitalFormation(ctx: PeMutationContext, input: ReturnType<typeof CAPITAL_FORMATION_OPERATIONS["capital-formation-submit"]["parse"]>) {
  const { mandate, authority } = input;
  await authorizeCapitalWork(ctx, mandate);
  requireDisposableCapitalRuntime();
  const method = await capitalMethod(), requestDigest = capitalDigest(input);
  return capitalTx(ctx, async (c) => {
    const rights = (await c.query<{ revision: number }>("SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1 FOR SHARE", [ctx.auth.tenantId])).rows[0];
    if (!rights) throw new CapitalFormationError("CURRENT_OWNER_AUTHORITY_REQUIRED");
    await lockCapitalWork(ctx, mandate, rights.revision, c);
    const mandatoryKeys = ["rights:tenant", "work-inputs:" + mandate.workId, "canonical:" + mandate.root.entityType + ":" + mandate.root.entityId,
      ...mandate.domainProfileIds.map(id => "v4-profile:" + id),
      ...mandate.disclosureRefs.map(r => `v4-disclosure:${mandate.programmeId}:${r.evidenceVersionId}`)];
    if (mandatoryKeys.some(key => !mandate.sourceRevisionVector.some(r => r.key === key))) throw new CapitalFormationError("COMPLETE_ORIGINAL_OWNER_REVISION_VECTOR_REQUIRED");
    const prior = (await c.query<{ programme_id: string; request_digest: string }>(
      "SELECT programme_id::text,request_digest FROM finnor_os.v4_programmes WHERE tenant_id=$1 AND principal_id=$2 AND (idempotency_key=$3 OR programme_id=$4) FOR UPDATE",
      [ctx.auth.tenantId, principal(ctx), input.idempotencyKey, mandate.programmeId])).rows[0];
    if (prior) {
      if (prior.request_digest !== requestDigest || prior.programme_id !== mandate.programmeId) throw new CapitalFormationError("ORIGINAL_PROGRAMME_IDENTITY_CONFLICT");
      return { programmeId: prior.programme_id, replayed: true, executionAuthorityGranted: false };
    }
    if (authority.body.id !== mandate.authorityProfileId || authority.body.issuingPrincipalId !== principal(ctx)) throw new CapitalFormationError("MANDATE_ACTIVITY_PROFILE_SUBSTITUTION");
    const { issuers, profiles } = await loadCapitalEnrolments(ctx, c), issuer = issuers.find(i => i.id === authority.issuerId && i.actorId === principal(ctx));
    if (!issuer || issuer.revoked || !issuer.purposes.includes("AUTHORITY") || Date.parse(issuer.validUntil) <= Date.now()
      || !verify(null, Buffer.from(canonicalCapital(authority.body)), createPublicKey(issuer.publicKey), Buffer.from(authority.signature, "base64"))) throw new CapitalFormationError("INDEPENDENT_PRINCIPAL_ACTIVITY_GRANT_REQUIRED");
    const approval = await capitalApproval(ctx, mandate, authority.body, rights.revision, c);
    if (!verify(null, Buffer.from(canonicalCapital(approval.body)), createPublicKey(issuer.publicKey), Buffer.from(approval.signature, "base64"))) throw new CapitalFormationError("INDEPENDENT_EXACT_MANDATE_APPROVAL_REQUIRED");
    for (const profileId of mandate.domainProfileIds) {
      const profile = profiles.find(p => p.id === profileId);
      if (!profile || profile.revoked || profile.environment !== "DISPOSABLE" || profile.independentCheckerDigest !== method.checkerDigest
        || !profile.permittedRootTypes.includes(mandate.root.entityType) || Date.parse(profile.validUntil) <= Date.now()) throw new CapitalFormationError("SEPARATE_INSTRUMENT_PROFILE_REQUIRED");
    }
    await validateCapitalBudgetTx(ctx, mandate, c);
    const contactLimit = Math.min(mandate.contactGrant, authority.body.maxContacts), expires = Date.parse(mandate.expiresAt), waits = Date.parse(mandate.waitingUntil);
    if (contactLimit < 1 || expires <= Date.now() + 5000 || waits > expires || waits <= Date.now()
      || BigInt(mandate.requirement.amountMinor) === 0n || BigInt(mandate.maxCostMicroUSD) === 0n) throw new CapitalFormationError("ORIGINAL_FINITE_EPISODE_GRANT_REQUIRED");
    for (const providerId of mandate.providerIds) {
      const recipient = (await c.query<{ id: string }>(`SELECT c.id::text FROM finnor_os.external_contacts c
        JOIN finnor_os.external_organizations o ON o.tenant_id=c.tenant_id AND o.id=c.external_organization_id
        WHERE c.tenant_id=$1 AND o.id=$2 AND c.active AND o.active AND c.id=ANY($3::uuid[]) ORDER BY c.id LIMIT 2 FOR SHARE OF c,o`,
      [ctx.auth.tenantId, providerId, authority.body.permittedRecipientIds])).rows;
      if (recipient.length !== 1) throw new CapitalFormationError("EXACT_ACTIVE_PROVIDER_AND_REPRESENTATIVE_REQUIRED");
      const channel = authority.body.activities.find(a => a.activity === "APPROACH" && a.actorIds.includes(principal(ctx)))?.channelIds[0];
      if (!channel) throw new CapitalFormationError("PERMITTED_PROVIDER_APPROACH_REQUIRED");
      const instruments = [...new Set(issuers.filter(i => i.purposes.includes("PROVIDER") && i.legalEntityId === providerId
        && i.actorId === recipient[0]!.id).flatMap(i => i.instruments).filter(instrument =>
        profiles.some(p => mandate.domainProfileIds.includes(p.id) && p.instrument === instrument)))];
      if (instruments.length !== 1) throw new CapitalFormationError("EXPLICIT_SINGLE_PROVIDER_INSTRUMENT_BINDING_REQUIRED");
      const professionalReviewEstablished = await capitalActivityReviewTx(ctx, mandate, authority.body, { activity: "APPROACH", providerId,
        recipientId: recipient[0]!.id, channelId: channel, instrument: instruments[0] }, c);
      assertCapitalActivity(authority.body, mandate, { activity: "APPROACH", providerId, recipientId: recipient[0]!.id, channelId: channel, actorId: principal(ctx), professionalReviewEstablished });
      await capitalDisclosures(ctx, mandate, providerId, channel, c, false);
    }
    await c.query("INSERT INTO finnor_os.s4_financing_mandates(tenant_id,principal_id,programme_id,approval_decision_id,work_id,work_input_id,mandate_digest,body,signed_authority) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)",
      [ctx.auth.tenantId, principal(ctx), mandate.programmeId, mandate.approvalDecisionId, mandate.workId, mandate.workInputId, capitalDigest(mandate), canonicalCapital(mandate), canonicalCapital(authority)]);
    await c.query("INSERT INTO finnor_os.v4_programmes(tenant_id,principal_id,programme_id,idempotency_key,request_digest,rights_revision,deadline_at,waiting_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [ctx.auth.tenantId, principal(ctx), mandate.programmeId, input.idempotencyKey, requestDigest, rights.revision, mandate.expiresAt, mandate.waitingUntil]);
    await capitalTransition(ctx, mandate.programmeId, "EXACT_MANDATE_ACCEPTED", { mandateDigest: capitalDigest(mandate), authorityDigest: capitalDigest(authority.body),
      approvalDecisionId: mandate.approvalDecisionId, methodDigest: method.digest, contactLimit, originalGrantPreserved: true, executionAuthorityGranted: false }, c);
    await enqueueCapitalJob(ctx, mandate.programmeId, 1, c);
    return { programmeId: mandate.programmeId, revision: 1, status: "PROGRESS", replayed: false, executionAuthorityGranted: false };
  });
}
async function viewTx(ctx: PeMutationContext, q: CapitalProgrammeRow, c: PoolClient, current: boolean, blockers: string[]): Promise<CapitalFormationView> {
  const publication = current ? await readCapitalPublicationTx(ctx, q, c) : null;
  const index = q.current_publication_id ? (await c.query<{ content_digest: string; evidence_version_id: string }>(
    "SELECT content_digest,evidence_version_id::text FROM finnor_os.v4_publications WHERE tenant_id=$1 AND principal_id=$2 AND publication_id=$3",
    [ctx.auth.tenantId, principal(ctx), q.current_publication_id])).rows[0] : null;
  const history = (await c.query<{ kind: string; created_at: Date; body: Record<string, unknown> }>(
    "SELECT kind,created_at,body FROM finnor_os.v4_transitions WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 ORDER BY created_at DESC,id DESC LIMIT 32",
    [ctx.auth.tenantId, principal(ctx), q.programme_id])).rows.map(r => ({ kind: r.kind, at: r.created_at.toISOString(), detail: r.body }));
  const count = (await c.query<{ n: number }>("SELECT count(*)::int n FROM finnor_os.v4_source_events WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3",
    [ctx.auth.tenantId, principal(ctx), q.programme_id])).rows[0]!.n;
  return { schema: "finnor.capital-formation-view.v1", programmeId: q.programme_id, workId: q.body.workId, revision: q.revision,
    root: q.body.root,
    status: q.status, current, package: publication?.package ?? null, publicationDigest: current ? index?.content_digest ?? null : null,
    evidenceVersionId: current ? index?.evidence_version_id ?? null : null, authenticatedEventCount: count,
    budget: { contactsSpent: q.contacts_spent, contactLimit: Math.min(q.body.contactGrant, q.signed_authority.body.maxContacts),
      stepsSpent: q.steps_spent, stepLimit: q.body.maxSteps, originalDeadlineAt: q.deadline_at.toISOString(), waitingUntil: q.waiting_until.toISOString(),
      humanSecondsSpent: q.human_seconds_spent, humanSecondsLimit: q.body.maxHumanSeconds,
      costCeilingMicroUSD: q.cost_ceiling_micro_usd, costUnknown: q.cost_unknown, maxCostMicroUSD: q.body.maxCostMicroUSD },
    nextStep: q.status === "COMPLETE" ? "COMPLETE" : q.status === "STOPPED" || q.status === "FAILED" ? "STOP"
      : q.status === "RECONCILING" ? "RECONCILE_ORIGINAL_OPERATION" : !current || q.status === "BLOCKED" ? "REQUEST_CURRENT_AUTHORITY"
        : q.status === "PROGRESS" ? "PROGRESS" : "WAIT_FOR_AUTHENTICATED_EVENT",
    blockers: [...new Set([...blockers, ...(publication?.package.conflicts ?? []), ...(publication?.package.unresolvedClaims ?? [])])],
    commitments: (publication?.artifacts ?? []).map(a => ({ artifactId: a.envelope.artifact_id, contentDigest: a.envelope.content_digest,
      state: a.state, providerEntityId: a.terms.providerEntityId, instrument: a.terms.instrument, sourceEventIds: a.envelope.external_event_refs,
      unsatisfiedConditions: a.conditions_and_satisfaction_evidence.unsatisfiedIds, expiresAt: a.terms.expiresAt,
      continuingObligations: a.terms.materialObligations.map(o => o.id) })),
    history, qualification: capitalQualification, executionAuthorityGranted: false };
}
export async function readCapitalFormation(ctx: PeMutationContext, id: string): Promise<CapitalFormationView> {
  const original = await capitalTx(ctx, c => capitalProgramme(ctx, id, c, false));
  await authorizeCapitalWork(ctx, original.body, false);
  return capitalTx(ctx, async c => {
    const q = await capitalProgramme(ctx, id, c), blockers: string[] = [];
    await lockCapitalWork(ctx, q.body, q.rights_revision, c, false);
    let current = true;
    try {
      await lockCapitalWork(ctx, q.body, q.rights_revision, c);
      const publication = await readCapitalPublicationTx(ctx, q, c);
      if (publication) {
        const snapshot = await capitalOwnerSnapshot(ctx, q, c), checked = await checkCapitalSnapshot(snapshot);
        if (publication.codeDigest !== (await capitalMethod()).digest || publication.ownerDigest !== snapshot.ownerDigest
          || publication.check.resultDigest !== checked.resultDigest) {
          current = false; blockers.push("OWNER_SOURCE_TIME_OR_INSTALLED_METHOD_CHANGED");
        }
      }
    } catch (error) {
      if (!(error instanceof CapitalFormationError) && !(error instanceof Error && /SOURCE_RIGHTS_MEMBERSHIP_OR_WORK_CHANGED/.test(error.message))) throw error;
      current = false; blockers.push(error instanceof CapitalFormationError ? error.code : "SOURCE_REVISION_CHANGED");
    }
    if (!current && q.current_publication_id) {
      const row = (await c.query<{ revision: number }>(`UPDATE finnor_os.v4_programmes SET current_publication_id=NULL,revision=revision+1,
        status=CASE WHEN status IN('STOPPED','FAILED','COMPLETE') THEN status ELSE 'BLOCKED' END,failure=$4::jsonb,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 RETURNING revision`,
      [ctx.auth.tenantId, principal(ctx), id, canonicalCapital({ code: blockers[0], historyAndObligationsRetained: true })])).rows[0]!;
      q.current_publication_id = null; q.revision = row.revision; if (!["STOPPED", "FAILED", "COMPLETE"].includes(q.status)) q.status = "BLOCKED";
      await capitalTransition(ctx, id, "CURRENT_PUBLICATION_INVALIDATED", { blockers, costsAndOriginalEffectsRetained: true }, c);
    }
    return viewTx(ctx, q, c, current, blockers);
  });
}
export async function recordCapitalEconomicNotice(ctx: PeMutationContext, publication: CapitalPublication, digest: string, q: CapitalProgrammeRow, c: PoolClient) {
  const obligations = publication.continuingObligations.flatMap(x => x.terms.materialObligations.map(obligation => ({
    commitmentId: x.commitmentId, termsDigest: x.termsDigest, obligation,
  })));
  return persistEconomicRecordTx(ctx, { kind: "SOURCE", rightsRef: "capital-work:" + q.body.workId, idempotencyKey: "v4-notice:" + digest,
    validAt: publication.knowledgeAt, horizon: "H0", uncertainty: "FINANCING_SOURCE_NOTICE_NOT_OWNER_WEALTH_OR_CAUSAL_ATTRIBUTION",
    dependencies: publication.artifacts.map(a => ({ owner: "V4", id: a.envelope.artifact_id, version: a.envelope.schema_revision, contentDigest: a.envelope.content_digest })),
    payload: { schema: "finnor.v4.economic-notice.v1", programmeId: q.programme_id, publicationDigest: digest,
      receivedFinancingPrincipalMinor: publication.package.fundingReceivedMinor, fundingUnknownMinor: publication.package.dispatchedUnknownMinor,
      currency: publication.package.currency, minorUnits: publication.package.minorUnits,
      profit: null, ownerWealthChange: null, attributionGranted: false, principalCreditedAsProfit: false,
      continuingObligations: [...new Map(obligations.map(o => [capitalDigest(o), o])).values()],
      debtEquityAndGuaranteeRefs: publication.artifacts.map(a => a.envelope.artifact_id),
      costReceiptRefs: [...new Set(publication.artifacts.flatMap(a => a.envelope.cost_receipts.map(r => `${r.issuerId}:${r.receiptId}`)))],
      costCeilingMicroUSD: q.cost_ceiling_micro_usd, physicalAndHumanCostQualification: "UNMETERED_OUTSIDE_RETAINED_PROVIDER_RECEIPTS",
      protectedGate: "NOT_ESTABLISHED" },
  }, c);
}
function assertOriginalEpisode(q: CapitalProgrammeRow) {
  if (["STOPPED", "FAILED", "COMPLETE"].includes(q.status) || q.deadline_at.getTime() <= Date.now()
    || q.waiting_until.getTime() <= Date.now() || q.steps_spent >= q.body.maxSteps
    || q.cost_unknown || BigInt(q.cost_ceiling_micro_usd) >= BigInt(q.body.maxCostMicroUSD)
    || q.failure?.code === "PROVIDER_COST_CEILING_EXCEEDED") throw new CapitalFormationError("ORIGINAL_EPISODE_STOPPED_OR_EXHAUSTED");
}
export async function handleCapitalFormationOperation(ctx: PeMutationContext, operation: string, value: unknown): Promise<{ status: number; body: unknown }> {
  const schema = CAPITAL_FORMATION_OPERATIONS[operation as keyof typeof CAPITAL_FORMATION_OPERATIONS];
  if (!schema) throw new CapitalFormationError("NOT_FOUND", undefined, 404);
  const input = schema.parse(value) as Record<string, any>;
  if (operation === "capital-formation-submit") return { status: 202, body: await submitCapitalFormation(ctx, input as ReturnType<typeof CAPITAL_FORMATION_OPERATIONS["capital-formation-submit"]["parse"]>) };
  if (operation === "capital-formation-read") return { status: 200, body: await readCapitalFormation(ctx, input.programmeId) };
  if (operation === "capital-formation-list" || operation === "capital-formation-profiles") {
    await resolveDecisionWork(ctx, input.workId);
    if (operation === "capital-formation-profiles") {
      const { profiles } = await capitalTx(ctx, c => loadCapitalEnrolments(ctx, c));
      return { status: 200, body: { workId: input.workId, profiles: profiles.map(p => ({ id: p.id, instrument: p.instrument, revision: p.revision,
        environment: p.environment, registered: true, qualified: false, activated: false,
        declaredQualified: p.qualified, declaredActivated: p.activated,
        admissionRef: p.admissionRef, admissionStatus: "CURRENT_OWNER_PROOF_REQUIRED", validUntil: p.validUntil })),
      qualification: capitalQualification, executionAuthorityGranted: false } };
    }
    const ids = await capitalTx(ctx, async c => (await c.query<{ programme_id: string }>(
      "SELECT p.programme_id::text FROM finnor_os.v4_programmes p JOIN finnor_os.s4_financing_mandates m USING(tenant_id,principal_id,programme_id) WHERE p.tenant_id=$1 AND p.principal_id=$2 AND m.work_id=$3 ORDER BY p.created_at DESC LIMIT 16",
      [ctx.auth.tenantId, principal(ctx), input.workId])).rows);
    const programmes = []; for (const row of ids) programmes.push(await readCapitalFormation(ctx, row.programme_id));
    return { status: 200, body: { workId: input.workId, programmes, executionAuthorityGranted: false } };
  }
  const first = await capitalTx(ctx, c => capitalProgramme(ctx, input.programmeId, c, false));
  await authorizeCapitalWork(ctx, first.body, operation !== "capital-formation-cancel" && operation !== "capital-formation-event");
  return capitalTx(ctx, async (c, db) => {
    const q = await capitalProgramme(ctx, input.programmeId, c);
    await lockCapitalWork(ctx, q.body, q.rights_revision, c, !["capital-formation-cancel", "capital-formation-event"].includes(operation));
    if (input.expectedRevision !== undefined && input.expectedRevision !== q.revision) throw new CapitalFormationError("PROGRAMME_REVISION_CHANGED");
    if (operation === "capital-formation-event") {
      const event = SignedEventSchema.parse(input.event);
      const appended = await appendCapitalSourceTx(ctx, q, event, c, db);
      if (appended) {
        const next = (await c.query<{ revision: number }>("UPDATE finnor_os.v4_programmes SET revision=revision+1,current_publication_id=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 RETURNING revision",
          [ctx.auth.tenantId, principal(ctx), q.programme_id])).rows[0]!.revision;
        await capitalTransition(ctx, q.programme_id, "AUTHENTICATED_EVENT", { eventId: event.body.eventId, issuerId: event.body.issuerId, kind: event.body.kind,
          integrityDigest: capitalDigest(event), historicalEffectsRetained: true }, c);
        await enqueueCapitalJob(ctx, q.programme_id, next, c);
      }
      return { status: appended ? 202 : 200, body: { programmeId: q.programme_id, accepted: true, replayed: !appended, eventId: event.body.eventId } };
    }
    if (operation === "capital-formation-cancel") {
      if (["STOPPED", "FAILED", "COMPLETE"].includes(q.status)) return { status: 200, body: {
        programmeId: q.programme_id, revision: q.revision, status: q.status, responsibilityRetained: true, replayed: true,
      } };
      const revision = q.revision + 1;
      await c.query("UPDATE finnor_os.v4_programmes SET status='STOPPED',revision=$4,current_publication_id=NULL,failure=$5::jsonb,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3",
        [ctx.auth.tenantId, principal(ctx), q.programme_id, revision, canonicalCapital({ code: "PRINCIPAL_STOP", reason: input.reason })]);
      await capitalTransition(ctx, q.programme_id, "PRINCIPAL_STOP", { reason: input.reason, originalEffectsCostsAndContinuingDutiesRetained: true, cancellationReceiptIsNotNoEffect: true }, c);
      await enqueueCapitalJob(ctx, q.programme_id, revision, c);
      return { status: 202, body: { programmeId: q.programme_id, revision, status: "STOPPED", responsibilityRetained: true } };
    }
    if (operation === "capital-formation-advance") {
      assertOriginalEpisode(q);
      const revision = q.revision + 1;
      await c.query("UPDATE finnor_os.v4_programmes SET status='PROGRESS',revision=$4,current_publication_id=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3",
        [ctx.auth.tenantId, principal(ctx), q.programme_id, revision]);
      await capitalTransition(ctx, q.programme_id, "PERMITTED_RESUMPTION", { triggerRef: input.triggerRef, originalGrantAndDeadlinePreserved: true }, c);
      await enqueueCapitalJob(ctx, q.programme_id, revision, c);
      return { status: 202, body: { programmeId: q.programme_id, revision, status: "PROGRESS", originalGrantPreserved: true } };
    }
    if (operation === "capital-formation-proposal") {
      const professionalReviewEstablished = await capitalActivityReviewTx(ctx, q.body, q.signed_authority.body, { activity: "NEGOTIATE",
        providerId: input.terms.providerEntityId, recipientId: input.recipientId, channelId: input.channelId, instrument: input.terms.instrument }, c);
      assertCapitalActivity(q.signed_authority.body, q.body, { activity: "NEGOTIATE", providerId: input.terms.providerEntityId, recipientId: input.recipientId,
        channelId: input.channelId, actorId: principal(ctx), terms: input.terms, professionalReviewEstablished });
      await capitalDisclosures(ctx, q.body, input.terms.providerEntityId, input.channelId, c, false);
      const proposalDigest = capitalDigest({ terms: input.terms, recipientId: input.recipientId, channelId: input.channelId }),
        prior = (await c.query("SELECT 1 FROM finnor_os.v4_proposals WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 AND proposal_digest=$4",
          [ctx.auth.tenantId, principal(ctx), q.programme_id, proposalDigest])).rows[0];
      if (prior) return { status: 200, body: { proposalDigest, replayed: true } };
      assertOriginalEpisode(q);
      const counts = (await c.query<{ proposals: number; receipts: number }>(`SELECT
        (SELECT count(*)::int FROM finnor_os.v4_proposals WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3) proposals,
        (SELECT count(*)::int FROM finnor_os.v4_transitions WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 AND kind='METERED_HUMAN_INTERVENTION') receipts`,
      [ctx.auth.tenantId, principal(ctx), q.programme_id])).rows[0]!;
      if (counts.proposals >= 64 || counts.receipts >= 64) throw new CapitalFormationError("ORIGINAL_PROPOSAL_OR_HUMAN_RECEIPT_BOUND_EXCEEDED", undefined, 413);
      const human = input.humanReceipt, enrolled = await loadCapitalEnrolments(ctx, c),
        profile = enrolled.profiles.find(p => q.body.domainProfileIds.includes(p.id) && p.instrument === input.terms.instrument),
        meter = enrolled.issuers.find(i => i.id === human?.body.issuerId);
      if (!human || !profile?.humanMeterIssuerIds.includes(human.body.issuerId) || !meter || meter.revoked
        || !meter.independentOfProducer || !meter.purposes.includes("HUMAN_METER")
        || Date.parse(meter.validUntil) <= Date.now() || Date.parse(meter.validFrom) > Date.parse(human.body.startedAt)
        || Date.parse(human.body.finishedAt) < Date.parse(human.body.startedAt) || human.body.tenantId !== ctx.auth.tenantId
        || human.body.principalId !== principal(ctx) || human.body.programmeId !== q.programme_id
        || human.body.proposalDigest !== proposalDigest || Date.parse(human.body.finishedAt) > Date.now()
        || human.body.seconds !== Math.ceil((Date.parse(human.body.finishedAt) - Date.parse(human.body.startedAt)) / 1000)
        || !verify(null, Buffer.from(canonicalCapital(human.body)), createPublicKey(meter.publicKey), Buffer.from(human.signature, "base64"))) {
        throw new CapitalFormationError("INDEPENDENT_METERED_HUMAN_PROPOSAL_RECEIPT_REQUIRED");
      }
      if (q.human_seconds_spent + human.body.seconds > q.body.maxHumanSeconds
        || BigInt(q.cost_ceiling_micro_usd) + BigInt(human.body.costMicroUSD) > BigInt(q.body.maxCostMicroUSD)) throw new CapitalFormationError("ORIGINAL_HUMAN_OR_MONEY_GRANT_EXHAUSTED");
      const reused = (await c.query("SELECT 1 FROM finnor_os.v4_transitions WHERE tenant_id=$1 AND principal_id=$2 AND kind='METERED_HUMAN_INTERVENTION' AND body->>'receiptId'=$3 AND body->>'issuerId'=$4 LIMIT 1",
        [ctx.auth.tenantId, principal(ctx), human.body.receiptId, meter.id])).rows[0];
      if (reused) throw new CapitalFormationError("HUMAN_RECEIPT_IDENTITY_ALREADY_CHARGED");
      const humanSource = await recordCapitalEvidence(ctx, c, db, q.body, "human-meter:" + meter.id + ":" + human.body.receiptId, "authenticated_human_meter_receipt", human);
      await c.query("UPDATE finnor_os.v4_programmes SET human_seconds_spent=human_seconds_spent+$4,cost_ceiling_micro_usd=cost_ceiling_micro_usd+$5::numeric WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3",
        [ctx.auth.tenantId, principal(ctx), q.programme_id, human.body.seconds, human.body.costMicroUSD]);
      await capitalTransition(ctx, q.programme_id, "METERED_HUMAN_INTERVENTION", { receiptId: human.body.receiptId, issuerId: meter.id,
        seconds: human.body.seconds, costMicroUSD: human.body.costMicroUSD, evidenceVersionId: humanSource.versionId, proposalDigest }, c);
      const stored = await recordCapitalEvidence(ctx, c, db, q.body, "proposal:" + proposalDigest, "bounded_negotiation_proposal",
        { terms: input.terms, recipientId: input.recipientId, channelId: input.channelId });
      await c.query("INSERT INTO finnor_os.v4_proposals(tenant_id,principal_id,programme_id,proposal_digest,provider_id,recipient_id,channel_id,evidence_version_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [ctx.auth.tenantId, principal(ctx), q.programme_id, proposalDigest, input.terms.providerEntityId, input.recipientId, input.channelId, stored.versionId]);
      const revision = q.revision + 1;
      await c.query("UPDATE finnor_os.v4_programmes SET revision=$4,status='PROGRESS',current_publication_id=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3",
        [ctx.auth.tenantId, principal(ctx), q.programme_id, revision]);
      await capitalTransition(ctx, q.programme_id, "BOUNDED_NEGOTIATION_PROPOSAL", { proposalDigest, humanReceiptId: human.body.receiptId,
        originalGrantPreserved: true, executionAuthorityGranted: false }, c);
      await enqueueCapitalJob(ctx, q.programme_id, revision, c);
      return { status: 202, body: { proposalDigest, revision, replayed: false, executionAuthorityGranted: false } };
    }
    if (operation === "capital-formation-draw-handoff") {
      assertOriginalEpisode(q);
      const publication = await readCapitalPublicationTx(ctx, q, c), snapshot = await capitalOwnerSnapshot(ctx, q, c), check = await checkCapitalSnapshot(snapshot);
      if (!publication || publication.check.resultDigest !== check.resultDigest || publication.ownerDigest !== snapshot.ownerDigest) throw new CapitalFormationError("CURRENT_CHECKED_FINANCING_PACKAGE_REQUIRED");
      const commitment = check.result.commitments.find(x => x.commitmentId === input.commitmentId),
        draw = snapshot.draws.find(x => x.effectId === input.drawEffectId && capitalDigest(x.allocationRef) === capitalDigest(input.allocationRef));
      if (!commitment || commitment.state !== "VERIFIED_EFFECTIVE_UNDRAWN" || !commitment.verified || !draw?.exactOwnerBinding
        || draw.termsDigest !== commitment.termsDigest || check.result.conflicts.length || check.result.unresolvedClaims.length) {
        throw new CapitalFormationError("EXACT_CURRENT_S5_S6_FINANCING_OBLIGATION_REQUIRED", "No indicative, conditional, stale, record-mutation or invented draw can use this handoff");
      }
      await capitalTransition(ctx, q.programme_id, "EXACT_DRAW_HANDOFF", { commitmentId: commitment.commitmentId, obligationId: draw.obligationId,
        allocationRef: draw.allocationRef, effectId: draw.effectId, executionAuthorityGranted: false }, c);
      return { status: 200, body: { programmeId: q.programme_id, obligationId: draw.obligationId, effectId: draw.effectId,
        allocationRef: draw.allocationRef, status: "EXACT_OWNER_BINDING_ONLY", executionAuthorityGranted: false,
        fundingReceived: false, requiredExecutor: "ADMITTED_S6_FINANCING_ADAPTER" } };
    }
    throw new CapitalFormationError("NOT_FOUND", undefined, 404);
  });
}
