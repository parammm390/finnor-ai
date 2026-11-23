/** Additive S2 contract for prospective W5 task randomization. This does not
 * change the existing observational S2 schema or issue scientific admission. */
import { z } from "zod";
import { ExperimentRefSchema } from "./experiments";
import { epistemicHash } from "./source-precedence";

const id = z.string().uuid(), key = z.string().min(1).max(160);
const sha = z.string().regex(/^[a-f0-9]{64}$/), instant = z.string().datetime({ offset: true });
export const W5_ASSIGNMENT_DENOMINATOR = 1_000_000;
export const W5TrialUnitSchema = z.object({
  unitId: id, workId: id, workInputId: id, workInputDigest: sha, enrollmentRef: ExperimentRefSchema,
}).strict();
export const W5ProspectiveTrialSchema = z.object({
  schema: z.literal("finnor.s2.w5-prospective-trial.v1"), trialId: id, tenantId: id, principalId: id,
  requestId: id, parentWorkId: id, parentWorkInputId: id, originalDigest: sha,
  originalBudgetRef: ExperimentRefSchema, originalReservationRef: ExperimentRefSchema, methodPinsDigest: sha,
  processId: key, transformedRoleId: key, transformedPrincipalId: id,
  originalRoleId: key, originalPrincipalId: id,
  evaluatorPrincipalId: id, selectedAlternativeId: key, selectedAlternativeDigest: sha,
  registeredRevision: z.number().int().nonnegative(), originalAssignmentIntentRef: ExperimentRefSchema,
  registeredAt: instant, originalDeadline: instant, sourceClass: z.enum(["CONTROLLED", "FIELD"]),
  assignment: z.object({ kind: z.literal("INDEPENDENT_BERNOULLI"),
    transformedNumerator: z.number().int().min(1).max(W5_ASSIGNMENT_DENOMINATOR - 1),
    denominator: z.literal(W5_ASSIGNMENT_DENOMINATOR), entropy: z.literal("NODE_CRYPTO_RANDOMINT"),
  }).strict(),
  analysis: z.object({ kind: z.literal("BOUNDED_HT_HOEFFDING_FIXED_FINAL_LOOK"),
    outcomeRangeSeconds: z.number().int().positive().max(2_000_000_000),
    confidence: z.number().min(0.9).max(0.999), minimumPerArm: z.number().int().min(20).max(100000),
    materialMarginSeconds: z.number().int().nonnegative(),
    interference: z.enum(["CONTROLLED", "UNKNOWN"]), carryover: z.enum(["NONE", "MODELED", "UNKNOWN"]),
  }).strict(),
  units: z.array(W5TrialUnitSchema).min(40).max(512),
  scientificAdmission: z.literal("NOT_ESTABLISHED"), executionAuthorityGranted: z.literal(false),
}).strict();
export type W5ProspectiveTrial = z.infer<typeof W5ProspectiveTrialSchema>;
export type W5TrialUnit = z.infer<typeof W5TrialUnitSchema>;
export interface W5ProspectiveTrialRecord { ref: z.infer<typeof ExperimentRefSchema>; body: W5ProspectiveTrial }

export const W5NativeAssignmentSchema = z.object({
  schema: z.literal("finnor.s2.w5-native-assignment.v1"), assignmentId: id, trialRef: ExperimentRefSchema,
  tenantId: id, principalId: id, requestId: id, unit: W5TrialUnitSchema,
  processId: key, selectedAlternativeDigest: sha, arm: z.enum(["ORIGINAL", "TRANSFORMED"]),
  performerRoleId: key, performerPrincipalId: id,
  transformedNumerator: z.number().int().min(1).max(W5_ASSIGNMENT_DENOMINATOR - 1),
  denominator: z.literal(W5_ASSIGNMENT_DENOMINATOR),
  nativeDraw: z.number().int().min(0).max(W5_ASSIGNMENT_DENOMINATOR - 1),
  entropy: z.literal("NODE_CRYPTO_RANDOMINT"), assignedAt: instant,
  nativeProvenance: z.object({
    jobId: id, deliveryAttemptId: id, claimFence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    workerId: z.string().min(1).max(512), claimTokenDigest: sha, claimCheckedAt: instant, claimLeaseExpiresAt: instant,
    consumptionRef: ExperimentRefSchema, originalBudgetRef: ExperimentRefSchema, methodPinsDigest: sha,
  }).strict(),
  qualifier: z.literal("NATIVE_PROSPECTIVE_RANDOMIZATION_NOT_SCIENTIFIC_OR_FIELD_ADMISSION"),
  executionAuthorityGranted: z.literal(false),
}).strict();
export type W5NativeAssignment = z.infer<typeof W5NativeAssignmentSchema>;
export interface W5NativeAssignmentRecord { ref: z.infer<typeof ExperimentRefSchema>; body: W5NativeAssignment }

export function w5TrialRecord(body: W5ProspectiveTrial): W5ProspectiveTrialRecord {
  const parsed = W5ProspectiveTrialSchema.parse(body), digest = epistemicHash(parsed);
  return { ref: { owner: "S2", id: "w5-trial:" + digest, version: "w5-prospective-trial-v1", contentDigest: digest },
    body: parsed };
}
export function w5AssignmentRecord(body: W5NativeAssignment): W5NativeAssignmentRecord {
  const parsed = W5NativeAssignmentSchema.parse(body), digest = epistemicHash(parsed);
  return { ref: { owner: "S2", id: "w5-assignment:" + digest, version: "w5-native-assignment-v1", contentDigest: digest },
    body: parsed };
}
export function checkW5ProspectiveTrial(trial: W5ProspectiveTrialRecord, assignments: readonly W5NativeAssignmentRecord[]) {
  const checked = w5TrialRecord(trial.body), errors: string[] = [];
  const same = (a: unknown, b: unknown) => epistemicHash(a) === epistemicHash(b);
  if (!same(checked.ref, trial.ref)) errors.push("ORIGINAL_TRIAL_PREIMAGE_CHANGED");
  const b = checked.body, works = new Set<string>(), inputs = new Set<string>();
  if (!Number.isFinite(Date.parse(b.registeredAt)) || !Number.isFinite(Date.parse(b.originalDeadline)) ||
      Date.parse(b.registeredAt) >= Date.parse(b.originalDeadline)) errors.push("ORIGINAL_TRIAL_DEADLINE_EXHAUSTED");
  if (b.originalBudgetRef.owner !== "S5" || b.originalReservationRef.owner !== "S5" ||
      b.originalAssignmentIntentRef.owner !== "S1" || b.units.length < b.analysis.minimumPerArm * 2)
    errors.push("ORIGINAL_PROSPECTIVE_ENVELOPE_AND_POPULATION_REQUIRED");
  if (b.evaluatorPrincipalId === b.principalId || [b.originalPrincipalId, b.transformedPrincipalId].includes(b.evaluatorPrincipalId))
    errors.push("INDEPENDENT_EVALUATOR_REQUIRED");
  for (const unit of b.units) {
    if (unit.unitId !== unit.workInputId || works.has(unit.workId) || inputs.has(unit.workInputId) ||
        unit.enrollmentRef.owner !== "S1") errors.push("UNIQUE_REAL_WORK_INPUT_UNITS_REQUIRED");
    works.add(unit.workId); inputs.add(unit.workInputId);
  }
  if (assignments.length !== b.units.length) errors.push("COMPLETE_REGISTERED_ASSIGNMENT_POPULATION_REQUIRED");
  const assigned = new Set<string>(), assignmentIds = new Set<string>();
  for (const entry of assignments) {
    const a = W5NativeAssignmentSchema.parse(entry.body), ref = w5AssignmentRecord(a).ref;
    const unit = b.units.find(u => u.unitId === a.unit.unitId), transformed = a.nativeDraw < b.assignment.transformedNumerator;
    if (!same(entry.ref, ref) || !same(a.trialRef, trial.ref) || a.tenantId !== b.tenantId ||
        a.principalId !== b.principalId || a.requestId !== b.requestId || !unit || !same(unit, a.unit) ||
        assigned.has(a.unit.unitId) || assignmentIds.has(a.assignmentId) ||
        a.processId !== b.processId || a.selectedAlternativeDigest !== b.selectedAlternativeDigest ||
        a.transformedNumerator !== b.assignment.transformedNumerator ||
        a.arm !== (transformed ? "TRANSFORMED" : "ORIGINAL") ||
        a.performerRoleId !== (transformed ? b.transformedRoleId : b.originalRoleId) ||
        a.performerPrincipalId !== (transformed ? b.transformedPrincipalId : b.originalPrincipalId) ||
        a.nativeProvenance.consumptionRef.owner !== "S5" ||
        !same(a.nativeProvenance.originalBudgetRef, b.originalBudgetRef) ||
        a.nativeProvenance.methodPinsDigest !== b.methodPinsDigest || !Number.isFinite(Date.parse(a.assignedAt)) ||
        Date.parse(a.nativeProvenance.claimCheckedAt) < Date.parse(b.registeredAt) ||
        Date.parse(a.nativeProvenance.claimCheckedAt) > Date.parse(a.assignedAt) ||
        Date.parse(a.nativeProvenance.claimLeaseExpiresAt) <= Date.parse(a.assignedAt) ||
        Date.parse(a.assignedAt) < Date.parse(b.registeredAt) || Date.parse(a.assignedAt) >= Date.parse(b.originalDeadline))
      errors.push("ORIGINAL_NATIVE_ASSIGNMENT_BINDING_CHANGED");
    assigned.add(a.unit.unitId); assignmentIds.add(a.assignmentId);
  }
  return { semanticOwner: "S2" as const, status: errors.length ? "REJECTED" as const : "CHECKED_NATIVE_ASSIGNMENT" as const,
    errors: [...new Set(errors)], trialRef: trial.ref, assignmentCount: assignments.length,
    entropyProvenance: "SERVER_OWNED_CRYPTOGRAPHIC_ENTROPY_REQUIRES_NATIVE_BOUNDARY_EVIDENCE",
    scientificAdmission: false, fieldTruthEstablished: false, executionAuthorityGranted: false };
}
