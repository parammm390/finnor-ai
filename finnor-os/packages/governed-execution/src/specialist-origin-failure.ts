/** Authenticated failures only. No candidate, clock seal, new source or issuer. */
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { z } from "zod";
import { digest } from "../../capability-evolution/src/contracts";
import { assertVerifiedEnrollment, type VerifiedEnrollment } from "../../capability-evolution/src/specialist-publication-protocol";
import { canonical } from "./protocol";
import {
  ORIGIN_FAILURE_BYTES, ORIGIN_RECORDS, originFailureSnapshotSchema, sourceRegistrationSchema,
  type SourceRegistration,
} from "./specialist-origin-contract";
import { OriginFrames, connectRootOriginEndpoint, readOriginPublicConfiguration } from "./specialist-origin-custody";
import { originJournalRecordSchema, verifyOriginalOriginJournalRecords } from "./specialist-origin-journal";
import { assertOriginConfiguration } from "./specialist-origin-contract";
import { loadOriginClockQualification, originalOriginAttempt } from "./specialist-origin-verification";
import { assertOriginalOriginProcessIdentityFields } from "./specialist-origin-native";
import { nativeCensusSchema } from "./specialist-origin-contract";
const hex = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().min(1).max(4096);
export const actualOriginalFailureEvidenceSchema = z.object({
  schema: z.literal("finnor.specialist.authenticated-original-failure-evidence.v1"),
  requestId: hex, enrollmentDigest: hex, publicationId: hex, originalSourceDigest: hex,
  registration: sourceRegistrationSchema,
  origins: z.array(z.object({
    originId: text, records: z.array(originJournalRecordSchema).min(1).max(ORIGIN_RECORDS),
    snapshot: originFailureSnapshotSchema,
  }).strict()).min(7).max(64),
}).strict();
export type ActualOriginalFailureEvidence = z.infer<typeof actualOriginalFailureEvidenceSchema>;
export const originalFailureResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ORIGINAL_FAILURE_BEGIN"), requestId: hex, originId: text }).strict(),
  z.object({ type: z.literal("ORIGINAL_FAILURE_RECORD"), requestId: hex, originId: text,
    index: z.number().int().nonnegative(), record: originJournalRecordSchema }).strict(),
  z.object({ type: z.literal("ORIGINAL_FAILURE_ORIGIN_COMPLETE"), requestId: hex,
    originId: text, snapshot: originFailureSnapshotSchema }).strict(),
  z.object({ type: z.literal("ORIGINAL_FAILURE_COMPLETE"), requestId: hex }).strict(),
  z.object({ type: z.literal("ORIGINAL_FAILURE_REFUSED"), requestId: hex, code: text }).strict(),
]);
export function originalFailureDigest(
  registration: SourceRegistration,
  origins: ReadonlyArray<Readonly<{ records: readonly z.infer<typeof originJournalRecordSchema>[] }>>,
  damagedOriginIds: readonly string[],
) {
  return digest({ registrationDigest: digest(registration),
    revocations: origins.flatMap(origin => origin.records.filter(record => record.body.operation === "REVOCATION")
      .map(record => digest(record.body.value))).sort(), damagedOriginIds: [...damagedOriginIds].sort() });
}
export async function verifyActualOriginalFailureEvidence(input: {
  enrollment: VerifiedEnrollment; publicationId: string; originalSourceDigest: string;
  evidence: unknown; expectedRequestId?: string; expectedRegistration?: SourceRegistration;
}): Promise<ActualOriginalFailureEvidence> {
  assertVerifiedEnrollment(input.enrollment);
  const evidence = actualOriginalFailureEvidenceSchema.parse(input.evidence), e = input.enrollment,
    r = evidence.registration, ids = e.body.origins.map(origin => origin.id).sort();
  if (evidence.enrollmentDigest !== e.digest || evidence.publicationId !== input.publicationId
    || evidence.originalSourceDigest !== input.originalSourceDigest || r.originalSourceDigest !== input.originalSourceDigest
    || evidence.origins.length !== ids.length || new Set(evidence.origins.map(origin => origin.originId)).size !== ids.length
    || digest(evidence.origins.map(origin => origin.originId).sort()) !== digest(ids)
    || input.expectedRequestId && evidence.requestId !== input.expectedRequestId
    || input.expectedRegistration && digest(r) !== digest(input.expectedRegistration))
    throw Error("SPECIALIST_ORIGIN_ACTUAL_FAILURE_SCOPE_REQUIRED");
  let bytes = 0;
  for (const item of evidence.origins) {
    bytes += Buffer.byteLength(canonical(item));
    if (bytes > ORIGIN_FAILURE_BYTES) throw Error("SPECIALIST_ORIGIN_FAILURE_EVIDENCE_BOUND");
    const origin = e.body.origins.find(origin => origin.id === item.originId)!,
      verified = verifyOriginalOriginJournalRecords(e, origin, input.publicationId, item.records), b = item.snapshot.body;
    if (digest(verified.registration) !== digest(r) || item.snapshot.keyId !== origin.id
      || b.requestId !== evidence.requestId || b.enrollmentDigest !== e.digest || b.publicationId !== input.publicationId
      || b.originalSourceDigest !== input.originalSourceDigest || b.originId !== origin.id || b.streamId !== origin.streamId
      || b.bootId !== origin.bootId || b.registrationDigest !== digest(r) || b.recordCount !== item.records.length
      || b.lastRecordDigest !== digest(item.records.at(-1)!.body)
      || !verify(null, Buffer.from(canonical(b)), createPublicKey(origin.publicKey), Buffer.from(item.snapshot.signature, "base64")))
      throw Error("SPECIALIST_ORIGIN_AUTHENTICATED_FAULT_TAIL_REQUIRED");
  }
  const first = evidence.origins[0]!.snapshot.body, damaged = first.damagedOriginIds;
  if (new Set(damaged).size !== damaged.length || damaged.some(id => !ids.includes(id)))
    throw Error("SPECIALIST_ORIGIN_INVALID_CONTINUITY_LOSS_SUBJECT");
  const revocations = evidence.origins.flatMap(origin => origin.records.filter(record => record.body.operation === "REVOCATION"));
  if (first.basis === "DURABLE_REVOCATION" ? !revocations.length : !damaged.length)
    throw Error("SPECIALIST_ORIGIN_NO_CONCRETE_AUTHENTICATED_FAILURE");
  const expectedFailureDigest = originalFailureDigest(r, evidence.origins, damaged);
  if (evidence.origins.some(origin => origin.snapshot.body.failureDigest !== expectedFailureDigest
    || origin.snapshot.body.basis !== first.basis || digest(origin.snapshot.body.damagedOriginIds) !== digest(damaged)))
    throw Error("SPECIALIST_ORIGIN_FAILURE_TAIL_EQUIVOCATION");
  const config = await readOriginPublicConfiguration(); assertOriginConfiguration(e, config);
  const qualified = await loadOriginClockQualification(e, config),
    original = await originalOriginAttempt({ enrollment: e, config, registration: r });
  if (original.originalSourceDigest !== input.originalSourceDigest
    || original.clockNamespaceDevice !== qualified.body.clockNamespaceDevice
    || original.clockNamespaceInode !== qualified.body.clockNamespaceInode)
    throw Error("SPECIALIST_ORIGIN_FAILURE_ORIGINAL_SOURCE_OR_QUALIFICATION_CHANGED");
  for (const origin of evidence.origins) for (const record of origin.records) if (record.body.operation === "CENSUS")
    assertOriginalOriginProcessIdentityFields(r,
      nativeCensusSchema.parse((record.body.value as Record<string, unknown>).native), original.processIdentity);
  return evidence;
}
/** Feeds only the existing source socket; it never opens or replaces a source. */
export class OriginalFailureRead {
  readonly requestId = randomBytes(32).toString("hex");
  readonly result: Promise<ActualOriginalFailureEvidence>;
  private yes!: (value: ActualOriginalFailureEvidence) => void;
  private no!: (error: Error) => void;
  private stopped = false;
  private used = 0;
  private current: { originId: string; records: z.infer<typeof originJournalRecordSchema>[] } | null = null;
  private origins: ActualOriginalFailureEvidence["origins"] = [];
  private readonly abort = () => this.fail(Error("SPECIALIST_ORIGIN_FAILURE_READ_ABORTED"));
  constructor(readonly input: {
    enrollment: VerifiedEnrollment; publicationId: string; originalSourceDigest: string;
    signal: AbortSignal; expectedRegistration?: SourceRegistration;
  }) {
    this.result = new Promise((yes, no) => { this.yes = yes; this.no = no; });
    void this.result.catch(() => undefined);
    input.signal.addEventListener("abort", this.abort, { once: true });
    if (input.signal.aborted) this.abort();
  }
  accept(raw: z.infer<typeof originalFailureResponseSchema>) {
    try {
      if (this.stopped || raw.requestId !== this.requestId) throw Error("SPECIALIST_ORIGIN_FOREIGN_FAILURE_REPLY");
      if (raw.type === "ORIGINAL_FAILURE_REFUSED") throw Error("SPECIALIST_ORIGIN_AUTHENTICATED_FAILURE_UNAVAILABLE");
      if (raw.type === "ORIGINAL_FAILURE_BEGIN") {
        if (this.current || this.origins.some(origin => origin.originId === raw.originId)
          || !this.input.enrollment.body.origins.some(origin => origin.id === raw.originId))
          throw Error("SPECIALIST_ORIGIN_FAILURE_ORIGIN_REPLAY");
        this.current = { originId: raw.originId, records: [] }; return;
      }
      if (raw.type === "ORIGINAL_FAILURE_RECORD") {
        this.used += Buffer.byteLength(canonical(raw.record)) + 1;
        if (!this.current || raw.originId !== this.current.originId || raw.index !== this.current.records.length
          || raw.index >= ORIGIN_RECORDS || this.used > ORIGIN_FAILURE_BYTES)
          throw Error("SPECIALIST_ORIGIN_FAILURE_RECORD_GAP_OR_BOUND");
        this.current.records.push(raw.record); return;
      }
      if (raw.type === "ORIGINAL_FAILURE_ORIGIN_COMPLETE") {
        if (!this.current || raw.originId !== this.current.originId) throw Error("SPECIALIST_ORIGIN_FAILURE_ORIGIN_SUBSTITUTED");
        this.origins.push({ ...this.current, snapshot: raw.snapshot }); this.current = null; return;
      }
      if (this.current || !this.origins.length) throw Error("SPECIALIST_ORIGIN_FAILURE_INCOMPLETE");
      this.stopped = true; this.input.signal.removeEventListener("abort", this.abort);
      const registration = sourceRegistrationSchema.parse(
        (this.origins[0]!.records[0]!.body.value as Record<string, unknown>).registration);
      void verifyActualOriginalFailureEvidence({
        ...this.input, expectedRequestId: this.requestId, evidence: {
          schema: "finnor.specialist.authenticated-original-failure-evidence.v1", requestId: this.requestId,
          enrollmentDigest: this.input.enrollment.digest, publicationId: this.input.publicationId,
          originalSourceDigest: this.input.originalSourceDigest, registration, origins: this.origins,
        },
      }).then(value => {
        if (this.input.signal.aborted) this.no(Error("SPECIALIST_ORIGIN_FAILURE_READ_ABORTED")); else this.yes(value);
      }, () => this.no(Error("SPECIALIST_ORIGIN_FAILURE_VERIFICATION_FAILED")));
    } catch { this.fail(Error("SPECIALIST_ORIGIN_FAILURE_STREAM_INVALID")); }
  }
  fail(error: Error) {
    if (this.stopped) return; this.stopped = true;
    this.input.signal.removeEventListener("abort", this.abort); this.no(error);
  }
  request() {
    return { type: "READ_ORIGINAL_FAILURE" as const, requestId: this.requestId, publicationId: this.input.publicationId,
      enrollmentDigest: this.input.enrollment.digest, originalSourceDigest: this.input.originalSourceDigest };
  }
}
/** Diagnostic read of existing originals only, including after a source died. */
export async function readExistingOriginalFailureEvidence(input: {
  enrollment: VerifiedEnrollment; publicationId: string; originalSourceDigest: string; signal: AbortSignal;
}): Promise<ActualOriginalFailureEvidence> {
  assertVerifiedEnrollment(input.enrollment); input.signal.throwIfAborted();
  const config = await readOriginPublicConfiguration(), connected = await connectRootOriginEndpoint(config.socketPath, config, input.signal),
    frames = new OriginFrames(connected.socket), read = new OriginalFailureRead(input);
  frames.onFailure(error => read.fail(error));
  frames.onMessage(raw => {
    const value = originalFailureResponseSchema.safeParse(raw);
    if (!value.success) read.fail(Error("SPECIALIST_ORIGIN_INVALID_FAILURE_REPLY")); else read.accept(value.data);
  });
  try { await frames.send(read.request()); return await read.result; } finally { frames.socket.destroy(); }
}
