/** Independent original-record oracle. No producer controller, mechanics,
 * reconciliation, permission flag or success interpretation is imported. */
import { createServer } from "node:http";
import { randomUUID, sign, createPublicKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { z } from "zod";
import {
  BilateralAuthoritySchema, BilateralDomainSchema, BilateralGrantSchema, BilateralMandateSchema,
  BilateralOriginalRecordsSchema, BilateralSourceProfileSchema, BilateralTermsSchema, RelationshipPolicySchema,
  type BilateralCheck, type BilateralBounds, type BilateralTerms, type VReference,
} from "@finnor/shared-types";
import { canonical, digest, verifySigned } from "../../../governed-execution/src/canonical";
import { brokerPrivateFile } from "../../../governed-execution/src/broker-io";
import { invokeBilateralInterface } from "../interface-synthesis/bilateral-adapter";

const configPath = process.env.FINNOR_V1_INDEPENDENT_CHECKER_CONFIG;
if (!configPath || process.env.NODE_ENV === "production" || process.env.FINNOR_V1_PROFILE !== "ordinary_disposable")
  throw Error("INDEPENDENT_DEVELOPMENT_CHECKER_CONFIGURATION_REQUIRED");
const privateFile = async (path: string) => (await brokerPrivateFile(path)).toString("utf8");
const config = z.object({
  schema: z.literal("finnor.bilateral-original-checker-config.v1"),
  databaseUrlPath: z.string(), receiptDatabaseUrlPath: z.string(), sourceConfigurationPath: z.string(),
  signerPath: z.string(), requestTokenPath: z.string(), port: z.number().int().min(0).max(65535),
}).strict().parse(JSON.parse(await privateFile(configPath)));
const pool = new pg.Pool({ connectionString: (await privateFile(config.databaseUrlPath)).trim(), max: 2 });
const receipts = new pg.Pool({ connectionString: (await privateFile(config.receiptDatabaseUrlPath)).trim(), max: 1 });
const signer = await privateFile(config.signerPath), requestToken = (await privateFile(config.requestTokenPath)).trim();
const publicKey = createPublicKey(signer).export({ type: "spki", format: "pem" }).toString();
const spec = await readFile(new URL("./checker-spec.md", import.meta.url));
const files = ["checker-service.mts", "checker-spec.md"].map(path => new URL("./" + path, import.meta.url))
  .concat([new URL("../interface-synthesis/bilateral-adapter.ts", import.meta.url),
    new URL("../../../shared-types/src/bilateral-opportunities.ts", import.meta.url),
    new URL("../../../governed-execution/src/canonical.ts", import.meta.url),
    new URL("../../../governed-execution/src/broker-io.ts", import.meta.url),
    new URL("../../../governed-execution/src/protocol.ts", import.meta.url)]);
const fileIdentity = async () => Promise.all(files.map(async path => ({ name: path.pathname.split("/").slice(-2).join("/"), digest: digest(await readFile(path)) })));
const loadedFiles = await fileIdentity(), specificationDigest = digest(spec);
const identity: VReference = {
  owner: "S8", id: "independent-bilateral-original-record-checker", revision: "1",
  contentDigest: digest({ files: loadedFiles, specificationDigest, node: process.version, credentialDomain: "SEPARATE_ORIGINAL_RECORD_READ_ONLY_CHECKER" }),
};
const exactRef = (owner: string, id: string, revision: number | string, body: unknown): VReference =>
  ({ owner, id, revision: String(revision), contentDigest: digest(body) });
const Input = z.object({ tenantId: z.string().uuid(), principalId: z.string().uuid(), programmeId: z.string().uuid(),
  candidateId: z.string().uuid(), termsId: z.string().uuid() }).strict();

function independentMechanics(t: BilateralTerms, b: BilateralBounds, buyer: string, currency: string) {
  const price = BigInt(t.purchasePrice.amount), close = Date.parse(t.proposedClosingAt);
  let sum = 0n, deferred = 0n, closingCount = 0, okay = true;
  for (const item of t.consideration) {
    const amount = BigInt(item.amount), when = Date.parse(item.dueAt);
    sum += amount;
    if (amount <= 0n || when < close) okay = false;
    if (item.condition === "AT_CLOSING") { closingCount++; if (when !== close) okay = false; }
    else { deferred += amount; if (when - close > b.maximumDeferredDays * 86400000) okay = false; }
  }
  return okay && closingCount === 1 && sum === price && price > 0n &&
    deferred * 10000n <= price * BigInt(b.maximumDeferredBps) &&
    price >= BigInt(b.minimumPurchaseMinorUnits) && price <= BigInt(b.maximumPurchaseMinorUnits) &&
    t.controlShareBps > 5000 && t.controlShareBps >= b.minimumControlBps && t.controlShareBps <= b.maximumControlBps &&
    t.controlShareBps + t.retainedShareBps === 10000 && t.managementParticipationBps <= t.retainedShareBps &&
    t.managementParticipationBps <= b.maximumManagementParticipationBps &&
    close >= Date.parse(b.earliestClosingAt) && close <= Date.parse(b.latestClosingAt) &&
    (t.managementContinuity === "NONE" || b.allowProposedManagementContinuity) &&
    t.buyerEntityId === buyer && t.purchasePrice.legalEntityId === buyer && t.purchasePrice.currency === currency &&
    t.purchasePrice.ownerShare.numerator === "1" && t.purchasePrice.ownerShare.denominator === "1";
}
function expectedDisclosure(a: z.infer<typeof BilateralAuthoritySchema>, t: BilateralTerms, intent: any, p: any) {
  const question = intent.kind === "CONFIRM"
    ? "Please explicitly confirm consideration of this buyer and these exact nonbinding terms, with timing or an agreed permitted diligence step."
    : intent.kind === "INQUIRE"
      ? "Please state your transaction objectives and constraints. Nothing here assumes willingness to sell."
      : "Would you consider this nonbinding transaction with this buyer? Please state constraints or a counterproposal; silence is not agreement.";
  return [
    `${a.representativeDisplayName} represents ${a.firmDisplayName}, buyer legal entity ${t.buyerEntityId}.`,
    a.automationDisclosure,
    "This is a nonbinding preliminary proposal, not an LOI, underwriting, a funding or IC approval, exclusivity, legal effectiveness or an employment guarantee.",
    t.managementContinuity === "NONE" ? "No management-continuity condition is proposed."
      : "Management continuity for 12 months is a proposed contractual condition subject to definitive agreement, not an accomplished fact or guaranteed employment.",
    question,
    `Programme ${p.id}; candidate ${intent.candidate_id}; action ${intent.action_id}; terms revision ${intent.terms_revision}; terms digest ${digest(t)}.`,
    `Exact proposed terms (amounts in currency minor units, not rounded execution amounts): ${canonical(t)}`,
    "You may refuse, opt out or withdraw consent. We will suppress further approaches across our agents and mailboxes.",
  ].join("\n");
}
async function check(input: z.infer<typeof Input>): Promise<BilateralCheck> {
  const usage = process.resourceUsage(), start = performance.now(), c = await pool.connect();
  try {
    if (digest(loadedFiles) !== digest(await fileIdentity())) throw Error("INDEPENDENT_LOADED_CHECKER_CHANGED");
    const role = (await c.query("SELECT current_user,rolsuper,rolbypassrls,has_table_privilege(current_user,'finnor_os.v1_artifacts','INSERT') can_write FROM pg_roles WHERE rolname=current_user")).rows[0];
    if (role.current_user !== "finnor_v1_checker" || role.rolsuper || role.rolbypassrls || role.can_write)
      throw Error("INDEPENDENT_READ_ONLY_NONPRIVILEGED_ROLE_REQUIRED");
    await c.query("BEGIN READ ONLY");
    await c.query("SET LOCAL statement_timeout=10000");
    await c.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true),set_config('app.bilateral_programme_id',$3,true)",
      [input.tenantId, input.principalId, input.programmeId]);
    const p = (await c.query("SELECT * FROM finnor_os.v1_programmes WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [input.tenantId, input.principalId, input.programmeId])).rows[0];
    const candidate = (await c.query("SELECT * FROM finnor_os.v1_candidates WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND programme_id=$4",
      [input.tenantId, input.principalId, input.candidateId, input.programmeId])).rows[0];
    const termsRow = (await c.query("SELECT * FROM finnor_os.v1_terms WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND candidate_id=$4",
      [input.tenantId, input.principalId, input.termsId, input.candidateId])).rows[0];
    if (!p?.frozen_manifest || !candidate || !termsRow) throw Error("INDEPENDENT_ACCEPTED_ORIGINAL_IDENTITIES_REQUIRED");
    const reasons: string[] = [], now = Date.now(), checkedAt = new Date(now).toISOString(), intake = p.intake, frozen = p.frozen_manifest;
    const require = (value: boolean, reason: string) => { if (!value) reasons.push(reason); return value; };
    const record = async (ref: VReference) => {
      const row = (await c.query(`SELECT v.*,h.state,h.revision head FROM finnor_os.primary_governance_versions v
        JOIN finnor_os.primary_governance_heads h ON h.tenant_id=v.tenant_id AND h.id=v.id
        WHERE v.tenant_id=$1 AND v.id=$2 AND v.revision=$3`, [input.tenantId, ref.id, Number(ref.revision)])).rows[0];
      if (!row || row.semantic_owner !== ref.owner || row.digest !== ref.contentDigest || digest(row.body) !== row.digest)
        throw Error("INDEPENDENT_EXACT_OWNER_RECORD_UNAVAILABLE");
      require(row.state === "CURRENT" && row.head === row.revision && row.body.environment === "DEVELOPMENT" &&
        now >= Date.parse(row.body.validFrom ?? "1970-01-01") && now < Date.parse(row.body.expiresAt), "CURRENT_OWNER_PROFILE_REQUIRED");
      return row.body;
    };
    const mandate = BilateralMandateSchema.parse(await record(intake.mandateRef));
    const authority = BilateralAuthoritySchema.parse(await record(intake.authorityProfileRef));
    const source = BilateralSourceProfileSchema.parse(await record(intake.sourceProfileRef));
    const domain = BilateralDomainSchema.parse(await record(intake.domainProfileRef));
    const policy = RelationshipPolicySchema.parse(await record(intake.relationshipPolicyRef));
    const grant = BilateralGrantSchema.parse(await record(intake.budgetGrantRef));
    const terms = BilateralTermsSchema.parse(termsRow.body);
    const originalRead = await invokeBilateralInterface(source, {
      schema: "finnor.bilateral-read.v1", tenantId: input.tenantId, principalId: input.principalId, programmeId: p.id,
      buyerEntityId: mandate.buyerEntityId, mandateDigest: intake.mandateRef.contentDigest,
      sourceProfileDigest: intake.sourceProfileRef.contentDigest, eligibleCompanyIds: intake.eligibleCompanyIds,
      universeDefinition: intake.universeDefinition, operation: "CHECK_ORIGINALS", candidateId: candidate.id,
      actionId: candidate.current_action_id, afterEventId: null,
    }, { independent: true, configurationPath: config.sourceConfigurationPath });
    const originals = BilateralOriginalRecordsSchema.parse(originalRead.value), snapshot = originals.snapshot.body;
    require(verifySigned(snapshot, originals.snapshot.signature, source.responsePublicKeyPem) &&
      digest(originals.snapshot) === digest(frozen.snapshot) && snapshot.tenantId === input.tenantId &&
      snapshot.buyerEntityId === mandate.buyerEntityId && snapshot.mandateDigest === intake.mandateRef.contentDigest &&
      snapshot.sourceProfileDigest === intake.sourceProfileRef.contentDigest &&
      digest(snapshot.eligibleCompanyIds.slice().sort()) === digest(intake.eligibleCompanyIds.slice().sort()) &&
      snapshot.universeDefinition === intake.universeDefinition && Date.parse(snapshot.knowledgeCut) <= now &&
      now < Date.parse(snapshot.expiresAt), "ORIGINAL_FROZEN_SOURCE_CUT_MISMATCH");
    const company = snapshot.companies.find(v => v.companyId === candidate.company_id);
    if (!company) throw Error("INDEPENDENT_ORIGINAL_COMPANY_UNAVAILABLE");
    const canonicalCompany = (await c.query("SELECT to_jsonb(o) body FROM finnor_os.external_organizations o WHERE tenant_id=$1 AND id=$2",
      [input.tenantId, company.companyId])).rows[0]?.body;
    const person = (await c.query("SELECT to_jsonb(p) body FROM finnor_os.external_contacts p WHERE tenant_id=$1 AND id=$2",
      [input.tenantId, company.counterpartyId])).rows[0]?.body;
    const identityAndRole = require(company.identityStatus === "ESTABLISHED" && !!canonicalCompany &&
      canonicalCompany.name === company.legalName && person?.external_organization_id === company.companyId &&
      company.counterpartyId === candidate.counterparty_id && ["OWNER", "AUTHORIZED_REPRESENTATIVE"].includes(company.role) &&
      company.representationActivities.includes("CONSIDER_NONBINDING_TRANSACTION") &&
      company.companySource.exactFields.includes("identity") && company.companySource.authorityScope.includes("ESTABLISH_COMPANY_IDENTITY") &&
      company.roleSource.exactFields.includes("role") && company.roleSource.authorityScope.includes("ESTABLISH_REPRESENTATION") &&
      company.companySource.integrityWitness === digest({ companyId: company.companyId, legalName: company.legalName, identityStatus: company.identityStatus }) &&
      company.roleSource.integrityWitness === digest({ companyId: company.companyId, counterpartyId: company.counterpartyId,
        role: company.role, representationActivities: company.representationActivities }), "INDEPENDENT_IDENTITY_AND_REPRESENTATION_UNESTABLISHED");
    const active = (state: string) => !["rejected", "closed", "lost", "withdrawn", "cancelled", "archived"].includes(state);
    const frozenPipelineAbsence = require(snapshot.pipeline.authoritative && snapshot.pipeline.completeAuthorizedVisibility &&
      snapshot.pipeline.coveredCompanyIds.includes(company.companyId) && snapshot.pipeline.coveredBuyerEntityIds.includes(mandate.buyerEntityId) &&
      snapshot.pipeline.source.authorityScope.includes("COMPLETE_FIRM_PIPELINE") &&
      !snapshot.pipeline.entries.some(e => e.companyId === company.companyId && e.buyerEntityId === mandate.buyerEntityId && active(e.state)) &&
      !frozen.canonicalPipeline.some((e: any) => e.target === company.companyId &&
        (!e.buyer || e.buyer === mandate.buyerEntityId) && active(e.state)), "FROZEN_ACTIVE_PIPELINE_ABSENCE_NOT_ESTABLISHED");
    require(company.origination !== "UNRESOLVED" && company.originationEvidence.exactFields.includes("origination") &&
      company.originationEvidence.authorityScope.includes("ESTABLISH_PROCESS_AT_CUT") &&
      company.originationEvidence.integrityWitness === digest({ companyId: company.companyId, origination: company.origination,
        priorRelationshipEvidence: company.priorRelationshipEvidence }), "ORIGINATION_CLASS_UNRESOLVED");
    const intents = (await c.query(`SELECT * FROM finnor_os.s6_contact_intents
      WHERE tenant_id=$1 AND programme_id=$2 AND candidate_id=$3 AND terms_digest=$4 ORDER BY created_at`,
      [input.tenantId, p.id, candidate.id, termsRow.digest])).rows;
    const intent = intents.find(i => i.action_id === candidate.current_action_id), action = intent ?
      (await c.query("SELECT * FROM finnor_os.domain_actions WHERE tenant_id=$1 AND id=$2", [input.tenantId, intent.action_id])).rows[0] : null;
    const authorization = intent ? (await c.query("SELECT * FROM finnor_os.s6_standing_contact_authorizations WHERE tenant_id=$1 AND action_id=$2",
      [input.tenantId, intent.action_id])).rows[0] : null;
    const effect = action?.business_effect_id ? (await c.query("SELECT * FROM finnor_os.business_effects WHERE tenant_id=$1 AND id=$2",
      [input.tenantId, action.business_effect_id])).rows[0] : null;
    const sender = (await c.query("SELECT * FROM finnor_os.communication_identities WHERE tenant_id=$1 AND id=$2",
      [input.tenantId, authority.communicationIdentityId])).rows[0];
    const actualTransport = intent ? originals.transport.find(v => v.body.actionId === intent.action_id) : null;
    const expectedPayload = intent ? { recipient: { partyType: "external_contact", partyId: company.counterpartyId }, channel: "email",
      subject: `Bilateral ${intent.kind.toLowerCase()} ${p.id}:${candidate.id}:${termsRow.revision}`,
      body: expectedDisclosure(authority, terms, intent, p), workRef: { workId: p.work_id },
      communicationIdentityRef: { communicationIdentityId: authority.communicationIdentityId }, purpose: "private-market-bilateral" } : null;
    const actor = (await c.query("SELECT role,status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2",
      [input.tenantId, input.principalId])).rows[0];
    const latestInput = (await c.query("SELECT id,to_jsonb(i) body FROM finnor_os.work_inputs i WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
      [input.tenantId, p.work_id])).rows[0];
    const deps = [...frozen.dependencies, ...(frozen.candidateDependencies[company.companyId] ?? [])];
    const changed: string[] = [];
    for (const dep of deps) {
      const current = Number((await c.query("SELECT revision FROM finnor_os.p4_source_revisions WHERE tenant_id=$1 AND key=$2",
        [input.tenantId, dep.key])).rows[0]?.revision ?? 0);
      if (current !== dep.revision) changed.push(dep.key);
    }
    const suppression = (await c.query(`WITH RECURSIVE subjects(subject) AS(
      SELECT unnest($2::text[]) UNION SELECT CASE WHEN a.subject_key=s.subject THEN a.canonical_key ELSE a.subject_key END
      FROM subjects s JOIN finnor_os.s6_relationship_aliases a ON a.tenant_id=$1 AND (a.subject_key=s.subject OR a.canonical_key=s.subject))
      SELECT e.id FROM finnor_os.s6_relationship_events e WHERE e.tenant_id=$1 AND
      e.kind IN('REFUSAL','OPT_OUT','WITHDRAWAL') AND e.subject_keys&&ARRAY(SELECT subject FROM subjects) LIMIT 1`,
      [input.tenantId, ["company:" + company.companyId, "person:" + company.counterpartyId,
        "endpoint:" + digest(input.tenantId + ":" + String(person?.business_email ?? "").trim().toLowerCase())]])).rows[0];
    const t = actualTransport?.body;
    const authorizedExactCommunication = require(!!intent && !!action && !!effect && !!authorization && !!sender &&
      actor?.role === "owner" && actor.status === "active" && !p.invalidated && !p.cancellation_requested_at && !suppression &&
      !changed.length && latestInput?.id === p.work_input_id && digest(latestInput.body) === p.work_input_digest &&
      authority.issuingPrincipalId === input.principalId && authority.professionalRequirements.length === 0 &&
      authority.legalEntityIds.includes(mandate.buyerEntityId) && authority.attachments === "FORBIDDEN" &&
      ["CONTACT", "DISCLOSE", "PROPOSE_NONBINDING", ...(intent?.kind === "CONFIRM" ? ["NEGOTIATE_WITHIN_BOUNDS"] : [])].every(activity =>
        authority.activities.some(a => a.activity === activity && a.actorIds.includes(input.principalId) && a.channel === "email")) &&
      digest(mandate.authorityProfileRef) === digest(intake.authorityProfileRef) &&
      digest(mandate.relationshipPolicyRef) === digest(intake.relationshipPolicyRef) &&
      digest(authority.relationshipPolicyRef) === digest(intake.relationshipPolicyRef) && policy.firmEntityId === mandate.buyerEntityId &&
      digest(domain.checker.identity) === digest(identity) && domain.checker.specificationDigest === specificationDigest &&
      digest(domain.checker.publicKeyPem) === digest(publicKey) &&
      now < Math.min(Date.parse(mandate.deadline), Date.parse(grant.originalProgrammeDeadline), Date.parse(source.retentionUntil)) &&
      digest(intent?.payload) === digest(expectedPayload) && digest(action?.payload) === digest(expectedPayload) &&
      effect?.effect?.approval.required === true && effect.effect.approval.typedConfirmation === false &&
      authorization?.business_effect_id === effect?.id && authorization?.effect_hash === effect?.semantic_hash &&
      authorization?.binding_digest === digest(intent?.activity_binding) && authorization?.issuer_id === input.principalId &&
      !!actualTransport && verifySigned(t, actualTransport.signature, source.responsePublicKeyPem) &&
      t?.outcome === "ACCEPTED" && t.tenantId === input.tenantId && t.programmeId === p.id &&
      t.companyId === company.companyId && t.participantId === company.counterpartyId &&
      t.communicationIdentityId === authority.communicationIdentityId && t.provider === source.transportReadback.provider &&
      t.recipientAddressDigest === digest(String(person?.business_email ?? "").trim().toLowerCase()) &&
      t.senderAddressDigest === digest(String(sender?.address ?? sender?.email ?? "").trim().toLowerCase()) &&
      t.subjectDigest === digest(expectedPayload?.subject) && t.bodyDigest === digest(expectedPayload?.body) &&
      Date.parse(t.observedAt) <= now && now < Date.parse(t.expiresAt) &&
      now < Date.parse(source.transportReadback.validUntil) &&
      now - Date.parse(t.observedAt) <= source.transportReadback.maximumObservationAgeMs,
    "EXACT_CURRENT_AUTHORIZED_PHYSICAL_COMMUNICATION_NOT_ESTABLISHED");
    const validEvents = originals.events.filter(v => verifySigned(v.body, v.signature, company.participantPublicKeyPem) &&
      v.body.tenantId === input.tenantId && v.body.programmeId === p.id && v.body.companyId === company.companyId &&
      v.body.participantId === company.counterpartyId);
    require(!validEvents.some(v => ["REFUSAL", "OPT_OUT", "WITHDRAWAL"].includes(v.body.kind)), "PARTICIPANT_CONTACT_OR_INTEREST_WITHDRAWN");
    const event = validEvents.filter(v => v.body.kind === "INTEREST" && v.body.actionId === intent?.action_id)
      .sort((a, b) => Date.parse(b.body.observedAt) - Date.parse(a.body.observedAt))[0];
    const reply = event?.body;
    const exactPositiveInterest = require(!!reply && reply.direct && reply.buyerEntityId === mandate.buyerEntityId &&
      reply.termsDigest === termsRow.digest && reply.revision === termsRow.revision && !!reply.terms &&
      digest(reply.terms) === termsRow.digest && !!reply.nextStep &&
      reply.statement === `I confirm interest in considering the nonbinding transaction with buyer ${mandate.buyerEntityId} on terms ${termsRow.digest}.` &&
      Date.parse(reply.observedAt) >= Date.parse(t?.observedAt ?? "9999-01-01") && Date.parse(reply.observedAt) <= now &&
      now - Date.parse(reply.observedAt) <= mandate.confirmationMaximumAgeMs && now < Date.parse(reply.expiresAt) &&
      Date.parse(reply.nextStep.agreedAt) >= Date.parse(t?.observedAt ?? "9999-01-01") &&
      Date.parse(reply.nextStep.agreedAt) <= now && Date.parse(reply.nextStep.scheduledAt) >= Date.parse(reply.nextStep.agreedAt),
    "EXACT_FRESH_POSITIVE_BUYER_TERMS_AND_NEXT_STEP_UNESTABLISHED");
    const fit = mandate.preliminaryPredicates.every(pred => {
      const fact = company.facts[pred.field], witness = company.factSources[pred.field];
      if (fact === null || fact === undefined || !witness || !witness.exactFields.includes(pred.field) ||
        !witness.authorityScope.includes("ESTABLISH_PRELIMINARY_FIELD") || Date.parse(witness.observedAt) > now ||
        now - Date.parse(witness.observedAt) > pred.maximumAgeMs ||
        witness.integrityWitness !== digest({ companyId: company.companyId, field: pred.field, value: fact,
          observedAt: witness.observedAt, revision: witness.revision })) return false;
      if (pred.operator === "EQ") return fact === pred.expected;
      if (typeof fact !== "string" || typeof pred.expected !== "string" ||
        !/^-?(0|[1-9]\d{0,95})$/.test(fact) || !/^-?(0|[1-9]\d{0,95})$/.test(pred.expected)) return false;
      return pred.operator === "GTE" ? BigInt(fact) >= BigInt(pred.expected) : BigInt(fact) <= BigInt(pred.expected);
    });
    const mechanicsAndPreliminaryFit = require(digest(terms) === termsRow.digest && candidate.current_terms_id === termsRow.id &&
      terms.companyId === company.companyId && independentMechanics(terms, mandate.bounds, mandate.buyerEntityId, mandate.currency) &&
      independentMechanics(terms, authority.negotiationBounds, mandate.buyerEntityId, mandate.currency) && fit,
    "EXACT_MECHANICS_OR_REQUIRED_PRELIMINARY_FIT_UNSUPPORTED");
    const gaps = intake.underwritingGapAssertions.filter((a: any) => a.semantics.legalEntityId === company.companyId);
    const explicitIndicationAndGaps = require(terms.indicationBindingStatus === "NONBINDING" &&
      ["NOT_UNDERWRITTEN", "NO_FUNDING_OR_IC_APPROVAL_CLAIM", "NO_EXCLUSIVITY", "NO_EMPLOYMENT_GUARANTEE", "NO_LEGAL_EFFECTIVENESS_CLAIM"]
        .every((value, index) => terms.exclusions[index] === value) &&
      gaps.every((a: any) => mandate.permittedFullDiligenceGapIds.includes(a.assertionId)) &&
      (!terms.managementContinuity.includes("12_MONTH") || expectedPayload?.body.includes("proposed contractual condition")),
    "NONBINDING_AND_UNRESOLVED_UNDERWRITING_SCOPE_NOT_EXPLICIT");
    const observationRefs = (await c.query("SELECT id,body FROM finnor_os.s1_bilateral_observations WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3",
      [input.tenantId, input.principalId, p.id])).rows.filter(r => r.body?.body?.companyId === company.companyId || r.body?.body?.schema === "finnor.bilateral-source-snapshot.v1")
      .map(r => exactRef("S1", r.id, 1, r.body));
    const usageEnd = process.resourceUsage();
    const expiresAt = reasons.length ? new Date(now + 15000).toISOString() : new Date(Math.min(Date.parse(reply?.expiresAt ?? snapshot.expiresAt),
      ...[mandate, authority, source, domain, policy, grant].map(v => Date.parse(v.expiresAt)),
      Date.parse(source.retentionUntil), Date.parse(mandate.deadline), Date.parse(grant.originalProgrammeDeadline),
      reply ? Date.parse(reply.observedAt) + mandate.confirmationMaximumAgeMs : now + 10000)).toISOString();
    await c.query("COMMIT");
    return {
      schema: "finnor.bilateral-check.v1", id: randomUUID(), result: reasons.length ? "REJECT" : "ACCEPT",
      reasons: [...new Set(reasons)], checkerIdentity: identity, specificationDigest,
      tenantId: input.tenantId, principalId: input.principalId, workId: p.work_id, workInputId: p.work_input_id,
      programmeId: p.id, candidateId: candidate.id, termsRef: exactRef("V1", termsRow.id, termsRow.revision, terms),
      sourceDigest: p.frozen_digest, mandateRef: intake.mandateRef, authorityProfileRef: intake.authorityProfileRef,
      domainProfileRef: intake.domainProfileRef, relationshipPolicyRef: intake.relationshipPolicyRef,
      dependencyDigest: digest(deps), rightsRevision: frozen.rightsRevision, checkedAt, expiresAt, observationRefs,
      conjuncts: { identityAndRole, frozenPipelineAbsence, authorizedExactCommunication, exactPositiveInterest,
        mechanicsAndPreliminaryFit, explicitIndicationAndGaps },
      usage: { cpuMicros: String(usageEnd.userCPUTime + usageEnd.systemCPUTime - usage.userCPUTime - usage.systemCPUTime),
        peakMemoryBytes: String(usageEnd.maxRSS * 1024), wallMs: performance.now() - start },
      excludedInterpretations: ["DOMAIN_ADMISSION", "PROFESSIONAL_ATTESTATION", "UNDERWRITTEN_INVESTMENT", "FUNDING_OR_IC_APPROVAL",
        "LEGAL_EFFECTIVENESS", "RECIPIENT_DELIVERY_FROM_TRANSPORT_ACCEPTANCE", "CAUSAL_INCREMENTAL_CREATION", "OWNER_VALUE"],
    };
  } catch (error) { await c.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { c.release(); }
}
const server = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store");
  if (req.url === "/identity" && req.method === "GET") {
    res.end(JSON.stringify({ identity, specificationDigest, publicKeyPem: publicKey, credentialDomain: "SEPARATE_ORIGINAL_RECORD_READ_ONLY_CHECKER" })); return;
  }
  if (req.url !== "/check" || req.method !== "POST" || req.headers.authorization !== "Bearer " + requestToken) {
    res.writeHead(403); res.end('{"code":"CHECKER_SCOPE_UNAVAILABLE"}'); return;
  }
  try {
    let raw = ""; for await (const bytes of req) { raw += bytes; if (Buffer.byteLength(raw) > 4096) throw Error("CHECKER_REQUEST_BOUND"); }
    const receipt = await check(Input.parse(JSON.parse(raw)));
    const signed = { body: receipt, signature: sign(null, Buffer.from(canonical(receipt)), signer).toString("base64") };
    const writer = await receipts.connect();
    try {
      const role = (await writer.query(`SELECT current_user,rolsuper,rolbypassrls,
        has_table_privilege(current_user,'finnor_os.v1_artifacts','INSERT') artifact_write
        FROM pg_roles WHERE rolname=current_user`)).rows[0];
      if (role.current_user !== "finnor_v1_receipt_writer" || role.rolsuper || role.rolbypassrls || role.artifact_write)
        throw Error("INDEPENDENT_RECEIPT_ONLY_WRITER_REQUIRED");
      await writer.query("BEGIN");
      await writer.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",
        [receipt.tenantId, receipt.principalId]);
      await writer.query(`INSERT INTO finnor_os.v1_claim_checks(tenant_id,principal_id,programme_id,candidate_id,id,body,signature,digest)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
      [receipt.tenantId, receipt.principalId, receipt.programmeId, receipt.candidateId, receipt.id,
        canonical(receipt), signed.signature, digest(signed)]);
      await writer.query("COMMIT");
    } catch (error) { await writer.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { writer.release(); }
    res.end(JSON.stringify(signed));
  } catch (error) {
    const predicate = String((error as Error).message).match(/^[A-Z][A-Z0-9_:]{0,159}$/)?.[0] ?? "INDEPENDENT_ORIGINAL_CHECK_UNAVAILABLE";
    res.writeHead(422); res.end(JSON.stringify({ code: "INDEPENDENT_CHECK_UNAVAILABLE", predicate }));
  }
});
await new Promise<void>(yes => server.listen(config.port, "127.0.0.1", yes));
const address = server.address();
if (!address || typeof address === "string") throw Error("CHECKER_OWNED_PORT_REQUIRED");
console.log(JSON.stringify({ status: "READY", port: address.port, identity, specificationDigest, publicKeyPem: publicKey,
  credentialDomain: "SEPARATE_ORIGINAL_RECORD_READ_ONLY_CHECKER" }));
const stop = () => { server.closeAllConnections(); server.close(() => { void Promise.all([pool.end(), receipts.end()]).then(() => process.exit(0)); }); };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
