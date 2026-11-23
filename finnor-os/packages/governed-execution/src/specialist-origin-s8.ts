/** Observe custody of the original grant, never admit a new use after COMMIT. */
import { z } from "zod";
import { digest } from "../../capability-evolution/src/contracts";
import {
  assertVerifiedEnrollment, candidateSchema, observationSchema,
} from "../../capability-evolution/src/specialist-publication-protocol";
import {
  originalAuthorityCustodySchema, type CanonicalSpecialistAuthority,
} from "../../capability-evolution/src/specialist-publication-authority";
import type { SourceRegistration } from "./specialist-origin-contract";
const hex = z.string().regex(/^[a-f0-9]{64}$/);
export async function observeOriginalS8Custody(input: {
  authority: CanonicalSpecialistAuthority; registration: SourceRegistration;
  requireCommittedOriginal: boolean; signal: AbortSignal;
}) {
  input.signal.throwIfAborted(); assertVerifiedEnrollment(input.authority.enrollment);
  const r = input.registration, e = input.authority.enrollment,
    current = originalAuthorityCustodySchema.parse(await input.authority.readOriginalAuthorityCustody());
  if (r.enrollmentDigest !== e.digest || current.enrollmentDigest !== e.digest
    || digest(current.primary) !== digest(e.body.primary) || current.epoch !== r.s8Epoch
    || current.historyDigest !== r.s8HistoryDigest || current.history.historyDigest !== current.historyDigest
    || current.history.policyDigest !== e.body.policyDigest)
    throw Error("SPECIALIST_ORIGIN_ACTUAL_ORIGINAL_S8_CUSTODY_LOST");
  if (input.requireCommittedOriginal) {
    const original = z.object({
      candidateRow: z.object({ candidate: candidateSchema, candidate_digest: hex }).passthrough(),
      originalUpperCaptured: z.literal(true), postObservation: observationSchema,
    }).passthrough().parse(await input.authority.observeOriginal(r.publicationId)),
      c = original.candidateRow.candidate, post = original.postObservation;
    if (original.candidateRow.candidate_digest !== digest(c) || c.publicationId !== r.publicationId
      || c.enrollmentDigest !== e.digest || c.bindingDigest !== digest(r.binding) || c.s8Epoch !== r.s8Epoch
      || post.publicationId !== r.publicationId || post.candidateDigest !== digest(c)
      || post.phase !== "AFTER_COMMITTED" || post.commitStatus !== "committed")
      throw Error("SPECIALIST_ORIGIN_ACTUAL_FROZEN_ORIGINAL_CUSTODY_REQUIRED");
  }
  // Pre-model positivity comes from the root's independently verified actual
  // original S6/native source AND this real domain grant. No missing candidate
  // or marker is treated as a healthy authority.
  input.signal.throwIfAborted();
  return Object.freeze({ enrollmentDigest: e.digest, epoch: current.epoch, historyDigest: current.historyDigest });
}
