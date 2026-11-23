import { z } from "zod";
import { r2Quantity } from "../../../epistemic-runtime/src/r2-rational";
import { responseFeaturesSchema, responsePinsSchema } from "../../../epistemic-runtime/src/metalevel-policy/response";
import { METALEVEL_LIMITS } from "../../../epistemic-runtime/src/metalevel-policy/contracts";

export const NATIVE_CONTINUATION_VERSION = "postz-w1-empirical-continuation-v2";
export const NATIVE_CONTINUATION_LIMITS = Object.freeze({ samples: 128, bytes: 1024 * 1024, gaps: 256 });
const id = z.string().min(1).max(1024);
const quantity = z.string().refine(value => { try { return r2Quantity(value).n >= 0n; } catch { return false; } });
export const nativeFrameSchema = z.object({
  units: z.array(z.object({ key: id, unitId: id, kind: z.enum(["EXECUTE_P1", "VERIFY_P1"]),
    status: z.enum(["PENDING", "QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "UNKNOWN"]),
    prerequisites: z.array(id).max(6), steps: z.number().int().positive(), observationRef: id.nullable(),
  }).strict()).max(6),
  history: z.array(z.object({ actionRef: id, observation: id }).strict()).max(METALEVEL_LIMITS.decisions),
  obligations: z.array(z.discriminatedUnion("status", [
    z.object({ id, status: z.literal("PENDING"), resolutionRef: z.null() }).strict(),
    z.object({ id, status: z.literal("UNKNOWN"), resolutionRef: z.null() }).strict(),
    z.object({ id, status: z.literal("RESOLVED"), resolutionRef: id }).strict(),
  ])).max(16),
  requiredChecks: z.array(id).max(16), completedChecks: z.array(id).max(16), acceptanceRef: id.nullable(),
  disposition: z.enum(["ACTIVE", "ACCEPTED", "INCOMPLETE", "UNKNOWN", "CANCELLED"]),
}).strict();
export const nativeStageActionSchema = z.object({
  ref: id, unitKeys: z.array(id).min(1).max(6), unitIds: z.array(id).min(1).max(6),
  computationRef: id, contextRefs: z.array(id), verifierRefs: z.array(id),
  attempts: z.number().int().positive(), steps: z.number().int().positive(),
}).strict();
export const nativeRemainingSchema = z.object({
  attempts: z.number().int().nonnegative(), steps: z.number().int().nonnegative(), wallMs: z.number().finite(),
  maxParallel: z.number().int().min(1).max(2), publicationAttempts: z.union([z.literal(0), z.literal(1)]),
  publicationSteps: z.number().int().nonnegative().optional(),
}).strict();
export const nativeStageObservationSchema = z.object({
  schema: z.literal("finnor.w1.native-stage-observation.v1"), id, assignmentRef: id, episodeRef: id, workId: id,
  premiseRef: id, split: z.enum(["TRAIN", "CALIBRATION"]), before: nativeFrameSchema,
  action: nativeStageActionSchema.nullable(), after: nativeFrameSchema, observation: id,
  beforeRemaining: nativeRemainingSchema.optional(),
  consumption: z.object({ attempts: z.number().int().nonnegative().nullable(), steps: z.number().int().nonnegative().nullable(),
    wallMs: quantity.nullable() }).strict(),
  evidenceRefs: z.array(id).min(1), observedAt: z.string().datetime({ offset: true }),
}).strict();
export const nativeContinuationContextSchema = z.object({
  tenantId: id, principalId: id, purposeRef: id, populationRef: id, pins: responsePinsSchema, features: responseFeaturesSchema,
  validUntil: z.string().datetime({ offset: true }), sourceClass: z.enum(["CONTROLLED_NATIVE", "SYNTHETIC_DEVELOPMENT"]),
}).strict();
export const nativeContinuationSchema = z.object({
  schema: z.literal("finnor.w1.native-continuation-response.v1"), version: z.literal(NATIVE_CONTINUATION_VERSION),
  ref: id, previousRef: id.nullable(), context: nativeContinuationContextSchema, knowledgeAt: z.string().datetime({ offset: true }),
  samples: z.array(nativeStageObservationSchema).max(NATIVE_CONTINUATION_LIMITS.samples),
  assignmentDesign: z.literal("LOGGED_CONDITIONAL_COMMON_PREMISE_GROUPED_NOT_CAUSAL"),
}).strict();
export type NativeFrame = z.infer<typeof nativeFrameSchema>;
export type NativeStageAction = z.infer<typeof nativeStageActionSchema>;
export type NativeStageObservation = z.infer<typeof nativeStageObservationSchema>;
export type NativeContinuationContext = z.infer<typeof nativeContinuationContextSchema>;
export type NativeContinuation = z.infer<typeof nativeContinuationSchema>;
