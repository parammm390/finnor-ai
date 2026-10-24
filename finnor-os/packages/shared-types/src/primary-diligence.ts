import { z } from "zod";
import { EvidenceRootSchema } from "./evidence-execution";

const id = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
const integer = z.string().regex(/^-?(?:0|[1-9][0-9]{0,95})$/);
const positiveInteger = z.string().regex(/^[1-9][0-9]{0,95}$/);
export const VReferenceSchema = z.object({
  owner: z.string().min(1).max(32), id, revision: id, contentDigest: digest,
}).strict();
export type VReference = z.infer<typeof VReferenceSchema>;
export const ExactQuantitySchema = z.object({ numerator: integer, denominator: positiveInteger }).strict();
export type ExactQuantity = z.infer<typeof ExactQuantitySchema>;
export const UnknownQuantitySchema = z.object({ kind: z.literal("UNKNOWN"), reason: z.string().min(1).max(1000) }).strict();
export const DiligenceValueSchema = z.discriminatedUnion("kind", [
  UnknownQuantitySchema,
  z.object({ kind: z.literal("EXACT"), quantity: ExactQuantitySchema }).strict(),
  z.object({ kind: z.literal("STATE"), state: id }).strict(),
  z.object({ kind: z.literal("INTERVAL"), lower: ExactQuantitySchema, upper: ExactQuantitySchema, measurementDesignRef: VReferenceSchema }).strict(),
]);
export type DiligenceValue = z.infer<typeof DiligenceValueSchema>;
export const DiligenceSourceClassSchema = z.enum([
  "EXTERNAL_AUTHORITATIVE_RECORD", "DIRECT_EXTERNAL_CONFIRMATION", "TARGET_CONTROLLED_RECORD", "DERIVED_COMPUTATION",
]);
export type DiligenceSourceClass = z.infer<typeof DiligenceSourceClassSchema>;
export const DiligenceSemanticsSchema = z.object({
  legalEntityId: z.string().uuid(), perimeter: z.array(z.string().uuid()).min(1).max(64),
  accountOrParticipantIds: z.array(id).min(1).max(128),
  periodStart: instant, periodEnd: instant, cutoff: instant,
  currency: z.string().regex(/^[A-Z]{3}$/), units: id, scale: ExactQuantitySchema,
  signConvention: z.enum(["AS_RECORDED", "NEGATE"]),
  basisRef: VReferenceSchema, grossNetTreatment: id, recognitionRule: id,
  calendarRef: id, consolidationRef: id, timeBasis: id,
}).strict().superRefine((s, ctx) => {
  if (!s.perimeter.includes(s.legalEntityId)) ctx.addIssue({ code: "custom", message: "Legal entity must belong to the exact perimeter" });
  if (Date.parse(s.periodStart) > Date.parse(s.periodEnd) || Date.parse(s.cutoff) < Date.parse(s.periodEnd))
    ctx.addIssue({ code: "custom", message: "Explicit ordered period and cutoff required" });
});
export type DiligenceSemantics = z.infer<typeof DiligenceSemanticsSchema>;
export const DiligenceAssertionSchema = z.object({
  assertionId: z.string().uuid(), revision: z.number().int().positive(),
  subject: EvidenceRootSchema, exactPredicate: z.string().min(1).max(2000),
  predicateKind: z.enum(["RECORD_VALUE", "RECORD_CLASSIFICATION", "POPULATION_TOTAL", "ABSENCE"]),
  field: id, economicRecordIds: z.array(id).max(1024),
  amountOrState: DiligenceValueSchema, semantics: DiligenceSemanticsSchema,
  startingSupportRefs: z.array(VReferenceSchema).max(128),
  knownGaps: z.array(z.string().min(1).max(1000)).max(128),
  materiality: z.object({ decisionRef: VReferenceSchema, rationale: z.string().min(1).max(2000), threshold: ExactQuantitySchema, dependencyRefs: z.array(VReferenceSchema).min(1).max(128) }).strict(),
  acceptableSourceClasses: z.array(DiligenceSourceClassSchema).min(1).max(4),
  observationPredicates: z.array(id).min(1).max(64),
  requiredCoverage: z.object({
    populationId: id, populationRevision: id, members: z.array(id).min(1).max(128),
    requiredRecordKinds: z.array(id).min(1).max(32), completePopulation: z.boolean(),
    measurementDesignRef: VReferenceSchema.nullable(), minimumCoverage: ExactQuantitySchema,
    errorTolerance: ExactQuantitySchema,
  }).strict(),
}).strict().superRefine((a, ctx) => {
  if (a.subject.entityId !== a.semantics.legalEntityId)
    ctx.addIssue({ code: "custom", message: "Subject and legal entity must be identical canonical references" });
  if (new Set(a.requiredCoverage.members).size !== a.requiredCoverage.members.length ||
      new Set(a.economicRecordIds).size !== a.economicRecordIds.length)
    ctx.addIssue({ code: "custom", message: "Duplicate population or economic record identity" });
  if (["RECORD_VALUE", "RECORD_CLASSIFICATION"].includes(a.predicateKind) && a.economicRecordIds.length === 0)
    ctx.addIssue({ code: "custom", message: "Exact record predicates require frozen economic identities" });
});
export type DiligenceAssertion = z.infer<typeof DiligenceAssertionSchema>;

export const PrimaryAuthorityProfileSchema = z.object({
  schema: z.literal("finnor.primary-authority.v1"), profileId: z.string().uuid(), revision: z.number().int().positive(),
  issuingPrincipalId: z.string().uuid(), legalEntityIds: z.array(z.string().uuid()).min(1).max(64),
  jurisdictions: z.array(id).min(1).max(16), instrumentAndTransactionClasses: z.array(id).min(1).max(32),
  activities: z.array(z.object({
    activity: z.enum(["RESEARCH", "ACCESS_RECORDS", "REQUEST_CONSENT", "CONTACT", "DISCLOSE", "INTERPRET"]),
    actorIds: z.array(z.string().uuid()).min(1).max(32), channelIds: z.array(id).min(1).max(32),
  }).strict()).min(1).max(32),
  professionalRequirements: z.array(z.object({ activity: id, qualificationRef: VReferenceSchema, requiredActorId: z.string().uuid() }).strict()).max(32),
  approvedTemplateRefs: z.array(VReferenceSchema).max(32), negotiationBoundsRef: VReferenceSchema.nullable(),
  disclosureRules: z.array(id).min(1).max(64), confidentialityRules: z.array(id).min(1).max(64),
  contactLimits: z.object({ maximumRequests: z.number().int().min(0).max(1024), minimumSpacingMs: z.number().int().min(0), suppressedParticipantIds: z.array(id).max(1024) }).strict(),
  exposureLimitMicroUsd: integer, reservationRequired: z.literal(true),
  approvalRef: VReferenceSchema, validFrom: instant, expiresAt: instant,
  escalationConditions: z.array(id).min(1).max(64), revocationConditions: z.array(id).min(1).max(64),
  legalReviewEvidenceRefs: z.array(VReferenceSchema).min(1).max(32), policyRevision: id,
  environment: z.enum(["DEVELOPMENT", "LIVE"]),
}).strict();
export type PrimaryAuthorityProfile = z.infer<typeof PrimaryAuthorityProfileSchema>;
export const PrimaryConsentSchema = z.object({
  schema: z.literal("finnor.primary-consent.v1"), consentId: z.string().uuid(), revision: z.number().int().positive(),
  issuerId: z.string().uuid(), authorizedActorId: z.string().uuid(), legalEntityId: z.string().uuid(),
  sourceProfileIds: z.array(z.string().uuid()).min(1).max(32), accountOrParticipantIds: z.array(id).min(1).max(128),
  products: z.array(id).min(1).max(32), purposes: z.array(id).min(1).max(32),
  periodStart: instant, periodEnd: instant, validFrom: instant, expiresAt: instant,
  rightsRef: VReferenceSchema, permissionEvidenceRef: VReferenceSchema,
  retention: z.object({ rawUntil: instant, derivativesUntil: instant, retainAfterRevocation: z.boolean() }).strict(),
  disclosureRules: z.array(id).min(1).max(32), environment: z.enum(["DEVELOPMENT", "LIVE"]),
}).strict();
export type PrimaryConsent = z.infer<typeof PrimaryConsentSchema>;
export const PrimarySourceProfileSchema = z.object({
  schema: z.literal("finnor.primary-source-profile.v1"), profileId: z.string().uuid(), revision: z.number().int().positive(),
  issuer: id, system: id, legalEntityId: z.string().uuid(), sourceClass: DiligenceSourceClassSchema,
  sourceControl: z.enum(["EXTERNAL_ISSUER", "EXTERNAL_RESPONDENT", "TARGET", "COMPUTATION"]),
  accountOrParticipantIds: z.array(id).min(1).max(128), products: z.array(id).min(1).max(32),
  purpose: id, channelId: id, channelResolutionEvidenceRef: VReferenceSchema,
  endpoint: z.string().url().max(2048), responsePublicKeyPem: z.string().min(40).max(4096),
  credentialRef: id.nullable(),
  authoritativeFields: z.array(id).min(1).max(64), respondentId: id.nullable(),
  respondentRole: id.nullable(), respondentKnowledge: z.array(id).max(64),
  respondentAuthorityRef: VReferenceSchema.nullable(),
  intermediary: z.object({ issuer: id, reliabilityContractRef: VReferenceSchema, independentlyQualified: z.boolean() }).strict().nullable(),
  availableHistory: z.object({ start: instant, end: instant, reasons: z.array(id).max(32) }).strict(),
  observationPredicates: z.array(id).min(1).max(64), adapterVersion: z.literal("primary-records-http-v1"),
  recovery: z.enum(["IDEMPOTENT_REQUEST_WITH_STATUS", "REPEATABLE_FREE_READ", "NONREPEATABLE_REQUEST_WITH_STATUS"]),
  price: z.object({ pricebookRef: VReferenceSchema, maximumRequestMicroUsd: integer, statusReadMicroUsd: integer }).strict(),
  rightsRef: VReferenceSchema, authorityEvidenceRefs: z.array(VReferenceSchema).min(1).max(32),
  environment: z.enum(["DEVELOPMENT", "LIVE"]), admissionRef: VReferenceSchema.nullable(),
  validFrom: instant, expiresAt: instant,
}).strict();
export type PrimarySourceProfile = z.infer<typeof PrimarySourceProfileSchema>;
export const PrimaryReferenceSemanticsSchema = z.object({
  schema: z.literal("finnor.primary-reference-semantics.v1"), profileId: z.string().uuid(), revision: z.number().int().positive(),
  issuerId: z.string().uuid(), acceptedBy: z.string().uuid(), authorityRef: VReferenceSchema,
  legalEntityId: z.string().uuid(), rules: z.array(z.object({
    field: id, recordKinds: z.array(id).min(1).max(32),
    treatment: z.enum(["EXACT_RECORDED_VALUE", "EXACT_RECORDED_STATE", "EARNED_REVENUE"]),
    requiredWitnessFields: z.array(id).min(1).max(32), excludedInterpretations: z.array(id).min(1).max(64),
  }).strict()).min(1).max(64),
  grossNetTreatment: id, recognitionRule: id, calendarRef: id, consolidationRef: id,
  professionalReviewRef: VReferenceSchema.nullable(), environment: z.enum(["DEVELOPMENT", "LIVE"]),
  validFrom: instant, expiresAt: instant,
}).strict();
export type PrimaryReferenceSemantics = z.infer<typeof PrimaryReferenceSemanticsSchema>;
export const PrimaryMandateSchema = z.object({
  schema: z.literal("finnor.primary-mandate.v1"), mandateId: z.string().uuid(), revision: z.number().int().positive(),
  issuingPrincipalId: z.string().uuid(), legalEntityId: z.string().uuid(), objective: z.string().min(1).max(2000),
  permittedPurpose: id, decisionRef: VReferenceSchema, authorityProfileId: z.string().uuid(),
  sourceProfileIds: z.array(z.string().uuid()).min(1).max(32), assertionIds: z.array(z.string().uuid()).min(1).max(128),
  stopping: z.object({ maxAcquisitions: z.number().int().min(1).max(1024), deadline: instant, waitUntil: instant, stopOnRequiredCoverage: z.boolean(), contradictionRevalidationRequired: z.literal(true) }).strict(),
  priorityRule: z.literal("MATERIAL_COVERAGE_PER_RESERVED_COST_THEN_DELAY"),
  validFrom: instant, expiresAt: instant, environment: z.enum(["DEVELOPMENT", "LIVE"]),
}).strict();
export type PrimaryMandate = z.infer<typeof PrimaryMandateSchema>;
export const PrimaryGrantSchema = z.object({
  schema: z.literal("finnor.primary-grant.v1"), grantId: z.string().uuid(), revision: z.number().int().positive(),
  issuingPrincipalId: z.string().uuid(), mandateId: z.string().uuid(), legalEntityId: z.string().uuid(),
  maximumMicroUsd: integer, maximumRequests: z.number().int().min(1).max(1024),
  maximumNativeCpuMicros: integer, maximumMemoryBytes: integer, maximumHumanSeconds: z.number().int().min(0),
  maximumStoredBytes: z.number().int().min(1024).max(67108864),
  pricebook: z.object({
    ref: VReferenceSchema, cpuMicroUsdPerSecond: ExactQuantitySchema,
    storageMicroUsdPerByte: ExactQuantitySchema, orchestrationMicroUsdPerSecond: ExactQuantitySchema,
    humanMicroUsdPerSecond: ExactQuantitySchema,
  }).strict(),
  reservationRef: VReferenceSchema, retainedObligationRefs: z.array(VReferenceSchema).max(128),
  expiresAt: instant, environment: z.enum(["DEVELOPMENT", "LIVE"]),
}).strict();
export type PrimaryGrant = z.infer<typeof PrimaryGrantSchema>;
export const PrimaryGovernanceSchema = z.discriminatedUnion("schema", [
  PrimarySourceProfileSchema, PrimaryAuthorityProfileSchema, PrimaryConsentSchema,
  PrimaryReferenceSemanticsSchema, PrimaryMandateSchema, PrimaryGrantSchema,
]);
export type PrimaryGovernance = z.infer<typeof PrimaryGovernanceSchema>;

export const PrimaryRecordSchema = z.object({
  issuerRecordId: id, economicId: id, revision: z.number().int().positive(), kind: id,
  legalEntityId: z.string().uuid(), accountOrParticipantId: id, periodStart: instant, periodEnd: instant,
  currency: z.string().regex(/^[A-Z]{3}$/), units: id, basisDigest: digest,
  state: z.enum(["POSTED", "PENDING", "REMOVED", "REVERSED"]),
  replacesEconomicId: id.nullable(), reversesEconomicId: id.nullable(), aliasOf: id.nullable(),
  effectiveAt: instant, observedAt: instant,
  fields: z.record(z.string(), DiligenceValueSchema).refine(v => Object.keys(v).length <= 64),
  witnessFields: z.record(z.string(), z.string().max(4000)).refine(v => Object.keys(v).length <= 64),
  relatedParty: z.enum(["YES", "NO", "UNKNOWN"]),
}).strict();
export type PrimaryRecord = z.infer<typeof PrimaryRecordSchema>;
export const PrimaryRequestSchema = z.object({
  schema: z.literal("finnor.primary-request.v1"), requestId: z.string().uuid(),
  tenantId: z.string().uuid(), principalId: z.string().uuid(), programmeId: z.string().uuid(),
  assertionRefs: z.array(VReferenceSchema).min(1).max(128),
  sourceProfileRef: VReferenceSchema, consentRef: VReferenceSchema, authorityRef: VReferenceSchema,
  mandateRef: VReferenceSchema, grantRef: VReferenceSchema, semanticsRef: VReferenceSchema,
  legalEntityId: z.string().uuid(), accountOrParticipantIds: z.array(id).min(1).max(128),
  purpose: id, product: id, fieldNames: z.array(id).min(1).max(64),
  periodStart: instant, periodEnd: instant, cutoff: instant,
  populationId: id, populationRevision: id, requiredMembers: z.array(id).min(1).max(128),
  economicRecordIds: z.array(id).max(1024), knowledgeCut: instant, requestedAt: instant, expiresAt: instant,
}).strict();
export type PrimaryRequest = z.infer<typeof PrimaryRequestSchema>;
export const PrimaryProviderCostSchema=z.object({receiptId:id,pricebookDigest:digest,microUsd:integer,possibleAdditionalMicroUsd:integer,final:z.boolean()}).strict();
/** Status carries only the retained request outcome and payer's receipt, never
 * financial record contents. Revoked data access cannot become a balance read. */
export const PrimaryRequestStatusBodySchema=z.object({
 schema:z.literal('finnor.primary-request-status.v1'),requestId:z.string().uuid(),requestDigest:digest,
 issuer:id,system:id,channelId:id,legalEntityId:z.string().uuid(),checkedAt:instant,
 outcome:z.enum(['ACKNOWLEDGED','UNKNOWN','REJECTED']),resultAvailable:z.boolean(),providerCost:PrimaryProviderCostSchema,
}).strict();
export const SignedPrimaryRequestStatusSchema=z.object({body:PrimaryRequestStatusBodySchema,signature:z.string().min(40).max(256)}).strict();
export type SignedPrimaryRequestStatus=z.infer<typeof SignedPrimaryRequestStatusSchema>;
export const PrimaryResponseBodySchema = z.object({
  schema: z.literal("finnor.primary-response.v1"), requestId: z.string().uuid(), requestDigest: digest,
  issuer: id, system: id, legalEntityId: z.string().uuid(), channelId: id,
  respondentId: id.nullable(), respondentRole: id.nullable(), respondentKnowledge: z.array(id).max(64),
  sourceClass: DiligenceSourceClassSchema, sourceControl: z.enum(["EXTERNAL_ISSUER", "EXTERNAL_RESPONDENT", "TARGET", "COMPUTATION"]),
  sourceRevision: id, observedAt: instant, status: z.enum(["OBSERVED", "NONRESPONSE", "UNAVAILABLE_HISTORY", "EMPTY_ACCESSIBLE_SUBSET", "NO_RECORD", "UNKNOWN"]),
  populationId: id, populationRevision: id, observedMembers: z.array(id).max(128),
  coverage: z.object({
    historyStart: instant, historyEnd: instant, completeForMembers: z.array(id).max(128),
    availableRecordKinds: z.array(id).max(32), completePopulation: z.boolean(),
    nextCursor: id.nullable(), pageId: id, totalPages: z.number().int().min(1).max(256),
    missingReasons: z.array(id).max(128), measurementDesignRef: VReferenceSchema.nullable(),
  }).strict(),
  records: z.array(PrimaryRecordSchema).max(1024),
  providerCost: PrimaryProviderCostSchema,
  suspiciousReasons: z.array(id).max(32),
}).strict();
export type PrimaryResponseBody = z.infer<typeof PrimaryResponseBodySchema>;
export const SignedPrimaryResponseSchema = z.object({ body: PrimaryResponseBodySchema, signature: z.string().min(40).max(256) }).strict();
export type SignedPrimaryResponse = z.infer<typeof SignedPrimaryResponseSchema>;
export interface PrimaryObservation {
  observationId: string; sourceRef: VReference; request: PrimaryRequest;
  requestDigest: string; raw: SignedPrimaryResponse; rawDigest: string;
  retrievedAt: string; sourceProfile: PrimarySourceProfile; consent: PrimaryConsent;
  authority: PrimaryAuthorityProfile; actualAcquisition: true; sourceClass: DiligenceSourceClass;
  instructionEligible: false;
}
export interface PrimaryCostReceipt {
  id: string; owner: "S5" | "S6" | "P4" | "P2"; requestId: string | null;
  kind: "ACQUISITION" | "STATUS_READ" | "CONTACT" | "NATIVE" | "ORCHESTRATION" | "STORAGE" | "HUMAN";
  microUsd: string | null; reservedMicroUsd: string; possibleAdditionalMicroUsd: string;
  cpuMicros: string | null; wallMs: number; peakMemoryBytes: string | null;
  bytes: number; humanSeconds: number; pricebookRef: VReference;
  status: "RECONCILED" | "UNKNOWN" | "METER_GAP"; reasons: string[];
}
export interface PrimarySourceWitness {
  observationRef: VReference; issuerRecordId: string; economicId: string; sourceRevision: string;
  field: string; rawPointer: string; rawValue: DiligenceValue; normalizedValue: DiligenceValue;
  semantics: DiligenceSemantics; sourceClass: DiligenceSourceClass;
}
export interface PrimaryReconciliation {
  assertionRef: VReference; sourceWitnesses: PrimarySourceWitness[];
  selectedEconomicIds: string[]; excludedEconomicIds: Array<{ id: string; reason: string }>;
  observedMembers: string[]; requiredMembers: string[]; coverageComplete: boolean;
  observedValue: DiligenceValue; gaps: string[];
  discrepancy: { asserted: DiligenceValue; observed: DiligenceValue; difference: DiligenceValue } | null;
  uncertainty: { identity: string[]; measurement: string[]; sampling: string[]; interpretation: string[] };
  excludedInterpretations: string[];
}
export interface PrimaryClaimCheck {
  checkId: string; checkerIdentity: VReference; assertionRef: VReference;
  observationRefs: VReference[]; sourceScopeDigest: string; semanticsRef: VReference;
  result: "ACCEPT" | "UNRESOLVED" | "REJECT";
  conclusion: "SUPPORTED" | "CONTRADICTED" | "UNRESOLVED";
  establishedValue: DiligenceValue; reasons: string[]; excludedInterpretations: string[];
  checkedAt: string; producerReconciliationDigest: string; independentReconciliation: PrimaryReconciliation;
}
export interface VArtifactEnvelope<K extends string = "IndependentlyEstablishedFinding", S extends string = "finnor.v2.finding.v1"> {
  artifactId: string; artifactKind: K; schemaRevision: S;
  contentDigest: string; tenantRef: string; workRef: string; workRevision: string;
  producerDigest: string; dependencyLockDigest: string; admissionRef: VReference | null;
  baselineManifestRef: VReference; domainProfileRef: VReference;
  mandateRef: VReference; authorityProfileRef: VReference; budgetGrantRef: VReference;
  sourceRefs: VReference[]; sourceRevisionVector: Array<{ key: string; revision: number }>; rightsRevision: number;
  effectiveTime: string; knowledgeTime: string; observationTime: string | null;
  acceptedClaims: VReference[]; unresolvedClaims: VReference[]; contradictionRefs: VReference[];
  independentCheckRefs: VReference[]; effectObligationRefs: VReference[]; externalEventRefs: VReference[];
  costReceipts: PrimaryCostReceipt[]; humanInterventionReceipts: VReference[];
  invalidationDependencies: Array<{ key: string; revision: number }>;
  lifecycleEvents: Array<{ state: "proposed" | "development-verified" | "domain-qualified" | "S8-admitted" | "active" | "invalidated" | "revoked"; at: string; evidenceRef: VReference }>;
}
export interface IndependentlyEstablishedFinding extends VArtifactEnvelope {
  assertionRef: VReference; startingEvidenceDigest: string;
  acquisitionPlanAndConsentRefs: VReference[]; actualPrimaryObservationRefs: VReference[];
  sourceAuthorityAndIndependenceBasis: Array<{ sourceRef: VReference; sourceClass: DiligenceSourceClass; sourceControl: string; authorityRefs: VReference[]; issuer: string; respondentId: string | null; intermediary: PrimarySourceProfile["intermediary"] }>;
  observedPopulationAndCoverage: PrimaryReconciliation;
  normalizedReconciliationAndCheckerRefs: VReference[];
  conclusion: "SUPPORTED" | "CONTRADICTED" | "UNRESOLVED"; establishedValueOrInterval: DiligenceValue;
  unobservedRemainderAndMaterialGaps: string[]; downstreamInvalidationRefs: VReference[];
  freshnessAndReacquisitionConditions: { expiresAt: string; conditions: string[] };
  evidenceLabels: Array<"SOURCE_ASSERTED" | "EXTERNALLY_CONFIRMED" | "COMPUTATION_CHECKED" | "UNRESOLVED" | "CONTRADICTED">;
  environment: "DEVELOPMENT" | "LIVE"; auditOpinion: false;
}
export const PrimaryIntakeSchema = z.object({
  schema: z.literal("finnor.primary-diligence.v1"), root: EvidenceRootSchema, workId: z.string().uuid(),
  expectedWorkInputId: z.string().uuid(), idempotencyKey: z.string().min(1).max(200),
  assertions: z.array(DiligenceAssertionSchema).min(1).max(128),
  startingEvidenceRefs: z.array(VReferenceSchema).max(128),
  mandateRef: VReferenceSchema, authorityProfileRef: VReferenceSchema, budgetGrantRef: VReferenceSchema,
  sourceProfileRefs: z.array(VReferenceSchema).min(1).max(32), consentRefs: z.array(VReferenceSchema).min(1).max(32),
  referenceSemanticsRefs: z.array(VReferenceSchema).min(1).max(32),
  predecessorRef: VReferenceSchema.nullable(), mode: z.enum(["ordinary_disposable", "protected"]),
}).strict();
export type PrimaryIntake = z.infer<typeof PrimaryIntakeSchema>;
export type PrimaryProgrammeStatus = "PROGRESS" | "WAITING" | "BLOCKED" | "STOPPED" | "RECONCILING" | "FAILED" | "COMPLETE";
export interface PrimaryAdvanceResult {
  status: PrimaryProgrammeStatus; principalArtifactRef: VReference | null;
  nextObligationRefs: VReference[]; requiredApprovalRefs: VReference[];
  unresolvedClaimRefs: VReference[]; remainingExposureRefs: VReference[]; costReceipts: PrimaryCostReceipt[];
}
export const PrimaryAdvanceSchema = z.object({
  programmeRef: VReferenceSchema, expectedRevision: z.number().int().positive(), triggerRef: VReferenceSchema,
  mandateRef: VReferenceSchema, authorityProfileRef: VReferenceSchema, domainProfileRef: VReferenceSchema,
  evidenceRevisionVector: z.array(z.object({ key: id, revision: z.number().int().min(0) }).strict()).max(1024),
  budgetGrantRef: VReferenceSchema,
}).strict();
export const PrimaryFindingBindingSchema = z.object({ findingId: z.string().uuid(),economicId:id.optional() }).strict();
export const PrimaryUnderwritingInputsSchema = z.record(z.string(), PrimaryFindingBindingSchema).refine(b => Object.keys(b).length <= 16);
export type PrimaryFindingBinding = z.infer<typeof PrimaryFindingBindingSchema>;
export const PrimaryUnderwritingScopeSchema = z.object(DiligenceAssertionSchema.shape).pick({
 predicateKind:true,field:true,economicRecordIds:true,semantics:true,requiredCoverage:true,acceptableSourceClasses:true,
}).strict();
export type PrimaryUnderwritingScope = z.infer<typeof PrimaryUnderwritingScopeSchema>;
