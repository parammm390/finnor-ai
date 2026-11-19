/** One append-only original. No truncate, repair, reset, replacement, or re-sign. */
import { constants } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { mkdir, open, opendir, lstat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { canonical } from "./protocol";
import { digest } from "../../capability-evolution/src/contracts";
import {
  assertVerifiedEnrollment, integer, originSealSchema, type VerifiedEnrollment, type OriginSeal, type SignedSeal,
} from "../../capability-evolution/src/specialist-publication-protocol";
import {
  ORIGIN_JOURNAL_BYTES, ORIGIN_RECORDS, signedRevocationSchema, sourceRegistrationSchema, originCensusSchema, nativeCensusSchema,
  type OriginPublicConfiguration, type SignedOriginRevocation, type SourceRegistration,
} from "./specialist-origin-contract";
import { assertRootOriginDirectory, readRootOriginFile, requireOriginLinuxRoot } from "./specialist-origin-custody";
import { nativeClockSampleSchema } from "./specialist-native-clock";

type Origin = VerifiedEnrollment["body"]["origins"][number];
type RecordBody = {
  schema: "finnor.specialist.native-origin-journal-record.v1"; enrollmentDigest: string;
  publicationId: string; originId: string; sequence: string; previousDigest: string;
  operation: "GENESIS" | "CENSUS" | "SEAL" | "REVOCATION" | "SOURCE_END";
  value: unknown;
};
interface JournalRecord { body: RecordBody; keyId: string; signature: string }
const hex = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().min(1).max(4096);
export const originJournalRecordSchema = z.object({
  body: z.object({
    schema: z.literal("finnor.specialist.native-origin-journal-record.v1"),
    enrollmentDigest: hex, publicationId: hex, originId: text, sequence: integer, previousDigest: hex,
    operation: z.enum(["GENESIS", "CENSUS", "SEAL", "REVOCATION", "SOURCE_END"]), value: z.unknown(),
  }).strict(), keyId: text, signature: text,
}).strict();
const genesisSchema = z.object({
  registration: sourceRegistrationSchema, registrationDigest: hex,
  streamId: text, bootId: text, genesisDigest: hex, fromMonotonicNs: integer,
}).strict();
const censusRecordSchema = z.object({
  source: originCensusSchema, native: nativeCensusSchema,
  rootClock: nativeClockSampleSchema.extend({ samplerSha256: hex }),
  throughMonotonicNs: integer, originalSourceDigest: hex,
}).strict();
const sourceEndSchema = z.object({
  sourceSequence: integer, atMonotonicNs: integer, drainedThroughMonotonicNs: integer,
  originalSourceDigest: hex,
}).strict();
const signedSealSchema = z.object({ body: originSealSchema, keyId: text, signature: text }).strict();
const headSchema = z.object({
  body: z.object({
    schema: z.literal("finnor.specialist.immutable-origin-byte-head.v1"), enrollmentDigest: hex,
    publicationId: hex, originId: text, sequence: integer, recordDigest: hex,
    byteLength: z.number().int().nonnegative().max(ORIGIN_JOURNAL_BYTES), bytesSha256: hex,
  }).strict(), keyId: text, signature: text,
}).strict();

export function verifyOriginalOriginJournalRecords(
  enrollment: VerifiedEnrollment, origin: Origin, publicationId: string, raw: readonly unknown[],
) {
  assertVerifiedEnrollment(enrollment);
  if (!raw.length || raw.length > ORIGIN_RECORDS) throw Error("SPECIALIST_ORIGIN_JOURNAL_BOUND");
  let previous = origin.genesisDigest, registration: SourceRegistration | null = null, from = 0n,
    sealPrevious = origin.genesisDigest, sealSequence = 0n, sealThrough: bigint | null = null,
    sourceSequence = 0n, ended = false, lastCensusThrough = 0n;
  const records: JournalRecord[] = [];
  for (const item of raw) {
    const record = originJournalRecordSchema.parse(item), b = record.body;
    if (Object.keys(b).length !== 8 || b.enrollmentDigest !== enrollment.digest || b.originId !== origin.id
      || b.publicationId !== publicationId || b.sequence !== String(records.length + 1) || b.previousDigest !== previous
      || record.keyId !== origin.id || !verify(null, Buffer.from(canonical(b)), createPublicKey(origin.publicKey),
        Buffer.from(record.signature, "base64"))) throw Error("SPECIALIST_ORIGIN_DURABLE_CHAIN_INVALID");
    if (!records.length) {
      const genesis = genesisSchema.parse(b.value);
      if (b.operation !== "GENESIS" || genesis.registrationDigest !== digest(genesis.registration)
        || genesis.registration.enrollmentDigest !== enrollment.digest || genesis.registration.publicationId !== publicationId
        || genesis.streamId !== origin.streamId || genesis.bootId !== origin.bootId || genesis.genesisDigest !== origin.genesisDigest)
        throw Error("SPECIALIST_ORIGIN_DURABLE_GENESIS_INVALID");
      registration = genesis.registration; from = BigInt(genesis.fromMonotonicNs);
    } else {
      if (!registration || b.operation === "GENESIS" || ended && b.operation !== "REVOCATION")
        throw Error("SPECIALIST_ORIGIN_DURABLE_OPERATION_ORDER");
      if (b.operation === "CENSUS") {
        const c = censusRecordSchema.parse(b.value), through = BigInt(c.throughMonotonicNs);
        if (c.originalSourceDigest !== registration.originalSourceDigest
          || c.source.publicationId !== publicationId || c.source.enrollmentDigest !== enrollment.digest
          || c.source.registrationDigest !== digest(registration)
          || c.source.s8.epoch !== registration.s8Epoch || c.source.s8.historyDigest !== registration.s8HistoryDigest
          || through !== BigInt(c.source.throughMonotonicNs) || through < lastCensusThrough || through < from
          || through > BigInt(c.native.throughMonotonicNs) || through > BigInt(c.rootClock.monotonicBeforeNs)
          || c.native.event !== null || c.native.type === "REVOKED"
          || c.native.bootId !== origin.bootId || c.rootClock.bootId !== origin.bootId
          || c.native.clockNamespaceDevice !== c.rootClock.clockNamespaceDevice
          || c.native.clockNamespaceInode !== c.rootClock.clockNamespaceInode
          || BigInt(c.source.sourceSequence) !== sourceSequence)
          throw Error("SPECIALIST_ORIGIN_DURABLE_CENSUS_INVALID");
        lastCensusThrough = through;
      } else if (b.operation === "SEAL") {
        const s = signedSealSchema.parse(b.value), v = s.body;
        if (s.keyId !== origin.id || v.enrollmentDigest !== enrollment.digest || v.publicationId !== publicationId
          || v.originId !== origin.id || v.streamId !== origin.streamId || v.bootId !== origin.bootId
          || v.sequence !== String(++sealSequence) || v.previousDigest !== sealPrevious
          || BigInt(v.fromMonotonicNs) !== (sealThrough ?? from) || BigInt(v.throughMonotonicNs) > lastCensusThrough
          || BigInt(v.throughMonotonicNs) < BigInt(v.fromMonotonicNs)
          || !verify(null, Buffer.from(canonical(v)), createPublicKey(origin.publicKey), Buffer.from(s.signature, "base64")))
          throw Error("SPECIALIST_ORIGIN_DURABLE_SEAL_INVALID");
        sealPrevious = digest(v); sealThrough = BigInt(v.throughMonotonicNs);
      } else if (b.operation === "REVOCATION") {
        const v = signedRevocationSchema.parse(b.value);
        if (v.keyId !== origin.id || v.body.enrollmentDigest !== enrollment.digest || v.body.publicationId !== publicationId
          || v.body.originId !== origin.id || v.body.streamId !== origin.streamId || v.body.bootId !== origin.bootId
          || BigInt(v.body.atMonotonicNs) > BigInt(v.body.learnedMonotonicNs)
          || !verify(null, Buffer.from(canonical(v.body)), createPublicKey(origin.publicKey), Buffer.from(v.signature, "base64")))
          throw Error("SPECIALIST_ORIGIN_DURABLE_REVOCATION_INVALID");
        if (BigInt(v.body.sourceSequence) > sourceSequence) sourceSequence = BigInt(v.body.sourceSequence);
      } else {
        const end = sourceEndSchema.parse(b.value);
        if (end.originalSourceDigest !== registration.originalSourceDigest || BigInt(end.sourceSequence) <= sourceSequence
          || BigInt(end.drainedThroughMonotonicNs) > BigInt(end.atMonotonicNs)
          || BigInt(end.drainedThroughMonotonicNs) > lastCensusThrough)
          throw Error("SPECIALIST_ORIGIN_DURABLE_END_INVALID");
        ended = true; sourceSequence = BigInt(end.sourceSequence);
      }
    }
    records.push(record); previous = digest(b);
  }
  return { records, registration: registration!, fromMonotonicNs: String(from), ended };
}
export class OriginalOriginJournal {
  private records: JournalRecord[] = [];
  private bytes = 0;
  private damaged = false;
  private serial: Promise<unknown> = Promise.resolve();
  private constructor(
    readonly enrollment: VerifiedEnrollment, readonly origin: Origin, readonly publicationId: string,
    private path: string, private fd: FileHandle | null, private key: KeyObject | null,
  ) {}
  static async existingKey(enrollment: VerifiedEnrollment, originId: string, path: string) {
    requireOriginLinuxRoot(); assertVerifiedEnrollment(enrollment);
    const origin = enrollment.body.origins.find(value => value.id === originId);
    if (!origin) throw Error("SPECIALIST_ORIGIN_UNENROLLED_KEY");
    const key = createPrivateKey(await readRootOriginFile(path, 32768, true));
    const expected = createPublicKey(origin.publicKey), actual = createPublicKey(key);
    if (key.asymmetricKeyType !== "ed25519" || expected.asymmetricKeyType !== "ed25519"
      || !actual.export({ type: "spki", format: "der" }).equals(expected.export({ type: "spki", format: "der" })))
      throw Error("SPECIALIST_ORIGIN_EXISTING_KEY_REQUIRED");
    return key;
  }
  static async begin(input: {
    enrollment: VerifiedEnrollment; origin: Origin; registration: SourceRegistration;
    config: OriginPublicConfiguration; key: KeyObject; fromMonotonicNs: string;
  }) {
    requireOriginLinuxRoot(); assertVerifiedEnrollment(input.enrollment);
    await assertRootOriginDirectory(input.config.journalDirectory);
    const directory = join(input.config.journalDirectory, input.registration.publicationId);
    let created = false;
    try { await mkdir(directory, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await assertRootOriginDirectory(directory);
    const path = join(directory, digest(input.origin.id) + ".jsonl");
    // Existing originals are never reopened for writing, even if their owner died.
    const fd = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT
      | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const value = new OriginalOriginJournal(input.enrollment, input.origin, input.registration.publicationId, path, fd, input.key);
    try {
      await mkdir(path + ".heads", { mode: 0o700 });
      await value.append("GENESIS", { registration: input.registration, registrationDigest: digest(input.registration),
        streamId: input.origin.streamId, bootId: input.origin.bootId, genesisDigest: input.origin.genesisDigest,
        fromMonotonicNs: input.fromMonotonicNs });
      const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
      if (created) {
        const parentRoot = await open(input.config.journalDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await parentRoot.sync(); } finally { await parentRoot.close(); }
      }
      return value;
    } catch (error) { await fd.close(); throw error; }
  }
  static async historical(enrollment: VerifiedEnrollment, origin: Origin, publicationId: string, config: OriginPublicConfiguration) {
    assertVerifiedEnrollment(enrollment);
    const path = join(config.journalDirectory, publicationId, digest(origin.id) + ".jsonl");
    const raw = await readRootOriginFile(path, ORIGIN_JOURNAL_BYTES);
    if (raw.at(-1) !== 10) throw Error("SPECIALIST_ORIGIN_TORN_JOURNAL_REFUSED");
    const value = new OriginalOriginJournal(enrollment, origin, publicationId, path, null, null);
    const lines = raw.toString("utf8").split("\n"); lines.pop();
    if (!lines.length || lines.length > ORIGIN_RECORDS) throw Error("SPECIALIST_ORIGIN_JOURNAL_BOUND");
    value.records = verifyOriginalOriginJournalRecords(enrollment, origin, publicationId,
      lines.map(line => JSON.parse(line) as unknown)).records;
    value.bytes = raw.length; await value.assertDurableTail(); return value;
  }
  private recordedHash() {
    const hash = createHash("sha256");
    for (const record of this.records) hash.update(canonical(record) + "\n");
    return hash.digest("hex");
  }
  private async assertHead() {
    const directory = this.path + ".heads"; await assertRootOriginDirectory(directory);
    const names: string[] = [], entries = await opendir(directory, { bufferSize: 32 });
    for await (const entry of entries) {
      if (!entry.isFile() || !/^\d{10}\.json$/.test(entry.name) || names.length >= ORIGIN_RECORDS)
        throw Error("SPECIALIST_ORIGIN_DURABLE_HEAD_DIRECTORY_CHANGED");
      names.push(entry.name);
    }
    names.sort();
    if (names.length !== this.records.length || names.some((name, at) => name !== String(at + 1).padStart(10, "0") + ".json"))
      throw Error("SPECIALIST_ORIGIN_DURABLE_PREFIX_ROLLBACK");
    if (!names.length) return;
    const head = headSchema.parse(JSON.parse((await readRootOriginFile(join(directory, names.at(-1)!), 16384, true)).toString("utf8"))),
      b = head.body, last = this.records.at(-1)!;
    if (b.enrollmentDigest !== this.enrollment.digest || b.publicationId !== this.publicationId
      || b.originId !== this.origin.id || b.sequence !== String(this.records.length)
      || b.recordDigest !== digest(last.body) || b.byteLength !== this.bytes || b.bytesSha256 !== this.recordedHash()
      || head.keyId !== this.origin.id || !verify(null, Buffer.from(canonical(b)), createPublicKey(this.origin.publicKey),
        Buffer.from(head.signature, "base64"))) throw Error("SPECIALIST_ORIGIN_DURABLE_HEAD_MISMATCH");
  }
  private async appendHead() {
    if (!this.key) throw Error("SPECIALIST_ORIGIN_READ_ONLY");
    const directory = this.path + ".heads", body = {
      schema: "finnor.specialist.immutable-origin-byte-head.v1" as const, enrollmentDigest: this.enrollment.digest,
      publicationId: this.publicationId, originId: this.origin.id, sequence: String(this.records.length),
      recordDigest: digest(this.records.at(-1)!.body), byteLength: this.bytes, bytesSha256: this.recordedHash(),
    }, value = headSchema.parse({ body, keyId: this.origin.id,
      signature: sign(null, Buffer.from(canonical(body)), this.key).toString("base64") });
    const fd = await open(join(directory, String(this.records.length).padStart(10, "0") + ".json"),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await fd.writeFile(canonical(value) + "\n"); await fd.sync(); } finally { await fd.close(); }
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
  }
  private async assertRecordedBytes() {
    if (!this.fd) {
      const bytes = await readRootOriginFile(this.path, ORIGIN_JOURNAL_BYTES);
      if (bytes.length !== this.bytes || createHash("sha256").update(bytes).digest("hex") !== this.recordedHash())
        throw Error("SPECIALIST_ORIGIN_DURABLE_BYTES_CHANGED");
      return;
    }
    const a = await this.fd.stat({ bigint: true }), named = await lstat(this.path, { bigint: true });
    if (!a.isFile() || !named.isFile() || a.uid !== 0n || a.nlink !== 1n || (a.mode & 0o077n)
      || a.size !== BigInt(this.bytes) || a.dev !== named.dev || a.ino !== named.ino)
      throw Error("SPECIALIST_ORIGIN_DURABLE_CUSTODY_CHANGED");
    const hash = createHash("sha256"), buffer = Buffer.alloc(65536); let used = 0;
    while (used <= this.bytes) {
      const read = await this.fd.read(buffer, 0, Math.min(buffer.length, this.bytes + 1 - used), used);
      if (!read.bytesRead) break; used += read.bytesRead; hash.update(buffer.subarray(0, read.bytesRead));
    }
    const b = await this.fd.stat({ bigint: true }), after = await lstat(this.path, { bigint: true });
    if (used !== this.bytes || hash.digest("hex") !== this.recordedHash()
      || a.dev !== b.dev || a.ino !== b.ino || a.size !== b.size || a.mode !== b.mode
      || a.mtimeNs !== b.mtimeNs || a.ctimeNs !== b.ctimeNs || b.uid !== 0n || b.nlink !== 1n
      || !after.isFile() || b.dev !== after.dev || b.ino !== after.ino || b.size !== after.size)
      throw Error("SPECIALIST_ORIGIN_DURABLE_BYTES_CHANGED");
  }
  async assertDurableTail() {
    try {
      await this.serial;
      if (this.damaged) throw Error("SPECIALIST_ORIGIN_DAMAGED_JOURNAL");
      await this.assertRecordedBytes(); await this.assertHead();
    } catch (error) { this.damaged = true; throw error; }
  }
  private async append(operation: RecordBody["operation"], data: unknown, unrevoked = false) {
    const run = this.serial.then(async () => {
      if (this.damaged || !this.fd || !this.key) throw Error("SPECIALIST_ORIGIN_READ_ONLY_OR_DAMAGED");
      if (unrevoked && this.revocations.length) throw Error("SPECIALIST_ORIGIN_REVOKED");
      if (this.sourceEnded && operation !== "REVOCATION") throw Error("SPECIALIST_ORIGIN_ORIGINAL_SOURCE_ENDED");
      const body: RecordBody = {
        schema: "finnor.specialist.native-origin-journal-record.v1", enrollmentDigest: this.enrollment.digest,
        publicationId: this.publicationId, originId: this.origin.id, sequence: String(this.records.length + 1),
        previousDigest: this.records.length ? digest(this.records[this.records.length - 1]!.body) : this.origin.genesisDigest,
        operation, value: data,
      };
      const record = { body, keyId: this.origin.id, signature: sign(null, Buffer.from(canonical(body)), this.key).toString("base64") };
      const bytes = Buffer.from(canonical(record) + "\n");
      if (this.records.length >= ORIGIN_RECORDS || this.bytes + bytes.length > ORIGIN_JOURNAL_BYTES)
        throw Error("SPECIALIST_ORIGIN_DURABLE_PROFILE_EXHAUSTED");
      await this.assertRecordedBytes(); await this.assertHead();
      let offset = 0;
      try {
        while (offset < bytes.length) {
          const written = await this.fd.write(bytes, offset, bytes.length - offset);
          if (!written.bytesWritten) throw Error("SPECIALIST_ORIGIN_DURABLE_WRITE_LOST");
          offset += written.bytesWritten;
        }
        await this.fd.sync();
      } catch (error) { this.damaged = true; throw error; }
      this.bytes += bytes.length; this.records.push(record);
      await this.appendHead(); await this.assertRecordedBytes(); await this.assertHead();
    });
    this.serial = run.catch(() => { this.damaged = true; });
    return run;
  }
  get registration(): SourceRegistration {
    return genesisSchema.parse(this.records[0]!.body.value).registration;
  }
  get fromMonotonicNs() { return genesisSchema.parse(this.records[0]!.body.value).fromMonotonicNs; }
  get sourceEnded() { return this.records.some(record => record.body.operation === "SOURCE_END"); }
  get continuityLost() { return this.damaged; }
  get recordsSnapshot(): readonly JournalRecord[] { return this.records.slice(); }
  get seals(): Array<SignedSeal<OriginSeal>> {
    return this.records.filter(record => record.body.operation === "SEAL")
      .map(record => record.body.value as SignedSeal<OriginSeal>);
  }
  get revocations(): SignedOriginRevocation[] {
    return this.records.filter(record => record.body.operation === "REVOCATION")
      .map(record => signedRevocationSchema.parse(record.body.value));
  }
  async census(value: unknown) { await this.append("CENSUS", censusRecordSchema.parse(value), true); }
  async revoke(value: SignedOriginRevocation["body"]) {
    if (!this.key) throw Error("SPECIALIST_ORIGIN_READ_ONLY");
    const body = signedRevocationSchema.shape.body.parse(value);
    const signed = { body, keyId: this.origin.id, signature: sign(null, Buffer.from(canonical(body)), this.key).toString("base64") };
    await this.append("REVOCATION", signed);
  }
  async sourceEnd(value: unknown) { await this.append("SOURCE_END", sourceEndSchema.parse(value)); }
  async seal(value: OriginSeal) {
    if (!this.key || this.revocations.length || this.damaged) throw Error("SPECIALIST_ORIGIN_REVOKED");
    const body = originSealSchema.parse(value), prior = this.seals;
    if (body.sequence !== String(prior.length + 1)
      || body.previousDigest !== (prior.length ? digest(prior[prior.length - 1]!.body) : this.origin.genesisDigest))
      throw Error("SPECIALIST_ORIGIN_SEAL_SEQUENCE");
    const signed = { body, keyId: this.origin.id, signature: sign(null, Buffer.from(canonical(body)), this.key).toString("base64") };
    await this.append("SEAL", signed, true); return signed;
  }
  async close() { await this.serial; await this.fd?.close(); this.fd = null; this.key = null; }
}
