/** Original qualified clock issuer. No generic signer or caller clock-body port. */
import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { byteDigest, digest, fault, type CapabilityRef } from "../../capability-evolution/src/contracts";
import { assertCurrentEnrollment, assertOriginalBounds, assertOriginalSignature,
  clockSealSchema, candidateSchema, observationSchema, encloseOriginalCommit, immutable, integer, verifyClockSeal,
  type ClockSeal, type CommitObservation, type PublicationCandidate, type SignedSeal, type VerifiedEnrollment,
} from "../../capability-evolution/src/specialist-publication-protocol";
import { canonical } from "./protocol";
import { readOriginalClockQualification, type OriginalClockQualification as Qualification } from "./specialist-clock-qualification";
import { readOriginalAttemptIdentity } from "./specialist-publication-witness";
import { assertActualNativeClockSample, readActualNativeClockSample, type NativeClockSample } from "./specialist-native-clock";
import { assertOriginalClockStart, assertOriginalClockEnd, assertOriginalQualifiedClockEvidence, originalClockStartSchema, originalClockEndSchema,
  type OriginalClockStart, type OriginalClockEnd } from "./specialist-clock-evidence";
import { assertSpecialistRootDirectory, readSpecialistRootBytes, writeSpecialistRootBytesOnce } from "./specialist-root-custody";

const hex = z.string().regex(/^[a-f0-9]{64}$/);
type OriginalAttempt = Awaited<ReturnType<typeof readOriginalAttemptIdentity>>;
export interface OriginalClockHandle { readonly publicationId: string }
const originals = new WeakMap<object, {
  issuer: OriginalQualifiedClockIssuer; original: OriginalAttempt; start: SignedSeal<OriginalClockStart>; used: boolean;
}>();
const maximum = (a: bigint, b: bigint) => a > b ? a : b;
const minimum = (a: bigint, b: bigint) => a < b ? a : b;

export class OriginalQualifiedClockIssuer {
  #key: KeyObject;
  private constructor(readonly enrollment: VerifiedEnrollment, readonly qualification: Qualification,
    readonly qualificationRef: CapabilityRef, key: KeyObject) { this.#key = key; Object.freeze(this); }
  static async open(input: {
    enrollment: VerifiedEnrollment; qualificationRef: CapabilityRef; privateKeyPath: string; signal: AbortSignal;
  }) {
    assertCurrentEnrollment(input.enrollment); input.signal.throwIfAborted();
    if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0)
      fault("SPECIALIST_CLOCK_ROOT_RUNTIME_REQUIRED", 503);
    const e = input.enrollment.body, qualified = await readOriginalClockQualification(input.enrollment, input.qualificationRef),
      q = qualified.body;
    for (const directory of ["clock-intents", "clock-starts", "clock-ends", "clocks", "attempts"])
      await assertSpecialistRootDirectory(join(q.witnessDirectory, directory));
    const authority = e.clockAuthorityKeys.find(key => key.id === q.clockAuthorityKeyId);
    if (!authority || authority.revoked) fault("SPECIALIST_EXISTING_CLOCK_KEY_REQUIRED", 503);
    if (!Number.isSafeInteger(Date.parse(authority.validAfter)) || !Number.isSafeInteger(Date.parse(authority.validUntil))
      || Date.parse(authority.validAfter) >= Date.parse(authority.validUntil))
      fault("SPECIALIST_EXISTING_CLOCK_KEY_WINDOW_REQUIRED", 503);
    const bytes = await readSpecialistRootBytes(input.privateKeyPath, 16384, true);
    let privateKey: KeyObject;
    try { privateKey = createPrivateKey(bytes); } finally { bytes.fill(0); }
    const actual = createPublicKey(privateKey), expected = createPublicKey(authority.publicKey);
    if (privateKey.asymmetricKeyType !== "ed25519" || actual.asymmetricKeyType !== "ed25519"
      || byteDigest(actual.export({ type: "spki", format: "der" }))
        !== byteDigest(expected.export({ type: "spki", format: "der" })))
      fault("SPECIALIST_EXISTING_CLOCK_PRIVATE_KEY_CUSTODY_REQUIRED", 503);
    input.signal.throwIfAborted();
    return new OriginalQualifiedClockIssuer(input.enrollment, immutable(q),
      qualified.reference, privateKey);
  }
  #signed<T>(body: T): SignedSeal<T> {
    return immutable({ body, keyId: this.qualification.clockAuthorityKeyId,
      signature: sign(null, Buffer.from(canonical(body)), this.#key).toString("base64") });
  }
  #assertSample(sample: NativeClockSample, original: OriginalAttempt) {
    assertActualNativeClockSample(sample);
    const q = this.qualification, e = this.enrollment.body,
      key = e.clockAuthorityKeys.find(key => key.id === q.clockAuthorityKeyId)!;
    const uncertainty = BigInt(q.utcErrorMicros)
      + (BigInt(sample.monotonicAfterNs) - BigInt(sample.monotonicBeforeNs) + 1999n) / 2000n + 1n;
    const utc = BigInt(sample.realtimeNs) / 1000n;
    if (original.hostPolicyDigest !== q.hostPolicyDigest || sample.samplerSha256 !== q.nativeSamplerSha256
      || sample.bootId !== q.bootId || sample.bootId !== original.bootId
      || sample.clockNamespaceDevice !== q.clockNamespaceDevice || sample.clockNamespaceInode !== q.clockNamespaceInode
      || sample.clockNamespaceDevice !== original.clockNamespaceDevice || sample.clockNamespaceInode !== original.clockNamespaceInode
      || BigInt(sample.monotonicBeforeNs) < BigInt(original.originalMonotonicStart)
      || BigInt(sample.monotonicAfterNs) >= BigInt(original.originalMonotonicDeadline)
      || BigInt(sample.monotonicBeforeNs) < BigInt(q.qualifiedMonotonicCoverage.lower)
      || BigInt(sample.monotonicAfterNs) > BigInt(q.qualifiedMonotonicCoverage.upper)
      || utc - uncertainty <= BigInt(q.qualifiedUtcCoverage.lower) || utc + uncertainty >= BigInt(q.qualifiedUtcCoverage.upper)
      || utc - uncertainty <= BigInt(Date.parse(key.validAfter)) * 1000n
      || utc + uncertainty >= BigInt(Date.parse(key.validUntil)) * 1000n)
      fault("SPECIALIST_ORIGINAL_NATIVE_CLOCK_SAMPLE_OUTSIDE_AUTHORITY", 503);
  }
  async begin(input: { publicationId: string; bindingDigest: string; hostDigest: string; originalSourceDigest: string;
    originalMonotonicDeadline: string; signal: AbortSignal }) {
    assertCurrentEnrollment(this.enrollment); input.signal.throwIfAborted();
    hex.parse(input.publicationId); hex.parse(input.bindingDigest); hex.parse(input.hostDigest);
    hex.parse(input.originalSourceDigest); integer.parse(input.originalMonotonicDeadline);
    const q = this.qualification, original = await readOriginalAttemptIdentity({ enrollment: this.enrollment,
      directory: q.witnessDirectory, publicationId: input.publicationId, bindingDigest: input.bindingDigest,
      expectedHostDigest: input.hostDigest, expectedHostPolicyDigest: q.hostPolicyDigest,
      expectedOriginalSourceDigest: input.originalSourceDigest,
      expectedMonotonicDeadline: input.originalMonotonicDeadline });
    input.signal.throwIfAborted();
    await writeSpecialistRootBytesOnce(join(q.witnessDirectory, "clock-intents", input.publicationId + ".json"),
      Buffer.from(canonical(this.#signed({ schema: "finnor.specialist.original-clock-intent.v1",
        enrollmentDigest: this.enrollment.digest, publicationId: input.publicationId, bindingDigest: input.bindingDigest,
        originalAttemptDigest: digest(original.signed), originalMonotonicDeadline: input.originalMonotonicDeadline,
        qualificationRef: this.qualificationRef }))));
    input.signal.throwIfAborted();
    const sample = await readActualNativeClockSample({ executablePath: q.nativeSamplerPath,
      executableSha256: q.nativeSamplerSha256, signal: input.signal });
    this.#assertSample(sample, original);
    const start = this.#signed(originalClockStartSchema.parse({
      schema: "finnor.specialist.original-native-clock-start.v1", enrollmentDigest: this.enrollment.digest,
      publicationId: input.publicationId, bindingDigest: input.bindingDigest, originalAttemptDigest: digest(original.signed),
      originalMonotonicDeadline: input.originalMonotonicDeadline, qualificationRef: this.qualificationRef, native: sample,
    }));
    input.signal.throwIfAborted();
    await writeSpecialistRootBytesOnce(join(q.witnessDirectory, "clock-starts", input.publicationId + ".json"),
      Buffer.from(canonical(start)));
    input.signal.throwIfAborted();
    const handle = Object.freeze({ publicationId: input.publicationId });
    originals.set(handle, { issuer: this, original, start, used: false }); return handle;
  }
  async complete(input: {
    original: OriginalClockHandle; candidate: PublicationCandidate; pre: CommitObservation; post: CommitObservation; signal: AbortSignal;
  }): Promise<SignedSeal<ClockSeal>> {
    assertCurrentEnrollment(this.enrollment); input.signal.throwIfAborted();
    const state = originals.get(input.original);
    if (!state || state.issuer !== this || state.used) fault("SPECIALIST_ORIGINAL_CLOCK_HANDLE_REQUIRED", 503);
    state.used = true;
    const c = immutable(candidateSchema.parse(input.candidate)), pre = immutable(observationSchema.parse(input.pre)),
      post = immutable(observationSchema.parse(input.post)), q = this.qualification, original = state.original;
    if (c.enrollmentDigest !== this.enrollment.digest || c.publicationId !== state.start.body.publicationId
      || c.bindingDigest !== original.bindingDigest || c.originalMonotonicStart !== original.originalMonotonicStart
      || c.originalMonotonicDeadline !== original.originalMonotonicDeadline || c.bootId !== original.bootId
      || c.guardianId !== original.guardianId || c.processIdentity !== original.processIdentity || c.cgroupId !== original.cgroupId
      || c.hostDigest !== original.hostDigest || digest(c.bounds) !== digest(original.originalUtcBounds))
      fault("SPECIALIST_ORIGINAL_CLOCK_CANDIDATE_CHANGED", 503);
    const current = await readOriginalAttemptIdentity({ enrollment: this.enrollment, directory: q.witnessDirectory,
      publicationId: c.publicationId, bindingDigest: c.bindingDigest, expectedHostDigest: original.hostDigest,
      expectedOriginalSourceDigest: original.originalSourceDigest,
      expectedHostPolicyDigest: q.hostPolicyDigest,
      expectedMonotonicDeadline: c.originalMonotonicDeadline });
    if (digest(current.signed) !== digest(original.signed)) fault("SPECIALIST_ORIGINAL_CLOCK_ATTEMPT_CHANGED", 503);
    const end = await readActualNativeClockSample({ executablePath: q.nativeSamplerPath,
      executableSha256: q.nativeSamplerSha256, signal: input.signal });
    this.#assertSample(end, original);
    const start = state.start.body.native, error = BigInt(q.utcErrorMicros)
      + (BigInt(start.monotonicAfterNs) - BigInt(start.monotonicBeforeNs) + 1999n) / 2000n + 1n;
    if (BigInt(end.monotonicBeforeNs) < BigInt(start.monotonicAfterNs))
      fault("SPECIALIST_ORIGINAL_CLOCK_SAMPLE_ORDER_REQUIRED", 503);
    const monoDistance = (BigInt(end.monotonicBeforeNs) + BigInt(end.monotonicAfterNs)
      - BigInt(start.monotonicBeforeNs) - BigInt(start.monotonicAfterNs)) / 2n;
    const discrepancy = BigInt(end.realtimeNs) - BigInt(start.realtimeNs) - monoDistance;
    const deviation = discrepancy < 0n ? -discrepancy : discrepancy;
    const allowance = BigInt(q.utcErrorMicros) * 2000n
      + BigInt(start.monotonicAfterNs) - BigInt(start.monotonicBeforeNs)
      + BigInt(end.monotonicAfterNs) - BigInt(end.monotonicBeforeNs)
      + (monoDistance * BigInt(q.driftPartsPerBillion) + 999999999n) / 1000000000n + 2000n;
    if (deviation > allowance) fault("SPECIALIST_ORIGINAL_CLOCK_STEP_OR_QUALIFICATION_LOSS", 503);
    const endError = BigInt(q.utcErrorMicros)
      + (BigInt(end.monotonicAfterNs) - BigInt(end.monotonicBeforeNs) + 1999n) / 2000n + 1n;
    const lower = maximum(BigInt(q.qualifiedUtcCoverage.lower), BigInt(start.realtimeNs) / 1000n + error),
      upper = minimum(BigInt(q.qualifiedUtcCoverage.upper), BigInt(end.realtimeNs) / 1000n - maximum(error, endError));
    const body = clockSealSchema.parse({
      schema: "finnor.specialist.qualified-clock-relation.v1", enrollmentDigest: this.enrollment.digest,
      publicationId: c.publicationId, primary: this.enrollment.body.primary, bootId: end.bootId,
      referenceUtcMicros: String(BigInt(start.realtimeNs) / 1000n),
      referenceMonotonicNs: String((BigInt(start.monotonicBeforeNs) + BigInt(start.monotonicAfterNs)) / 2n),
      utcErrorMicros: String(error), dbErrorMicros: q.dbErrorMicros, driftPartsPerBillion: q.driftPartsPerBillion,
      qualifiedUtcCoverage: { lower: String(lower), upper: String(upper) },
      qualifiedMonotonicCoverage: { lower: start.monotonicBeforeNs, upper: end.monotonicAfterNs },
      qualificationRef: this.qualificationRef, qualificationDigest: this.qualificationRef.contentDigest,
      sequence: "1", previousDigest: digest(state.start.body),
    });
    const sealed = this.#signed(body);
    assertOriginalSignature(sealed, this.enrollment.body.clockAuthorityKeys, { lower, upper });
    const clock = verifyClockSeal(this.enrollment, sealed), interval = encloseOriginalCommit(c, pre, post, clock);
    assertOriginalBounds(this.enrollment, c, interval);
    const sealedEnd = this.#signed<OriginalClockEnd>(originalClockEndSchema.parse({
      schema: "finnor.specialist.original-native-clock-end.v1", enrollmentDigest: this.enrollment.digest,
      publicationId: c.publicationId, candidateDigest: digest(c), startDigest: digest(state.start.body),
      qualificationRef: this.qualificationRef, native: end,
    }));
    const actualStart = assertOriginalClockStart({ enrollment: this.enrollment, candidate: c, clock: sealed,
      start: state.start, originalAttemptDigest: digest(original.signed),
      clockNamespaceDevice: original.clockNamespaceDevice, clockNamespaceInode: original.clockNamespaceInode });
    const actualEnd = assertOriginalClockEnd({ enrollment: this.enrollment, candidate: c, clock: sealed,
      start: actualStart, end: sealedEnd });
    assertOriginalQualifiedClockEvidence({ enrollment: this.enrollment, qualification: q, candidate: c,
      clock: sealed, start: actualStart, end: actualEnd, witnessDirectory: q.witnessDirectory,
      hostPolicyDigest: original.hostPolicyDigest });
    input.signal.throwIfAborted();
    await writeSpecialistRootBytesOnce(join(q.witnessDirectory, "clock-ends", c.publicationId + ".json"),
      Buffer.from(canonical(sealedEnd)));
    input.signal.throwIfAborted();
    await writeSpecialistRootBytesOnce(join(q.witnessDirectory, "clocks", c.publicationId + ".json"),
      Buffer.from(canonical(sealed)));
    input.signal.throwIfAborted(); return sealed;
  }
}
