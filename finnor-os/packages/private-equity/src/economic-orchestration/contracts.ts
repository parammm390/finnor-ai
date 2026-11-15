import { z } from "zod";
import { METALEVEL_LIMITS, metalevelBindingSchema, metalevelPolicySchema } from "../../../epistemic-runtime/src/metalevel-policy/contracts";
import { responseFeaturesSchema, responsePinsSchema, responseStateSchema } from "../../../epistemic-runtime/src/metalevel-policy/response";
import { r2Quantity } from "../../../epistemic-runtime/src/r2-rational";
import { BoundedReferenceSchema } from "../bounded-reference";
import { HarnessRequestSchema } from "../program-synthesis/contracts";
import { nativeFrameSchema, nativeStageActionSchema, nativeContinuationSchema, nativeContinuationContextSchema, nativeRemainingSchema, type NativeFrame } from "./continuation-contracts";

export const W1_NATIVE_VERSION = "postz-w1-native-v2" as const;
export const W1_NATIVE_PROTOCOL = 3 as const;
export const W1_NATIVE_LIMITS = Object.freeze({ modules: 3, bundles: 7, controlRuns: 8, controllerSteps: 256, kernelSteps: 4_000_000, bytes: 2 * 1024 * 1024 });
/** Persisted P1 projection consumed by both the snapshot and frame reader. */
export const nativeOriginalProgramSchema = z.object({
  modules: z.array(z.object({
    id: z.string(), compiled: z.string(), compiledDigest: z.string(), structureDigest: z.string(),
    format: z.enum(["BOUNDED_SSA", "BOUNDED_STACK"]),
    runtime: z.object({ version: z.string(), closureDigest: z.string() }).passthrough(),
    bounds: z.object({ steps: z.number().int().positive() }).passthrough(),
  }).passthrough()),
  acceptance: HarnessRequestSchema.shape.acceptance,
}).passthrough();
const identity = z.string().min(1).max(2048);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const quantity = z.string().refine(value => {
  try { return r2Quantity(value).n >= 0n; } catch { return false; }
}, "Exact nonnegative rational required");
export const EconomicOrchestrationOptionsSchema = z.object({
  schema: z.literal("finnor.economic-orchestration-options.v1"),
  purposeRef: nativeContinuationContextSchema.shape.purposeRef,
  populationRef: nativeContinuationContextSchema.shape.populationRef,
  domainRef: responseFeaturesSchema.shape.domainRef,
  responseRef: responseStateSchema.shape.ref.nullable().default(null),
  continuationRef: nativeContinuationSchema.shape.ref.nullable().optional(),
  observationSplit: z.enum(["TRAIN", "CALIBRATION"]).default("TRAIN"),
}).strict();
export const catalogueEntrySchema = z.object({
  computationRef: identity, treatmentRef: identity, unitIds: z.array(identity).min(1).max(6),
  unitCosts: z.array(z.object({ unitId: identity, attempts: z.literal(1), steps: z.number().int().positive() }).strict()).min(1).max(6),
  moduleIds: z.array(identity).min(1).max(W1_NATIVE_LIMITS.modules),
  methodRefs: z.array(BoundedReferenceSchema).min(1).max(W1_NATIVE_LIMITS.modules),
  contextRefs: z.array(identity).min(1), verifierRefs: z.array(identity).min(1),
  prerequisiteEdges: z.array(z.object({ from: identity, to: identity }).strict()).max(16),
  attempts: z.number().int().min(1).max(6), steps: z.number().int().positive().max(65536),
  independence: z.literal("COMMON_PREMISE_ALTERNATE_IMPLEMENTATIONS"), available: z.boolean(),
}).strict().superRefine((entry, ctx) => {
  if (new Set(entry.unitIds).size !== entry.unitIds.length || entry.unitCosts.length !== entry.unitIds.length ||
      entry.unitIds.some(id => entry.unitCosts.filter(cost => cost.unitId === id).length !== 1) ||
      entry.attempts !== entry.unitCosts.length || entry.steps !== entry.unitCosts.reduce((total, cost) => total + cost.steps, 0))
    ctx.addIssue({ code: "custom", message: "Exact original native per-unit resource conservation required" });
});
export type NativeComputation = z.infer<typeof catalogueEntrySchema>;
export const NativeCapabilitySourceSchema = z.object({
  schema: z.literal("finnor.w1.native-capability.v1"), revision: z.string().uuid(),
  recordedAt: z.string().datetime({ offset: true }), modelRef: identity,
  nativeAttemptCostMultiplier: z.string().max(64).refine(value => {
    try { const n = r2Quantity(value); return n.compare(r2Quantity("1")) >= 0 && n.compare(r2Quantity("1000000")) <= 0; }
    catch { return false; }
  }),
  stageLatencyPlanningMs: z.number().int().min(0).max(3600000),
  latencyEvidence: z.array(z.object({ attemptId: z.string().uuid(), digest }).strict()).max(4),
  qualification: z.literal("P3_OPERATOR_SUPPLIED_ATTENUATION_NOT_BILLING_FUNDING_OR_MODEL_ADMISSION"),
}).strict();
export const NativeCapabilityObservationSchema = NativeCapabilitySourceSchema.extend({
  ref: identity, sourceSha256: digest, latencyReceipts: z.array(z.object({
    attemptId: z.string().uuid(), digest, elapsedMs: z.number().finite().nonnegative(),
  }).strict()).max(4), authorityGranted: z.literal(false), originalDebitsUnchanged: z.literal(true),
}).strict();
export const nativeControlInputSchema = z.object({
  schema: z.literal("finnor.w1.native-control-input.v1"),
  searchId: identity, programId: identity, episodeId: identity, workInputId: identity,
  workInputDigest: digest, generation: z.number().int().positive(),
  purposeRef: identity, populationRef: identity, protocolRef: identity,
  binding: metalevelBindingSchema, features: responseFeaturesSchema, pins: responsePinsSchema,
  catalogue: z.object({ ref: identity, entries: z.array(catalogueEntrySchema).max(W1_NATIVE_LIMITS.bundles) }).strict(),
  response: responseStateSchema.nullable(),
  continuation: nativeContinuationSchema.nullable().optional(), frame: nativeFrameSchema.optional(),
  contextValidUntil: z.string().datetime({ offset: true }).optional(),
  episodeDeadlineAt: z.string().datetime({ offset: true }).optional(),
  dependencyState: z.record(z.string(), z.string()).optional(),
  nativeCapability: NativeCapabilityObservationSchema.nullable().optional(),
  utility: z.object({ ref: BoundedReferenceSchema, unit: identity, lossGap: quantity,
    nativeAttemptCost: quantity, delayMsCost: quantity, controllerMsCost: quantity }).strict().nullable(),
  remaining: nativeRemainingSchema,
  incumbentRef: identity.nullable(),
  outstanding: z.array(z.object({ id: identity, status: z.enum(["PENDING", "UNKNOWN"]) }).strict()),
  now: z.string().datetime({ offset: true }),
}).strict();
export type NativeControlInput = z.infer<typeof nativeControlInputSchema>;
export function nativeDeadlineAt(input: Pick<NativeControlInput, "binding" | "episodeDeadlineAt" | "contextValidUntil" | "continuation">): number {
  return Math.min(...[input.binding.deadline, input.episodeDeadlineAt, input.contextValidUntil, input.continuation?.context.validUntil]
    .filter((value): value is string => !!value).map(value => Date.parse(value)));
}
const policyCheckSchema = z.object({
  status: z.literal("VALID"), modelSha256: digest, checkedStates: z.number().int().positive(),
  scope: z.literal("MODEL_RELATIVE_EXACT"), authorityGranted: z.literal(false),
}).strict();
export const nativeProposalSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("CHECKED_POLICY"), schema: z.literal("finnor.w1.native-policy-proposal.v1"),
    inputDigest: digest, materialDigest: digest, modelBytes: z.string().max(W1_NATIVE_LIMITS.bytes),
    policy: metalevelPolicySchema, check: policyCheckSchema, responseRef: identity,
    limitations: z.array(identity),
    continuation: z.object({ modelRef: identity, horizonUsed: z.number().int().min(0).max(METALEVEL_LIMITS.decisions),
      frames: z.record(z.string(), nativeFrameSchema), actions: z.record(z.string(), nativeStageActionSchema),
      unidentified: z.array(z.object({ stateId: identity, actionRef: identity, reason: identity }).strict()).max(1024),
      kernelUsage: z.object({ producerSteps: z.number().int().nonnegative(), checkerSteps: z.number().int().nonnegative(),
        limitPerCall: z.number().int().positive() }).strict(),
    }).strict().optional(),
    authorityGranted: z.literal(false), protectedAdmission: z.literal(false),
  }).strict(),
  z.object({
    status: z.literal("FALLBACK_REQUIRED"), schema: z.literal("finnor.w1.native-policy-proposal.v1"),
    reason: identity, inputDigest: digest, materialDigest: digest,
    authorityGranted: z.literal(false), protectedAdmission: z.literal(false),
  }).strict(),
]);
export type NativeProposal = z.infer<typeof nativeProposalSchema>;
export const nativeUnitSchema = z.object({
  id: identity, status: z.enum(["PENDING", "QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "UNKNOWN"]),
  prerequisites: z.array(identity),
}).strict();
export type NativeUnitState = z.infer<typeof nativeUnitSchema>;
export type NativeConsumption =
  | { status: "DISPATCH"; computationRef: string; unitIds: string[]; authorityGranted: false;
      stateId: string | null; actionRef: string; beforeFrame: NativeFrame }
  | { status: "STOP"; reason: string; acceptedOriginalResult: boolean; authorityGranted: false }
  | { status: "WAIT"; reason: string; authorityGranted: false }
  | { status: "FALLBACK"; reason: string; authorityGranted: false };
export const meterSchema = z.object({
  schema: z.literal("finnor.w1.native-meter.v1"), elapsedMs: z.number().finite().nonnegative(),
  startedAt: z.string().datetime({ offset: true }), endedAt: z.string().datetime({ offset: true }),
  cpuMs: z.number().finite().nonnegative(), peakMemoryBytes: z.number().int().nonnegative(),
  scope: z.literal("ROOT_PROCESS_INTERVAL_NONADDITIVE_CHILDREN_UNMETERED"),
  peakMemoryScope: z.literal("ROOT_PROCESS_LIFETIME_MAX_RSS_NOT_INTERVAL_PEAK"),
  humanSeconds: z.literal(0), costUSD: z.null(), costStatus: z.literal("UNKNOWN"),
  childCpuMs: z.null(), childPeakMemoryBytes: z.null(),
}).strict();
export type NativeMeter = z.infer<typeof meterSchema>;
export const developmentCheckSchema = z.object({
  schema: z.literal("finnor.w1.s8-development-check.v1"),
  domain: z.literal("ECONOMIC_ORCHESTRATION"), protectionDomain: z.literal("DISPOSABLE_LOCAL_DEVELOPMENT"),
  tenantId: identity, principalId: identity, workId: identity, searchId: identity,
  candidateDigest: digest, modelDigest: digest, checkerRef: identity, runtimeRef: identity,
  materialDigest: digest, validUntil: z.string().datetime({ offset: true }),
  status: z.literal("CHECKED"), protectedAdmission: z.literal(false),
  productionActivated: z.literal(false), executionAuthorityGranted: z.literal(false),
}).strict();
export type EconomicDevelopmentCheck = z.infer<typeof developmentCheckSchema>;
export const nativeCapsuleSchema = z.object({
  schema: z.literal("finnor.orchestration-policy-capsule.v1"), version: z.enum(["postz-w1-native-v1", W1_NATIVE_VERSION]),
  id: z.string().uuid(), searchId: identity, revision: z.number().int().positive(),
  input: nativeControlInputSchema, proposal: nativeProposalSchema,
  execution: z.object({ attemptId: z.string().uuid(), unitId: identity, unitBodyDigest: digest,
    deliveryAttemptId: z.string().uuid(), jobId: z.string().uuid(), claimFence: z.number().int().positive(),
    originalEpisode: identity, originalDeadline: identity }).strict(),
  meter: meterSchema,
  qualifications: z.array(identity), authorityGranted: z.literal(false),
}).strict();
export type OrchestrationPolicyCapsule = z.infer<typeof nativeCapsuleSchema>;
