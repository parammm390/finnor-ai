import { createHash } from "node:crypto";
import { z } from "zod";

export const W4_VERSION = "finnor.market-validated-operating-program.v1" as const;
export const W4_REQUIREMENTS = "FINNOR-POSTZ-W-PRD-1.0.0" as const;
export const W4_BOUNDS = Object.freeze({ capabilities: 32, demands: 32, buyers: 256, offers: 32,
  events: 8192, searchNodes: 20000, sourceBytes: 524288, artifactBytes: 4194304 });
const key = z.string().trim().min(1).max(160), uuid = z.string().uuid();
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const instantSchema = z.string().datetime({ offset: true });
export const minorSchema = z.string().regex(/^(0|[1-9]\d{0,14})$/);
export const moneySchema = z.object({ currency: z.string().regex(/^[A-Z]{3}$/), minor: minorSchema }).strict();
export const sourceRefSchema = z.object({ sourceId: uuid, versionId: uuid, contentDigest: digestSchema }).strict();
export const nativeRefSchema = z.object({ owner: key, id: z.string().min(1).max(1024), version: key,
  contentDigest: digestSchema }).strict();
export const scopeSchema = z.object({ tenantId: uuid, principalId: uuid, companyId: uuid, workId: uuid,
  businessAssignmentId: key }).strict();
export type SourceRef = z.infer<typeof sourceRefSchema>;
export type NativeRef = z.infer<typeof nativeRefSchema>;
export type GrowthScope = z.infer<typeof scopeSchema>;
export const AFFILIATIONS = ["UNAFFILIATED_ASSERTED", "EMPLOYEE", "RELATED_PARTY", "PRODUCER", "SYNTHETIC", "UNKNOWN"] as const;
export const COST_CATEGORIES = ["ACQUISITION", "IMPLEMENTATION", "FULFILLMENT", "SUPPORT", "HUMAN_TIME",
  "COMPUTE", "STORAGE", "RETURNS", "CANNIBALIZATION", "FINANCING", "TAX", "WORKING_CAPITAL", "RESIDUAL"] as const;
export const capabilitySchema = z.object({
  id: key, name: z.string().min(1).max(1024), outcomeIds: z.array(key).min(1).max(32),
  prerequisites: z.array(key).max(32), source: sourceRefSchema, validUntil: instantSchema,
  capacityUnits: z.number().int().nonnegative().max(1000000), committedUnits: z.number().int().nonnegative().max(1000000),
  supportCapacityUnits: z.number().int().nonnegative().max(1000000),
  committedSupportUnits: z.number().int().nonnegative().max(1000000),
  unitCost: moneySchema.nullable(), unitSupportCost: moneySchema.nullable(),
  deliveryLeadHours: z.number().int().min(1).max(8760), supportHours: z.number().int().min(1).max(8760),
  permittedClaims: z.array(z.string().min(1).max(1024)).min(1).max(32),
  operatorId: uuid, operationRef: nativeRefSchema,
}).strict();
export const demandSchema = z.object({
  id: key, description: z.string().min(1).max(4000), source: sourceRefSchema,
  outcomeIds: z.array(key).min(1).max(32), buyerIds: z.array(uuid).min(1).max(W4_BOUNDS.buyers),
  existingAlternatives: z.array(z.string().min(1).max(1024)).max(32),
  selectionBias: z.array(z.string().min(1).max(1024)).min(1).max(32), validUntil: instantSchema,
}).strict();
export const buyerSchema = z.object({
  buyerId: uuid, customerRef: nativeRefSchema, consentSource: sourceRefSchema,
  affiliation: z.enum(AFFILIATIONS), consentValidUntil: instantSchema, permittedPurpose: key,
}).strict();
export const growthInputSchema = z.object({
  schema: z.literal("finnor.growth-outcome.v1"), scope: scopeSchema, originalMeaning: z.string().min(1).max(8000),
  mandateSource: sourceRefSchema, validFrom: instantSchema, originalDeadlineAt: instantSchema,
  marketRevision: key, currency: z.string().regex(/^[A-Z]{3}$/), parentPolicy: nativeRefSchema,
  parentAllocation: nativeRefSchema, budgetObligation: nativeRefSchema,
  question: z.string().min(1).max(4000), permittedPurpose: key,
  permittedCapabilityIds: z.array(key).min(1).max(W4_BOUNDS.capabilities),
  capabilities: z.array(capabilitySchema).max(W4_BOUNDS.capabilities),
  demands: z.array(demandSchema).min(1).max(W4_BOUNDS.demands),
  population: z.array(buyerSchema).min(1).max(W4_BOUNDS.buyers),
  test: z.object({
    populationSource: sourceRefSchema, protocolSource: sourceRefSchema, independentObservationOwnerId: uuid,
    design: z.enum(["OBSERVATIONAL", "RANDOMIZED_CONTROLLED", "QUASI_EXPERIMENTAL"]),
    causalStatus: z.enum(["UNIDENTIFIED", "PROVISIONAL_S3_REFERENCE"]),
    s2ProtocolRef: nativeRefSchema, s3ModelRef: nativeRefSchema.nullable(),
    maxContacts: z.number().int().positive().max(W4_BOUNDS.buyers),
    maxMoney: moneySchema, maxHumanSeconds: z.number().int().nonnegative().max(86400),
    closesAt: instantSchema, minimumCommitments: z.number().int().positive().max(W4_BOUNDS.buyers),
    minimumRepetitions: z.number().int().positive().max(W4_BOUNDS.buyers),
    stopOnIncrementalLoss: z.literal(true), nonresponse: z.literal("RETAIN_IN_ORIGINAL_DENOMINATOR"),
    offeredExposure: z.literal("ASSIGNED_ONCE_BEFORE_CONTACT"),
    allowedChanges: z.array(z.enum(["PRICE_WITHIN_MANDATE", "CAPABILITY_PACKAGE", "NO_NEW_EXPOSURE"])).max(3),
  }).strict(),
  terms: z.object({
    revision: key, minimumContributionMinor: minorSchema, maximumUnitPrice: moneySchema,
    maximumUnitsPerBuyer: z.number().int().positive().max(1000000),
    refunds: z.string().min(1).max(2000), warranty: z.string().min(1).max(2000),
    exclusions: z.array(z.string().min(1).max(1024)).min(1).max(32),
    disclosure: z.string().min(1).max(4000), accountingPolicySource: sourceRefSchema,
    accountingCalendar: key, taxTreatment: z.string().min(1).max(2000),
    recognition: z.literal("DELIVERED_AND_INDEPENDENTLY_ACCEPTED_ACCRUAL"),
  }).strict(),
  reservedDecisions: z.array(z.object({ id: key, ownerId: uuid, reason: z.string().min(1).max(2000) }).strict()).max(32),
}).strict().superRefine((v, c) => {
  const unique = <T>(a: T[], label: string) => {
    if (new Set(a).size !== a.length) c.addIssue({ code: "custom", message: "Duplicate " + label });
  };
  unique(v.capabilities.map(x => x.id), "capability"); unique(v.demands.map(x => x.id), "demand");
  unique(v.population.map(x => x.buyerId), "buyer"); unique(v.permittedCapabilityIds, "permitted capability");
  if (Date.parse(v.validFrom) >= Date.parse(v.test.closesAt)
    || Date.parse(v.test.closesAt) >= Date.parse(v.originalDeadlineAt)
    || v.test.maxContacts > v.population.length || v.test.minimumCommitments > v.test.maxContacts
    || v.test.minimumRepetitions > v.test.maxContacts
    || v.test.maxMoney.currency !== v.currency || v.terms.maximumUnitPrice.currency !== v.currency)
    c.addIssue({ code: "custom", message: "Original test/resource/calendar contract mismatch" });
  const caps = new Set(v.capabilities.map(x => x.id)), buyers = new Set(v.population.map(x => x.buyerId));
  for (const cap of v.capabilities) {
    unique(cap.outcomeIds, "capability outcome"); unique(cap.prerequisites, "prerequisite");
    if (cap.prerequisites.some(id => !caps.has(id) || id === cap.id)
      || cap.committedUnits > cap.capacityUnits || cap.committedSupportUnits > cap.supportCapacityUnits
      || cap.unitCost && cap.unitCost.currency !== v.currency
      || cap.unitSupportCost && cap.unitSupportCost.currency !== v.currency)
      c.addIssue({ code: "custom", message: "Capability prerequisites, costs or existing obligations mismatch" });
  }
  for (const d of v.demands) {
    unique(d.outcomeIds, "demand outcome"); unique(d.buyerIds, "demand buyer");
    if (d.buyerIds.some(id => !buyers.has(id))) c.addIssue({ code: "custom", message: "Unregistered demand population" });
  }
  if (v.population.some(b => b.permittedPurpose !== v.permittedPurpose
    || b.customerRef.owner !== "external_contact" && b.customerRef.owner !== "external_organization"))
    c.addIssue({ code: "custom", message: "Canonical customer/purpose binding required" });
});
export type GrowthInput = z.infer<typeof growthInputSchema>;
export type Capability = z.infer<typeof capabilitySchema>;
export type Demand = z.infer<typeof demandSchema>;
export const offerSchema = z.object({
  id: key, demandId: key, capabilityIds: z.array(key).min(1).max(W4_BOUNDS.capabilities),
  outcomeIds: z.array(key).min(1).max(32), unitPrice: moneySchema, unitLifecycleCost: moneySchema,
  maximumUnits: z.number().int().positive().max(1000000), deliveryLeadHours: z.number().int().positive(),
  supportHours: z.number().int().positive(), claims: z.array(z.string()).min(1).max(1024),
  exclusions: z.array(z.string()).min(1).max(32), refunds: z.string(), warranty: z.string(), disclosure: z.string(),
  revision: key, accountingPolicySource: sourceRefSchema, termsDigest: digestSchema,
}).strict();
export type ConstructedOffer = z.infer<typeof offerSchema>;
export interface BuildIdentity { methodDigest: string; checkerDigest: string; runtimeDigest: string }
export const identitySchema = z.object({ methodDigest: digestSchema, checkerDigest: digestSchema, runtimeDigest: digestSchema }).strict();
export const programSchema = z.object({
  schema: z.literal(W4_VERSION), requirements: z.literal(W4_REQUIREMENTS), scope: scopeSchema,
  originalDigest: digestSchema, identity: identitySchema, originalDeadlineAt: instantSchema,
  parentPolicy: nativeRefSchema, parentAllocation: nativeRefSchema, budgetObligation: nativeRefSchema,
  marketRevision: key, compiledAt: instantSchema,
  hypotheses: z.array(z.object({ demandId: key, problem: z.string(),
    alternatives: z.array(z.string()), selectionBias: z.array(z.string()), source: sourceRefSchema,
    explanations: z.tuple([z.literal("NO_VIABLE_DEMAND"), z.literal("INTEREST_WITHOUT_VIABLE_COMMITMENT"),
      z.literal("VIABLE_COMMITMENT_REQUIRES_DELIVERY_AND_ECONOMICS")]) }).strict()).max(W4_BOUNDS.demands),
  protocol: growthInputSchema.shape.test, population: z.array(buyerSchema).max(W4_BOUNDS.buyers),
  offers: z.array(offerSchema).max(W4_BOUNDS.offers),
  assignedExposure: z.array(z.object({ buyerId: uuid, offerId: key, termsDigest: digestSchema }).strict()).max(W4_BOUNDS.buyers),
  operatingShape: z.array(z.object({ duty: z.enum(["CONTACT", "OFFER", "ACCEPT", "FULFILL", "DELIVERY_ACCEPTANCE",
    "COLLECT", "RECOGNIZE", "SUPPORT_REFUND", "STOP_RECONCILE"]), owner: key, required: z.literal(true) }).strict()).length(9),
  search: z.object({ visited: z.number().int().nonnegative().max(W4_BOUNDS.searchNodes),
    complete: z.boolean(), optimalityClaimed: z.literal(false) }).strict(),
  capabilityRequests: z.array(z.object({ demandId: key, missingOutcomeIds: z.array(key), reason: key }).strict()).max(W4_BOUNDS.demands),
  gaps: z.array(z.string()).max(4096), validationState: z.literal("CANDIDATE"),
  admitted: z.literal(false), productionActive: z.literal(false), fieldValidated: z.literal(false),
}).strict();
export type MarketValidatedOperatingProgram = z.infer<typeof programSchema>;
export interface ProgramCheck { disposition: "CHECKED_DEVELOPMENT" | "REJECTED"; reasons: string[];
  originalDigest: string; candidateDigest: string; fieldValidated: false; admissionGranted: false }

const common = { scope: scopeSchema, buyerId: uuid, offerId: key, termsDigest: digestSchema, at: instantSchema };
export const eventSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("RESPONSE"), response: z.enum(["INTEREST", "DECLINED", "ACCEPTED", "NONRESPONSE"]),
    quantity: z.number().int().positive().max(1000000) }).strict(),
  z.object({ ...common, kind: z.literal("DELIVERY"), quantity: z.number().int().positive().max(1000000),
    effectRef: nativeRefSchema }).strict(),
  z.object({ ...common, kind: z.literal("DELIVERY_ACCEPTANCE"), deliveredSourceIds: z.array(uuid).min(1).max(256),
    quantity: z.number().int().positive().max(1000000), accepted: z.boolean() }).strict(),
  z.object({ ...common, kind: z.literal("COLLECTION"), amount: moneySchema, invoiceRef: nativeRefSchema,
    accountingRef: nativeRefSchema, effectRef: nativeRefSchema }).strict(),
  z.object({ ...common, kind: z.literal("RECOGNITION"), amount: moneySchema, accountingRef: nativeRefSchema,
    accountingPolicySource: sourceRefSchema, acceptedSourceIds: z.array(uuid).min(1).max(256) }).strict(),
  z.object({ ...common, kind: z.literal("REFUND"), amount: moneySchema,
    status: z.enum(["REQUESTED", "SETTLED"]), requestSourceId: uuid.nullable(),
    accountingRef: nativeRefSchema.nullable(), effectRef: nativeRefSchema.nullable() }).strict(),
  z.object({ ...common, kind: z.literal("SUPPORT"), issueId: key, state: z.enum(["OPEN", "RESOLVED"]),
    residualLiability: moneySchema.nullable() }).strict(),
  z.object({ scope: scopeSchema, at: instantSchema, kind: z.literal("COST"), itemId: key,
    category: z.enum(COST_CATEGORIES), expense: moneySchema.nullable(), cash: moneySchema.nullable(),
    additionalTerminalLiability: moneySchema.nullable(), accountingRef: nativeRefSchema,
    treatment: z.literal("NO_DUPLICATE_EXPENSE_OR_TERMINAL_LIABILITY") }).strict(),
  z.object({ scope: scopeSchema, at: instantSchema, kind: z.literal("TEST_CLOSED"),
    originalPopulationSource: sourceRefSchema }).strict(),
  z.object({ scope: scopeSchema, at: instantSchema, kind: z.literal("MARKET_CHANGE"),
    previousRevision: key, currentRevision: key, reason: z.string().min(1).max(2000) }).strict(),
]);
export type CommercialEvent = z.infer<typeof eventSchema>;
export type ParticipantRole = "BUYER" | "OPERATOR" | "ACCOUNTANT" | "INDEPENDENT_OBSERVER";
export interface EventOriginal { ref: SourceRef; body: CommercialEvent; authorId: string; role: ParticipantRole;
  receivedAt: string; consentCurrent: boolean; consentValidAtReceipt?: boolean;
  evidenceClass: "CONTROLLED" | "REPLAYED" }
export interface EffectObservation { ref: NativeRef; kind: "OFFER" | "DELIVER" | "COLLECT" | "REFUND";
  buyerId: string; offerId: string; termsDigest: string; state: "NOT_ATTEMPTED" | "UNKNOWN" | "VERIFIED";
  quantity: number | null; amount: { currency: string; minor: string } | null; originalIdentityReadback: boolean;
  notBeforeAt?: string; basisSourceIds?: string[] }
export interface BusinessProjection {
  schema: "finnor.w4.operating-projection.v1"; scope: GrowthScope; artifactDigest: string;
  currentness: "CURRENT" | "STALE"; validationState: "CANDIDATE" | "TESTED_CONTROLLED" | "INCOMPLETE";
  counts: { assigned: number; responded: number; interested: number; declined: number; nonresponse: number;
    accepted: number; independentEligibleAccepted: number; delivered: number; repetitions: number };
  commitments: Array<{ buyerId: string; offerId: string; termsDigest: string; quantity: number;
    deliveredQuantity: number; acceptedDeliveryQuantity: number; state: string;
    supportUntil: string; continuingObligations: string[]; sourceIds: string[] }>;
  accounting: { currency: string; bookingsMinor: string; collectedMinor: string; recognizedMinor: string;
    deferredMinor: string; receivableMinor: string; refundedMinor: string; refundRequestedMinor: string;
    expenseMinor: string | null; cashCostMinor: string | null; additionalTerminalLiabilityMinor: string | null;
    incrementalNetAfterTaxMinor: string | null; missingCostCategories: string[]; canonicalAccountingRefs: NativeRef[] };
  decision: "TEST_WITHIN_ORIGINAL_LIMITS" | "CONTINUE_WITHIN_ORIGINAL_LIMITS" | "HOLD_UNKNOWN" | "ITERATE" | "STOP"
    | "STOP_NEW_EXPOSURE_RETAIN_OBLIGATIONS";
  gaps: string[]; originalFailures: string[]; causalStatus: "UNIDENTIFIED" | "PROVISIONAL_S3_REFERENCE";
  qualification: "CONTROLLED_DEVELOPMENT_ONLY"; fieldValidated: false; s7ProfitQualified: false;
  admissionGranted: false; executionAuthorityGranted: false;
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
}
export const bytesHash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const hash = (value: unknown) => bytesHash(canonical(value));
export const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export const sameScope = (a: GrowthScope, b: GrowthScope) => same(a, b);
export const offerTermsDigest = (offer: Omit<ConstructedOffer, "termsDigest">) => hash(offer);
