/** Original-only root signer. Its only request argument is an original ID. */
import { createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { join } from "node:path";
import { byteDigest, digest, fault } from "../../capability-evolution/src/contracts";
import { assertCurrentEnrollment, immutable } from "../../capability-evolution/src/specialist-publication-protocol";
import type { CanonicalSpecialistAuthority } from "../../capability-evolution/src/specialist-publication-authority";
import { readVerifiedOriginalBusinessSource } from "../../orchestration/src/workforce-execution/specialist-original-source";
import { canonical } from "./protocol";
import { assertOriginConfiguration, originKeyCustodySchema,
  type ActualOriginPeer, type OriginPublicConfiguration } from "./specialist-origin-contract";
import { assertActualOriginPeer, readOriginPublicConfiguration, readRootOriginFile, requireOriginLinuxRoot } from "./specialist-origin-custody";
import { readActualNativeOriginIdentity, originalOriginProcessIdentity } from "./specialist-origin-native";
import { readOriginalClockQualification, type OriginalClockQualification } from "./specialist-clock-qualification";
import { readActualNativeClockSample } from "./specialist-native-clock";
import { OriginalQualifiedClockIssuer } from "./specialist-clock-issuer";
import { originalAttemptIdentitySchema, readOriginalAttemptIdentity } from "./specialist-publication-witness";
import { assertSpecialistRootDirectory, readSpecialistRootBytes, writeSpecialistRootBytesOnce } from "./specialist-root-custody";

export class OriginalNativeAttemptIssuer {
  #key: KeyObject;
  private constructor(
    private readonly authority: CanonicalSpecialistAuthority, readonly config: OriginPublicConfiguration,
    private readonly qualification: OriginalClockQualification, private readonly guardianOriginId: string,
    private readonly clockIssuer: OriginalQualifiedClockIssuer, key: KeyObject,
  ) { this.#key = key; Object.freeze(this); }
  static async open(input: {
    authority: CanonicalSpecialistAuthority; guardianOriginId: string;
    clockIssuer: OriginalQualifiedClockIssuer; signal: AbortSignal;
  }) {
    requireOriginLinuxRoot(); input.signal.throwIfAborted(); assertCurrentEnrollment(input.authority.enrollment);
    if (input.authority.config.role !== "reader") fault("SPECIALIST_ROOT_ATTEMPT_READER_REQUIRED", 503);
    const config = await readOriginPublicConfiguration(), e = input.authority.enrollment;
    assertOriginConfiguration(e, config);
    const qualified = await readOriginalClockQualification(e, config.clockQualificationRef), q = qualified.body;
    if (q.hostPolicyDigest !== config.hostPolicyDigest || q.witnessDirectory !== config.witnessDirectory
      || q.nativeSamplerPath !== config.clockExecutable.path || q.nativeSamplerSha256 !== config.clockExecutable.sha256
      || input.clockIssuer.enrollment.digest !== e.digest || digest(input.clockIssuer.qualification) !== digest(q))
      fault("SPECIALIST_ROOT_ATTEMPT_QUALIFICATION_REQUIRED", 503);
    const guardian = e.body.origins.find(o => o.id === input.guardianOriginId && o.kind === "GUARDIAN");
    const custodyPath = process.env.FINNOR_SPECIALIST_ORIGIN_KEY_CUSTODY;
    if (!guardian || !custodyPath) fault("SPECIALIST_EXISTING_ROOT_GUARDIAN_KEY_REQUIRED", 503);
    const custody = originKeyCustodySchema.parse(JSON.parse((await readRootOriginFile(custodyPath, 1048576, true)).toString("utf8")));
    if (custody.publicConfigurationDigest !== digest(config)
      || new Set(custody.keys.map(k => k.originId)).size !== custody.keys.length)
      fault("SPECIALIST_ROOT_GUARDIAN_KEY_CONFIGURATION_REQUIRED", 503);
    const selected = custody.keys.find(k => k.originId === guardian.id);
    if (!selected) fault("SPECIALIST_EXISTING_ROOT_GUARDIAN_KEY_REQUIRED", 503);
    const bytes = await readSpecialistRootBytes(selected.privateKeyPath, 16384, true);
    let key: KeyObject;
    try { key = createPrivateKey(bytes); } finally { bytes.fill(0); }
    if (key.asymmetricKeyType !== "ed25519"
      || byteDigest(createPublicKey(key).export({ type: "spki", format: "der" }))
        !== byteDigest(createPublicKey(guardian.publicKey).export({ type: "spki", format: "der" })))
      fault("SPECIALIST_EXISTING_ROOT_GUARDIAN_PRIVATE_KEY_REQUIRED", 503);
    for (const name of ["attempt-intents", "attempts"]) await assertSpecialistRootDirectory(join(config.witnessDirectory, name));
    input.signal.throwIfAborted();
    return new OriginalNativeAttemptIssuer(input.authority, immutable(config), immutable(q),
      guardian.id, input.clockIssuer, key);
  }
  async issue(publicationId: string, peer: ActualOriginPeer, signal: AbortSignal) {
    requireOriginLinuxRoot(); assertActualOriginPeer(peer); signal.throwIfAborted();
    const source = await readVerifiedOriginalBusinessSource(this.authority, publicationId, signal),
      e = this.authority.enrollment, q = this.qualification;
    if (source.physics.hostReference.hostPolicyDigest !== this.config.hostPolicyDigest
      || source.physics.nativeBootstrap.uid !== this.config.sourceUid
      || peer.uid !== this.config.sourceUid || peer.pid !== source.physics.sourcePid)
      fault("SPECIALIST_ORIGINAL_ROOT_NATIVE_HOST_POLICY_REQUIRED", 503);
    // Consume the identity before starting a native snapshot or clock relation.
    // Missing/lost/partial writes cannot become a fresh original on restart.
    const intent = { schema: "finnor.specialist.root-original-attempt-intent.v1",
      enrollmentDigest: e.digest, publicationId, bindingDigest: digest(source.binding),
      originalSourceDigest: source.originalSourceDigest, guardianId: this.guardianOriginId };
    await writeSpecialistRootBytesOnce(join(this.config.witnessDirectory, "attempt-intents", publicationId + ".json"),
      Buffer.from(canonical({ body: intent, keyId: this.guardianOriginId,
        signature: sign(null, Buffer.from(canonical(intent)), this.#key).toString("base64") })));
    signal.throwIfAborted();
    const sample = await readActualNativeClockSample({ executablePath: q.nativeSamplerPath,
      executableSha256: q.nativeSamplerSha256, signal });
    const native = await readActualNativeOriginIdentity({ config: this.config, registration: source.physics, clock: sample, signal });
    const guardian = e.body.origins.find(o => o.id === this.guardianOriginId)!;
    if (native.bootId !== q.bootId || native.bootId !== guardian.bootId || native.bootId !== peer.bootId
      || native.workerStartTicks !== peer.startTicks
      || native.clockNamespaceDevice !== q.clockNamespaceDevice || native.clockNamespaceInode !== q.clockNamespaceInode
      || native.clockNamespaceDevice !== peer.clockNamespaceDevice || native.clockNamespaceInode !== peer.clockNamespaceInode
      || BigInt(native.fromMonotonicNs) < BigInt(q.qualifiedMonotonicCoverage.lower)
      || BigInt(native.throughMonotonicNs) > BigInt(q.qualifiedMonotonicCoverage.upper)
      || BigInt(native.fromMonotonicNs) >= BigInt(source.physics.nativeBootstrap.deadlineMonotonicNanoseconds)
      || BigInt(native.throughMonotonicNs) >= BigInt(source.physics.nativeBootstrap.deadlineMonotonicNanoseconds))
      fault("SPECIALIST_ORIGINAL_ROOT_NATIVE_IDENTITY_OUTSIDE_QUALIFICATION", 503);
    const body = originalAttemptIdentitySchema.parse({
      schema: "finnor.specialist.root-original-attempt.v1", enrollmentDigest: e.digest, publicationId,
      bindingDigest: digest(source.binding), originalSourceDigest: source.originalSourceDigest,
      hostDigest: digest({ reference: source.physics.hostReference, nativeBootstrap: source.physics.nativeBootstrap }),
      hostPolicyDigest: this.config.hostPolicyDigest, bootId: native.bootId, guardianId: guardian.id,
      cgroupId: native.cgroupDevice + ":" + native.cgroupInode,
      processIdentity: originalOriginProcessIdentity(source.physics, native),
      clockNamespaceDevice: native.clockNamespaceDevice, clockNamespaceInode: native.clockNamespaceInode,
      originalMonotonicStart: native.fromMonotonicNs,
      originalMonotonicDeadline: source.physics.nativeBootstrap.deadlineMonotonicNanoseconds,
      originalUtcBounds: source.originalUtcBounds,
    });
    const signed = immutable({ body, keyId: guardian.id,
      signature: sign(null, Buffer.from(canonical(body)), this.#key).toString("base64") });
    signal.throwIfAborted();
    await writeSpecialistRootBytesOnce(join(this.config.witnessDirectory, "attempts", publicationId + ".json"),
      Buffer.from(canonical(signed)));
    const actual = await readOriginalAttemptIdentity({ enrollment: e, directory: this.config.witnessDirectory,
      publicationId, bindingDigest: body.bindingDigest, expectedHostDigest: body.hostDigest,
      expectedHostPolicyDigest: body.hostPolicyDigest, expectedOriginalSourceDigest: source.originalSourceDigest,
      expectedMonotonicDeadline: body.originalMonotonicDeadline });
    signal.throwIfAborted();
    const clock = await this.clockIssuer.begin({ publicationId, bindingDigest: body.bindingDigest, hostDigest: body.hostDigest,
      originalSourceDigest: source.originalSourceDigest, originalMonotonicDeadline: body.originalMonotonicDeadline, signal });
    return Object.freeze({ original: actual, clock, source });
  }
}
