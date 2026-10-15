import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@finnor/planning";
import { PE_WORLD_ROOT_TYPES } from "../types";
import {
  CAPITAL_INSTRUMENT_CLASSES, CAPITAL_COMMITMENT_STATES, CAPITAL_PROGRAMME_STATES,
  CAPITAL_COMMITMENT_ID_MAX_LENGTH,
  type CapitalCandidateClassification, type CapitalFinancingPackage,
} from "@finnor/shared-types";

export const CAPITAL_FORMATION_SCHEMA = "finnor.capital-formation.v1" as const;
export const INSTRUMENT_CLASSES = CAPITAL_INSTRUMENT_CLASSES;
export const COMMITMENT_STATES = CAPITAL_COMMITMENT_STATES;
export const PROGRAMME_STATES = CAPITAL_PROGRAMME_STATES;
export const CAPITAL_ACTIVITIES = [
  "RESEARCH", "APPROACH", "DISCLOSE", "NEGOTIATE", "REQUEST_PROFESSIONAL_REVIEW",
  "APPROVE", "EXECUTE_COMMITMENT", "GUARANTEE", "INSTRUCT_DRAW", "DETERMINE_LEGAL_STATUS",
] as const;
export const EVIDENCE_DIMENSIONS = [
  "SOURCE_ASSERTED", "EXTERNALLY_CONFIRMED", "COMPUTATION_CHECKED", "PROFESSIONALLY_ATTESTED",
  "LEGALLY_EFFECTIVE", "SETTLEMENT_OBSERVED", "UNRESOLVED", "CONTRADICTED", "EXPIRED",
] as const;
const uuid = z.string().uuid();
const text = z.string().min(1).max(512);
const commitmentId = z.string().min(1).max(CAPITAL_COMMITMENT_ID_MAX_LENGTH);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
export const IntegerSchema = z.string().regex(/^(0|[1-9][0-9]{0,37})$/);
export const RationalSchema = z.object({
  numerator: z.string().regex(/^-?(0|[1-9][0-9]{0,37})$/),
  denominator: z.string().regex(/^[1-9][0-9]{0,37}$/),
}).strict();
export const OwnerRefSchema = z.object({ owner: text, id: text, version: text, contentDigest: digest }).strict();
export const SourceRefSchema = z.object({
  evidenceVersionId: uuid, issuerId: uuid, recordId: text, channel: text, assertion: text,
  authorityScope: text, timestamp, revision: z.number().int().positive().safe(), integrityDigest: digest,
}).strict();
export const MoneySchema = z.object({
  legalEntityId: uuid, ownerShare: RationalSchema, amountMinor: IntegerSchema,
  currency: z.string().regex(/^[A-Z]{3}$/), minorUnits: z.number().int().min(0).max(12),
  unit: z.literal("CURRENCY_MINOR_UNIT"), timeBasis: text, valuationDate: timestamp,
  rounding: z.enum(["EXACT", "FLOOR", "CEILING", "HALF_EVEN"]),
}).strict();
export const RootSchema = z.object({ entityType: z.enum(PE_WORLD_ROOT_TYPES), entityId: uuid }).strict();
export const ConditionSchema = z.object({
  id: text, predicate: text, kind: z.enum(["OBSERVABLE", "PROFESSIONAL", "PROVIDER_APPROVAL", "DEPENDENCY", "DISCRETIONARY"]),
  material: z.boolean(), responsibleActorId: uuid, interpretation: text,
  requiredIssuerIds: z.array(uuid).min(1).max(16), dependencyCommitmentIds: z.array(commitmentId).max(16),
  waiverActorIds: z.array(uuid).max(16), expiry: timestamp.nullable(),
}).strict();
export const TermsSchema = z.object({
  providerEntityId: uuid, representativeId: uuid, programmeId: uuid, instrument: z.enum(INSTRUMENT_CLASSES),
  instrumentIdentity: text, facilityId: uuid.nullable(), securityId: uuid.nullable(),
  commitmentIdentity: text, trancheId: text, amount: MoneySchema,
  availableFrom: timestamp, drawDeadline: timestamp, expiresAt: timestamp,
  fixedRate: RationalSchema.nullable(), rateConvention: text, financialIRRef: OwnerRefSchema.nullable(),
  fees: z.array(z.object({ id: text, amount: MoneySchema, dueAt: timestamp, purpose: text }).strict()).max(64),
  security: z.array(z.object({ collateralId: text, priority: text, exclusivity: z.boolean(), requiredConsentRefs: z.array(text).max(32) }).strict()).max(64),
  covenants: z.array(z.object({ id: text, semanticRef: text, conflictsWith: z.array(text).max(64), obligation: text }).strict()).max(64),
  guarantees: z.array(z.object({ id: text, guarantorEntityId: uuid, maximum: MoneySchema, expiresAt: timestamp.nullable() }).strict()).max(32),
  crossDefaults: z.array(text).max(64),
  ownership: z.object({ subjectEntityId: uuid, economicShare: RationalSchema, votingShare: RationalSchema, class: text }).strict().nullable(),
  conditions: z.array(ConditionSchema).max(64), withdrawalRules: z.array(text).min(1).max(64),
  materialObligations: z.array(z.object({ id: text, meaning: text, accountingDestination: z.enum(["ENTITY_LIABILITY", "OWNER_LIABILITY", "COST", "CONTINUING_DUTY"]) }).strict()).max(128),
  capacityResourceIds: z.array(text).min(1).max(16), executionDigest: digest.nullable(),
  disclosureRevision: digest, offeringAuthorityDigest: digest,
  materialInventoryComplete: z.literal(true),
}).strict();
export const DisclosureSchema = z.object({
  evidenceVersionId: uuid, contentDigest: digest, sourceRevision: z.number().int().positive().safe(),
  rightsRevision: z.number().int().positive().safe(), principalId: uuid, programmeId: uuid,
  purpose: text, consentRef: text, confidentiality: text, permittedProviderIds: z.array(uuid).min(1).max(64),
  permittedChannels: z.array(text).min(1).max(16), validUntil: timestamp, retentionUntil: timestamp,
  acceptedLimitations: z.array(text).max(64),
}).strict();
export const AuthorityProfileSchema = z.object({
  id: uuid, revision: z.number().int().positive().safe(), issuingPrincipalId: uuid,
  legalEntityIds: z.array(uuid).min(1).max(16), jurisdictions: z.array(text).min(1).max(16),
  instruments: z.array(z.enum(INSTRUMENT_CLASSES)).min(1).max(3),
  activities: z.array(z.object({
    activity: z.enum(CAPITAL_ACTIVITIES), actorIds: z.array(uuid).min(1).max(32),
    channelIds: z.array(text).min(1).max(16), professionalRequired: z.boolean(),
  }).strict()).min(1).max(32),
  permittedProviderIds: z.array(uuid).min(1).max(64), suppressedProviderIds: z.array(uuid).max(64),
  permittedRecipientIds: z.array(uuid).min(1).max(128),
  templates: z.array(digest).min(1).max(32), disclosurePurpose: text,
  legalReviewEvidenceRef: text, offeringRoute: text, compensationRules: text,
  policyRevision: text, validFrom: timestamp, validUntil: timestamp, revoked: z.boolean(),
  maxContacts: z.number().int().min(0).max(1000), maxExposureMinor: IntegerSchema,
  pricingBounds: z.object({ minRate: RationalSchema, maxRate: RationalSchema, maxFeesMinor: IntegerSchema }).strict(),
  permittedGuaranteeIds: z.array(text).max(32), approvalConditions: z.array(text).max(64),
  escalationConditions: z.array(text).max(64), stopConditions: z.array(text).min(1).max(64),
}).strict();
export const FinancingMandateSchema = z.object({
  schema: z.literal("finnor.s4.financing-mandate.v1"), programmeId: uuid, tenantId: uuid, principalId: uuid,
  workId: uuid, workInputId: uuid, workInputDigest: digest, root: RootSchema, legalEntityId: uuid,
  approvedProgrammeRef: OwnerRefSchema, approvedTermsDigest: digest, approvalDecisionId: uuid,
  authorityProfileId: uuid, domainProfileIds: z.array(uuid).min(1).max(3), budgetGrantRef: OwnerRefSchema,
  requirement: MoneySchema,
  tranches: z.array(z.object({
    id: text, purpose: z.enum(["PRINCIPAL", "EQUITY", "FEES", "RESERVE", "CONTINGENT_OBLIGATION"]),
    requiredMinor: IntegerSchema, currency: z.string().regex(/^[A-Z]{3}$/), dueAt: timestamp,
    instruments: z.array(z.enum(INSTRUMENT_CLASSES)).min(1).max(3),
  }).strict()).min(1).max(64),
  providerIds: z.array(uuid).min(1).max(64), disclosureRefs: z.array(DisclosureSchema).min(1).max(64),
  readinessBasis: z.enum(["EFFECTIVE_UNDRAWN_AND_RECONCILED_FUNDING", "RECONCILED_FUNDING_ONLY"]),
  readinessRevision: text, acceptedConversions: z.array(z.object({
    fromCurrency: text, toCurrency: text, rate: RationalSchema, haircut: RationalSchema,
    evidenceRef: SourceRefSchema, validUntil: timestamp, rounding: z.enum(["FLOOR", "EXACT"]),
  }).strict()).max(16),
  prohibitedCovenantIds: z.array(text).max(64), prohibitedCrossDefaults: z.array(text).max(64),
  maxEconomicOwnership: RationalSchema, maxVotingOwnership: RationalSchema,
  requiredCollateralConsents: z.array(text).max(64),
  expiresAt: timestamp, waitingUntil: timestamp, contactGrant: z.number().int().min(0).max(1000),
  maxCostMicroUSD: IntegerSchema, maxHumanSeconds: z.number().int().min(0).max(900),
  maxSteps: z.number().int().min(1).max(1000), stoppingRules: z.array(text).min(1).max(64),
  sourceRevisionVector: z.array(z.object({ key: text, revision: z.number().int().nonnegative().safe() }).strict()).max(256),
}).strict();
export const IssuerSchema = z.object({
  id: uuid, revision: z.number().int().positive().safe(), legalEntityId: uuid, actorId: uuid, publicKey: z.string().min(32).max(4096),
  purposes: z.array(z.enum(["IDENTITY", "PROVIDER", "PROFESSIONAL", "CONDITION", "SETTLEMENT", "AUTHORITY", "HUMAN_METER"])).min(1).max(7),
  instruments: z.array(z.enum(INSTRUMENT_CLASSES)).min(1).max(3),
  activities: z.array(z.enum(CAPITAL_ACTIVITIES)).max(16),
  validFrom: timestamp, validUntil: timestamp, revoked: z.boolean(),
  independentOfProducer: z.literal(true), sourceRef: text, domainDigest: digest,
}).strict();
export const InstrumentProfileSchema = z.object({
  id: uuid, revision: z.number().int().positive().safe(), instrument: z.enum(INSTRUMENT_CLASSES),
  environment: z.enum(["DISPOSABLE", "LIVE"]), jurisdiction: text,
  legalBasisDigest: digest, activityAuthorityDigest: digest, professionalIssuerIds: z.array(uuid).min(1).max(16),
  identityIssuerIds: z.array(uuid).min(1).max(16), settlementIssuerIds: z.array(uuid).min(1).max(16),
  humanMeterIssuerIds: z.array(uuid).max(16),
  receivingPredicate: z.enum(["RECEIVER_CONFIRMED_AND_SETTLEMENT_FINAL"]),
  operationCostCeilingMicroUSD: IntegerSchema,
  independentCheckerDigest: digest, providerInterfaceRef: OwnerRefSchema,
  admissionRef: OwnerRefSchema.nullable(), qualified: z.boolean(), activated: z.boolean(),
  legalStatusSemantics: z.literal("EXACT_PROFESSIONAL_DETERMINATION_WITH_MATERIAL_CONDITION_INVENTORY"),
  permittedRootTypes: z.array(z.enum(PE_WORLD_ROOT_TYPES)).min(1).max(8),
  executionRequirements: z.array(text).min(1).max(32), validUntil: timestamp, revoked: z.boolean(),
}).strict();
export const EventBodySchema = z.object({
  schema: z.literal("finnor.capital-source-event.v1"), eventId: text, issuerId: uuid,
  issuerRevision: z.number().int().positive().safe(), sequence: z.number().int().positive().safe(),
  tenantId: uuid, programmeId: uuid, providerEntityId: uuid, representativeId: uuid,
  instrument: z.enum(INSTRUMENT_CLASSES), commitmentIdentity: text,
  operationId: uuid.nullable(), operationRequestDigest: digest.nullable(), termsDigest: digest.nullable(),
  kind: z.enum(["IDENTITY_CONFIRMED", "INDICATION", "OFFER", "COUNTERPROPOSAL", "COMMITMENT_EXECUTED",
    "REFUSAL", "PROFESSIONAL_DETERMINATION", "CONDITION_OBSERVED", "WITHDRAWAL", "CORRECTION", "FUNDING_OBSERVATION"]),
  observedAt: timestamp, effectiveAt: timestamp, expiresAt: timestamp, sourceRecord: text,
  terms: TermsSchema.nullable(),
  identity: z.object({
    legalName: text, registryRecord: text, jurisdiction: text, providerEligible: z.boolean(),
    representativeActs: z.array(z.enum(CAPITAL_ACTIVITIES)).max(16), permittedChannels: z.array(text).max(16),
  }).strict().nullable(),
  determination: z.object({
    operativeStatus: z.enum(["NONBINDING", "APPROVAL_PENDING", "BINDING_CONDITIONAL", "EFFECTIVE"]),
    termsDigest: digest, materialConditionIds: z.array(text).max(64),
    unsatisfiedConditionIds: z.array(text).max(64), interpretation: text, legalBasisDigest: digest,
    executionEstablished: z.boolean(), issuerAuthorityEstablished: z.boolean(),
    offeringActivityEstablished: z.boolean(), liabilitiesComplete: z.boolean(),
  }).strict().nullable(),
  condition: z.object({ id: text, satisfied: z.boolean(), meaning: text, evidenceRefs: z.array(text).min(1).max(32) }).strict().nullable(),
  funding: z.object({
    receivingEntityId: uuid, amount: MoneySchema, observationIdentity: text,
    receiverConfirmed: z.boolean(), settlementFinal: z.boolean(), originalDrawEffectId: uuid,
    receivingRecord: text, settlementRecord: text,
  }).strict().nullable(),
  reason: text.nullable(), cost: z.object({ receiptId: text, microUSD: IntegerSchema, final: z.boolean() }).strict(),
}).strict();
export const SignedEventSchema = z.object({ body: EventBodySchema, signature: z.string().min(32).max(1024) }).strict();
export const SignedAuthoritySchema = z.object({
  body: AuthorityProfileSchema, issuerId: uuid, signature: z.string().min(32).max(1024),
}).strict();
export const ProfessionalActivityReviewSchema = z.object({
  body: z.object({ schema: z.literal("finnor.v4.professional-activity-review.v1"), issuerId: uuid,
    tenantId: uuid, programmeId: uuid, principalId: uuid, legalEntityId: uuid,
    authorityDigest: digest, activities: z.array(z.enum(CAPITAL_ACTIVITIES)).min(1).max(16),
    instruments: z.array(z.enum(INSTRUMENT_CLASSES)).min(1).max(3),
    providerIds: z.array(uuid).min(1).max(64), recipientIds: z.array(uuid).min(1).max(128),
    channels: z.array(text).min(1).max(16), satisfiedApprovalConditionIds: z.array(text).max(64),
    legalBasisDigest: digest, validFrom: timestamp, validUntil: timestamp,
  }).strict(), signature: z.string().min(32).max(1024),
}).strict();
export const HumanInterventionReceiptSchema = z.object({
  body: z.object({ schema: z.literal("finnor.s7.capital-human-meter.v1"), receiptId: text, issuerId: uuid,
    tenantId: uuid, principalId: uuid, programmeId: uuid, proposalDigest: digest,
    startedAt: timestamp, finishedAt: timestamp, seconds: z.number().int().min(0).max(900),
    costMicroUSD: IntegerSchema, costFinal: z.literal(true),
  }).strict(), signature: z.string().min(32).max(1024),
}).strict();

export const CAPITAL_FORMATION_OPERATIONS = {
  "capital-formation-submit": z.object({ mandate: FinancingMandateSchema, authority: SignedAuthoritySchema, idempotencyKey: text }).strict(),
  "capital-formation-read": z.object({ programmeId: uuid }).strict(),
  "capital-formation-list": z.object({ workId: uuid }).strict(),
  "capital-formation-profiles": z.object({ workId: uuid }).strict(),
  "capital-formation-advance": z.object({ programmeId: uuid, expectedRevision: z.number().int().positive().safe(), triggerRef: text }).strict(),
  "capital-formation-event": z.object({ programmeId: uuid, event: SignedEventSchema }).strict(),
  "capital-formation-proposal": z.object({ programmeId: uuid, expectedRevision: z.number().int().positive().safe(), terms: TermsSchema, recipientId: uuid, channelId: text,
    humanReceipt: HumanInterventionReceiptSchema.optional() }).strict(),
  "capital-formation-cancel": z.object({ programmeId: uuid, expectedRevision: z.number().int().positive().safe(), reason: text }).strict(),
  "capital-formation-draw-handoff": z.object({ programmeId: uuid, commitmentId, expectedRevision: z.number().int().positive().safe(), allocationRef: OwnerRefSchema, drawEffectId: uuid }).strict(),
} as const;
export type Money = z.infer<typeof MoneySchema>;
export type Terms = z.infer<typeof TermsSchema>;
export type FinancingMandate = z.infer<typeof FinancingMandateSchema>;
export type AuthorityProfile = z.infer<typeof AuthorityProfileSchema>;
export type InstrumentProfile = z.infer<typeof InstrumentProfileSchema>;
export type Issuer = z.infer<typeof IssuerSchema>;
export type SignedEvent = z.infer<typeof SignedEventSchema>;
export type SourceEvent = SignedEvent["body"];
export type OwnerRef = z.infer<typeof OwnerRefSchema>;
export type CommitmentState = typeof COMMITMENT_STATES[number];
export type ProgrammeState = typeof PROGRAMME_STATES[number];

export interface ClaimCheck {
  assertionDigest: string; sourceEventIds: string[]; checkerDigest: string;
  result: "PASS" | "FAIL" | "UNRESOLVED"; supportedDomain: string; excludedInterpretations: string[];
}
export interface VArtifactEnvelope {
  artifact_id: string; artifact_kind: "VerifiedCapitalCommitment"; schema_revision: string; content_digest: string;
  tenant_ref: string; work_ref: string; work_revision: string; producer_digest: string; dependency_lock_digest: string;
  admission_ref: OwnerRef | null; baseline_manifest_ref: string; domain_profile_ref: string;
  mandate_ref: string; authority_profile_ref: string; budget_grant_ref: OwnerRef;
  source_refs: z.infer<typeof SourceRefSchema>[]; source_revision_vector: FinancingMandate["sourceRevisionVector"];
  rights_revision: number; effective_time: string; knowledge_time: string; observation_time: string;
  accepted_claims: string[]; unresolved_claims: string[]; contradiction_refs: string[];
  independent_check_refs: ClaimCheck[]; effect_obligation_refs: string[]; external_event_refs: string[];
  cost_receipts: Array<SourceEvent["cost"] & { issuerId: string }>; human_intervention_receipts: string[];
  invalidation_dependencies: string[]; lifecycle_events: string[];
}
export interface VerifiedCapitalCommitment {
  envelope: VArtifactEnvelope; commitmentId: string; state: CommitmentState; terms: Terms;
  programme_and_financing_mandate_refs: { programmeId: string; mandateDigest: string };
  provider_entity_and_authorized_representative: { entityId: string; representativeId: string; identityEventId: string };
  instrument_profile_and_offering_authority: { profileId: string; authorityDigest: string };
  executed_commitment_terms_digest: string;
  amount_currency_timing_and_allocation: { faceAmount: Money; eligibleUndrawnMinor: string; reservedAllocationMinor: string };
  pricing_fees_security_covenants_and_guarantees: Pick<Terms, "fixedRate" | "rateConvention" | "fees" | "security" | "covenants" | "guarantees" | "crossDefaults" | "ownership" | "materialObligations">;
  conditions_and_satisfaction_evidence: { conditions: Terms["conditions"]; unsatisfiedIds: string[]; eventIds: string[] };
  professional_legal_status_and_issuer_confirmation: { determinationEventId: string; executionEventId: string };
  shared_capacity_and_reservation_refs: { resourceIds: string[]; allocationRefs: OwnerRef[] };
  effectiveness_expiry_and_withdrawal_rules: Pick<Terms, "availableFrom" | "drawDeadline" | "expiresAt" | "withdrawalRules">;
  independent_checks_and_current_state: ClaimCheck;
  funding_obligation_and_observation_refs: { obligationIds: string[]; observationEventIds: string[]; receivedMinor: string; unknownMinor: string };
}
export type CandidateClassification = CapitalCandidateClassification;
export type FinancingPackage = CapitalFinancingPackage;
export class CapitalFormationError extends Error {
  constructor(readonly code: string, message = code, readonly status = 409) { super(message); }
}
export function requireDisposableCapitalRuntime(): void {
  let target: URL;
  try { target = new URL(process.env.DATABASE_URL ?? ""); } catch { throw new CapitalFormationError("V4_DISPOSABLE_DATABASE_REQUIRED", undefined, 503); }
  if (process.env.FINNOR_V4_PROFILE !== "DISPOSABLE" || process.env.FINNOR_ENVIRONMENT === "production"
    || !["127.0.0.1", "[::1]"].includes(target.hostname)) {
    throw new CapitalFormationError("V4_LIVE_PROFILE_UNADMITTED", "Live financing requires separate admission and activation", 503);
  }
}
export function canonicalCapital(value: unknown): string {
  return canonicalJson(value);
}
export const capitalDigest = (value: unknown): string => createHash("sha256").update(
  typeof value === "string" || Buffer.isBuffer(value) ? value : canonicalCapital(value),
).digest("hex");
