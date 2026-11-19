import { z } from "zod";

const key = z.string().trim().min(1).max(160);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const seconds = z.number().int().min(0).max(2_000_000_000);
const instant = z.string().datetime({ offset: true });
export const organizationReference = z.object({
  owner: key, id: key, version: key, contentDigest: digest,
}).strict();
export type OrganizationReference = z.infer<typeof organizationReference>;
export const organizationRole = z.object({
  id: key, principalId: z.string().uuid(), teamId: key,
  kind: z.enum(["HUMAN", "DIGITAL", "PROVIDER"]),
  capabilities: z.array(key).max(64), availableSeconds: seconds, committedSeconds: seconds,
  compensationMinor: seconds, benefitsDigest: key, safetyDigest: key, accessibilityDigest: key,
  authorityRefs: z.array(organizationReference).max(32),
}).strict();
export const organizationNode = z.object({
  id: key, kind: z.enum(["PREPARE", "INTERPRET", "APPROVE", "EXECUTE", "INSPECT", "RECONCILE", "EVIDENCE_GATE", "COORDINATE"]),
  roleId: key, operation: key, after: z.array(key).max(64),
  requiredEvidence: z.array(key).max(64), mandatory: z.boolean(), effortSeconds: seconds,
}).strict();
export const organizationProcess = z.object({
  id: key, family: z.enum(["CUSTOMER_RESOLUTION", "PROCUREMENT", "ONBOARDING", "CLOSE_READINESS", "GROWTH_STRAIN", "IT_INCIDENT"]),
  serviceId: key, teamIds: z.array(key).min(1).max(4), nodes: z.array(organizationNode).min(1).max(64),
}).strict();
export const liveOrganizationObligation = z.object({
  id: key, workId: z.string().uuid(), meaningDigest: key, termsDigest: key, deadline: instant,
  // Null is unobserved, not zero. An S5 envelope or attempt count cannot supply money.
  reservationRef: organizationReference, consumedMinor: seconds.nullable(), unresolvedMinor: seconds.nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(), accountableRoleId: key, processId: key, nodeId: key,
  state: z.enum(["OPEN", "ACCEPTED", "DISPATCHED", "MAY_HAVE_LEFT", "UNKNOWN", "DISPUTED", "SETTLED"]),
  effectRefs: z.array(organizationReference).max(64), dependencyRefs: z.array(organizationReference).max(64),
  attempts: z.number().int().min(0).max(10000),
  attemptAccounting: z.literal("NATIVE_OBSERVED_MINIMUM_NOT_COMPLETE_PROVIDER_METER").optional(),
  canonical: z.object({
    obligationRef: organizationReference, allocationRef: organizationReference, consumptionRef: organizationReference,
    workInputId: z.string().uuid().nullable(), planRevisionId: z.string().uuid().nullable(), planDigest: digest.nullable(),
    deadlines: z.object({ businessStartAt: instant, businessPeriodEndAt: instant, authorityExpiresAt: instant }).strict(),
    resourceEnvelopeDigest: digest, reservationRevisionAtPreparation: z.number().int().positive(),
  }).strict().optional(),
}).strict();
export type LiveOrganizationObligation = z.infer<typeof liveOrganizationObligation>;
export const organizationResourceOwner = z.object({
  owner: z.enum(["P1", "P2", "W2"]), id: z.string().uuid(), parentId: z.string().uuid().nullable(),
  workId: z.string().uuid(), workInputId: z.string().uuid(), workInputDigest: digest,
  requestDigest: digest, originalTermsDigest: digest, originalDeadline: instant,
  originalLimits: z.record(key, z.number().int().nonnegative()).refine(v => Object.keys(v).length <= 32),
  observedCounters: z.record(key, z.number().int().nonnegative()).refine(v => Object.keys(v).length <= 64),
  generation: z.number().int().positive().nullable(), status: key, currentNativeStateDigest: digest,
  physicalAttempts: z.array(z.object({ id: z.string().uuid(), unitId: z.string().uuid(), deliveryId: z.string().uuid(),
    claimFence: z.number().int().positive(), status: key, preimageDigest: digest,
  }).strict()).max(4096),
  physicalAttemptCoverage: z.enum(["P2_NATIVE_ATTEMPT_ROWS_NOT_PROVIDER_BILLING", "NOT_A_P2_PHYSICAL_ATTEMPT_METER"]),
  counterAccounting: z.literal("ORIGINAL_NATIVE_COUNTERS_NOT_ADDITIVE_MONEY"),
}).strict();
export type OrganizationResourceOwner = z.infer<typeof organizationResourceOwner>;
/** A native resource hold is not a fabricated business Work or S6 obligation. */
export const organizationResourceConstraint = z.object({
  schema: z.literal("finnor.organization-native-resource-constraint.v1"), id: key,
  reservationRef: organizationReference, certificateRef: organizationReference, problemRef: organizationReference,
  nativeProblemDigest: digest, originalDeadline: instant,
  canonicalRoots: z.array(z.object({ entityType: z.enum(["work", "COMPANY", "external_organization"]), entityId: key }).strict()).min(1).max(2048),
  originalWorks: z.array(z.object({ workId: z.string().uuid(), initialMeaningDigest: digest }).strict()).max(1024),
  nativeOwners: z.array(organizationResourceOwner).max(2048).optional(),
  originalResourceEnvelope: z.array(z.object({
    resourceId: key, unit: key, kind: z.enum(["STOCK", "FLOW", "OCCUPANCY", "CUMULATIVE_EXPENDITURE", "EXPOSURE"]),
    horizon: z.object({ startAt: instant, periodMs: z.number().int().positive(), periods: z.number().int().min(1).max(1024) }).strict(),
    quantities: z.array(z.string().min(1).max(1024)).min(2).max(1025),
    minimumQuantities: z.array(z.string().min(1).max(1024)).min(2).max(1025),
  }).strict()).min(1).max(16),
  reservationRevision: z.number().int().positive(),
  reservationStatus: z.enum(["RESERVED", "CONSUMPTION_PENDING", "UNKNOWN_OUTCOME", "PARTIALLY_RECONCILED", "SETTLED_RETAINED", "RELEASED"]),
  revocationReason: z.string().max(2000).nullable(),
  consumptions: z.array(z.object({ ref: organizationReference,
    status: z.enum(["INTENDED_PENDING_S6", "UNKNOWN_OUTCOME", "RECONCILED"]), effectRef: organizationReference.nullable(),
  }).strict()).max(4096),
  monetaryExposure: z.object({ consumedMinor: z.null(), unresolvedMinor: z.null(), currency: z.null() }).strict(),
  retention: z.literal("EXISTING_S5_OWNER_CONSTRAINT_NOT_NEW_WORK_OR_RESOURCE_GRANT"),
}).strict().superRefine((value, ctx) => {
  if (value.id !== value.reservationRef.id || value.reservationRef.owner !== "S5" ||
      value.certificateRef.owner !== "S5" || value.problemRef.owner !== "S5" ||
      value.originalResourceEnvelope.some(e => e.quantities.length !== e.horizon.periods + 1 ||
        e.minimumQuantities.length !== e.horizon.periods + 1) ||
      new Set(value.originalWorks.map(w => w.workId)).size !== value.originalWorks.length ||
      (value.nativeOwners ?? []).some(owner => !value.originalWorks.some(w => w.workId === owner.workId)) ||
      new Set((value.nativeOwners ?? []).map(owner => owner.owner + ":" + owner.id)).size !== (value.nativeOwners ?? []).length ||
      new Set(value.consumptions.map(s => s.ref.id)).size !== value.consumptions.length)
    ctx.addIssue({ code: "custom", message: "W5 exact original S5 resource-constraint shape required" });
});
export type OrganizationResourceConstraint = z.infer<typeof organizationResourceConstraint>;
export const organizationTransformationInput = z.object({
  schema: z.literal("finnor.organization-transformation-input.v1"),
  tenantId: z.string().uuid(), principalId: z.string().uuid(), companyId: z.string().uuid(),
  workId: z.string().uuid(), workInputId: z.string().uuid(), sourceClass: z.enum(["CONTROLLED", "FIELD"]),
  mandate: z.object({
    ref: organizationReference, purpose: z.string().min(1).max(2000), originalDeadline: instant, validFrom: instant,
    materialImprovementSeconds: seconds, maxMigrationHumanSeconds: seconds, maxAddedOperationHumanSeconds: seconds,
    maxMigrationCostMinor: seconds, currency: z.string().regex(/^[A-Z]{3}$/),
    evaluatorPrincipalId: z.string().uuid(), maxAlternatives: z.number().int().min(2).max(32),
    requiredServiceIds: z.array(key).min(1).max(32),
    trial: z.object({
      assignmentRef: organizationReference, kind: z.enum(["PARALLEL_RANDOMIZED", "SWITCHBACK", "QUASI_EXPERIMENTAL"]),
      outcomeRangeSeconds: z.number().int().min(1).max(2_000_000_000),
      confidence: z.number().min(0.9).max(0.999), minimumPerArm: z.number().int().min(20).max(100000),
      interference: z.enum(["CONTROLLED", "UNKNOWN"]), carryover: z.enum(["NONE", "MODELED", "UNKNOWN"]),
    }).strict(),
  }).strict(),
  organization: z.object({
    ref: organizationReference, revision: key, sourceRefs: z.array(organizationReference).min(1).max(128),
    roles: z.array(organizationRole).min(1).max(128),
    processes: z.array(organizationProcess).min(1).max(16),
    observations: z.array(z.object({
      processId: key, nodeId: key, samples: z.number().int().min(1).max(100000),
      queueSeconds: seconds, incompleteEvidenceCount: seconds, repeatedInterpretationSeconds: seconds,
      repairHumanSeconds: seconds, externalWaitSeconds: seconds, evidenceRefs: z.array(organizationReference).min(1).max(32),
    }).strict()).min(1).max(256),
    obligations: z.array(liveOrganizationObligation).max(1024),
    resourceConstraints: z.array(organizationResourceConstraint).max(1024).optional(),
  }).strict(),
}).strict();
export type OrganizationTransformationInput = z.infer<typeof organizationTransformationInput>;
export type OrganizationRole = z.infer<typeof organizationRole>;
export type OrganizationProcess = z.infer<typeof organizationProcess>;
export type OrganizationNode = z.infer<typeof organizationNode>;

export interface OrganizationAlternative {
  id: string;
  kind: "RETAIN" | "PREPARED_HANDOFF" | "COORDINATION_INTERFACE" | "COMBINED";
  roles: OrganizationRole[];
  processes: OrganizationProcess[];
  diagnoses: Array<{ processId: string; nodeId: string; cause: "INCOMPLETE_EVIDENCE" | "REPEATED_COORDINATION" | "EXTERNAL_LIMIT";
    evidenceRefs: OrganizationReference[]; claim: "OBSERVED_ASSOCIATION_NOT_CAUSAL_IDENTIFICATION" }>;
  constructedAssets: Array<{ id: string; kind: "EVIDENCE_CONTRACT" | "COORDINATION_CONTRACT"; processId: string; nodeId: string;
    inputFields: string[]; outputFields: string[]; grantsAuthority: false }>;
  migrationHumanSeconds: number;
  addedOperationHumanSeconds: number;
  migrationCostMinor: number | null;
  predictedImprovementSeconds: number | null;
  predictionBasis: "NO_CHANGE" | "UNQUALIFIED_QUEUE_HYPOTHESIS";
  unresolved: string[];
}
export interface TransformationAdoption {
  roleId: string; principalId: string; termsDigest: string; state: "ADOPTED" | "DECLINED" | "REVOKED";
  at: string; observationRef: OrganizationReference | null;
}
export interface OrganizationTransformationProgram {
  schema: "finnor.organization-transformation-program.v1";
  requirements: "FINNOR-POSTZ-W-PRD-1.0.0";
  originalDigest: string;
  tenantId: string; principalId: string; companyId: string; workId: string; workInputId: string;
  originalOrganizationRef: OrganizationReference; mandateRef: OrganizationReference;
  originalDeadline: string; sourceRefs: OrganizationReference[]; originalObligations: LiveOrganizationObligation[];
  originalResourceConstraints: OrganizationResourceConstraint[];
  alternatives: OrganizationAlternative[]; recommendedAlternativeId: string; selectedAlternativeId: string | null;
  status: "CANDIDATE" | "AWAITING_ADOPTION" | "ADOPTED" | "TRIAL" | "ACTIVE" | "PARTIAL" | "RETAINED" | "ROLLED_BACK" | "CANCELLED";
  revision: number; adoptions: TransformationAdoption[];
  events: Array<{ revision: number; kind: string; principalId: string; at: string; body: Record<string, unknown> }>;
  exclusions: string[]; unresolved: string[];
  claims: { actualAdoption: false | "AUTHENTICATED_DECISIONS_ONLY"; observedOperation: boolean;
    fieldBenefit: false; protectedAdmission: false; newAuthorityGranted: false };
}
export type TransformationDecision =
  | { kind: "SELECT"; alternativeId: string; principalId: string; at: string }
  | { kind: "ADOPT"; alternativeId: string; roleId: string; termsDigest: string; principalId: string; at: string; observationRef?: OrganizationReference }
  | { kind: "DECLINE" | "REVOKE"; alternativeId: string; roleId: string; principalId: string; at: string }
  | { kind: "CANCEL"; principalId: string; at: string };
export interface OperatingObservation {
  id: string; arm: "ORIGINAL" | "TRANSFORMED"; elapsedSeconds: number;
  costMinor: number | null; humanSeconds: number | null; serviceRetained: boolean;
  evidenceRef: OrganizationReference; principalId: string; assignmentId: string;
}
export interface OperatingEvaluationInput {
  observations: OperatingObservation[]; assistance: string[]; completeCosts: boolean;
  sourceClass: "CONTROLLED" | "FIELD"; assignmentVerified: boolean;
  migrationCostMinor?: number | null; migrationHumanSeconds?: number | null;
}
export class OrganizationTransformationError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
