/** Existing root socket hooks. Never accept worker candidate/clock/bound JSON. */
import { join } from "node:path";
import { z } from "zod";
import { digest, fault } from "../../capability-evolution/src/contracts";
import type { CanonicalSpecialistAuthority } from "../../capability-evolution/src/specialist-publication-authority";
import { candidateSchema, observationSchema, integer } from "../../capability-evolution/src/specialist-publication-protocol";
import { assertVerifiedOriginalBusinessSource, deriveOriginalBusinessBounds,
  originalNativeReadySourceSchema } from "../../orchestration/src/workforce-execution/specialist-original-source";
import { canonical } from "./protocol";
import { OriginalQualifiedClockIssuer } from "./specialist-clock-issuer";
import { OriginalNativeAttemptIssuer } from "./specialist-original-attempt";
import { collectOriginalOriginCoverage } from "./specialist-origin-collector-client";
import { assertActualOriginPeer, readOriginPublicConfiguration, requireOriginLinuxRoot } from "./specialist-origin-custody";
import type { OriginalOriginProducerHooks } from "./specialist-origin-service";
import { readOriginalPublicationWitness } from "./specialist-publication-witness";
import { writeSpecialistRootBytesOnce } from "./specialist-root-custody";

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const originalReadback = z.object({
  originalUpperCaptured: z.literal(true), postObservation: observationSchema,
  candidateRow: z.object({
    candidate: candidateSchema, candidate_digest: hex, original_xid8: integer, pre_observation: observationSchema,
    original_intent: z.object({ admittedDevelopmentMethod: z.any() }).passthrough(),
    original_sources: z.object({ nativeReady: z.unknown() }).passthrough(),
    locked_program: z.object({ program: z.unknown(), original: z.unknown(), budget: z.unknown() }).passthrough(),
    locked_native_input: z.object({ authorityPins: z.array(z.unknown()) }).passthrough(), proposed_delta: z.unknown(),
  }).passthrough(),
}).passthrough();

export async function createOriginalRootPublicationHooks(input: {
  authority: CanonicalSpecialistAuthority; guardianOriginId: string;
  clockPrivateKeyPath: string; signal: AbortSignal;
}): Promise<OriginalOriginProducerHooks> {
  requireOriginLinuxRoot(); input.signal.throwIfAborted();
  if (input.authority.config.role !== "reader") fault("SPECIALIST_ROOT_COLLECTOR_READER_REQUIRED", 503);
  const authority = input.authority, enrollment = authority.enrollment, config = await readOriginPublicConfiguration(),
    clockIssuer = await OriginalQualifiedClockIssuer.open({ enrollment, qualificationRef: config.clockQualificationRef,
      privateKeyPath: input.clockPrivateKeyPath, signal: input.signal }),
    attemptIssuer = await OriginalNativeAttemptIssuer.open({ authority, guardianOriginId: input.guardianOriginId,
      clockIssuer, signal: input.signal });
  if (digest(config) !== digest(attemptIssuer.config)
    || config.witnessDirectory !== authority.config.witnessDirectory)
    fault("SPECIALIST_ROOT_COLLECTOR_CONFIGURATION_CHANGED", 503);
  const hooks: OriginalOriginProducerHooks = {
    onOriginalStart: async ({ publicationId, peer, signal }) => attemptIssuer.issue(publicationId, peer, signal),
    onOriginalFinalize: async ({ publicationId, peer, started, signal }) => {
      requireOriginLinuxRoot(); assertActualOriginPeer(peer); assertVerifiedOriginalBusinessSource(started.source);
      signal.throwIfAborted();
      if (started.source.publicationId !== publicationId || started.source.enrollmentDigest !== enrollment.digest
        || started.original.publicationId !== publicationId || started.clock.publicationId !== publicationId
        || peer.pid !== started.source.physics.sourcePid || peer.uid !== config.sourceUid
        || peer.bootId !== started.original.bootId
        || peer.clockNamespaceDevice !== started.original.clockNamespaceDevice
        || peer.clockNamespaceInode !== started.original.clockNamespaceInode)
        fault("SPECIALIST_ROOT_FINALIZE_ORIGINAL_SOURCE_REQUIRED", 503);
      await authority.assertDatabaseCustody(); signal.throwIfAborted();
      const custody = await authority.readOriginalAuthorityCustody();
      if (custody.enrollmentDigest !== started.source.enrollmentDigest
        || custody.epoch !== started.source.s8Epoch || custody.historyDigest !== started.source.s8HistoryDigest)
        fault("SPECIALIST_ROOT_ORIGINAL_S8_CUSTODY_CHANGED", 503);
      // This reads the immutable upper captured by the original candidate
      // backend. It never captures an upper or observes a replacement COMMIT.
      const actual = originalReadback.parse(await authority.observeOriginal(publicationId)),
        row = actual.candidateRow, candidate = row.candidate, pre = row.pre_observation, post = actual.postObservation,
        sourceDigest = digest({ intent: row.original_intent, nativeReady: row.original_sources.nativeReady }),
        ready = originalNativeReadySourceSchema.parse(row.original_sources.nativeReady),
        bounds = deriveOriginalBusinessBounds({ enrollment, binding: started.source.binding,
          program: row.locked_program.program, original: row.locked_program.original, budget: row.locked_program.budget,
          nativeReady: ready, admission: row.original_intent.admittedDevelopmentMethod });
      if (candidate.publicationId !== publicationId || candidate.enrollmentDigest !== enrollment.digest
        || candidate.bindingDigest !== digest(started.source.binding) || row.candidate_digest !== digest(candidate)
        || candidate.intentDigest !== digest(row.original_intent) || row.original_xid8 !== pre.xid8
        || candidate.nativeDigest !== digest(row.locked_program.program)
        || candidate.proposedDeltaDigest !== digest(row.proposed_delta)
        || sourceDigest !== started.source.originalSourceDigest
        || digest(bounds) !== digest(candidate.bounds) || digest(bounds) !== digest(started.source.originalUtcBounds)
        || digest(row.locked_native_input.authorityPins) !== digest(ready.originalAcceptedSource.authority))
        fault("SPECIALIST_ROOT_FROZEN_ORIGINAL_CANDIDATE_CHANGED", 503);
      if (candidate.physicalContract !== "LOGICAL_COMMIT" || enrollment.body.requiredPhysicalEvents.length)
        fault("SPECIALIST_GENUINE_ORIGINAL_PHYSICAL_EVENT_PRODUCER_REQUIRED", 503);
      signal.throwIfAborted();
      const clock = await clockIssuer.complete({ original: started.clock, candidate, pre, post, signal });
      const origins = await collectOriginalOriginCoverage({ enrollment, candidate, clock, pre, post, signal });
      signal.throwIfAborted();
      const witness = {
        schema: "finnor.specialist.root-publication-witness.v1", publicationId, candidateDigest: digest(candidate),
        bootId: candidate.bootId, guardianId: candidate.guardianId, cgroupId: candidate.cgroupId,
        processIdentity: candidate.processIdentity, clock, origins, physicalEvents: [],
      };
      await writeSpecialistRootBytesOnce(join(config.witnessDirectory, publicationId + ".json"), Buffer.from(canonical(witness)));
      signal.throwIfAborted();
      await readOriginalPublicationWitness({ directory: config.witnessDirectory, expectedDirectory: config.witnessDirectory,
        enrollment, candidate, pre, post, originalSourceDigest: started.source.originalSourceDigest });
      signal.throwIfAborted();
    },
  };
  return Object.freeze(hooks);
}
