/** Immutable original clock-start evidence. Never samples or signs on recovery. */
import { z } from "zod";
import { digest, fault, RefSchema, sameRef } from "../../capability-evolution/src/contracts";
import { assertOriginalSignature, assertVerifiedEnrollment, integer, type PublicationCandidate,
  type VerifiedEnrollment, type ClockSeal, type SignedSeal } from "../../capability-evolution/src/specialist-publication-protocol";
import { nativeClockSampleSchema } from "./specialist-native-clock";
import type { OriginalClockQualification } from "./specialist-clock-qualification";
const hex = z.string().regex(/^[a-f0-9]{64}$/);
export const originalClockStartSchema = z.object({
  schema: z.literal("finnor.specialist.original-native-clock-start.v1"),
  enrollmentDigest: hex, publicationId: hex, bindingDigest: hex, originalAttemptDigest: hex,
  originalMonotonicDeadline: integer, qualificationRef: RefSchema,
  native: nativeClockSampleSchema.extend({ samplerSha256: hex }),
}).strict();
export type OriginalClockStart = z.infer<typeof originalClockStartSchema>;
export const originalClockEndSchema = z.object({
  schema: z.literal("finnor.specialist.original-native-clock-end.v1"),
  enrollmentDigest: hex, publicationId: hex, candidateDigest: hex, startDigest: hex,
  qualificationRef: RefSchema, native: nativeClockSampleSchema.extend({ samplerSha256: hex }),
}).strict();
export type OriginalClockEnd = z.infer<typeof originalClockEndSchema>;
export function assertOriginalClockStart(input: {
  enrollment: VerifiedEnrollment; candidate: PublicationCandidate; clock: SignedSeal<ClockSeal>;
  start: SignedSeal<unknown>; originalAttemptDigest: string;
  clockNamespaceDevice: string; clockNamespaceInode: string;
}) {
  assertVerifiedEnrollment(input.enrollment);
  const start = originalClockStartSchema.parse(input.start.body), c = input.candidate, clock = input.clock;
  assertOriginalSignature({ ...input.start, body: start }, input.enrollment.body.clockAuthorityKeys, {
    lower: BigInt(clock.body.qualifiedUtcCoverage.lower), upper: BigInt(clock.body.qualifiedUtcCoverage.upper),
  });
  if (start.enrollmentDigest !== input.enrollment.digest || start.publicationId !== c.publicationId
    || start.bindingDigest !== c.bindingDigest || start.originalAttemptDigest !== input.originalAttemptDigest
    || start.originalMonotonicDeadline !== c.originalMonotonicDeadline || input.start.keyId !== clock.keyId
    || !sameRef(start.qualificationRef, clock.body.qualificationRef)
    || clock.body.previousDigest !== digest(start) || clock.body.sequence !== "1"
    || clock.body.referenceUtcMicros !== String(BigInt(start.native.realtimeNs) / 1000n)
    || clock.body.referenceMonotonicNs !== String((BigInt(start.native.monotonicBeforeNs) + BigInt(start.native.monotonicAfterNs)) / 2n)
    || clock.body.qualifiedMonotonicCoverage.lower !== start.native.monotonicBeforeNs
    || start.native.bootId !== c.bootId || start.native.clockNamespaceDevice !== input.clockNamespaceDevice
    || start.native.clockNamespaceInode !== input.clockNamespaceInode
    || BigInt(start.native.monotonicBeforeNs) < BigInt(c.originalMonotonicStart)
    || BigInt(start.native.monotonicBeforeNs) > BigInt(start.native.monotonicAfterNs)
    || BigInt(start.native.monotonicAfterNs) >= BigInt(c.originalMonotonicDeadline))
    fault("SPECIALIST_ORIGINAL_NATIVE_CLOCK_START_REQUIRED", 503);
  return start;
}
export function assertOriginalClockEnd(input: {
  enrollment: VerifiedEnrollment; candidate: PublicationCandidate; clock: SignedSeal<ClockSeal>;
  start: OriginalClockStart; end: SignedSeal<unknown>;
}) {
  assertVerifiedEnrollment(input.enrollment);
  const end = originalClockEndSchema.parse(input.end.body), c = input.candidate, clock = input.clock;
  assertOriginalSignature({ ...input.end, body: end }, input.enrollment.body.clockAuthorityKeys, {
    lower: BigInt(clock.body.qualifiedUtcCoverage.lower), upper: BigInt(clock.body.qualifiedUtcCoverage.upper),
  });
  if (end.enrollmentDigest !== input.enrollment.digest || end.publicationId !== c.publicationId
    || end.candidateDigest !== digest(c) || end.startDigest !== digest(input.start)
    || input.end.keyId !== clock.keyId || !sameRef(end.qualificationRef, clock.body.qualificationRef)
    || end.native.bootId !== c.bootId || end.native.samplerSha256 !== input.start.native.samplerSha256
    || end.native.clockNamespaceDevice !== input.start.native.clockNamespaceDevice
    || end.native.clockNamespaceInode !== input.start.native.clockNamespaceInode
    || BigInt(end.native.monotonicBeforeNs) < BigInt(input.start.native.monotonicAfterNs)
    || BigInt(end.native.monotonicBeforeNs) > BigInt(end.native.monotonicAfterNs)
    || BigInt(end.native.monotonicAfterNs) >= BigInt(c.originalMonotonicDeadline)
    || clock.body.qualifiedMonotonicCoverage.upper !== end.native.monotonicAfterNs)
    fault("SPECIALIST_ORIGINAL_NATIVE_CLOCK_END_REQUIRED", 503);
  return end;
}
export function assertOriginalQualifiedClockEvidence(input: {
  enrollment: VerifiedEnrollment; qualification: OriginalClockQualification; candidate: PublicationCandidate;
  clock: SignedSeal<ClockSeal>; start: OriginalClockStart; end: OriginalClockEnd; witnessDirectory: string; hostPolicyDigest: string;
}) {
  assertVerifiedEnrollment(input.enrollment);
  const q = input.qualification, c = input.candidate, clock = input.clock, start = input.start.native;
  const startError = BigInt(q.utcErrorMicros)
    + (BigInt(start.monotonicAfterNs) - BigInt(start.monotonicBeforeNs) + 1999n) / 2000n + 1n;
  const key = input.enrollment.body.clockAuthorityKeys.find(key => key.id === clock.keyId);
  if (!key || clock.keyId !== q.clockAuthorityKeyId || input.hostPolicyDigest !== q.hostPolicyDigest
    || q.witnessDirectory !== input.witnessDirectory || clock.body.bootId !== q.bootId || q.bootId !== c.bootId
    || clock.body.qualificationDigest !== clock.body.qualificationRef.contentDigest
    || clock.body.utcErrorMicros !== String(startError) || clock.body.dbErrorMicros !== q.dbErrorMicros
    || clock.body.driftPartsPerBillion !== q.driftPartsPerBillion
    || BigInt(clock.body.qualifiedUtcCoverage.lower) < BigInt(q.qualifiedUtcCoverage.lower)
    || BigInt(clock.body.qualifiedUtcCoverage.upper) > BigInt(q.qualifiedUtcCoverage.upper)
    || BigInt(clock.body.qualifiedMonotonicCoverage.lower) < BigInt(q.qualifiedMonotonicCoverage.lower)
    || BigInt(clock.body.qualifiedMonotonicCoverage.upper) > BigInt(q.qualifiedMonotonicCoverage.upper))
    fault("SPECIALIST_CLOCK_ACTUAL_QUALIFICATION_DISAGREES", 503);
  for (const sample of [start, input.end.native]) {
    const error = BigInt(q.utcErrorMicros)
      + (BigInt(sample.monotonicAfterNs) - BigInt(sample.monotonicBeforeNs) + 1999n) / 2000n + 1n,
      utc = BigInt(sample.realtimeNs) / 1000n;
    if (sample.bootId !== q.bootId || sample.samplerSha256 !== q.nativeSamplerSha256
      || sample.clockNamespaceDevice !== q.clockNamespaceDevice || sample.clockNamespaceInode !== q.clockNamespaceInode
      || utc - error <= BigInt(q.qualifiedUtcCoverage.lower) || utc + error >= BigInt(q.qualifiedUtcCoverage.upper)
      || utc - error <= BigInt(Date.parse(key.validAfter)) * 1000n
      || utc + error >= BigInt(Date.parse(key.validUntil)) * 1000n)
      fault("SPECIALIST_CLOCK_ORIGINAL_SAMPLES_OUTSIDE_QUALIFICATION", 503);
  }
}
