/** Native origin transport, not a second publication or qualification protocol. */
import { z } from "zod";
import { digest, RefSchema } from "../../capability-evolution/src/contracts";
import {
  candidateSchema, clockSealSchema, observationSchema, integer,
  type VerifiedEnrollment, assertVerifiedEnrollment,
} from "../../capability-evolution/src/specialist-publication-protocol";
import { specialistExecutionBindingSchema, specialistHostReferenceSchema } from "./specialist-contract";

export const ORIGIN_FRAME_BYTES = 1024 * 1024;
export const ORIGIN_JOURNAL_BYTES = 8 * 1024 * 1024;
export const ORIGIN_RECORDS = 4096;
export const ORIGIN_FAILURE_BYTES = 16 * 1024 * 1024;
const text = z.string().min(1).max(4096), hex = z.string().regex(/^[a-f0-9]{64}$/);
export const originKindSchema = z.enum([
  "GUARDIAN", "JOB", "CONTROLLER", "P3", "COMBINED_ABORT", "S8_AUTHORITY", "SOURCE_RUNTIME_HOST",
]);
export type OriginKind = z.infer<typeof originKindSchema>;
export const eventKindSchema = z.enum([
  "ABORT", "AUTHORITY_LOSS", "CLOCK_STEP", "GUARDIAN_LOSS",
  "PROCESS_LOSS", "CGROUP_LOSS", "SOURCE_CHANGE", "HOST_CHANGE",
]);
export type OriginEventKind = z.infer<typeof eventKindSchema>;
const executable = z.object({ path: text, sha256: hex }).strict();
const sourcePin = z.object({ path: text, sha256: hex }).strict();
const endpoint = z.object({ originId: text, socketPath: text }).strict();
export const originPublicConfigurationSchema = z.object({
  schema: z.literal("finnor.specialist.native-origin-endpoints.v1"),
  enrollmentDigest: hex, qualifiedDeploymentRef: RefSchema, clockQualificationRef: RefSchema,
  hostPolicyDigest: hex,
  sourceClosureDigest: hex, runtimeDigest: hex, participatingCodeDigest: hex,
  witnessDirectory: text, journalDirectory: text, socketPath: text,
  peerExecutable: executable, watchExecutable: executable, clockExecutable: executable,
  sourceExecutableSha256: hex, sourceUid: z.number().int().positive(), sourceGid: z.number().int().positive(),
  sourcePins: z.array(sourcePin).min(1).max(4096),
  endpoints: z.array(endpoint).min(7).max(64),
}).strict();
export type OriginPublicConfiguration = z.infer<typeof originPublicConfigurationSchema>;
export const originKeyCustodySchema = z.object({
  schema: z.literal("finnor.specialist.existing-origin-key-custody.v1"),
  publicConfigurationDigest: hex,
  keys: z.array(z.object({ originId: text, privateKeyPath: text }).strict()).min(1).max(64),
}).strict();
export type OriginKeyCustody = z.infer<typeof originKeyCustodySchema>;

export function assertOriginConfiguration(enrollment: VerifiedEnrollment, config: OriginPublicConfiguration) {
  assertVerifiedEnrollment(enrollment);
  const e = enrollment.body;
  if (config.enrollmentDigest !== enrollment.digest
    || digest(config.qualifiedDeploymentRef) !== digest(e.qualifiedDeploymentRef)
    || config.sourceClosureDigest !== e.sourceClosureDigest || config.runtimeDigest !== e.runtimeDigest
    || config.participatingCodeDigest !== e.participatingCodeDigest
    || new Set(config.endpoints.map(item => item.originId)).size !== e.origins.length
    || config.endpoints.length !== e.origins.length
    || e.origins.some(origin => !config.endpoints.some(item => item.originId === origin.id))
    || new Set(config.sourcePins.map(pin => pin.path)).size !== config.sourcePins.length)
    throw Error("SPECIALIST_ORIGIN_ENROLLED_CONFIGURATION_REQUIRED");
}

export const nativeBootstrapSchema = z.object({
  guardianPid: z.number().int().positive(), guestPid: z.number().int().positive(),
  parentPid: z.number().int().positive(), uid: z.number().int().positive(),
  cgroupDevice: integer, cgroupInode: integer,
  deadlineMonotonicNanoseconds: integer,
}).passthrough();
export const nativeOriginPhysicsSchema = z.object({
  hostReference: specialistHostReferenceSchema, nativeBootstrap: nativeBootstrapSchema,
  sourcePid: z.number().int().positive(),
}).strict();
export type NativeOriginPhysics = z.infer<typeof nativeOriginPhysicsSchema>;
export const initialJobClaimSchema = z.object({
  schema: z.literal("finnor.specialist.actual-initial-job-claim.v1"),
  jobId: text, deliveryAttemptId: text, claimTokenDigest: hex, claimFence: z.number().int().positive().safe(),
  workerId: text, initialAcquiredUtcMicros: integer, initialExpiresUtcMicros: integer,
}).strict();
export const initialP3GrantSchema = z.object({
  schema: z.literal("finnor.specialist.actual-initial-p3-grant.v1"),
  resourceKey: text, tokenSha256: hex, fence: z.number().int().positive().safe(), ownerId: text,
  initialAcquiredUtcMicros: integer, initialExpiresUtcMicros: integer,
}).strict();
export type InitialJobClaim = z.infer<typeof initialJobClaimSchema>;
export type InitialP3Grant = z.infer<typeof initialP3GrantSchema>;
const publicLease = z.object({
  resourceKey: text, tokenSha256: hex, fence: z.number().int().positive().safe(),
  ownerId: text, leaseSeconds: z.number().int().positive(),
}).strict();
export const sourceRegistrationSchema = z.object({
  schema: z.literal("finnor.specialist.actual-original-source-registration.v1"),
  enrollmentDigest: hex, publicationId: hex, originalSourceDigest: hex,
  binding: specialistExecutionBindingSchema,
  hostReference: specialistHostReferenceSchema,
  nativeBootstrap: nativeBootstrapSchema,
  sourcePid: z.number().int().positive(), sourceStartedMonotonicNs: integer,
  p3: z.array(publicLease).length(3), s8Epoch: integer, s8HistoryDigest: hex,
  initialJobClaim: initialJobClaimSchema, initialP3Grants: z.array(initialP3GrantSchema).length(3),
}).strict();
export type SourceRegistration = z.infer<typeof sourceRegistrationSchema>;

const signalCensus = z.object({ aborted: z.literal(false) }).strict();
export const originCensusSchema = z.object({
  schema: z.literal("finnor.specialist.actual-original-source-census.v1"),
  publicationId: hex, enrollmentDigest: hex, registrationDigest: hex,
  sourceSequence: integer, challenge: hex, throughMonotonicNs: integer,
  controller: signalCensus, combinedAbort: signalCensus,
  job: z.object({
    jobId: text, deliveryAttemptId: text, claimFence: integer, claimTokenDigest: hex,
    leaseOwner: text, status: z.literal("running"), leaseLive: z.literal(true),
    deliveryRunning: z.literal(true), heartbeatSourceLive: z.literal(true),
  }).strict(),
  p3: z.object({
    setDigest: hex, complete: z.literal(true), capacitySignalAborted: z.literal(false),
    current: z.array(publicLease).length(3),
  }).strict(),
  s8: z.object({ enrollmentDigest: hex, epoch: integer, historyDigest: hex }).strict(),
  source: z.object({ sourceClosureDigest: hex, runtimeDigest: hex, hostDigest: hex,
    bootId: text, cgroupDevice: integer, cgroupInode: integer }).strict(),
}).strict();
export type OriginCensus = z.infer<typeof originCensusSchema>;
export const sourceEventSchema = z.object({
  type: z.literal("SOURCE_EVENT"), publicationId: hex, sourceSequence: integer,
  originKind: originKindSchema, event: eventKindSchema, atMonotonicNs: integer,
  reason: z.string().regex(/^[A-Z0-9_]{1,128}$/),
}).strict();
export type SourceEvent = z.infer<typeof sourceEventSchema>;
export const collectRequestSchema = z.object({
  type: z.literal("COLLECT"), requestId: hex, historical: z.boolean(), readOnly: z.boolean().default(false),
  enrollmentDigest: hex, originId: text, candidate: candidateSchema,
  clock: z.object({ body: clockSealSchema, keyId: text, signature: text }).strict(),
  pre: observationSchema, post: observationSchema,
}).strict();
export type OriginCollectRequest = z.infer<typeof collectRequestSchema>;
export const originalFinalizeRequestSchema = z.object({
  type: z.literal("ORIGINAL_FINALIZE"), requestId: hex, publicationId: hex, enrollmentDigest: hex,
}).strict();
export const originalFailureReadRequestSchema = z.object({
  type: z.literal("READ_ORIGINAL_FAILURE"), requestId: hex, publicationId: hex,
  enrollmentDigest: hex, originalSourceDigest: hex,
}).strict();
export const originFailureSnapshotSchema = z.object({
  body: z.object({
    schema: z.literal("finnor.specialist.authenticated-original-failure-snapshot.v1"),
    requestId: hex, enrollmentDigest: hex, publicationId: hex, originalSourceDigest: hex,
    originId: text, streamId: text, bootId: text, registrationDigest: hex,
    recordCount: z.number().int().min(1).max(ORIGIN_RECORDS), lastRecordDigest: hex,
    state: z.literal("FAILED"), failureDigest: hex,
    basis: z.enum(["DURABLE_REVOCATION", "JOURNAL_CONTINUITY_LOST"]),
    damagedOriginIds: z.array(text).max(64),
  }).strict(), keyId: text, signature: text,
}).strict();
export const originSnapshotSchema = z.object({
  body: z.object({
    schema: z.literal("finnor.specialist.actual-origin-journal-snapshot.v1"),
    requestId: hex, enrollmentDigest: hex, publicationId: hex, candidateDigest: hex, clockDigest: hex,
    originId: text, streamId: text, bootId: text, registrationDigest: hex,
    recordCount: z.number().int().min(1).max(ORIGIN_RECORDS), lastRecordDigest: hex,
    state: z.enum(["LIVE", "SOURCE_ENDED"]), completedThroughMonotonicNs: integer,
  }).strict(), keyId: text, signature: text,
}).strict();
export type OriginSnapshot = z.infer<typeof originSnapshotSchema>;
export const sourceMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SOURCE_OPEN"), requestId: hex, registration: sourceRegistrationSchema }).strict(),
  sourceEventSchema,
  z.object({ type: z.literal("SOURCE_CENSUS"), requestId: hex, census: originCensusSchema }).strict(),
  z.object({ type: z.literal("SOURCE_END"), publicationId: hex, sourceSequence: integer,
    atMonotonicNs: integer }).strict(),
  z.object({ type: z.literal("SOURCE_DRAINED"), publicationId: hex, sourceSequence: integer,
    atMonotonicNs: integer }).strict(),
]);
export const signedRevocationSchema = z.object({
  body: z.object({
    schema: z.literal("finnor.specialist.native-origin-revocation.v1"),
    enrollmentDigest: hex, publicationId: hex, originId: text, streamId: text, bootId: text,
    event: eventKindSchema, atMonotonicNs: integer, learnedMonotonicNs: integer,
    reason: z.string().regex(/^[A-Z0-9_]{1,128}$/),
    sourceSequence: integer,
  }).strict(),
  keyId: text, signature: text,
}).strict();
export type SignedOriginRevocation = z.infer<typeof signedRevocationSchema>;

export const peerSchema = z.object({
  schema: z.literal("finnor.specialist.actual-unix-peer.v1"),
  pid: z.number().int().positive(), uid: z.number().int().nonnegative(), gid: z.number().int().nonnegative(),
  parentPid: z.number().int().positive(), startTicks: integer,
  clockNamespaceDevice: integer.nullable(), clockNamespaceInode: integer.nullable(), bootId: text,
}).strict();
export type ActualOriginPeer = z.infer<typeof peerSchema>;
export const nativeCensusSchema = z.object({
  type: z.enum(["READY", "CENSUS", "REVOKED"]), nonce: hex,
  bootId: text, clockNamespaceDevice: integer, clockNamespaceInode: integer,
  guardianPid: z.number().int().positive(), guestPid: z.number().int().positive(),
  workerPid: z.number().int().positive(), guardianStartTicks: integer, guestStartTicks: integer,
  workerStartTicks: integer, cgroupDevice: integer, cgroupInode: integer,
  fromMonotonicNs: integer, throughMonotonicNs: integer,
  event: eventKindSchema.nullable(), atMonotonicNs: integer.nullable(),
  reason: z.string().regex(/^[A-Z0-9_]{1,128}$/),
}).strict();
export type NativeOriginCensus = z.infer<typeof nativeCensusSchema>;
