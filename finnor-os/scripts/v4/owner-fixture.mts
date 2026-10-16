/** Shared native S4/S5/capital fixture owners. Existing identities are checked,
 * never substituted. Independent actor keys remain outside candidate processes. */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { createStrategy, createOpportunity } from "@finnor/private-equity";
import { linkEmployeeConversationTurnToWork } from "@finnor/orchestration";
import { resolveDecisionWork } from "../../packages/private-equity/src/decision-slice/adapters";
import { revisions } from "../../packages/private-equity/src/evidence-execution/store";
import { currentCapitalMethod } from "../../packages/private-equity/src/capital-formation/store";
import { capitalDigest, canonicalCapital } from "../../packages/private-equity/src/capital-formation/contracts";
import { CAPITAL_PROVIDER_INTERFACE_DIGEST } from "../../packages/tools/src/capital-provider";

type OriginalCapitalWork = {
  tenant: string; principal: string;
  root: { entityType: "external_organization"; entityId: string };
  workId: string; workInputId: string;
};

export function createCapitalFixtureBuilder(context: {
  admin: () => pg.Client; remainingCampaign: () => number;
  http: (fixture: any, path: string, body?: unknown) => Promise<any>;
  actor: (role: string, config: any) => Promise<any>; registeredActors: any[];
  artifact: (name: string, value: unknown) => Promise<unknown>;
  token?: (fixture: any) => string; mounted: boolean; programmeWallMs: number;
}) {
const { remainingCampaign, http, actor, registeredActors, artifact, token, mounted, programmeWallMs } = context;
const success = (r: any) => { assert([200, 201, 202].includes(r.status), JSON.stringify(r)); return r.body; };
async function originalWork(existing: OriginalCapitalWork) {
  const work = await resolveDecisionWork({
    auth: { tenantId: existing.tenant, userId: existing.principal, employeeId: existing.principal, role: "owner" },
    provenance: { sourceSystem: "v4:original-work-continuation", createdBy: existing.principal },
  }, existing.workId);
  assert.equal(work.inputId, existing.workInputId, "CAPITAL_CHAIN_ORIGINAL_INPUT_CHANGED");
  const row = (await context.admin().query(`SELECT w.status,coalesce(w.current_owner_id,w.created_by)::text owner_id,
    l.state loop_state,l.deadline_at::text deadline_at,
    l.step_count,l.action_count,l.query_count,l.max_steps,l.max_actions,l.max_queries,
    jsonb_build_object('objective',l.objective,'successCondition',l.success_condition,
      'deadlineAt',l.deadline_at,'maxSteps',l.max_steps,'maxActions',l.max_actions,
      'maxQueries',l.max_queries,'maxPlannerFailures',l.max_planner_failures,
      'maxConsecutiveNoProgress',l.max_consecutive_no_progress,'maxParallelNodes',l.max_parallel_nodes,
      'maxNodeAttempts',l.max_node_attempts,'maxWaits',l.max_waits,
      'maxEstimatedCostMicros',l.max_estimated_cost_micros,'revision',l.revision) original_goal
    FROM finnor_os.works w JOIN finnor_os.work_objective_loops l
      ON l.tenant_id=w.tenant_id AND l.work_id=w.id
    WHERE w.tenant_id=$1 AND w.id=$2`, [existing.tenant, existing.workId])).rows[0];
  assert(row && row.owner_id === existing.principal && !["completed", "cancelled", "failed"].includes(row.status),
    "CAPITAL_CHAIN_ORIGINAL_WORK_UNAVAILABLE");
  assert(!["completed", "cancelled", "failed"].includes(row.loop_state)
    && Date.parse(row.deadline_at) > Date.now()
    && row.step_count < row.max_steps && row.action_count < row.max_actions && row.query_count < row.max_queries,
    "CAPITAL_CHAIN_ORIGINAL_GOAL_OR_BUDGET_UNAVAILABLE");
  return { work, row };
}
function assertOriginalWorkUnchanged(
  original: Awaited<ReturnType<typeof originalWork>>,
  checked: Awaited<ReturnType<typeof originalWork>>,
) {
  assert.equal(checked.work.inputDigest, original.work.inputDigest,
    "CAPITAL_CHAIN_ORIGINAL_INPUT_OR_RIGHTS_CHANGED_DURING_PREPARATION");
  assert.equal(capitalDigest(checked.row.original_goal), capitalDigest(original.row.original_goal),
    "CAPITAL_CHAIN_ORIGINAL_GOAL_CHANGED_DURING_PREPARATION");
  for (const counter of ["step_count", "action_count", "query_count"])
    assert(checked.row[counter] >= original.row[counter], "CAPITAL_CHAIN_COUNTER_RESET");
}
async function originalEvidence(f: any, key: string, content: string, snapshot: unknown = {}, privateScope = false, versionId = randomUUID()) {
  const sourceId = randomUUID();
  await context.admin().query("INSERT INTO finnor_os.evidence_sources(id,scope,tenant_id,source_key,source_type,title,metadata) VALUES($1,'tenant',$2,$3,'v4_independent_development_input',$3,$4::jsonb)",
    [sourceId, f.tenant, key, JSON.stringify(privateScope ? { capitalPrivateScope: { principalId: f.principal, workId: f.workId } } : {})]);
  await context.admin().query("INSERT INTO finnor_os.evidence_source_versions(id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of) VALUES($1,$2,'tenant',$3,1,$4,$5,$6::jsonb,clock_timestamp())",
    [versionId, sourceId, f.tenant, capitalDigest(content), content, JSON.stringify(snapshot)]);
  return { sourceId, versionId };
}
async function enrol(f: any, actor: any, instruments: string[], purposes: string[], activities: string[]) {
  const body = { id: actor.public.id, revision: 1, legalEntityId: actor.public.legalEntityId, actorId: actor.public.actorId,
    publicKey: actor.public.publicKey, purposes, instruments, activities, validFrom: new Date(Date.now() - 86400000).toISOString(),
    validUntil: new Date(Math.min(Date.now() + 3600000, f.originalDeadline ?? Infinity)).toISOString(), revoked: false, independentOfProducer: true,
    sourceRef: "independently-keyed-development-process-not-licensed-field-professional", domainDigest: capitalDigest({ instruments, purposes, actor: actor.public.id }) };
  const evidence = await originalEvidence(f, "v4:issuer:" + body.id, canonicalCapital(body), body, true);
  await context.admin().query("INSERT INTO finnor_os.s1_capital_issuers(tenant_id,principal_id,issuer_id,revision,body,content_digest,source_evidence_version_id) VALUES($1,$2,$3,1,$4::jsonb,$5,$6)",
    [f.tenant, f.principal, body.id, canonicalCapital(body), capitalDigest(body), evidence.versionId]);
  return body;
}
async function fixture(support: any, name: string, delayed = false, options: { issuerLocalIds?: boolean; providerCostMicroUSD?: string;
  providerCostFinal?: boolean; additionalTranche?: boolean; allowedGuarantee?: boolean; shadowDebtProfile?: boolean;
  activityReview?: "INDEPENDENT" | "REPRESENTATIVE" | "SHARED_KEY";
  existing?: OriginalCapitalWork } = {}) {
  remainingCampaign();
  const original = options.existing ? await originalWork(options.existing) : null;
  const f = await support.fixture(name, 1, [
    { id: "cash", unit: "USD", capacity: 100, totalLimit: 100, resourceClass: "CASH" },
    { id: "contacts", unit: "contact", capacity: 8, totalLimit: 8, resourceClass: "INQUIRY_EXPOSURE" },
    { id: "compute", unit: "request", capacity: 32, totalLimit: 32, resourceClass: "COMPUTE" },
    { id: "human", unit: "seconds", capacity: 900, totalLimit: 900, resourceClass: "HUMAN_ATTENTION" },
  ], { existing: options.existing,
    ...(original ? { expiresAt: new Date(original.row.deadline_at).toISOString() } : {}) });
  f.originalDeadline = original ? Date.parse(original.row.deadline_at) : undefined;
  if (token) f.token = token(f);
  if (mounted && name === "original-positive") {
    const strategy = await createStrategy(f.ctx, { name: "Disposable financing scope, not field investment evidence" });
    const opportunity = await createOpportunity(f.ctx, { strategyId: String(strategy.row.id), targetOrganizationId: f.root.entityId,
      name: "Original hypothetical financing programme", summary: "Mounted owner-route proof only, no signed LOI, legal commitment or field investment inferred" });
    f.uiRoot = { entityType: "pe_opportunity", entityId: String(opportunity.row.id) };
    f.wrongUiRoot = { entityType: "pe_strategy", entityId: String(strategy.row.id) };
    await artifact(name + "/canonical-mounted-root.json", { uiRoot: f.uiRoot, financingRoot: f.root, strategy, opportunity });
  }
  let intake: any;
  if (options.existing) {
    const checked = await originalWork(options.existing), work = checked.work;
    assertOriginalWorkUnchanged(original!, checked);
    f.workId = options.existing.workId;
    intake = { status: 200, body: { workId: f.workId, workInputId: work.inputId, originalInputReused: true } };
    f.intake = intake;
    await artifact(name + "/original-work-continuation.json", intake);
  } else {
  intake = await http(f, "actions", { instruction: "Prepare an original bounded financing programme for the selected company, subject to exact approval. Do not execute borrowing or funding.",
    instructionId: randomUUID(), idempotencyKey: "v4-native-intake:" + name, channel: "text",
    activeContext: { version: 1, capturedAt: new Date().toISOString(), source: "text", selectedEntities: [f.root],
      excludedEntities: [], surface: { id: "home", route: "/centropy", spatialState: "canvas" }, filters: [] } });
  assert(intake.body.workId, "Actual bearer intake must retain an original Work id");
  f.workId = intake.body.workId; f.intake = intake;
  if (intake.status === 503 && intake.body.code === "worker_fleet_unavailable") {
    const recovery = await http(f, `works/${f.workId}/retry`, { idempotencyKey: "same-original-financing-intake-" + name });
    await artifact(name + "/original-intake-recovery.json", { intake, recovery, originalWorkId: f.workId,
      originalWorkInputId: intake.body.workInputId, changedFinancingGrant: false });
    assert([200, 201, 202].includes(recovery.status), JSON.stringify(recovery));
    const nativeThreads = success(await http(f, "threads")).threads;
    let projected = false;
    for (const thread of nativeThreads) {
      const loaded = success(await http(f, `threads/${thread.id}`));
      const message = loaded.messages.find((m: any) => m.role === "user" && m.instructionId === intake.body.instructionId);
      if (!message) continue;
      await linkEmployeeConversationTurnToWork({ tenantId: f.tenant, employeeId: f.principal, threadId: thread.id,
        userMessageId: message.id, workId: f.workId, workInputId: intake.body.workInputId });
      const observed = success(await http(f, `threads/${thread.id}`));
      assert.equal(observed.thread.activeWorkId, f.workId);
      await artifact(name + "/original-recovery-projection.json", { originalWorkId: f.workId, originalWorkInputId: intake.body.workInputId,
        threadId: thread.id, messageId: message.id, observed,
        path: "Canonical conversation-owner seam completes original recovery projection. Not an unbroken installed objective-intake/fleet proof.",
        newWorkInputOrFinancingGrantCreated: false });
      projected = true; break;
    }
    assert(projected, "Same original recovered Work must bind its actual canonical user turn");
  } else success(intake);
  }
  const policy = await support.policy(f, "budget", { cash: 100, contacts: 8, compute: 32, human: 900 });
  for (const [id, unit, amount] of [["cash", "USD", "100"], ["contacts", "contact", "8"], ["compute", "request", "32"], ["human", "seconds", "900"]]) {
    await support.resource(f, id, unit, "STOCK", [amount, amount]);
  }
  const cleared = success(await http(f, "allocations/clear", support.clearing(f, { budget: ["100"] })));
  await artifact(name + "/original-budget-owner-result.json", cleared);
  assert.equal(cleared.status, "FEASIBLE", JSON.stringify(cleared)); assert(cleared.certificate.policyBindings.some((p: any) => p.policyRef.id === policy.ref.id));
  const authorityActor = await actor("authority", { id: randomUUID(), actorId: f.principal, legalEntityId: f.root.entityId });
  registeredActors.push(authorityActor);
  const authorityIssuer = await enrol(f, authorityActor, ["CORPORATE_DEBT", "TRANSACTION_CO_INVESTMENT_EQUITY", "FUND_LP"], ["AUTHORITY"], ["APPROVE"]);
  const domainActors: any = {}, profiles: any[] = [], providerIds: string[] = [], recipientIds: string[] = [];
  const method = await currentCapitalMethod();
  for (const instrument of options.shadowDebtProfile ? ["CORPORATE_DEBT", "TRANSACTION_CO_INVESTMENT_EQUITY"]
    : ["CORPORATE_DEBT", "TRANSACTION_CO_INVESTMENT_EQUITY", "FUND_LP"]) {
    const providerEntity = randomUUID(), representative = randomUUID(), idActor = await actor("identity", { id: randomUUID(), actorId: randomUUID(), legalEntityId: randomUUID() }),
      profActor = await actor("professional", { id: randomUUID(), actorId: options.activityReview === "REPRESENTATIVE" && instrument === "CORPORATE_DEBT" ? representative : randomUUID(), legalEntityId: randomUUID() }),
      receiver = await actor("receiver", { id: randomUUID(), actorId: randomUUID(), legalEntityId: randomUUID() }),
      meter = await actor("meter", { id: randomUUID(), actorId: randomUUID(), legalEntityId: randomUUID() });
    const provider = await actor("provider", { id: randomUUID(), actorId: representative, legalEntityId: providerEntity,
      identityOrigin: idActor.public.origin, professionalOrigin: profActor.public.origin });
    registeredActors.push(idActor, profActor, receiver, meter, provider);
    await context.admin().query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,$3,'other')",
      [providerEntity, f.tenant, (name + "-" + instrument).toLowerCase()]);
    await context.admin().query("INSERT INTO finnor_os.external_contacts(id,tenant_id,external_organization_id,contact_key,name,business_email) VALUES($1,$2,$3,$4,$4,$5)",
      [representative, f.tenant, providerEntity, "v4-" + representative, representative + "@disposable.example.test"]);
    await enrol(f, idActor, [instrument], ["IDENTITY"], []);
    await enrol(f, options.activityReview === "SHARED_KEY" && instrument === "CORPORATE_DEBT"
      ? { ...profActor, public: { ...profActor.public, publicKey: provider.public.publicKey } } : profActor, [instrument], ["PROFESSIONAL"], ["DETERMINE_LEGAL_STATUS"]);
    await enrol(f, receiver, [instrument], ["SETTLEMENT"], []);
    await enrol(f, meter, [instrument], ["HUMAN_METER"], []);
    await enrol(f, provider, [instrument], ["PROVIDER", "CONDITION"], ["APPROACH", "NEGOTIATE", "EXECUTE_COMMITMENT"]);
    const profile = { id: randomUUID(), revision: 1, instrument, environment: "DISPOSABLE", jurisdiction: "DISPOSABLE_REGISTERED_DOMAIN",
      legalBasisDigest: capitalDigest("Hypothetical exact " + instrument), activityAuthorityDigest: capitalDigest("Declared development activity"),
      professionalIssuerIds: [profActor.public.id], identityIssuerIds: [idActor.public.id], settlementIssuerIds: [receiver.public.id], humanMeterIssuerIds: [meter.public.id],
      receivingPredicate: "RECEIVER_CONFIRMED_AND_SETTLEMENT_FINAL", operationCostCeilingMicroUSD: "2500", independentCheckerDigest: method.checkerDigest,
      providerInterfaceRef: { owner: "S6", id: provider.public.origin, version: "capital-disposable-http-v1", contentDigest: CAPITAL_PROVIDER_INTERFACE_DIGEST },
      admissionRef: null, qualified: false, activated: false, legalStatusSemantics: "EXACT_PROFESSIONAL_DETERMINATION_WITH_MATERIAL_CONDITION_INVENTORY",
      permittedRootTypes: ["external_organization"], executionRequirements: ["Original exact source and independent professional"],
      validUntil: new Date(Math.min(Date.now() + 3600000, f.originalDeadline ?? Infinity)).toISOString(), revoked: false };
    if (options.shadowDebtProfile) {
      for (let n = 0; n < 64 && capitalDigest(profile) < "8"; n++) profile.id = randomUUID();
      assert(capitalDigest(profile) >= "8", "Finite original selected-profile digest preparation");
    }
    const source = await originalEvidence(f, "v4:profile:" + profile.id, canonicalCapital(profile), profile, true);
    await context.admin().query("INSERT INTO finnor_os.v4_instrument_profiles(tenant_id,principal_id,profile_id,revision,body,content_digest,source_evidence_version_id) VALUES($1,$2,$3,1,$4::jsonb,$5,$6)",
      [f.tenant, f.principal, profile.id, canonicalCapital(profile), capitalDigest(profile), source.versionId]);
    profiles.push(profile); domainActors[instrument] = { provider, identity: idActor, professional: profActor, receiver, meter };
    if (instrument !== "FUND_LP") { providerIds.push(providerEntity); recipientIds.push(representative); }
  }
  if (options.shadowDebtProfile) {
    const shadow = { ...profiles[0], id: "00000000-0000-4000-8000-000000000001", revoked: true };
    for (let n = 0; n < 64 && capitalDigest(shadow) >= "8"; n++) {
      shadow.activityAuthorityDigest = capitalDigest("Separate revoked development profile " + n);
    }
    assert(capitalDigest(shadow) < "8", "Finite original earlier content-digest profile preparation");
    const source = await originalEvidence(f, "v4:profile:" + shadow.id, canonicalCapital(shadow), shadow, true);
    await context.admin().query("INSERT INTO finnor_os.v4_instrument_profiles(tenant_id,principal_id,profile_id,revision,body,content_digest,source_evidence_version_id) VALUES($1,$2,$3,1,$4::jsonb,$5,$6)",
      [f.tenant, f.principal, shadow.id, canonicalCapital(shadow), capitalDigest(shadow), source.versionId]);
    f.shadowProfile = shadow;
    await artifact(name + "/original-unselected-revoked-profile.json", { shadow, source, selectedProfileIds: profiles.map(p => p.id),
      enrolledProfiles: 3, ownerOrdering: "content_digest", profileDigestPreparationBound: 64, programmeDeadlineOrBudgetChanged: false });
  }
  if (options.activityReview) { providerIds.splice(1); recipientIds.splice(1); }
  const programmeId = randomUUID(), rights = (await context.admin().query("SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1", [f.tenant])).rows[0].revision;
  const disclosure = await originalEvidence(f, "original-disclosure-" + programmeId, "V4_PRIVATE_SYNTHETIC_CANARY_" + programmeId);
  const sourceRevision = (await revisions(f.ctx, ["evidence:" + disclosure.sourceId]))[0]!.revision;
  const expires = new Date(Math.min(Date.now() + programmeWallMs, f.originalDeadline ?? Infinity)).toISOString(),
    until = new Date(Math.min(Date.now() + 3600000, f.originalDeadline ?? Infinity)).toISOString();
  const disclosureBody = { evidenceVersionId: disclosure.versionId, contentDigest: capitalDigest("V4_PRIVATE_SYNTHETIC_CANARY_" + programmeId),
    sourceRevision, rightsRevision: rights, principalId: f.principal, programmeId, purpose: "ORIGINAL_DISPOSABLE_FINANCING",
    consentRef: "EXPLICIT_GENERATED_DISPOSABLE_CONSENT_NOT_REAL_DATA", confidentiality: "CAPITAL_PRIVATE",
    permittedProviderIds: providerIds, permittedChannels: ["capital-disposable-http-v1"], validUntil: until, retentionUntil: until, acceptedLimitations: [] };
  await context.admin().query("INSERT INTO finnor_os.s1_capital_disclosures(tenant_id,principal_id,programme_id,work_id,evidence_version_id,source_id,body,content_digest,valid_until,retention_until) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$9)",
    [f.tenant, f.principal, programmeId, f.workId, disclosure.versionId, disclosure.sourceId, canonicalCapital(disclosureBody), capitalDigest(disclosureBody), until]);
  const work = await resolveDecisionWork(f.ctx, f.workId);
  const authority = { id: randomUUID(), revision: 1, issuingPrincipalId: f.principal, legalEntityIds: [f.root.entityId],
    jurisdictions: ["DISPOSABLE_REGISTERED_DOMAIN"], instruments: ["CORPORATE_DEBT", "TRANSACTION_CO_INVESTMENT_EQUITY", "FUND_LP"],
    activities: ["RESEARCH", "APPROACH", "DISCLOSE", "NEGOTIATE"].map(activity => ({ activity, actorIds: [f.principal], channelIds: ["capital-disposable-http-v1"], professionalRequired: false })),
    permittedProviderIds: providerIds, suppressedProviderIds: [], permittedRecipientIds: recipientIds, templates: [capitalDigest("Frozen disposable exact template")],
    disclosurePurpose: disclosureBody.purpose, legalReviewEvidenceRef: "DEVELOPMENT_NO_FIELD_LEGAL_ACTIVATION", offeringRoute: "DISPOSABLE_ONLY",
    compensationRules: "No real compensation or financial attribution", policyRevision: "v4-disposable-v1",
    validFrom: new Date(Date.now() - 1000).toISOString(), validUntil: until, revoked: false, maxContacts: 8, maxExposureMinor: "12000000000",
    pricingBounds: { minRate: { numerator: "0", denominator: "1" }, maxRate: { numerator: "1", denominator: "10" }, maxFeesMinor: "0" },
    permittedGuaranteeIds: options.allowedGuarantee ? ["development-allowed-guarantee"] : [], approvalConditions: [], escalationConditions: [], stopConditions: ["Original expiry or bounded budget exhausted"] };
  let activityReviewSource: { sourceId: string; versionId: string } | undefined;
  if (options.activityReview) {
    const group = domainActors.CORPORATE_DEBT, versionId = randomUUID();
    authority.legalReviewEvidenceRef = versionId;
    authority.activities = authority.activities.map(a => ({ ...a, professionalRequired: true }));
    const review = await (options.activityReview === "SHARED_KEY" ? group.provider : group.professional).rpc("ACTIVITY_REVIEW", {
      schema: "finnor.v4.professional-activity-review.v1", issuerId: group.professional.public.id, tenantId: f.tenant,
      programmeId, principalId: f.principal, legalEntityId: f.root.entityId, authorityDigest: capitalDigest(authority),
      activities: authority.activities.map(a => a.activity), instruments: ["CORPORATE_DEBT"], providerIds, recipientIds,
      channels: ["capital-disposable-http-v1"], satisfiedApprovalConditionIds: [], legalBasisDigest: profiles[0].legalBasisDigest,
      validFrom: authority.validFrom, validUntil: until,
    });
    activityReviewSource = await originalEvidence(f, "v4:activity-review:" + programmeId, canonicalCapital(review), review, true, versionId);
  }
  const signedAuthority = await authorityActor.rpc("SIGN", authority);
  const money = { legalEntityId: f.root.entityId, ownerShare: { numerator: "1", denominator: "1" }, amountMinor: "12000000000", currency: "USD",
    minorUnits: 2, unit: "CURRENCY_MINOR_UNIT", timeBasis: "ORIGINAL_APPROVED_REQUIREMENT", valuationDate: new Date().toISOString(), rounding: "EXACT" };
  const keys = ["rights:tenant", "work-inputs:" + f.workId, "canonical:" + f.root.entityType + ":" + f.root.entityId,
    ...profiles.slice(0, 2).map(p => "v4-profile:" + p.id), `v4-disclosure:${programmeId}:${disclosure.versionId}`];
  if (activityReviewSource) keys.push("evidence:" + activityReviewSource.sourceId);
  f.ownerFixture = { ...f, mandate: f.mandate };
  f.mandate = { schema: "finnor.s4.financing-mandate.v1", programmeId, tenantId: f.tenant, principalId: f.principal,
    workId: f.workId, workInputId: work.inputId, workInputDigest: work.inputDigest, root: f.root, legalEntityId: f.root.entityId,
    approvedProgrammeRef: policy.ref, approvedTermsDigest: capitalDigest(policy.problem), approvalDecisionId: randomUUID(),
    authorityProfileId: authority.id, domainProfileIds: profiles.slice(0, 2).map(p => p.id), budgetGrantRef: cleared.certificate.ref,
    requirement: money, tranches: [{ id: "principal", purpose: "PRINCIPAL", requiredMinor: money.amountMinor, currency: "USD",
      dueAt: new Date(Math.min(Date.now() + 300000, f.originalDeadline ?? Infinity)).toISOString(), instruments: ["CORPORATE_DEBT", "TRANSACTION_CO_INVESTMENT_EQUITY"] }],
    providerIds, disclosureRefs: [disclosureBody], readinessBasis: "EFFECTIVE_UNDRAWN_AND_RECONCILED_FUNDING", readinessRevision: "original-v1",
    acceptedConversions: [], prohibitedCovenantIds: [], prohibitedCrossDefaults: [], maxEconomicOwnership: { numerator: "1", denominator: "2" },
    maxVotingOwnership: { numerator: "1", denominator: "2" }, requiredCollateralConsents: [], expiresAt: expires, waitingUntil: expires,
    contactGrant: 8, maxCostMicroUSD: "100000000", maxHumanSeconds: 900, maxSteps: 32, stoppingRules: ["Original deadline and bounded grant"],
    sourceRevisionVector: (await revisions(f.ctx, keys)).map(({ key, revision }) => ({ key, revision })) };
  if (options.additionalTranche) {
    f.mandate.tranches[0].requiredMinor = "6000000000";
    f.mandate.tranches.push({ ...f.mandate.tranches[0], id: "secondary" });
  }
  const approval = await authorityActor.rpc("SIGN", { schema: "finnor.s4.capital-approval.v1", tenantId: f.tenant, principalId: f.principal,
    programmeId, mandateDigest: capitalDigest(f.mandate), authorityDigest: capitalDigest(authority) });
  await context.admin().query("INSERT INTO finnor_os.authority_decisions(id,tenant_id,employee_id,work_id,operation,capability,resource_type,resource_id,risk,outcome,reason_code,authority_revision,evidence) VALUES($1,$2,$3,$4,'approval','capital:financing-mandate','financing_programme',$5,'high','allowed','independently_signed_development_approval',$6,$7::jsonb)",
    [f.mandate.approvalDecisionId, f.tenant, f.principal, f.workId, programmeId, rights, JSON.stringify({ capitalApproval: { ...approval, issuerId: authorityIssuer.id } })]);
  f.request = { mandate: f.mandate, authority: { ...signedAuthority, issuerId: authorityIssuer.id }, idempotencyKey: "original-" + name };
  f.domainActors = domainActors; f.profiles = profiles; f.disclosure = disclosure; f.authorityActor = authorityActor; f.authorityIssuer = authorityIssuer;
  const definition = { programmeId, tenantId: f.tenant, principalId: f.principal, requirement: money, debtMinor: "8000000000", equityMinor: "4000000000",
    facilityId: randomUUID(), securityId: randomUUID(), conditional: true, availableFrom: new Date(Date.now() - 1000).toISOString(),
    expiresAt: until, authorityDigest: capitalDigest(authority), responseDelayMs: delayed ? 20000 : 0,
    legalBasisDigests: Object.fromEntries(profiles.map(p => [p.instrument, p.legalBasisDigest])),
    providers: Object.fromEntries(Object.entries(domainActors).map(([instrument, d]: any) => [instrument, { entityId: d.provider.public.legalEntityId, actorId: d.provider.public.actorId }])),
    issuerLocalIds: options.issuerLocalIds ?? false, ...(options.providerCostMicroUSD ? { providerCostMicroUSD: options.providerCostMicroUSD } : {}),
    providerCostFinal: options.providerCostFinal ?? true };
  for (const group of Object.values(domainActors) as any[]) for (const a of Object.values(group) as any[]) await a.rpc("DEFINE", definition);
  if (options.existing) {
    const checked = await originalWork(options.existing);
    assertOriginalWorkUnchanged(original!, checked);
    assert.equal(f.mandate.workInputId, checked.work.inputId, "CAPITAL_CHAIN_MANDATE_INPUT_CHANGED");
    assert.equal(f.mandate.workInputDigest, checked.work.inputDigest, "CAPITAL_CHAIN_MANDATE_INPUT_DIGEST_CHANGED");
    remainingCampaign();
  }
  f.definition = definition; await artifact(name + "/original-input.json", { request: f.request, intake, definition, profiles });
  return f;
}
return { fixture, originalEvidence, enrol };
}
