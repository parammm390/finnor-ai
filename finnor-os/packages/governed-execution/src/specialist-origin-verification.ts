import { createPublicKey, verify } from "node:crypto";
import { digest } from "../../capability-evolution/src/contracts";
import {
  assertOriginalBounds, encloseOriginalCommit, verifyClockSeal, type ClockSeal, type CommitObservation,
  type PublicationCandidate, type SignedSeal, type VerifiedEnrollment,
} from "../../capability-evolution/src/specialist-publication-protocol";
import { canonical } from "./protocol";
import { readOriginalClockQualification } from "./specialist-clock-qualification";
import {
  assertOriginConfiguration, signedRevocationSchema, type OriginPublicConfiguration,
  type SignedOriginRevocation, type SourceRegistration,
} from "./specialist-origin-contract";
import { readActualNativeClockSample, type NativeClockSample } from "./specialist-native-clock";
import { readOriginalAttemptIdentity } from "./specialist-publication-witness";

export type OriginClockQualification = Awaited<ReturnType<typeof readOriginalClockQualification>>;
export async function loadOriginClockQualification(enrollment: VerifiedEnrollment, config: OriginPublicConfiguration) {
  assertOriginConfiguration(enrollment, config);
  const qualified = await readOriginalClockQualification(enrollment, config.clockQualificationRef), q = qualified.body;
  if (q.hostPolicyDigest !== config.hostPolicyDigest || q.witnessDirectory !== config.witnessDirectory
    || q.nativeSamplerPath !== config.clockExecutable.path || q.nativeSamplerSha256 !== config.clockExecutable.sha256
    || q.sourceClosureDigest !== config.sourceClosureDigest || q.runtimeDigest !== config.runtimeDigest)
    throw Error("SPECIALIST_ORIGIN_ACTUAL_QUALIFIED_DEPLOYMENT_REQUIRED");
  return qualified;
}
export async function sampleOriginClock(config: OriginPublicConfiguration, qualified: OriginClockQualification, signal: AbortSignal) {
  const value = await readActualNativeClockSample({
    executablePath: config.clockExecutable.path, executableSha256: config.clockExecutable.sha256, signal,
  }), q = qualified.body;
  if (value.bootId !== q.bootId || value.clockNamespaceDevice !== q.clockNamespaceDevice
    || value.clockNamespaceInode !== q.clockNamespaceInode
    || BigInt(value.monotonicBeforeNs) < BigInt(q.qualifiedMonotonicCoverage.lower)
    || BigInt(value.monotonicAfterNs) > BigInt(q.qualifiedMonotonicCoverage.upper)
    || BigInt(value.realtimeNs) / 1000n < BigInt(q.qualifiedUtcCoverage.lower)
    || BigInt(value.realtimeNs) / 1000n > BigInt(q.qualifiedUtcCoverage.upper))
    throw Error("SPECIALIST_ORIGIN_ACTUAL_CLOCK_NAMESPACE_OR_QUALIFICATION_LOST");
  return value;
}
export function assertQualifiedOriginCollection(input: {
  enrollment: VerifiedEnrollment; config: OriginPublicConfiguration; qualified: OriginClockQualification;
  candidate: PublicationCandidate; clock: SignedSeal<ClockSeal>; pre: CommitObservation; post: CommitObservation;
}) {
  const c = input.candidate, q = input.qualified.body, clock = verifyClockSeal(input.enrollment, input.clock);
  assertOriginConfiguration(input.enrollment, input.config);
  if (input.clock.keyId !== q.clockAuthorityKeyId || clock.bootId !== q.bootId
    || clock.qualificationDigest !== digest(q) || digest(clock.qualificationRef) !== digest(input.qualified.reference)
    || clock.utcErrorMicros !== q.utcErrorMicros || clock.dbErrorMicros !== q.dbErrorMicros
    || clock.driftPartsPerBillion !== q.driftPartsPerBillion
    || digest(clock.qualifiedUtcCoverage) !== digest(q.qualifiedUtcCoverage)
    || digest(clock.qualifiedMonotonicCoverage) !== digest(q.qualifiedMonotonicCoverage))
    throw Error("SPECIALIST_ORIGIN_GENUINE_QUALIFIED_CLOCK_REQUIRED");
  const interval = encloseOriginalCommit(c, input.pre, input.post, clock);
  assertOriginalBounds(input.enrollment, c, interval);
  return { clock, interval };
}
export async function originalOriginAttempt(input: {
  enrollment: VerifiedEnrollment; config: OriginPublicConfiguration; registration: SourceRegistration;
}) {
  const r = input.registration;
  if (r.hostReference.hostPolicyDigest !== input.config.hostPolicyDigest
    || r.hostReference.bindingDigest !== digest(r.binding)
    || r.enrollmentDigest !== input.enrollment.digest
    || r.sourcePid !== r.nativeBootstrap.parentPid || r.nativeBootstrap.uid !== input.config.sourceUid
    || r.nativeBootstrap.cgroupDevice !== r.hostReference.device || r.nativeBootstrap.cgroupInode !== r.hostReference.inode)
    throw Error("SPECIALIST_ORIGIN_ORIGINAL_SOURCE_BINDING_REQUIRED");
  return readOriginalAttemptIdentity({
    enrollment: input.enrollment, directory: input.config.witnessDirectory, publicationId: r.publicationId,
    bindingDigest: digest(r.binding), expectedHostDigest: digest({ reference: r.hostReference, nativeBootstrap: r.nativeBootstrap }),
    expectedHostPolicyDigest: input.config.hostPolicyDigest, expectedOriginalSourceDigest: r.originalSourceDigest,
    expectedMonotonicDeadline: r.nativeBootstrap.deadlineMonotonicNanoseconds,
  });
}
export function originUtcWindow(at: bigint, seal: {
  referenceUtcMicros: string; referenceMonotonicNs: string; utcErrorMicros: string; driftPartsPerBillion: string;
}) {
  const reference = BigInt(seal.referenceMonotonicNs), delta = at - reference,
    absolute = delta < 0n ? -delta : delta,
    errorNs = BigInt(seal.utcErrorMicros) * 1000n
      + (absolute * BigInt(seal.driftPartsPerBillion) + 999999999n) / 1000000000n,
    errorMicros = (errorNs + 999n) / 1000n,
    lower = delta >= 0n ? delta / 1000n : -((-delta + 999n) / 1000n),
    upper = delta >= 0n ? (delta + 999n) / 1000n : -((-delta) / 1000n);
  return { lower: BigInt(seal.referenceUtcMicros) + lower - errorMicros,
    upper: BigInt(seal.referenceUtcMicros) + upper + errorMicros };
}
export function assertOriginalRevocationTail(input: {
  enrollment: VerifiedEnrollment; candidate: PublicationCandidate; clock: ClockSeal;
  interval: { utc: { lower: bigint; upper: bigint } }; revocations: readonly SignedOriginRevocation[];
}) {
  for (const raw of input.revocations) {
    const value = signedRevocationSchema.parse(raw), body = value.body,
      origin = input.enrollment.body.origins.find(item => item.id === body.originId), at = BigInt(body.atMonotonicNs);
    if (!origin || value.keyId !== origin.id || body.publicationId !== input.candidate.publicationId
      || body.enrollmentDigest !== input.enrollment.digest || body.bootId !== origin.bootId || body.streamId !== origin.streamId
      || at > BigInt(body.learnedMonotonicNs)
      || !verify(null, Buffer.from(canonical(body)), createPublicKey(origin.publicKey), Buffer.from(value.signature, "base64"))
      || at < BigInt(input.clock.qualifiedMonotonicCoverage.lower) || at > BigInt(input.clock.qualifiedMonotonicCoverage.upper)
      || originUtcWindow(at, input.clock).lower <= input.interval.utc.upper)
      throw Error("SPECIALIST_ORIGIN_EARLIER_OR_UNQUALIFIED_REVOCATION");
  }
}
export function assertCandidateOriginalSource(
  c: PublicationCandidate, r: SourceRegistration, original: Awaited<ReturnType<typeof originalOriginAttempt>>,
) {
  if (c.publicationId !== r.publicationId || c.enrollmentDigest !== r.enrollmentDigest
    || c.bindingDigest !== digest(r.binding) || c.hostDigest !== original.hostDigest
    || c.processIdentity !== original.processIdentity || c.guardianId !== original.guardianId || c.cgroupId !== original.cgroupId
    || c.originalMonotonicStart !== original.originalMonotonicStart
    || c.originalMonotonicDeadline !== original.originalMonotonicDeadline
    || digest(c.bounds) !== digest(original.originalUtcBounds)
    || c.bootId !== original.bootId || c.sourceClosureDigest !== r.binding.sourceClosureDigest
    || c.runtimeDigest !== r.binding.runtimeDigest || c.s8Epoch !== r.s8Epoch
    || c.jobId !== r.binding.job.id || c.claimFence !== String(r.binding.job.claimFence)
    || c.claimTokenDigest !== r.binding.job.claimTokenSha256)
    throw Error("SPECIALIST_ORIGIN_CANDIDATE_IS_NOT_THE_ORIGINAL_SOURCE");
}
export function assertRawClockForOriginal(value: NativeClockSample, original: {
  bootId: string; clockNamespaceDevice: string; clockNamespaceInode: string; originalMonotonicDeadline: string;
}) {
  if (value.bootId !== original.bootId || value.clockNamespaceDevice !== original.clockNamespaceDevice
    || value.clockNamespaceInode !== original.clockNamespaceInode
    || BigInt(value.monotonicAfterNs) >= BigInt(original.originalMonotonicDeadline))
    throw Error("SPECIALIST_ORIGIN_ORIGINAL_PHYSICAL_CLOCK_OR_DEADLINE_LOST");
}
