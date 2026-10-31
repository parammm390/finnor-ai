import { z } from "zod";
import { createHash } from "node:crypto";

export const W3_VERSION = "finnor.real-world-service.v1" as const;
export const W3_BOUNDS = Object.freeze({
  sites: 3, calendarDays: 30, instances: 2048, providers: 128, criteria: 128,
  edges: 16384, sourceBytes: 262144, artifactBytes: 8388608, observations: 50000,
  searchNodes: 100000,
});
const key = z.string().trim().min(1).max(160);
const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const instant = z.string().datetime({ offset: true }).refine(v => Number.isFinite(Date.parse(v)));
export const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v =>
  Number.isFinite(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v);
export const scalar = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/);
export const money = z.object({ currency: z.string().regex(/^[A-Z]{3}$/), minor: z.string().regex(/^(0|[1-9]\d{0,14})$/) }).strict();
export const quantity = z.object({ value: scalar.refine(v => decimal(v) > 0n), unit: key }).strict();
export const SourceRefSchema = z.object({
  sourceId: uuid, versionId: uuid, contentDigest: digest,
}).strict();
export type SourceRef = z.infer<typeof SourceRefSchema>;
export const NativeRefSchema = z.object({
  owner: key, id: z.string().min(1).max(1024), version: key, contentDigest: digest,
}).strict();
export type NativeRef = z.infer<typeof NativeRefSchema>;
export const ScopeSchema = z.object({
  tenantId: uuid, principalId: uuid, companyId: uuid, workId: uuid, businessAssignmentId: key,
}).strict();
export type ServiceScope = z.infer<typeof ScopeSchema>;
export const SERVICE_FAMILIES = [
  "COOK_CONTINUITY", "FACILITY_REPAIR", "INVENTORY_REPLENISHMENT", "EQUIPMENT_ONBOARDING",
  "CUSTOMER_RECOVERY", "TRAVEL_EVENT_SITE", "RECURRENT_SERVICE",
] as const;
export const COST_CATEGORIES = [
  "PROVIDER", "MATERIAL", "TRIAL", "EVALUATOR", "LOGISTICS", "ACCESS", "INSPECTION",
  "CANCELLATION", "BACKUP", "WASTE", "COORDINATION", "SUPERVISION", "RESCUE",
  "MODEL_TOOL_COMPUTE", "STORAGE_MAINTENANCE", "TAX_FINANCING", "RESIDUAL_LIABILITY",
] as const;
export const CostSchema = z.object({
  id: key, category: z.enum(COST_CATEGORIES),
  amount: money.nullable(), basis: z.enum(["QUOTE", "ACCRUED", "CASH", "EXPOSURE", "UNKNOWN"]),
  evidence: z.array(SourceRefSchema).max(32), reason: z.string().max(1024),
}).strict();
export type ServiceCost = z.infer<typeof CostSchema>;
const phase = z.enum(["READINESS", "TRIAL", "SERVICE", "HANDBACK", "ACCESS_RETIREMENT"]);
export const CriterionSchema = z.object({
  id: key, phase, kind: z.enum(["OBSERVED_EVENT", "INSPECTION", "SENSORY", "PROFESSIONAL", "ORIGINAL_ACCEPTANCE"]),
  hard: z.boolean(), independentOfProvider: z.boolean(), qualificationIds: z.array(key).max(32),
  maximumAgeSeconds: z.number().int().positive().max(2678400),
  description: z.string().min(1).max(2000),
}).strict().refine(v => v.kind !== "PROFESSIONAL" || v.hard && v.qualificationIds.length > 0,
  "Professional criteria require an explicit qualified process");
export type ServiceCriterion = z.infer<typeof CriterionSchema>;
export const DemandSchema = z.object({
  id: key, siteId: key, localDate,
  startAt: instant, endAt: instant, quantity,
  criterionIds: z.array(key).min(1).max(W3_BOUNDS.criteria),
  prerequisites: z.array(key).max(W3_BOUNDS.instances),
}).strict();
export type ServiceDemand = z.infer<typeof DemandSchema>;
const triggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("EXPLICIT_OUTCOME"), requesterId: uuid, originalSource: SourceRefSchema }).strict(),
  z.object({ kind: z.literal("STANDING_EVENT"), eventSource: SourceRefSchema, mandateSource: SourceRefSchema }).strict(),
]);
export const OutcomeContractSchema = z.object({
  schema: z.literal("finnor.service-outcome.v1"), scope: ScopeSchema,
  family: z.enum(SERVICE_FAMILIES), enterpriseArchetype: z.enum(["OPERATING_COMPANY", "PROFESSIONAL_SERVICES", "CAPITAL_INVESTMENT"]),
  trigger: triggerSchema, originalMeaning: z.string().min(1).max(8000), acceptanceOwnerId: uuid,
  mandateSource: SourceRefSchema, originalDeadlineAt: instant,
  fromDate: localDate, throughDate: localDate,
  sites: z.array(z.object({
    id: key, timeZone: key.refine(v => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true } catch { return false } }),
  }).strict()).min(1).max(W3_BOUNDS.sites),
  demands: z.array(DemandSchema).min(1).max(W3_BOUNDS.instances),
  criteria: z.array(CriterionSchema).min(1).max(W3_BOUNDS.criteria),
  disclosure: z.object({
    purpose: z.string().min(1).max(1024), operationalRequirements: z.array(z.string().min(1).max(512)).max(128),
    prohibitedData: z.array(key).max(64),
  }).strict(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  parentPolicy: NativeRefSchema, parentAllocation: NativeRefSchema,
  reservedDecisions: z.array(z.object({ id: key, ownerId: uuid, reason: z.string().min(1).max(2000) }).strict()).max(64),
  permittedOperations: z.array(z.enum(["OFFER", "TRIAL", "BOOK", "ACCESS", "CANCEL", "PAY", "RETIRE_ACCESS"])).max(7),
  assumptions: z.array(z.string().min(1).max(2000)).max(128),
}).strict().superRefine((v, ctx) => {
  const days = (Date.parse(v.throughDate) - Date.parse(v.fromDate)) / 86400000 + 1;
  const demandIds = new Set(v.demands.map(d => d.id)), criterionIds = new Set(v.criteria.map(c => c.id));
  if (days < 1 || days > W3_BOUNDS.calendarDays) ctx.addIssue({ code: "custom", message: "Original calendar bound" });
  if (new Set(v.sites.map(s => s.id)).size !== v.sites.length
    || demandIds.size !== v.demands.length || criterionIds.size !== v.criteria.length)
    ctx.addIssue({ code: "custom", message: "Duplicate original identity" });
  if (v.demands.reduce((n, d) => n + d.prerequisites.length, 0) > W3_BOUNDS.edges) {
    ctx.addIssue({ code: "custom", message: "Original dependency bound" });
    return;
  }
  for (const d of v.demands) {
    const site = v.sites.find(s => s.id === d.siteId);
    let calendarMatches = false;
    try { calendarMatches = !!site && dateAt(d.startAt, site.timeZone) === d.localDate }
    catch (error) { if (!(error instanceof RangeError)) throw error }
    if (!site || d.localDate < v.fromDate || d.localDate > v.throughDate
      || !Number.isFinite(Date.parse(d.startAt)) || !Number.isFinite(Date.parse(d.endAt))
      || Date.parse(d.endAt) <= Date.parse(d.startAt) || Date.parse(d.endAt) > Date.parse(v.originalDeadlineAt)
      || !calendarMatches
      || new Set(d.criterionIds).size !== d.criterionIds.length
      || new Set(d.prerequisites).size !== d.prerequisites.length
      || d.criterionIds.some(id => !criterionIds.has(id))
      || d.prerequisites.some(id => id === d.id || !demandIds.has(id)))
      ctx.addIssue({ code: "custom", message: "Original service site/calendar/window/criterion/dependency mismatch" });
  }
  const indegrees = new Map(v.demands.map(d => [d.id, d.prerequisites.length]));
  const dependents = new Map(v.demands.map(d => [d.id, [] as string[]]));
  for (const d of v.demands) for (const prerequisite of d.prerequisites) dependents.get(prerequisite)?.push(d.id);
  const ready = [...indegrees].filter(([, count]) => count === 0).map(([id]) => id);
  for (let cursor = 0; cursor < ready.length; cursor++) for (const dependent of dependents.get(ready[cursor]!) ?? []) {
    const count = indegrees.get(dependent)! - 1;
    indegrees.set(dependent, count);
    if (count === 0) ready.push(dependent);
  }
  if (ready.length !== v.demands.length)
    ctx.addIssue({ code: "custom", message: "Original dependency graph must be acyclic" });
});
export type OutcomeContract = z.infer<typeof OutcomeContractSchema>;

export const ProviderEvidenceSchema = z.object({
  schema: z.literal("finnor.service-provider-evidence.v1"), scope: ScopeSchema,
  providerId: uuid, reportingPrincipalId: uuid,
  provisionKind: z.enum(["INTERNAL", "EXISTING_VENDOR_EXPANSION", "TEMPORARY_PROVIDER", "PARTIAL_COVERAGE", "BACKUP"]),
  classification: z.enum(["SERVICE_PROCUREMENT", "EMPLOYMENT_RESERVED", "UNRESOLVED"]),
  classificationBasis: z.array(SourceRefSchema).max(16),
  lawfulDiscoveryBasis: z.array(SourceRefSchema).min(1).max(32),
  qualifications: z.array(z.object({
    id: key, validUntil: instant, evidence: SourceRefSchema, verifiedByPrincipalId: uuid,
    limitation: z.string().min(1).max(1024),
  }).strict()).max(64),
  availability: z.array(z.object({
    id: key, siteId: key, startAt: instant, endAt: instant, capacity: quantity,
    basis: SourceRefSchema, validUntil: instant,
  }).strict()).min(1).max(W3_BOUNDS.instances),
  quote: z.object({
    revision: key, validUntil: instant, cancellation: z.string().min(1).max(2000),
    compensation: z.string().min(1).max(2000), acceptance: z.string().min(1).max(2000),
    perInstanceCosts: z.array(CostSchema).min(1).max(64),
    unresolvedTerms: z.array(z.string().min(1).max(1024)).max(32),
  }).strict(),
  evidenceValidUntil: instant,
  claimsNotIndependentPhysicalTruth: z.literal(true),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.availability.map(a => a.id)).size !== v.availability.length
    || new Set(v.qualifications.map(q => q.id)).size !== v.qualifications.length
    || new Set(v.quote.perInstanceCosts.map(c => c.id)).size !== v.quote.perInstanceCosts.length
    || v.availability.some(a => Date.parse(a.startAt) >= Date.parse(a.endAt)))
    ctx.addIssue({ code: "custom", message: "Provider identities or availability windows are inconsistent" });
});
export type ProviderEvidence = z.infer<typeof ProviderEvidenceSchema>;
export interface ProviderOriginal {
  ref: SourceRef; body: ProviderEvidence; authorId: string; classification: EvidenceClass;
  current: boolean; invalidationReasons: string[];
}
export type EvidenceClass = "CONTROLLED" | "REPLAYED" | "GENUINE_HUMAN" | "FIELD";
export interface ServiceInstance extends ServiceDemand {
  originalDigest: string;
  timeZone: string;
}
export interface ServiceOption {
  providerId: string; source: SourceRef; provisionKind: ProviderEvidence["provisionKind"];
  instanceId: string; availabilityId: string; termsDigest: string;
  total: { currency: string; minor: string } | null;
  costs: ServiceCost[]; gaps: string[];
}
export interface RealWorldServiceProgram {
  schema: typeof W3_VERSION;
  envelope: {
    scope: ServiceScope; requirements: "FINNOR-POSTZ-W-PRD-1.0.0"; schemaVersion: 1;
    originalDigest: string; originalDeadlineAt: string;
    sourceRefs: SourceRef[]; methodDigest: string; checkerDigest: string; runtimeDigest: string;
    parentPolicy: NativeRef; parentAllocation: NativeRef;
    checked: "UNCHECKED"; admitted: false; productionActive: false; fieldValidated: false;
    supportedProfile: { sites: 3; calendarDays: 30; instances: 2048 };
  };
  original: OutcomeContract;
  instances: ServiceInstance[];
  dependencyEdges: Array<{ prerequisite: string; dependent: string }>;
  options: ServiceOption[];
  selection: Array<{ instanceId: string; providerId: string; termsDigest: string; availabilityId: string }>;
  observationRequirements: Array<{ instanceId: string; criterion: ServiceCriterion }>;
  search: { disposition: "COMPLETE" | "PARTIAL" | "EXHAUSTED"; visited: number; optimalityClaimed: false };
  gaps: string[];
  assignmentCount: 1;
}
export const ServiceProgramSchema = z.object({
  schema: z.literal(W3_VERSION),
  envelope: z.object({
    scope: ScopeSchema, requirements: z.literal("FINNOR-POSTZ-W-PRD-1.0.0"), schemaVersion: z.literal(1),
    originalDigest: digest, originalDeadlineAt: instant, sourceRefs: z.array(SourceRefSchema).max(W3_BOUNDS.providers),
    methodDigest: digest, checkerDigest: digest, runtimeDigest: digest,
    parentPolicy: NativeRefSchema, parentAllocation: NativeRefSchema, checked: z.literal("UNCHECKED"),
    admitted: z.literal(false), productionActive: z.literal(false), fieldValidated: z.literal(false),
    supportedProfile: z.object({ sites: z.literal(3), calendarDays: z.literal(30), instances: z.literal(2048) }).strict(),
  }).strict(),
  original: OutcomeContractSchema,
  instances: z.array(DemandSchema.extend({ originalDigest: digest, timeZone: key }).strict()).min(1).max(W3_BOUNDS.instances),
  dependencyEdges: z.array(z.object({ prerequisite: key, dependent: key }).strict()).max(W3_BOUNDS.edges),
  options: z.array(z.object({
    providerId: uuid, source: SourceRefSchema, provisionKind: ProviderEvidenceSchema.shape.provisionKind,
    instanceId: key, availabilityId: key, termsDigest: digest, total: money.nullable(),
    costs: z.array(CostSchema).min(1).max(64), gaps: z.array(z.string().min(1).max(1024)).max(34),
  }).strict()).max(W3_BOUNDS.artifactBytes),
  selection: z.array(z.object({ instanceId: key, providerId: uuid, termsDigest: digest, availabilityId: key }).strict()).max(W3_BOUNDS.instances),
  observationRequirements: z.array(z.object({ instanceId: key, criterion: CriterionSchema }).strict())
    .max(W3_BOUNDS.instances * W3_BOUNDS.criteria),
  search: z.object({ disposition: z.enum(["COMPLETE", "PARTIAL", "EXHAUSTED"]),
    visited: z.number().int().positive().max(W3_BOUNDS.searchNodes), optimalityClaimed: z.literal(false) }).strict(),
  gaps: z.array(z.string().min(1).max(2048)).max(W3_BOUNDS.instances + W3_BOUNDS.providers + 65),
  assignmentCount: z.literal(1),
}).strict();
export interface ProgramCheck {
  schema: "finnor.service-program-check.v1"; disposition: "CHECKED_DEVELOPMENT" | "REJECTED";
  originalDigest: string; candidateDigest: string; reasons: string[];
  checkedInstances: number; checkedEdges: number; physicalDeliveryEstablished: false; admissionGranted: false;
}
const observationCommon = {
  scope: ScopeSchema, instanceId: key, providerId: uuid, termsDigest: digest, at: instant,
  limits: z.array(z.string().min(1).max(1024)).min(1).max(32),
  unobserved: z.array(z.string().min(1).max(1024)).max(32),
  basis: z.array(SourceRefSchema).max(32),
};
const assessed = {
  criterionId: key, result: z.enum(["PASS", "FAIL", "CONFLICTING", "UNOBSERVED"]),
  note: z.string().min(1).max(2000),
};
export const ObservationSchema = z.discriminatedUnion("kind", [
  z.object({ ...observationCommon, kind: z.literal("QUOTE"), quoteRevision: key }).strict(),
  z.object({ ...observationCommon, kind: z.literal("ACCEPTED"), quoteRevision: key, effectRef: NativeRefSchema }).strict(),
  z.object({ ...observationCommon, kind: z.literal("STARTED") }).strict(),
  z.object({ ...observationCommon, kind: z.literal("DELIVERED"), quantity }).strict(),
  z.object({ ...observationCommon, ...assessed, kind: z.literal("OBSERVATION") }).strict(),
  z.object({ ...observationCommon, kind: z.literal("MISSED"), reason: z.string().min(1).max(2000) }).strict(),
  z.object({ ...observationCommon, kind: z.literal("DISPUTED"), reason: z.string().min(1).max(2000) }).strict(),
  z.object({ ...observationCommon, kind: z.literal("CANCELLATION_REQUESTED"), effectRef: NativeRefSchema }).strict(),
  z.object({ ...observationCommon, kind: z.literal("CANCELLED"), effectRef: NativeRefSchema,
    residualCosts: z.array(CostSchema).max(64) }).strict(),
  z.object({ ...observationCommon, kind: z.literal("ORIGINAL_ACCEPTANCE"), accepted: z.boolean(),
    observedSourceIds: z.array(uuid).min(1).max(W3_BOUNDS.observations) }).strict(),
  z.object({ ...observationCommon, kind: z.literal("INVOICE"), invoiceId: key, quantity, amount: money }).strict(),
  z.object({ ...observationCommon, kind: z.literal("PAYMENT"), invoiceId: key,
    effectRef: NativeRefSchema, status: z.enum(["UNKNOWN", "SETTLED", "DISPUTED"]), amount: money }).strict(),
  z.object({ ...observationCommon, kind: z.literal("COST"), cost: CostSchema }).strict(),
]);
export type ServiceObservation = z.infer<typeof ObservationSchema>;
export interface ObservationOriginal {
  ref: SourceRef; body: ServiceObservation; authorId: string; classification: EvidenceClass;
  role: "PROVIDER" | "RECIPIENT" | "INSPECTOR" | "PROFESSIONAL" | "ACCEPTANCE_OWNER";
  consentCurrent: boolean; qualificationIds: string[]; receivedAt: string;
}
export type ServiceState =
  | "PROPOSAL" | "QUOTED" | "ACCEPTED" | "READY" | "STARTED" | "OBSERVED_DELIVERED"
  | "INSPECTED" | "DISPUTED" | "MISSED" | "CANCELLATION_REQUESTED"
  | "CONFIRMED_CANCELLED_WITH_RESIDUALS" | "OPERATIONALLY_COMPLETE" | "FINANCIALLY_RECONCILED";
export interface NativeEffectObservation {
  ref: NativeRef; instanceId: string; providerId: string; termsDigest: string;
  invoiceSourceIds: string[];
  operation: "OFFER" | "TRIAL" | "BOOK" | "ACCESS" | "CANCEL" | "PAY" | "RETIRE_ACCESS";
  state: "NOT_ATTEMPTED" | "MAY_HAVE_LEFT" | "UNKNOWN" | "VERIFIED" | "CANCELLED_BEFORE_EFFECT";
  originalIdentityReadback: boolean;
}
export interface ProviderCommitmentProjection {
  providerId: string; termsDigest: string;
  state: "PROPOSED" | "QUOTED" | "ACCEPTED" | "CANCELLATION_REQUESTED" | "CONFIRMED_CANCELLED_WITH_RESIDUALS";
  effectRefs: NativeRef[]; residualCosts: ServiceCost[];
}
export interface InstanceProjection {
  instanceId: string; providerId: string; state: ServiceState;
  accepted: boolean; ready: boolean; delivered: boolean; inspected: boolean;
  operationallyComplete: boolean; financiallyReconciled: boolean;
  missingCriteria: string[]; contradictions: string[]; originalFailures: string[];
  observations: SourceRef[]; outstandingEffects: NativeRef[]; costs: ServiceCost[];
  commitments: ProviderCommitmentProjection[];
}
export interface ServiceProjection {
  originalBusinessAssignments: 1; instances: InstanceProjection[];
  operationallyComplete: boolean; financiallyReconciled: boolean; fieldValidated: false;
  originalFailures: string[]; residualEffects: NativeRef[]; knownCosts: Array<{ currency: string; minor: string }>;
  unknownCostCategories: string[]; evidenceClasses: EvidenceClass[]; unreconciledInvoiceSources: SourceRef[];
}
export function decimal(value: string): bigint {
  const [whole = "0", part = ""] = value.split(".");
  return BigInt(whole) * 1000000n + BigInt(part.padEnd(6, "0"));
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw Error("W3_NONFINITE_VALUE"); return JSON.stringify(value) }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (typeof value === "object") {
    return "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
  }
  throw Error("W3_NON_JSON_VALUE");
}
export const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export const bytesHash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function dateAt(value: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(value));
  const p = (name: string) => parts.find(x => x.type === name)?.value;
  return `${p("year")}-${p("month")}-${p("day")}`;
}
export const sameScope = (a: ServiceScope, b: ServiceScope) => canonical(a) === canonical(b);
export function optionTerms(outcome: OutcomeContract, demand: ServiceDemand, original: ProviderOriginal, originalDigest = hash(outcome)): string {
  return hash({ original: originalDigest, demand, providerId: original.body.providerId,
    providerSource: original.ref, quote: original.body.quote, disclosure: outcome.disclosure });
}
