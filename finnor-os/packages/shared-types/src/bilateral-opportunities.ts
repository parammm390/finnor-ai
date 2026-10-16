import { z } from "zod";
import { EvidenceRootSchema } from "./evidence-execution";
import {
  DiligenceAssertionSchema, ExactQuantitySchema, PrimaryGrantSchema, VReferenceSchema,
  type DiligenceAssertion, type PrimaryCostReceipt, type VArtifactEnvelope, type VReference,
} from "./primary-diligence";

const id = z.string().min(1).max(200);
const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
const nonnegative = z.string().regex(/^(0|[1-9]\d{0,95})$/);
const bps = z.number().int().min(0).max(10000);
const base = {
  profileId: uuid, revision: z.number().int().positive(), issuingPrincipalId: uuid,
  environment: z.enum(["DEVELOPMENT", "LIVE"]), validFrom: instant, expiresAt: instant,
};

export const BilateralMoneySchema = z.object({
  amount: nonnegative, currency: z.string().regex(/^[A-Z]{3}$/), units: z.literal("MINOR_UNITS"),
  minorUnitsPerMajor: z.literal(100), legalEntityId: uuid, ownerShare: ExactQuantitySchema,
  timeBasis: z.literal("AT_PROPOSED_CLOSING"), valuationDate: instant,
  rounding: z.literal("EXACT_INTEGER_NO_EXECUTION_ROUNDING"),
}).strict();
export const BilateralTermsSchema = z.object({
  schema: z.literal("finnor.bilateral-terms.v1"), companyId: uuid, buyerEntityId: uuid,
  purchasePrice: BilateralMoneySchema, controlShareBps: bps, retainedShareBps: bps,
  managementParticipationBps: bps,
  consideration: z.array(z.object({ amount: nonnegative, dueAt: instant, condition: z.enum(["AT_CLOSING", "FIXED_DEFERRED_SUBJECT_TO_DEFINITIVE_AGREEMENT"]) }).strict()).min(1).max(4),
  managementContinuity: z.enum(["NONE", "PROPOSED_12_MONTH_CONTINUITY_SUBJECT_TO_DEFINITIVE_AGREEMENT"]),
  proposedClosingAt: instant, indicationBindingStatus: z.literal("NONBINDING"),
  exclusions: z.tuple([
    z.literal("NOT_UNDERWRITTEN"), z.literal("NO_FUNDING_OR_IC_APPROVAL_CLAIM"),
    z.literal("NO_EXCLUSIVITY"), z.literal("NO_EMPLOYMENT_GUARANTEE"), z.literal("NO_LEGAL_EFFECTIVENESS_CLAIM"),
  ]),
}).strict();
export type BilateralTerms = z.infer<typeof BilateralTermsSchema>;
export const BilateralBoundsSchema = z.object({
  minimumPurchaseMinorUnits: nonnegative, maximumPurchaseMinorUnits: nonnegative,
  minimumControlBps: bps, maximumControlBps: bps, maximumManagementParticipationBps: bps,
  maximumDeferredBps: bps, maximumDeferredDays: z.number().int().min(0).max(3650),
  earliestClosingAt: instant, latestClosingAt: instant, allowProposedManagementContinuity: z.boolean(),
}).strict();
export type BilateralBounds = z.infer<typeof BilateralBoundsSchema>;
export const BilateralMandateSchema = z.object({
  ...base, schema: z.literal("finnor.bilateral-mandate.v1"), buyerEntityId: uuid, strategyId: uuid,
  objective: z.string().min(1).max(2000),
  selectionRule: z.literal("MANDATE_FIT_AND_REQUIRED_INFORMATION_PER_COST_THEN_KNOWN_DELAY"),
  currency: z.string().regex(/^[A-Z]{3}$/), bounds: BilateralBoundsSchema,
  preliminaryPredicates: z.array(z.object({
    id, field: id, operator: z.enum(["EQ", "GTE", "LTE"]), expected: z.union([z.string().max(200), z.boolean()]),
    maximumAgeMs: z.number().int().positive().max(31536000000),
  }).strict()).min(1).max(32),
  permittedFullDiligenceGapIds: z.array(uuid).max(128),
  programmeGrammar: z.literal("PRIVATE_MAJORITY_NONBINDING_V1"),
  authorityProfileRef: VReferenceSchema, relationshipPolicyRef: VReferenceSchema,
  sourceProfileRef: VReferenceSchema, domainProfileRef: VReferenceSchema,
  maximumCompanies: z.number().int().min(1).max(64), maximumRevisionsPerCompany: z.number().int().min(1).max(16),
  confirmationMaximumAgeMs: z.number().int().positive().max(2592000000),
  deadline: instant, responseWaitMs: z.number().int().min(1000).max(2592000000),
}).strict();
export type BilateralMandate = z.infer<typeof BilateralMandateSchema>;
export const BilateralAuthoritySchema = z.object({
  ...base, schema: z.literal("finnor.bilateral-authority.v1"),
  legalEntityIds: z.array(uuid).min(1).max(64), jurisdictions: z.array(id).min(1).max(16),
  transactionClass: z.literal("PRIVATE_MAJORITY_NONBINDING_V1"),
  activities: z.array(z.object({
    activity: z.enum(["RESEARCH", "CONTACT", "DISCLOSE", "PROPOSE_NONBINDING", "NEGOTIATE_WITHIN_BOUNDS"]),
    actorIds: z.array(uuid).min(1).max(32), channel: z.literal("email"),
  }).strict()).min(1).max(5),
  professionalRequirements: z.array(z.object({ activity: id, requiredActorId: uuid, qualificationRef: VReferenceSchema }).strict()).max(32),
  approvedTemplate: z.literal("TRUTHFUL_NONBINDING_BILATERAL_V1"),
  firmDisplayName: z.string().min(1).max(200), representativeDisplayName: z.string().min(1).max(200),
  automationDisclosure: z.string().min(1).max(500), confidentialityRules: z.array(id).min(1).max(32),
  permittedAssertionFields: z.array(id).min(1).max(64), attachments: z.literal("FORBIDDEN"),
  negotiationBounds: BilateralBoundsSchema, communicationIdentityId: uuid,
  relationshipPolicyRef: VReferenceSchema, standingApproval: z.literal("EXACT_EFFECTS_WITHIN_ORIGINAL_ENVELOPE"),
  maximumDisclosureBytes: z.number().int().min(1024).max(65536),
  legalReviewEvidenceRefs: z.array(VReferenceSchema).min(1).max(32),
  escalationActorId: uuid, escalationConditions: z.array(id).min(1).max(32),
  revocationConditions: z.array(id).min(1).max(32), policyRevision: id,
}).strict();
export type BilateralAuthority = z.infer<typeof BilateralAuthoritySchema>;
export const RelationshipPolicySchema = z.object({
  ...base, schema: z.literal("finnor.relationship-policy.v1"), firmEntityId: uuid,
  channel: z.literal("email"), companyMaximumContacts: z.number().int().min(1).max(1024),
  personMaximumContacts: z.number().int().min(1).max(1024),
  minimumSpacingMs: z.number().int().min(0).max(2592000000),
  totalMaximumContacts: z.number().int().min(1).max(65536),
  visibility: z.literal("ENTIRE_AUTHORIZED_TENANT_RELATIONSHIP_DOMAIN"),
  suppression: z.literal("REFUSAL_OPT_OUT_WITHDRAWAL_IMMEDIATE_ALL_WORKS_AGENTS_MAILBOXES"),
}).strict();
export type RelationshipPolicy = z.infer<typeof RelationshipPolicySchema>;
export const BilateralSourceProfileSchema = z.object({
  ...base, schema: z.literal("finnor.bilateral-source-profile.v1"), issuer: id, system: id,
  endpoint: z.string().url().max(2048), responsePublicKeyPem: z.string().min(40).max(4096),
  channel: z.literal("AUTHENTICATED_DIRECT_RECORD_AND_PARTICIPANT_HTTP"),
  sourceClasses: z.array(z.enum(["INDEPENDENT_COMPANY_REGISTRY", "AUTHORITATIVE_FIRM_PIPELINE", "DIRECT_PARTICIPANT"])).length(3),
  authorityEvidenceRefs: z.array(VReferenceSchema).min(1).max(32),
  permittedFields: z.array(id).min(1).max(64), rightsRef: VReferenceSchema,
  retentionUntil: instant, maximumReadMicroUsd: nonnegative,
  transportReadback: z.object({
    contract: z.literal("DEVELOPMENT_SMTP_ACCEPTANCE_V1"), provider: z.literal("gmail"),
    meaning: z.literal("TRANSPORT_ACCEPTANCE_NOT_INTEREST_OR_RECIPIENT_DELIVERY"),
    validUntil: instant, maximumContactMicroUsd: nonnegative,
    maximumObservationAgeMs: z.number().int().positive().max(86400000),
    mutationIdempotency: z.literal("NONE"), absenceAllowsRetry: z.literal(false),
  }).strict(),
  pricebookRef: VReferenceSchema, adapterVersion: z.literal("bilateral-direct-records-v1"),
  recovery: z.literal("REPEATABLE_READ_NO_CONTACT_EFFECT"), admissionRef: VReferenceSchema.nullable(),
}).strict();
export type BilateralSourceProfile = z.infer<typeof BilateralSourceProfileSchema>;
export const BilateralDomainSchema = z.object({
  ...base, schema: z.literal("finnor.bilateral-domain.v1"),
  grammar: z.literal("PRIVATE_MAJORITY_NONBINDING_V1"),
  deduplicationRule: z.literal("CANONICAL_COMPANY_BUYER_ALL_ACTIVE_FIRM_PIPELINE_V1"),
  supportedActivities: z.array(id).min(1).max(16),
  checker: z.object({
    endpoint: z.string().url().max(2048), publicKeyPem: z.string().min(40).max(4096),
    identity: VReferenceSchema, specificationDigest: digest,
    credentialDomain: z.literal("SEPARATE_ORIGINAL_RECORD_READ_ONLY_CHECKER"),
  }).strict(),
  professionalProfileRefs: z.array(VReferenceSchema).max(32), admissionRef: VReferenceSchema.nullable(),
}).strict();
export type BilateralDomain = z.infer<typeof BilateralDomainSchema>;
export const BilateralGrantSchema = PrimaryGrantSchema.extend({
  schema: z.literal("finnor.bilateral-grant.v1"),
  maximumContacts: z.number().int().min(1).max(1024),
  originalProgrammeDeadline: instant,
}).strict();
export type BilateralGrant = z.infer<typeof BilateralGrantSchema>;
export const BilateralGovernanceSchema = z.discriminatedUnion("schema", [
  BilateralMandateSchema, BilateralAuthoritySchema, RelationshipPolicySchema,
  BilateralSourceProfileSchema, BilateralDomainSchema, BilateralGrantSchema,
]);
export type BilateralGovernance = z.infer<typeof BilateralGovernanceSchema>;
export const BilateralSourceRefSchema = z.object({
  issuer: id, system: id, recordOrParticipantId: id, authenticatedChannel: id,
  exactFields: z.array(id).min(1).max(64), authorityScope: z.array(id).min(1).max(64),
  observedAt: instant, effectiveAt: instant, revision: id, integrityWitness: digest,
}).strict();
export const BilateralCompanyRecordSchema = z.object({
  companyId: uuid, legalName: z.string().min(1).max(200), identityStatus: z.enum(["ESTABLISHED", "CONFLICTED", "UNKNOWN"]),
  counterpartyId: uuid, role: z.enum(["OWNER", "AUTHORIZED_REPRESENTATIVE", "BROKER", "ASSISTANT", "UNKNOWN"]),
  representationActivities: z.array(id).max(32), roleSource: BilateralSourceRefSchema,
  companySource: BilateralSourceRefSchema,
  facts: z.record(z.union([z.string().max(200), z.boolean(), z.null()])).refine(v => Object.keys(v).length <= 64),
  factSources: z.record(BilateralSourceRefSchema).refine(v => Object.keys(v).length <= 64),
  ownerObjectives: z.object({
    majoritySaleConsidered: z.boolean().nullable(), minimumRetainedBps: bps.nullable(),
    proposedManagementContinuityRequested: z.boolean().nullable(), earliestClosingAt: instant.nullable(),
    latestClosingAt: instant.nullable(), source: BilateralSourceRefSchema,
  }).strict(),
  priorRelationshipEvidence: z.array(BilateralSourceRefSchema).max(32),
  origination: z.enum(["NO_KNOWN_PROCESS_AT_CUT", "PREEXISTING_PROCESS", "UNRESOLVED"]),
  originationEvidence: BilateralSourceRefSchema,
  participantPublicKeyPem: z.string().min(40).max(4096),
}).strict();
export type BilateralCompanyRecord = z.infer<typeof BilateralCompanyRecordSchema>;
export const BilateralSnapshotSchema = z.object({
  schema: z.literal("finnor.bilateral-source-snapshot.v1"),
  tenantId: uuid, buyerEntityId: uuid, mandateDigest: digest,
  eligibleCompanyIds: z.array(uuid).min(1).max(64), knowledgeCut: instant,
  universeDefinition: z.string().min(1).max(2000), companies: z.array(BilateralCompanyRecordSchema).min(1).max(64),
  pipeline: z.object({
    coveredCompanyIds: z.array(uuid).min(1).max(64), coveredBuyerEntityIds: z.array(uuid).min(1).max(64),
    authoritative: z.boolean(), completeAuthorizedVisibility: z.boolean(),
    entries: z.array(z.object({ companyId: uuid, buyerEntityId: uuid, canonicalOpportunityId: uuid.nullable(), state: id }).strict()).max(1024),
    source: BilateralSourceRefSchema,
  }).strict(),
  sourceProfileDigest: digest, expiresAt: instant,
}).strict();
export type BilateralSnapshot = z.infer<typeof BilateralSnapshotSchema>;
export const SignedBilateralSnapshotSchema = z.object({
  body: BilateralSnapshotSchema, signature: z.string().min(40).max(256),
}).strict();
export type SignedBilateralSnapshot = z.infer<typeof SignedBilateralSnapshotSchema>;
export const BilateralTransportObservationSchema = z.object({
  schema: z.literal("finnor.bilateral-transport-observation.v1"), tenantId: uuid,
  programmeId: uuid, actionId: uuid, companyId: uuid, participantId: uuid,
  communicationIdentityId: uuid, provider: z.literal("gmail"),
  contract: z.literal("DEVELOPMENT_SMTP_ACCEPTANCE_V1"),
  meaning: z.literal("TRANSPORT_ACCEPTANCE_NOT_INTEREST_OR_RECIPIENT_DELIVERY"),
  recipientAddressDigest: digest, senderAddressDigest: digest, subjectDigest: digest, bodyDigest: digest,
  outcome: z.enum(["ACCEPTED", "UNKNOWN", "ABSENT"]), providerMessageRef: id.nullable(),
  observedAt: instant, expiresAt: instant,
}).strict();
export const SignedBilateralTransportSchema = z.object({
  body: BilateralTransportObservationSchema, signature: z.string().min(40).max(256),
}).strict();
export type SignedBilateralTransport = z.infer<typeof SignedBilateralTransportSchema>;
export const BilateralReplySchema = z.object({
  schema: z.literal("finnor.bilateral-participant-event.v1"), eventId: uuid, tenantId: uuid,
  programmeId: uuid, companyId: uuid, participantId: uuid, buyerEntityId: uuid,
  channel: z.literal("AUTHENTICATED_DIRECT_RECORD_AND_PARTICIPANT_HTTP"),
  actionId: uuid, termsDigest: digest, revision: z.number().int().positive(),
  kind: z.enum(["COUNTERPROPOSAL", "CONSTRAINTS", "INTEREST", "ACKNOWLEDGMENT", "REFUSAL", "OPT_OUT", "WITHDRAWAL"]),
  statement: z.string().min(1).max(4000), terms: BilateralTermsSchema.nullable(),
  nextStep: z.object({ kind: z.enum(["DILIGENCE_MEETING", "PERMITTED_INFORMATION_EXCHANGE"]), agreedAt: instant, scheduledAt: instant, description: z.string().min(1).max(1000) }).strict().nullable(),
  observedAt: instant, expiresAt: instant, direct: z.literal(true),
}).strict();
export type BilateralReply = z.infer<typeof BilateralReplySchema>;
export const SignedBilateralReplySchema = z.object({ body: BilateralReplySchema, signature: z.string().min(40).max(256) }).strict();
export type SignedBilateralReply = z.infer<typeof SignedBilateralReplySchema>;
export const BilateralSourceReadSchema = z.object({
  schema: z.literal("finnor.bilateral-read.v1"), tenantId: uuid, principalId: uuid, programmeId: uuid,
  buyerEntityId: uuid, mandateDigest: digest, eligibleCompanyIds: z.array(uuid).min(1).max(64),
  universeDefinition: z.string().min(1).max(2000), sourceProfileDigest: digest,
  operation: z.enum(["SNAPSHOT", "EVENTS", "TRANSPORT_STATUS", "CHECK_ORIGINALS"]),
  candidateId: uuid.nullable(), actionId: uuid.nullable(), afterEventId: uuid.nullable(),
}).strict();
export type BilateralSourceRead = z.infer<typeof BilateralSourceReadSchema>;
export const BilateralOriginalRecordsSchema = z.object({
  snapshot: SignedBilateralSnapshotSchema, events: z.array(SignedBilateralReplySchema).max(128),
  transport: z.array(SignedBilateralTransportSchema).max(128),
}).strict();
export const BilateralIntakeSchema = z.object({
  schema: z.literal("finnor.bilateral-programme.v1"), root: EvidenceRootSchema,
  workId: uuid, expectedWorkInputId: uuid, idempotencyKey: id,
  mandateRef: VReferenceSchema, authorityProfileRef: VReferenceSchema,
  domainProfileRef: VReferenceSchema, budgetGrantRef: VReferenceSchema,
  sourceProfileRef: VReferenceSchema, relationshipPolicyRef: VReferenceSchema,
  eligibleCompanyIds: z.array(uuid).min(1).max(64), universeDefinition: z.string().min(1).max(2000),
  underwritingGapAssertions: z.array(DiligenceAssertionSchema).max(128),
  mode: z.enum(["ordinary_disposable", "protected"]),
}).strict();
export type BilateralIntake = z.infer<typeof BilateralIntakeSchema>;
export const BilateralAdvanceSchema = z.object({
  programmeRef: VReferenceSchema, expectedRevision: z.number().int().positive(), triggerRef: VReferenceSchema,
  mandateRef: VReferenceSchema, authorityProfileRef: VReferenceSchema,
  domainProfileRef: VReferenceSchema, budgetGrantRef: VReferenceSchema,
  evidenceRevisionVector: z.array(z.object({ key: id, revision: z.number().int().nonnegative() }).strict()).max(1024),
}).strict();
export const BilateralCheckSchema = z.object({
  schema: z.literal("finnor.bilateral-check.v1"), id: uuid, result: z.enum(["ACCEPT", "REJECT"]),
  reasons: z.array(id).max(128), checkerIdentity: VReferenceSchema, specificationDigest: digest,
  tenantId: uuid, principalId: uuid, workId: uuid, workInputId: uuid,
  programmeId: uuid, candidateId: uuid, termsRef: VReferenceSchema, sourceDigest: digest,
  mandateRef: VReferenceSchema, authorityProfileRef: VReferenceSchema, domainProfileRef: VReferenceSchema,
  relationshipPolicyRef: VReferenceSchema, dependencyDigest: digest, rightsRevision: z.number().int().nonnegative(),
  checkedAt: instant, expiresAt: instant, observationRefs: z.array(VReferenceSchema).max(256),
  conjuncts: z.object({
    identityAndRole: z.boolean(), frozenPipelineAbsence: z.boolean(), authorizedExactCommunication: z.boolean(),
    exactPositiveInterest: z.boolean(), mechanicsAndPreliminaryFit: z.boolean(), explicitIndicationAndGaps: z.boolean(),
  }).strict(),
  usage: z.object({ cpuMicros: nonnegative, peakMemoryBytes: nonnegative, wallMs: z.number().nonnegative() }).strict(),
  excludedInterpretations: z.array(id).max(32),
}).strict();
export type BilateralCheck = z.infer<typeof BilateralCheckSchema>;
export const SignedBilateralCheckSchema = z.object({ body: BilateralCheckSchema, signature: z.string().min(40).max(256) }).strict();
export type SignedBilateralCheck = z.infer<typeof SignedBilateralCheckSchema>;
export interface QualifiedBilateralOpportunity extends VArtifactEnvelope<"QualifiedBilateralOpportunity", "finnor.v1.opportunity.v1"> {
  opportunityId: string; companyRef: VReference; buyerEntityRef: VReference; counterpartyRef: VReference;
  counterpartyRoleAndChannelEvidence: BilateralSourceRef[];
  sourcingMandateRef: VReference; baselinePipelineDigest: string;
  originationClass: "CREATED_BILATERAL" | "NEW_TO_FIRM_PREEXISTING_PROCESS" | "ALREADY_ACTIVE" | "UNRESOLVED";
  priorRelationshipEvidence: BilateralSourceRef[]; originationEvidence: BilateralSourceRef;
  communicatedTermsRevision: VReference; terms: BilateralTerms;
  confirmedInterestStatementAndSource: { statement: string; source: VReference; participantEvent: BilateralReply };
  preliminaryFitChecks: Array<{ id: string; evidence: BilateralSourceRef; status: "SUPPORTED" }>;
  remainingUnderwritingGaps: DiligenceAssertion[]; indicationBindingStatus: "NONBINDING";
  agreedNextStep: NonNullable<BilateralReply["nextStep"]>; validityAndExpiry: { validFrom: string; expiresAt: string };
  communicationObligationRefs: VReference[]; evidenceLabels: ["SOURCE_ASSERTED", "EXTERNALLY_CONFIRMED", "COMPUTATION_CHECKED"];
  environment: "DEVELOPMENT" | "LIVE"; qualification: "DEVELOPMENT_ACCEPTED_NOT_DOMAIN_ADMITTED";
  causalIncrementalCreation: "NOT_ESTABLISHED"; costReceipts: PrimaryCostReceipt[];
}
export type BilateralSourceRef = z.infer<typeof BilateralSourceRefSchema>;
