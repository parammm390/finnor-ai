/** Collect complete actual original histories, never seven fabricated "healthy" flags. */
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { z } from "zod";
import { digest } from "../../capability-evolution/src/contracts";
import {
  assertAllOriginCoverage, assertOriginalBounds, assertVerifiedEnrollment, candidateSchema, clockSealSchema, observationSchema,
  originSealSchema, integer, immutable,
  type ClockSeal, type CommitObservation, type OriginSeal, type PublicationCandidate, type SignedSeal, type VerifiedEnrollment,
} from "../../capability-evolution/src/specialist-publication-protocol";
import { canonical } from "./protocol";
import {
  ORIGIN_JOURNAL_BYTES, ORIGIN_RECORDS, originSnapshotSchema, originCensusSchema, nativeCensusSchema,
  type OriginPublicConfiguration,
} from "./specialist-origin-contract";
import {
  OriginFrames, connectRootOriginEndpoint, readOriginPublicConfiguration,
} from "./specialist-origin-custody";
import { originJournalRecordSchema, verifyOriginalOriginJournalRecords } from "./specialist-origin-journal";
import { assertOriginalOriginProcessIdentityFields } from "./specialist-origin-native";
import {
  assertCandidateOriginalSource, assertOriginalRevocationTail, assertQualifiedOriginCollection,
  loadOriginClockQualification, originalOriginAttempt, type OriginClockQualification,
} from "./specialist-origin-verification";

export interface OriginalOriginCollection {
  enrollment: VerifiedEnrollment; candidate: PublicationCandidate; clock: SignedSeal<ClockSeal>;
  pre: CommitObservation; post: CommitObservation; signal: AbortSignal;
}
export interface CurrentOriginalOriginTailInput extends OriginalOriginCollection {
  frozenOrigins: unknown;
  /** Already verified physical-event uppers only. This cannot lower the original logical upper. */
  verifiedRequiredPhysicalUpperUtcMicros?: string;
}
export interface VerifiedCurrentOriginalOriginTails {
  readonly schema: "finnor.specialist.verified-current-original-tails.v1";
  readonly enrollmentDigest: string; readonly publicationId: string; readonly candidateDigest: string;
  readonly clockDigest: string; readonly frozenOriginsDigest: string; readonly originalSourceDigest: string;
  readonly requiredOriginalUtcUpperMicros: string; readonly verificationMetadataDigest: string;
  readonly newCoverageIssued: false; readonly clockRenewed: false; readonly frozenWitnessChanged: false;
  readonly originalBoundsChanged: false;
}
const verifiedCurrentTails = new WeakMap<object, Readonly<{
  scopeDigest: string;
}>>();
function currentTailScope(input: Omit<CurrentOriginalOriginTailInput, "signal">) {
  return digest({ enrollmentDigest: input.enrollment.digest, candidate: input.candidate, clock: input.clock,
    pre: input.pre, post: input.post, frozenOrigins: input.frozenOrigins,
    verifiedRequiredPhysicalUpperUtcMicros: input.verifiedRequiredPhysicalUpperUtcMicros ?? null });
}
/** Required in core consumers. Serialized metadata or a fabricated object has no brand. */
export function assertVerifiedCurrentOriginalOriginTails(
  value: VerifiedCurrentOriginalOriginTails, input: Omit<CurrentOriginalOriginTailInput, "signal">,
) {
  assertVerifiedEnrollment(input.enrollment);
  const actual = value && typeof value === "object" ? verifiedCurrentTails.get(value) : undefined;
  if (!actual || actual.scopeDigest !== currentTailScope(input))
    throw Error("SPECIALIST_ORIGIN_MANDATORY_CURRENT_TAIL_BRAND_REQUIRED");
}
const text = z.string().min(1).max(4096), hex = z.string().regex(/^[a-f0-9]{64}$/);
const responseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ORIGIN_BEGIN"), requestId: hex, originId: text }).strict(),
  z.object({ type: z.literal("ORIGIN_RECORD"), requestId: hex, index: z.number().int().nonnegative(),
    record: originJournalRecordSchema }).strict(),
  z.object({ type: z.literal("ORIGIN_COMPLETE"), requestId: hex, snapshot: originSnapshotSchema }).strict(),
  z.object({ type: z.literal("REFUSED"), code: text }).strict(),
]);
async function fetchOriginal(input: OriginalOriginCollection & {
  config: OriginPublicConfiguration; qualified: OriginClockQualification; originId: string; historical: boolean;
  readOnly: boolean; requiredUtcUpperMicros?: string;
}) {
  const endpoint = input.config.endpoints.find(item => item.originId === input.originId),
    origin = input.enrollment.body.origins.find(item => item.id === input.originId);
  if (!endpoint || !origin) throw Error("SPECIALIST_ORIGIN_EXACT_ENROLLED_ENDPOINT_REQUIRED");
  const connected = await connectRootOriginEndpoint(endpoint.socketPath, input.config, input.signal);
  const frames = new OriginFrames(connected.socket), requestId = randomBytes(32).toString("hex");
  let began = false, done = false, used = 0, cleanup = () => {};
  const records: Array<z.infer<typeof originJournalRecordSchema>> = [];
  try {
    const complete = new Promise<z.infer<typeof originSnapshotSchema>>((yes, no) => {
      const stop = () => no(Error("SPECIALIST_ORIGIN_COLLECTION_ABORTED"));
      input.signal.addEventListener("abort", stop, { once: true });
      cleanup = () => input.signal.removeEventListener("abort", stop);
      frames.onFailure(error => { cleanup(); no(error); });
      frames.onMessage(raw => {
        try {
          input.signal.throwIfAborted();
          if (done) throw Error("SPECIALIST_ORIGIN_UNSOLICITED_TAIL");
          const message = responseSchema.parse(raw);
          if (message.type === "REFUSED") throw Error("SPECIALIST_ORIGIN_PRODUCER_REFUSED");
          if (message.requestId !== requestId) throw Error("SPECIALIST_ORIGIN_STALE_OR_FOREIGN_SNAPSHOT");
          if (message.type === "ORIGIN_BEGIN") {
            if (began || message.originId !== origin.id) throw Error("SPECIALIST_ORIGIN_SUBSTITUTED");
            began = true; return;
          }
          if (!began) throw Error("SPECIALIST_ORIGIN_NO_ORIGINAL_BEGIN");
          if (message.type === "ORIGIN_RECORD") {
            used += Buffer.byteLength(canonical(message.record)) + 1;
            if (message.index !== records.length || records.length >= ORIGIN_RECORDS || used > ORIGIN_JOURNAL_BYTES)
              throw Error("SPECIALIST_ORIGIN_GAPPED_OR_OVERSIZED_HISTORY");
            records.push(message.record); return;
          }
          const snapshot = message.snapshot, body = snapshot.body;
          if (snapshot.keyId !== origin.id || body.requestId !== requestId || body.enrollmentDigest !== input.enrollment.digest
            || body.publicationId !== input.candidate.publicationId || body.candidateDigest !== digest(input.candidate)
            || body.clockDigest !== digest(input.clock.body) || body.originId !== origin.id
            || body.streamId !== origin.streamId || body.bootId !== origin.bootId
            || body.recordCount !== records.length || !records.length || body.lastRecordDigest !== digest(records.at(-1)!.body)
            || input.historical && body.state !== "SOURCE_ENDED"
            || !input.historical && !input.readOnly && body.state !== "LIVE"
            || !verify(null, Buffer.from(canonical(body)), createPublicKey(origin.publicKey), Buffer.from(snapshot.signature, "base64")))
            throw Error("SPECIALIST_ORIGIN_FRESH_AUTHENTICATED_COMPLETE_TAIL_REQUIRED");
          done = true; cleanup(); yes(snapshot);
        } catch {
          cleanup(); no(Error("SPECIALIST_ORIGIN_COLLECTED_HISTORY_INVALID")); frames.fail("SPECIALIST_ORIGIN_COLLECTED_HISTORY_INVALID");
        }
      });
      if (input.signal.aborted) stop();
    });
    void complete.catch(() => undefined);
    await frames.send({ type: "COLLECT", requestId, historical: input.historical, readOnly: input.readOnly, enrollmentDigest: input.enrollment.digest,
      originId: origin.id, candidate: input.candidate, clock: input.clock, pre: input.pre, post: input.post });
    const snapshot = await complete;
    input.signal.throwIfAborted();
    const verified = verifyOriginalOriginJournalRecords(input.enrollment, origin, input.candidate.publicationId, records);
    if (snapshot.body.registrationDigest !== digest(verified.registration)
      || (input.historical || snapshot.body.state === "SOURCE_ENDED") && !verified.ended)
      throw Error("SPECIALIST_ORIGIN_ORIGINAL_REGISTRATION_OR_CLOSED_ARCHIVE_REQUIRED");
    const original = await originalOriginAttempt({
      enrollment: input.enrollment, config: input.config, registration: verified.registration,
    });
    assertCandidateOriginalSource(input.candidate, verified.registration, original);
    if (original.clockNamespaceDevice !== input.qualified.body.clockNamespaceDevice
      || original.clockNamespaceInode !== input.qualified.body.clockNamespaceInode)
      throw Error("SPECIALIST_ORIGIN_QUALIFIED_ORIGINAL_TIME_NAMESPACE_REQUIRED");
    for (const record of records) if (record.body.operation === "CENSUS") {
      const v = record.body.value as Record<string, unknown>,
        source = originCensusSchema.parse(v.source), native = nativeCensusSchema.parse(v.native);
      assertOriginalOriginProcessIdentityFields(verified.registration, native, original.processIdentity);
      if (source.source.sourceClosureDigest !== input.candidate.sourceClosureDigest
        || source.source.runtimeDigest !== input.candidate.runtimeDigest || source.source.hostDigest !== input.candidate.hostDigest
        || source.job.claimFence !== input.candidate.claimFence || source.job.claimTokenDigest !== input.candidate.claimTokenDigest
        || source.job.jobId !== input.candidate.jobId || source.s8.epoch !== input.candidate.s8Epoch
        || source.p3.setDigest !== digest(verified.registration.p3))
        throw Error("SPECIALIST_ORIGIN_AUTHENTICATED_SOURCE_HISTORY_MISMATCH");
    }
    const seals = records.filter(record => record.body.operation === "SEAL")
      .map(record => record.body.value as SignedSeal<OriginSeal>),
      revocations = records.filter(record => record.body.operation === "REVOCATION")
        .map(record => record.body.value);
    const checked = assertQualifiedOriginCollection(input);
    assertOriginalRevocationTail({ enrollment: input.enrollment, candidate: input.candidate, clock: checked.clock,
      interval: { utc: { lower: checked.interval.utc.lower,
        upper: input.requiredUtcUpperMicros === undefined ? checked.interval.utc.upper : BigInt(input.requiredUtcUpperMicros) } },
      revocations: revocations as Parameters<typeof assertOriginalRevocationTail>[0]["revocations"] });
    if (!seals.length || snapshot.body.completedThroughMonotonicNs !== seals.at(-1)!.body.throughMonotonicNs)
      throw Error("SPECIALIST_ORIGIN_COMPLETED_CONTIGUOUS_WATERMARK_REQUIRED");
    return { chain: seals, recordDigests: records.map(record => digest(record)), snapshot,
      originalSourceDigest: verified.registration.originalSourceDigest,
      lastRecordDigest: snapshot.body.lastRecordDigest, registrationDigest: snapshot.body.registrationDigest };
  } finally { cleanup(); frames.socket.destroy(); }
}
async function collect(input: OriginalOriginCollection, historical: boolean, readOnly = false, requiredUtcUpperMicros?: string) {
  input.signal.throwIfAborted(); assertVerifiedEnrollment(input.enrollment);
  const candidate = candidateSchema.parse(input.candidate), pre = observationSchema.parse(input.pre),
    post = observationSchema.parse(input.post), clock = { ...input.clock, body: clockSealSchema.parse(input.clock.body) },
    config = await readOriginPublicConfiguration(), qualified = await loadOriginClockQualification(input.enrollment, config),
    checked = assertQualifiedOriginCollection({ ...input, candidate, pre, post, clock, config, qualified });
  if (digest([...candidate.requiredOriginIds].sort()) !== digest(input.enrollment.body.origins.map(origin => origin.id).sort()))
    throw Error("SPECIALIST_ORIGIN_EVERY_ENROLLED_ID_REQUIRED");
  const upper = requiredUtcUpperMicros === undefined ? checked.interval.utc.upper : BigInt(integer.parse(requiredUtcUpperMicros)),
    required = { utc: { lower: checked.interval.utc.lower, upper } };
  if (upper < checked.interval.utc.upper || upper > BigInt(checked.clock.qualifiedUtcCoverage.upper))
    throw Error("SPECIALIST_ORIGIN_QUERY_CANNOT_REPLACE_OR_EXTEND_THE_QUALIFIED_ORIGINAL");
  assertOriginalBounds(input.enrollment, candidate, required);
  const request = { ...input, candidate, pre, post, clock, config, qualified, historical, readOnly,
    requiredUtcUpperMicros: String(upper) };
  const fetchAll = async () => {
    // A finite enrollment-sized walk avoids unbounded independent DB probes.
    const values: Awaited<ReturnType<typeof fetchOriginal>>[] = [];
    for (const origin of input.enrollment.body.origins) {
      input.signal.throwIfAborted(); values.push(await fetchOriginal({ ...request, originId: origin.id }));
    }
    return values;
  };
  const first = await fetchAll();
  if (new Set(first.map(value => value.registrationDigest)).size !== 1
    || new Set(first.map(value => value.originalSourceDigest)).size !== 1)
    throw Error("SPECIALIST_ORIGIN_CROSS_ORIGIN_REGISTRATION_FORK");
  assertAllOriginCoverage(input.enrollment, candidate, required, first.map(value => value.chain));
  // A fresh nonce-bound second full-tail read catches stale prefixes and
  // late-learned earlier failures. It never reacquires a source or upper bound.
  const final = await fetchAll(); input.signal.throwIfAborted();
  for (let index = 0; index < first.length; index++) {
    const before = first[index]!, after = final[index]!;
    if (before.registrationDigest !== after.registrationDigest || after.chain.length < before.chain.length
      || after.recordDigests.length < before.recordDigests.length
      || before.recordDigests.some((hash, at) => hash !== after.recordDigests[at])
      || before.chain.some((seal, at) => digest(seal) !== digest(after.chain[at])))
      throw Error("SPECIALIST_ORIGIN_ORIGINAL_PREFIX_REPLACED");
  }
  const chains = final.map(value => value.chain);
  assertAllOriginCoverage(input.enrollment, candidate, required, chains);
  return { chains: Object.freeze(chains.map(chain => Object.freeze(chain.map(seal => Object.freeze({
    ...seal, body: Object.freeze(seal.body),
  }))))), first, final, requiredOriginalUtcUpperMicros: String(upper) };
}
/** Stable owner-facing export. Same actual guest/guardian/P3 must remain held. */
export async function collectOriginalOriginCoverage(
  input: OriginalOriginCollection,
): Promise<ReadonlyArray<ReadonlyArray<SignedSeal<OriginSeal>>>> {
  return (await collect(input, false)).chains;
}
/** Read-only closed originals only. Never restarts an observer or issues seals. */
export async function readClosedOriginalOriginCoverage(
  input: OriginalOriginCollection,
): Promise<ReadonlyArray<ReadonlyArray<SignedSeal<OriginSeal>>>> {
  return (await collect(input, true)).chains;
}
/** Revalidate existing live OR drained closed tails. Never calls a barrier or signer for coverage. */
export async function readCurrentOriginalOriginCoverage(
  input: CurrentOriginalOriginTailInput,
): Promise<VerifiedCurrentOriginalOriginTails> {
  const frozen = z.array(z.array(z.object({ body: originSealSchema, keyId: text, signature: text }).strict())
    .min(1).max(ORIGIN_RECORDS)).min(7).max(64).parse(input.frozenOrigins);
  const bound: CurrentOriginalOriginTailInput = {
    enrollment: input.enrollment, signal: input.signal, candidate: candidateSchema.parse(input.candidate),
    clock: z.object({ body: clockSealSchema, keyId: text, signature: text }).strict().parse(input.clock),
    pre: observationSchema.parse(input.pre), post: observationSchema.parse(input.post), frozenOrigins: frozen,
    verifiedRequiredPhysicalUpperUtcMicros: input.verifiedRequiredPhysicalUpperUtcMicros,
  }, scopeDigest = currentTailScope(bound),
    result = await collect(bound, false, true, bound.verifiedRequiredPhysicalUpperUtcMicros),
    current = result.chains;
  if (frozen.length !== input.enrollment.body.origins.length
    || new Set(frozen.map(chain => chain[0]!.body.originId)).size !== frozen.length)
    throw Error("SPECIALIST_ORIGIN_FROZEN_ENROLLED_PREFIX_REQUIRED");
  for (const origin of input.enrollment.body.origins) {
    const before = frozen.find(chain => chain[0]!.body.originId === origin.id),
      after = current.find(chain => chain[0]!.body.originId === origin.id);
    if (!before || !after || after.length < before.length
      || before.some((seal, at) => digest(seal) !== digest(after[at])))
      throw Error("SPECIALIST_ORIGIN_FROZEN_PREFIX_IDENTITY_CHANGED");
  }
  input.signal.throwIfAborted();
  // This digest is deliberately fresh diagnostic metadata. Never add it,
  // nonces, heads or irrelevant END records to the frozen witness/evidenceDigest.
  const value: VerifiedCurrentOriginalOriginTails = immutable({
    schema: "finnor.specialist.verified-current-original-tails.v1" as const,
    enrollmentDigest: bound.enrollment.digest, publicationId: bound.candidate.publicationId,
    candidateDigest: digest(bound.candidate), clockDigest: digest(bound.clock), frozenOriginsDigest: digest(frozen),
    originalSourceDigest: result.final[0]!.originalSourceDigest,
    requiredOriginalUtcUpperMicros: result.requiredOriginalUtcUpperMicros,
    verificationMetadataDigest: digest({ first: result.first.map(value => value.snapshot),
      final: result.final.map(value => value.snapshot) }),
    newCoverageIssued: false as const, clockRenewed: false as const,
    frozenWitnessChanged: false as const, originalBoundsChanged: false as const,
  });
  verifiedCurrentTails.set(value, { scopeDigest });
  assertVerifiedCurrentOriginalOriginTails(value, bound); return value;
}
/** Call only after capture_original_upper committed the original frozen upper. */
export async function finalizeOriginalOriginPublication(input: {
  enrollment: VerifiedEnrollment; publicationId: string; signal: AbortSignal;
}): Promise<void> {
  assertVerifiedEnrollment(input.enrollment); input.signal.throwIfAborted();
  const { finalizeOriginalSourcePublication } = await import("./specialist-origin-source");
  await finalizeOriginalSourcePublication(input);
}
