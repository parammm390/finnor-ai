/** Root-held real origin producers. There is no generic signing operation. */
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { constants } from "node:fs";
import { chown, chmod, lstat, open } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { digest } from "../../capability-evolution/src/contracts";
import {
  assertCurrentEnrollment, type SignedSeal, type OriginSeal, type VerifiedEnrollment,
} from "../../capability-evolution/src/specialist-publication-protocol";
import { canonical } from "./protocol";
import {
  assertOriginConfiguration, collectRequestSchema, sourceMessageSchema, originKeyCustodySchema,
  originCensusSchema, originSnapshotSchema, type ActualOriginPeer, type OriginCollectRequest,
  type OriginCensus, type OriginEventKind, type OriginKind, type OriginPublicConfiguration,
  type SourceEvent, type SourceRegistration, originalFinalizeRequestSchema,
  originalFailureReadRequestSchema, originFailureSnapshotSchema, ORIGIN_FAILURE_BYTES,
} from "./specialist-origin-contract";
import {
  assertActualOriginPeer, assertRootOriginDirectory, OriginFrames, readActualOriginPeer, readOriginPublicConfiguration,
  readRootOriginFile, requireOriginLinuxRoot,
} from "./specialist-origin-custody";
import { OriginalOriginJournal } from "./specialist-origin-journal";
import {
  originalOriginProcessIdentity, startActualNativeOriginObserver, type ActualNativeOriginCensus,
} from "./specialist-origin-native";
import {
  assertCandidateOriginalSource, assertQualifiedOriginCollection, assertRawClockForOriginal,
  loadOriginClockQualification, originalOriginAttempt, sampleOriginClock, type OriginClockQualification,
} from "./specialist-origin-verification";
import { assertVerifiedOriginalBusinessSource } from "../../orchestration/src/workforce-execution/specialist-original-source";
import type { OriginalNativeAttemptIssuer } from "./specialist-original-attempt";
import { originalFailureDigest } from "./specialist-origin-failure";

export type OriginalRootStart = Awaited<ReturnType<OriginalNativeAttemptIssuer["issue"]>>;
export interface OriginalOriginProducerHooks {
  onOriginalStart(input: Readonly<{
    publicationId: string; peer: ActualOriginPeer; signal: AbortSignal;
  }>): Promise<OriginalRootStart>;
  onOriginalFinalize(input: Readonly<{
    publicationId: string; peer: ActualOriginPeer; started: OriginalRootStart; signal: AbortSignal;
  }>): Promise<void>;
}

type Original = Awaited<ReturnType<typeof originalOriginAttempt>>;
type Native = Awaited<ReturnType<typeof startActualNativeOriginObserver>>;
type End = Extract<ReturnType<typeof sourceMessageSchema.parse>, { type: "SOURCE_END" }>;
type Drained = Extract<ReturnType<typeof sourceMessageSchema.parse>, { type: "SOURCE_DRAINED" }>;
type CensusMessage = Extract<ReturnType<typeof sourceMessageSchema.parse>, { type: "SOURCE_CENSUS" }>;
const MAX_CONNECTIONS = 128, MAX_PUBLICATIONS = 8;
async function assertCurrentSourcePins(config: OriginPublicConfiguration, signal: AbortSignal) {
  for (const pin of config.sourcePins) {
    signal.throwIfAborted();
    if (createHash("sha256").update(await readRootOriginFile(pin.path, 3 * 1024 * 1024)).digest("hex") !== pin.sha256)
      throw Error("SPECIALIST_ORIGIN_QUALIFIED_SOURCE_PIN_CHANGED");
  }
}

async function actualSourceExecutable(socket: Socket, peer: ActualOriginPeer, config: OriginPublicConfiguration, signal: AbortSignal) {
  if (peer.uid !== config.sourceUid || peer.gid !== config.sourceGid) throw Error("SPECIALIST_ORIGIN_SOURCE_UID_GID");
  // This is a kernel-derived /proc link for the actual SO_PEERCRED PID, not a
  // caller pathname. The pidfd census later checks this exact start identity.
  const fd = await open(`/proc/${peer.pid}/exe`, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const a = await fd.stat();
    if (!a.isFile() || a.uid !== 0 || a.nlink !== 1 || (a.mode & 0o022) || a.size <= 0 || a.size > 256 * 1024 * 1024)
      throw Error("SPECIALIST_ORIGIN_SOURCE_EXECUTABLE_CUSTODY");
    const hash = createHash("sha256"), buffer = Buffer.alloc(65536); let used = 0;
    while (used <= a.size) {
      signal.throwIfAborted();
      const read = await fd.read(buffer, 0, Math.min(buffer.length, a.size + 1 - used), null);
      if (!read.bytesRead) break; used += read.bytesRead; hash.update(buffer.subarray(0, read.bytesRead));
    }
    const b = await fd.stat(), again = await readActualOriginPeer(socket, config, signal);
    if (used !== a.size || b.size !== a.size || b.dev !== a.dev || b.ino !== a.ino
      || b.mtimeMs !== a.mtimeMs || b.ctimeMs !== a.ctimeMs || b.mode !== a.mode || b.nlink !== 1
      || hash.digest("hex") !== config.sourceExecutableSha256 || digest(again) !== digest(peer))
      throw Error("SPECIALIST_ORIGIN_ACTUAL_EXECUTABLE_OR_PEER_REPLACED");
  } finally { await fd.close(); }
}
class PublicationOrigins {
  readonly journals = new Map<string, OriginalOriginJournal>();
  native: Native | null = null;
  original: Original | null = null;
  private sourceSequence = 0n;
  private lastCensus: OriginCensus | null = null;
  private candidateDigest: string | null = null;
  private barrierCache: string | null = null;
  private serial: Promise<unknown> = Promise.resolve();
  private events: Promise<void> = Promise.resolve();
  private pendingEvents = 0;
  private negative = false;
  private failed = false;
  private ended = false;
  private endRequested = false;
  private closed = false;
  private expectedNativeStop = false;
  private finalization: Promise<void> | null = null;
  private initialization: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private waiting: { requestId: string; challenge: string; target: bigint; yes: (value: OriginCensus) => void; no: (e: Error) => void } | null = null;
  readonly signal: AbortSignal;
  constructor(
    readonly enrollment: VerifiedEnrollment, readonly config: OriginPublicConfiguration,
    readonly qualified: OriginClockQualification, readonly keys: Map<string, KeyObject>,
    readonly registration: SourceRegistration, readonly peer: ActualOriginPeer, readonly frames: OriginFrames,
    readonly serviceSignal: AbortSignal, readonly sourceChannelSignal: AbortSignal,
    readonly started: OriginalRootStart, readonly hooks: OriginalOriginProducerHooks,
    readonly privateCustodyPaths: readonly string[], readonly assertPrivateCustody: () => Promise<void>,
  ) {
    const remaining = BigInt(registration.nativeBootstrap.deadlineMonotonicNanoseconds) - process.hrtime.bigint();
    if (remaining <= 0n || remaining > 60000000000n) throw Error("SPECIALIST_ORIGIN_ORIGINAL_DEADLINE");
    this.signal = AbortSignal.any([serviceSignal, sourceChannelSignal,
      AbortSignal.timeout(Math.max(1, Number(remaining / 1000000n)))]);
    this.signal.addEventListener("abort", () => {
      this.waiting?.no(Error("SPECIALIST_ORIGIN_ORIGINAL_DEADLINE")); this.waiting = null;
      this.loss("ABORT", "ORIGINAL_DEADLINE_OR_SERVICE_LOST");
    }, { once: true });
  }
  private run<T>(work: () => Promise<T>) {
    const next = this.serial.then(work); this.serial = next.catch(() => undefined); return next;
  }
  private fatal() {
    this.failed = true; this.waiting?.no(Error("SPECIALIST_ORIGIN_SOURCE_CUSTODY_LOST")); this.waiting = null;
    this.frames.fail("SPECIALIST_ORIGIN_SOURCE_CUSTODY_LOST");
  }
  private async currentPeer() {
    const peer = await readActualOriginPeer(this.frames.socket, this.config, this.signal);
    if (digest(peer) !== digest(this.peer)) throw Error("SPECIALIST_ORIGIN_SOURCE_PROCESS_REPLACED");
  }
  initialize() {
    if (this.initialization) throw Error("SPECIALIST_ORIGIN_INITIALIZATION_REPLAY");
    this.initialization = this.initializeOriginal(); return this.initialization;
  }
  private async initializeOriginal() {
    this.signal.throwIfAborted();
    assertCurrentEnrollment(this.enrollment);
    const q = this.qualified.body, r = this.registration;
    assertVerifiedOriginalBusinessSource(this.started.source);
    const source = this.started.source, byKey = <T extends {resourceKey: string}>(values: readonly T[]) =>
      values.slice().sort((a, b) => a.resourceKey < b.resourceKey ? -1 : a.resourceKey > b.resourceKey ? 1 : 0);
    if (source.publicationId !== r.publicationId || source.enrollmentDigest !== r.enrollmentDigest
      || source.originalSourceDigest !== r.originalSourceDigest || digest(source.binding) !== digest(r.binding)
      || digest(source.physics) !== digest({ hostReference: r.hostReference, nativeBootstrap: r.nativeBootstrap, sourcePid: r.sourcePid })
      || digest(source.initialJobClaim) !== digest(r.initialJobClaim)
      || digest(byKey(source.initialP3Grants)) !== digest(byKey(r.initialP3Grants))
      || digest(byKey(source.p3)) !== digest(byKey(r.p3)) || source.s8Epoch !== r.s8Epoch
      || source.s8HistoryDigest !== r.s8HistoryDigest)
      throw Error("SPECIALIST_ORIGIN_ACTUAL_COMMITTED_SOURCE_READBACK_MISMATCH");
    if (r.sourcePid !== this.peer.pid || this.peer.uid !== this.config.sourceUid || this.peer.gid !== this.config.sourceGid
      || this.peer.clockNamespaceDevice !== q.clockNamespaceDevice || this.peer.clockNamespaceInode !== q.clockNamespaceInode
      || this.peer.bootId !== q.bootId) throw Error("SPECIALIST_ORIGIN_REAL_ORIGINAL_PEER_REQUIRED");
    this.native = await startActualNativeOriginObserver({
      config: this.config, registration: r,
      namespace: { device: q.clockNamespaceDevice, inode: q.clockNamespaceInode }, signal: this.signal,
      privateCustodyPaths: this.privateCustodyPaths,
    });
    this.native.onLoss((_error, census) => {
      if (census || !this.expectedNativeStop) this.loss(census?.event ?? "PROCESS_LOSS", census?.reason ?? "NATIVE_OBSERVER_LOST",
        census?.atMonotonicNs ?? undefined);
    });
    // Watch first, then authenticate all current bytes, then drain the watcher.
    // Startup-only hashes cannot qualify a later original's installed source.
    await assertCurrentSourcePins(this.config, this.signal);
    await this.assertPrivateCustody();
    if (this.native.ready.workerStartTicks !== this.peer.startTicks || this.native.ready.bootId !== q.bootId)
      throw Error("SPECIALIST_ORIGIN_ORIGINAL_PROCESS_REPLACED");
    this.original = await originalOriginAttempt({ enrollment: this.enrollment, config: this.config, registration: r });
    if (this.original.clockNamespaceDevice !== q.clockNamespaceDevice || this.original.clockNamespaceInode !== q.clockNamespaceInode
      || this.original.processIdentity !== originalOriginProcessIdentity(r, this.native.ready)
      || this.original.bootId !== this.native.ready.bootId)
      throw Error("SPECIALIST_ORIGIN_SIGNED_ORIGINAL_PHYSICS_MISMATCH");
    const first = await this.sourceBarrier(BigInt(this.native.ready.throughMonotonicNs));
    const sample = await this.native.barrier(first.throughMonotonicNs, this.signal),
      clock = await sampleOriginClock(this.config, this.qualified, this.signal);
    assertRawClockForOriginal(clock, this.original); await this.events;
    if (this.failed || this.negative) throw Error("SPECIALIST_ORIGIN_LOST_BEFORE_GENESIS");
    for (const origin of this.enrollment.body.origins) {
      this.signal.throwIfAborted();
      if (origin.bootId !== clock.bootId) throw Error("SPECIALIST_ORIGIN_ENROLLED_BOOT_MISMATCH");
      const journal = await OriginalOriginJournal.begin({
        enrollment: this.enrollment, origin, registration: r, config: this.config, key: this.keys.get(origin.id)!,
        fromMonotonicNs: this.native.ready.throughMonotonicNs,
      });
      this.journals.set(origin.id, journal);
    }
    await this.appendCensus(first, sample, clock);
  }
  private async appendCensus(source: OriginCensus, native: ActualNativeOriginCensus, rootClock: Awaited<ReturnType<typeof sampleOriginClock>>) {
    if (BigInt(source.throughMonotonicNs) > BigInt(native.throughMonotonicNs)
      || BigInt(source.throughMonotonicNs) > BigInt(rootClock.monotonicBeforeNs))
      throw Error("SPECIALIST_ORIGIN_COMPLETED_WATERMARK_REQUIRED");
    const record = { source, native, rootClock, throughMonotonicNs: source.throughMonotonicNs,
      originalSourceDigest: this.registration.originalSourceDigest };
    for (const journal of this.journals.values()) {
      if (this.failed || this.negative) throw Error("SPECIALIST_ORIGIN_SOURCE_REVOKED_BEFORE_CENSUS");
      await journal.census(record);
    }
    this.lastCensus = source;
  }
  private async sourceBarrier(target: bigint, requireCommittedOriginal = false) {
    this.signal.throwIfAborted();
    if (this.waiting || this.failed || this.negative || this.closed || this.ended)
      throw Error("SPECIALIST_ORIGIN_SAME_LIVE_SOURCE_REQUIRED");
    const requestId = randomBytes(32).toString("hex"), challenge = randomBytes(32).toString("hex");
    const completed = new Promise<OriginCensus>((yes, no) => { this.waiting = { requestId, challenge, target, yes, no }; });
    await this.frames.send({ type: "BARRIER", requestId, challenge, publicationId: this.registration.publicationId,
      throughMonotonicNs: String(target), requireCommittedOriginal });
    return completed;
  }
  acceptCensus(message: CensusMessage) {
    const waiting = this.waiting, c = originCensusSchema.parse(message.census), r = this.registration;
    if (!waiting || waiting.requestId !== message.requestId || waiting.challenge !== c.challenge
      || c.publicationId !== r.publicationId || c.enrollmentDigest !== this.enrollment.digest
      || c.registrationDigest !== digest(r) || c.sourceSequence !== String(this.sourceSequence)
      || BigInt(c.throughMonotonicNs) <= waiting.target
      || BigInt(c.throughMonotonicNs) >= BigInt(r.nativeBootstrap.deadlineMonotonicNanoseconds)
      || c.job.jobId !== r.binding.job.id || c.job.deliveryAttemptId !== r.binding.job.deliveryAttemptId
      || c.job.claimFence !== String(r.binding.job.claimFence) || c.job.claimTokenDigest !== r.binding.job.claimTokenSha256
      || c.job.leaseOwner !== r.initialJobClaim.workerId || digest(c.p3.current) !== digest(r.p3)
      || c.p3.setDigest !== digest(r.p3) || c.s8.enrollmentDigest !== this.enrollment.digest || c.s8.epoch !== r.s8Epoch
      || c.s8.historyDigest !== r.s8HistoryDigest
      || c.source.sourceClosureDigest !== r.binding.sourceClosureDigest || c.source.runtimeDigest !== r.binding.runtimeDigest
      || c.source.hostDigest !== digest({ reference: r.hostReference, nativeBootstrap: r.nativeBootstrap })
      || c.source.bootId !== this.qualified.body.bootId || c.source.cgroupDevice !== r.hostReference.device
      || c.source.cgroupInode !== r.hostReference.inode) { this.fatal(); return; }
    this.waiting = null;
    void this.events.then(() => this.failed || this.negative
      ? waiting.no(Error("SPECIALIST_ORIGIN_NEGATIVE_BEFORE_BARRIER")) : waiting.yes(c)).catch(() => this.fatal());
  }
  acceptEvent(event: SourceEvent) {
    if (this.pendingEvents >= 64) { this.fatal(); return; }
    this.pendingEvents++;
    if (event.publicationId !== this.registration.publicationId || BigInt(event.sourceSequence) !== this.sourceSequence + 1n
      || BigInt(event.atMonotonicNs) > process.hrtime.bigint()) { this.fatal(); return; }
    this.sourceSequence++; this.negative = true; this.barrierCache = null;
    this.events = this.events.then(async () => {
      try {
      await this.recordNegative(event.originKind, event.event, event.reason, event.atMonotonicNs, event.sourceSequence);
      await this.frames.send({ type: "SOURCE_EVENT_ACK", sourceSequence: event.sourceSequence });
      } finally { this.pendingEvents--; }
    }).catch(() => this.fatal());
  }
  private async recordNegative(kind: OriginKind | null, event: OriginEventKind, reason: string, at: string, sourceSequence: string) {
    const learned = await sampleOriginClock(this.config, this.qualified, this.serviceSignal);
    if (BigInt(at) > BigInt(learned.monotonicBeforeNs)) throw Error("SPECIALIST_ORIGIN_NEGATIVE_TIME_INVALID");
    for (const journal of this.journals.values()) {
      if (kind !== null && journal.origin.kind !== kind) continue;
      await journal.revoke({
        schema: "finnor.specialist.native-origin-revocation.v1", enrollmentDigest: this.enrollment.digest,
        publicationId: this.registration.publicationId, originId: journal.origin.id, streamId: journal.origin.streamId,
        bootId: journal.origin.bootId, event, atMonotonicNs: at, learnedMonotonicNs: learned.monotonicAfterNs,
        sourceSequence, reason,
      });
    }
  }
  loss(event: OriginEventKind, reason: string, at?: string) {
    if (this.closed && this.ended) return;
    this.negative = true; this.barrierCache = null;
    void this.frames.send({ type: "ORIGINAL_SOURCE_REVOKED", publicationId: this.registration.publicationId,
      enrollmentDigest: this.enrollment.digest }).catch(() => undefined);
    this.waiting?.no(Error("SPECIALIST_ORIGIN_ORIGINAL_SOURCE_LOST")); this.waiting = null;
    const effective = at ?? this.lastCensus?.throughMonotonicNs ?? this.native?.ready.throughMonotonicNs
      ?? this.registration.sourceStartedMonotonicNs;
    this.events = this.events.then(() => this.recordNegative(null, event, reason, effective, "0"))
      .catch(() => this.fatal());
  }
  async collect(request: OriginCollectRequest) {
    return this.run(async () => {
      if (!this.original || !this.native || this.failed || this.closed || this.ended || this.endRequested || request.historical)
        throw Error("SPECIALIST_ORIGIN_LIVE_ORIGINAL_REQUIRED");
      const checked = assertQualifiedOriginCollection({
        enrollment: this.enrollment, config: this.config, qualified: this.qualified, ...request,
      });
      assertCandidateOriginalSource(request.candidate, this.registration, this.original);
      if (this.candidateDigest && this.candidateDigest !== digest(request.candidate))
        throw Error("SPECIALIST_ORIGIN_ORIGINAL_CANDIDATE_REBIND");
      this.candidateDigest = digest(request.candidate);
      const cache = digest({ candidate: request.candidate, clock: request.clock, pre: request.pre, post: request.post });
      await immediate(undefined, { signal: this.signal }); await this.events; await this.currentPeer();
      if (this.negative) throw Error("SPECIALIST_ORIGIN_SOURCE_REVOKED");
      if (this.barrierCache !== cache) {
        const source = await this.sourceBarrier(checked.interval.monotonic.upper, true),
          native = await this.native.barrier(source.throughMonotonicNs, this.signal),
          clock = await sampleOriginClock(this.config, this.qualified, this.signal);
        assertRawClockForOriginal(clock, this.original); await this.events;
        if (this.failed || this.negative) throw Error("SPECIALIST_ORIGIN_SOURCE_REVOKED");
        await this.appendCensus(source, native, clock); this.barrierCache = cache;
      } else {
        // Same completed source barrier may serve every enrolled ID, but kernel
        // notifications are drained again; no new source interval is invented.
        await this.native.barrier(this.lastCensus!.throughMonotonicNs, this.signal); await this.events;
      }
      const journal = this.journals.get(request.originId);
      if (!journal || this.failed || this.negative || !this.lastCensus) throw Error("SPECIALIST_ORIGIN_ORIGINAL_UNAVAILABLE");
      const previous = journal.seals, last = previous.at(-1);
      if (!last || BigInt(last.body.throughMonotonicNs) < BigInt(this.lastCensus.throughMonotonicNs)) {
        const seal: OriginSeal = {
          schema: "finnor.specialist.original-origin-coverage.v1", enrollmentDigest: this.enrollment.digest,
          publicationId: this.registration.publicationId, candidateDigest: this.candidateDigest,
          originId: journal.origin.id, streamId: journal.origin.streamId, bootId: journal.origin.bootId,
          sequence: String(previous.length + 1), previousDigest: last ? digest(last.body) : journal.origin.genesisDigest,
          fromMonotonicNs: last?.body.throughMonotonicNs ?? journal.fromMonotonicNs,
          throughMonotonicNs: this.lastCensus.throughMonotonicNs,
          referenceUtcMicros: checked.clock.referenceUtcMicros, referenceMonotonicNs: checked.clock.referenceMonotonicNs,
          utcErrorMicros: checked.clock.utcErrorMicros, driftPartsPerBillion: checked.clock.driftPartsPerBillion, events: [],
        };
        await journal.seal(seal);
      }
      await immediate(undefined, { signal: this.signal }); await this.events;
      if (this.failed || this.negative || this.closed || this.ended) throw Error("SPECIALIST_ORIGIN_TAIL_CHANGED_DURING_SEAL");
      await journal.assertDurableTail();
      return journal;
    });
  }
  async sourceEnd(message: End) {
    if (message.publicationId !== this.registration.publicationId || BigInt(message.sourceSequence) !== this.sourceSequence + 1n
      || BigInt(message.atMonotonicNs) > process.hrtime.bigint() || this.endRequested) throw Error("SPECIALIST_ORIGIN_SOURCE_END_INVALID");
    this.sourceSequence++; this.endRequested = true;
    await this.run(async () => {
      if (this.ended || !this.lastCensus || !this.native) throw Error("SPECIALIST_ORIGIN_SOURCE_END_REPLAY");
      try { await this.native.barrier(this.lastCensus.throughMonotonicNs, this.signal); }
      catch { this.loss("PROCESS_LOSS", "FINAL_NATIVE_DRAIN_LOST"); }
      await immediate(); await this.events;
      if (this.failed) throw Error("SPECIALIST_ORIGIN_SOURCE_END_CUSTODY_LOST");
      await this.frames.send({ type: "SOURCE_END_ACK", sourceSequence: message.sourceSequence });
    });
  }
  async sourceDrained(message: Drained) {
    if (!this.endRequested || this.ended || message.publicationId !== this.registration.publicationId
      || BigInt(message.sourceSequence) !== this.sourceSequence + 1n
      || BigInt(message.atMonotonicNs) > process.hrtime.bigint()) throw Error("SPECIALIST_ORIGIN_SOURCE_DRAIN_INVALID");
    this.sourceSequence++;
    await this.run(async () => {
      try { await this.native?.barrier(this.lastCensus!.throughMonotonicNs, this.signal); }
      catch { this.loss("PROCESS_LOSS", "FINAL_NATIVE_DRAIN_LOST"); }
      await this.events;
      if (this.failed || !this.lastCensus || !this.native || BigInt(message.sourceSequence) !== this.sourceSequence)
        throw Error("SPECIALIST_ORIGIN_SOURCE_DRAIN_LOST");
      this.expectedNativeStop = true; await this.native.stop(); await this.events;
      for (const journal of this.journals.values()) await journal.sourceEnd({
        sourceSequence: message.sourceSequence, atMonotonicNs: message.atMonotonicNs,
        drainedThroughMonotonicNs: this.lastCensus.throughMonotonicNs,
        originalSourceDigest: this.registration.originalSourceDigest,
      });
      this.ended = true;
      await this.frames.send({ type: "SOURCE_DRAINED_ACK", sourceSequence: message.sourceSequence });
    });
  }
  channelClosed() {
    if (!this.closing) {
      this.closed = true;
      if (!this.ended) this.loss("SOURCE_CHANGE", "ORIGINAL_SOURCE_CHANNEL_LOST");
      this.waiting?.no(Error("SPECIALIST_ORIGIN_SOURCE_CHANNEL_CLOSED")); this.waiting = null;
      this.closing = (async () => {
        await this.initialization?.catch(() => undefined); await this.serial; await this.events;
        this.expectedNativeStop = true; await this.native?.stop(); await this.events;
        for (const journal of this.journals.values()) await journal.close();
      })();
    }
    return this.closing;
  }
  async archiveReady() { await this.events; return this.ended && this.closed && !this.failed; }
  snapshotReadable() {
    return !this.failed && this.journals.size === this.enrollment.body.origins.length && (!this.closed || this.ended);
  }
  async readOnly(request: OriginCollectRequest) {
    if (!request.readOnly || !this.original || !this.snapshotReadable())
      throw Error("SPECIALIST_ORIGIN_ORIGINAL_READ_ONLY_TAIL_UNAVAILABLE");
    assertQualifiedOriginCollection({ enrollment: this.enrollment, config: this.config, qualified: this.qualified, ...request });
    assertCandidateOriginalSource(request.candidate, this.registration, this.original);
    await immediate(); await this.events;
    const journal = this.journals.get(request.originId);
    if (!journal || !this.snapshotReadable() || request.historical && !journal.sourceEnded)
      throw Error("SPECIALIST_ORIGIN_READ_ONLY_ORIGINAL_CONTINUITY_UNKNOWN");
    await journal.assertDurableTail(); return journal;
  }
  async failureJournals() {
    // A positive operation may be waiting for the worker's owning callback.
    // Negative evidence must not queue behind it or request another census.
    await immediate(); await this.events;
    for (const journal of this.journals.values())
      await journal.assertDurableTail().catch(() => undefined);
    await this.events;
    if (this.journals.size !== this.enrollment.body.origins.length
      || !Array.from(this.journals.values()).some(journal => journal.revocations.length || journal.continuityLost))
      throw Error("SPECIALIST_ORIGIN_NO_EXISTING_AUTHENTICATED_ORIGINAL_FAULT");
    return this.journals;
  }
  snapshotLive() { return !this.failed && !this.negative && !this.ended && !this.endRequested && !this.closed && !this.signal.aborted; }
  async finalize(peer: ActualOriginPeer) {
    assertActualOriginPeer(peer); this.signal.throwIfAborted();
    if (this.finalization || this.ended || this.endRequested || this.closed || this.failed
      || peer.pid !== this.peer.pid || peer.startTicks !== this.peer.startTicks || peer.uid !== this.peer.uid)
      throw Error("SPECIALIST_ORIGIN_ORIGINAL_FINALIZATION_REPLAY_OR_FOREIGN_PEER");
    // Only the original ID and authenticated peer enter W2's retained collector.
    // No worker-provided clock, candidate, observation, or signer data is forwarded.
    this.finalization = (async () => {
      await this.currentPeer();
      await this.hooks.onOriginalFinalize({
        publicationId: this.registration.publicationId, peer, started: this.started, signal: this.signal,
      });
      await this.events; await this.currentPeer();
      if (!this.snapshotLive()) throw Error("SPECIALIST_ORIGIN_SOURCE_LOST_DURING_FINALIZATION");
    })();
    await this.finalization; this.signal.throwIfAborted();
  }
}
async function sendOriginalFailure(
  frames: OriginFrames, request: ReturnType<typeof originalFailureReadRequestSchema.parse>,
  enrollment: VerifiedEnrollment, journals: ReadonlyMap<string, OriginalOriginJournal>, keys: ReadonlyMap<string, KeyObject>,
) {
  const rows = enrollment.body.origins.map(origin => {
    const journal = journals.get(origin.id);
    if (!journal) throw Error("SPECIALIST_ORIGIN_FAILURE_MISSING_ENROLLED_GENESIS");
    return { origin, journal, records: journal.recordsSnapshot };
  }), registration = rows[0]!.journal.registration,
    damaged = rows.filter(row => row.journal.continuityLost).map(row => row.origin.id).sort(),
    revocations = rows.flatMap(row => row.journal.revocations);
  if (registration.originalSourceDigest !== request.originalSourceDigest || !revocations.length && !damaged.length)
    throw Error("SPECIALIST_ORIGIN_NO_ACTUAL_ORIGINAL_FAILURE");
  const failureDigest = originalFailureDigest(registration, rows, damaged),
    basis = damaged.length ? "JOURNAL_CONTINUITY_LOST" as const : "DURABLE_REVOCATION" as const;
  let bytes = 0;
  for (const row of rows) {
    if (digest(row.journal.registration) !== digest(registration)) throw Error("SPECIALIST_ORIGIN_FAILURE_ORIGINAL_FORK");
    if (!row.journal.continuityLost) await row.journal.assertDurableTail();
    await frames.send({ type: "ORIGINAL_FAILURE_BEGIN", requestId: request.requestId, originId: row.origin.id });
    for (let index = 0; index < row.records.length; index++) {
      const record = row.records[index]!; bytes += Buffer.byteLength(canonical(record)) + 1;
      if (bytes > ORIGIN_FAILURE_BYTES) throw Error("SPECIALIST_ORIGIN_FAILURE_OUTPUT_BOUND");
      await frames.send({ type: "ORIGINAL_FAILURE_RECORD", requestId: request.requestId, originId: row.origin.id, index, record });
    }
    const body = {
      schema: "finnor.specialist.authenticated-original-failure-snapshot.v1" as const,
      requestId: request.requestId, enrollmentDigest: enrollment.digest, publicationId: request.publicationId,
      originalSourceDigest: request.originalSourceDigest, originId: row.origin.id, streamId: row.origin.streamId,
      bootId: row.origin.bootId, registrationDigest: digest(registration), recordCount: row.records.length,
      lastRecordDigest: digest(row.records.at(-1)!.body), state: "FAILED" as const, failureDigest, basis, damagedOriginIds: damaged,
    }, snapshot = originFailureSnapshotSchema.parse({ body, keyId: row.origin.id,
      signature: sign(null, Buffer.from(canonical(body)), keys.get(row.origin.id)!).toString("base64") });
    await frames.send({ type: "ORIGINAL_FAILURE_ORIGIN_COMPLETE", requestId: request.requestId, originId: row.origin.id, snapshot });
  }
  for (const row of rows) {
    const current = row.journal.recordsSnapshot;
    if (current.length !== row.records.length || digest(current.at(-1)!.body) !== digest(row.records.at(-1)!.body))
      throw Error("SPECIALIST_ORIGIN_FAILURE_TAIL_CHANGED");
  }
  await frames.send({ type: "ORIGINAL_FAILURE_COMPLETE", requestId: request.requestId });
}

async function sendSnapshot(
  frames: OriginFrames, request: OriginCollectRequest, journal: OriginalOriginJournal,
  key: KeyObject, live: boolean, stillCurrent: () => boolean,
) {
  const records = journal.recordsSnapshot, seals = journal.seals;
  await journal.assertDurableTail();
  if (!records.length || !seals.length || !live && !journal.sourceEnded) throw Error("SPECIALIST_ORIGIN_NO_COMPLETE_ORIGINAL_ARCHIVE");
  await frames.send({ type: "ORIGIN_BEGIN", requestId: request.requestId, originId: journal.origin.id });
  for (let index = 0; index < records.length; index++)
    await frames.send({ type: "ORIGIN_RECORD", requestId: request.requestId, index, record: records[index] });
  const current = journal.recordsSnapshot;
  await journal.assertDurableTail();
  if (!stillCurrent() || current.length !== records.length || digest(current.at(-1)!.body) !== digest(records.at(-1)!.body))
    throw Error("SPECIALIST_ORIGIN_TAIL_CHANGED_DURING_TRANSFER");
  const body = {
    schema: "finnor.specialist.actual-origin-journal-snapshot.v1" as const,
    requestId: request.requestId, enrollmentDigest: journal.enrollment.digest, publicationId: journal.publicationId,
    candidateDigest: digest(request.candidate), clockDigest: digest(request.clock.body), originId: journal.origin.id,
    streamId: journal.origin.streamId, bootId: journal.origin.bootId, registrationDigest: digest(journal.registration),
    recordCount: records.length, lastRecordDigest: digest(records.at(-1)!.body),
    state: live ? "LIVE" as const : "SOURCE_ENDED" as const,
    completedThroughMonotonicNs: seals.at(-1)!.body.throughMonotonicNs,
  };
  const snapshot = originSnapshotSchema.parse({ body, keyId: journal.origin.id,
    signature: sign(null, Buffer.from(canonical(body)), key).toString("base64") });
  await frames.send({ type: "ORIGIN_COMPLETE", requestId: request.requestId, snapshot });
}
export async function startOriginalOriginProducerService(input: {
  enrollment: VerifiedEnrollment; signal: AbortSignal; historyOnly?: boolean;
  config?: OriginPublicConfiguration; keyCustodyPath?: string; clockPrivateKeyPath?: string; hooks: OriginalOriginProducerHooks;
}) {
  requireOriginLinuxRoot(); input.signal.throwIfAborted();
  const config = input.config ?? await readOriginPublicConfiguration(); assertOriginConfiguration(input.enrollment, config);
  const qualified = await loadOriginClockQualification(input.enrollment, config), privatePath = input.keyCustodyPath
    ?? process.env.FINNOR_SPECIALIST_ORIGIN_KEY_CUSTODY;
  if (!privatePath || config.endpoints.some(endpoint => endpoint.socketPath !== config.socketPath))
    throw Error("SPECIALIST_ORIGIN_GENUINE_LOCAL_CUSTODY_TOPOLOGY_REQUIRED");
  const custody = originKeyCustodySchema.parse(JSON.parse((await readRootOriginFile(privatePath, 65536, true)).toString("utf8")));
  if (custody.publicConfigurationDigest !== digest(config) || custody.keys.length !== input.enrollment.body.origins.length
    || new Set(custody.keys.map(key => key.originId)).size !== custody.keys.length
    || new Set(custody.keys.map(key => key.privateKeyPath)).size !== custody.keys.length)
    throw Error("SPECIALIST_ORIGIN_ALL_EXISTING_KEYS_REQUIRED");
  const keys = new Map<string, KeyObject>(), identities = new Set<string>();
  for (const stored of custody.keys) {
    const key = await OriginalOriginJournal.existingKey(input.enrollment, stored.originId, stored.privateKeyPath);
    identities.add(createPublicKey(key).export({ type: "spki", format: "der" }).toString("hex")); keys.set(stored.originId, key);
  }
  if (identities.size !== custody.keys.length || input.enrollment.body.origins.some(origin => !keys.has(origin.id)))
    throw Error("SPECIALIST_ORIGIN_DISTINCT_ENROLLED_KEY_CUSTODY_REQUIRED");
  if (!input.historyOnly && !input.clockPrivateKeyPath)
    throw Error("SPECIALIST_ORIGIN_EXISTING_CLOCK_KEY_CUSTODY_REQUIRED");
  if (input.clockPrivateKeyPath) {
    const enrolledClock = input.enrollment.body.clockAuthorityKeys.find(key => key.id === qualified.body.clockAuthorityKeyId),
      actualClock = createPrivateKey(await readRootOriginFile(input.clockPrivateKeyPath, 32768, true));
    if (!enrolledClock || actualClock.asymmetricKeyType !== "ed25519"
      || !createPublicKey(actualClock).export({ type: "spki", format: "der" })
        .equals(createPublicKey(enrolledClock.publicKey).export({ type: "spki", format: "der" })))
      throw Error("SPECIALIST_ORIGIN_EXISTING_ENROLLED_CLOCK_KEY_REQUIRED");
  }
  const privateCustodyPaths = [...new Set([privatePath, ...custody.keys.map(key => key.privateKeyPath),
    ...(input.clockPrivateKeyPath ? [input.clockPrivateKeyPath] : [])])], privatePins = new Map<string, string>();
  for (const path of privateCustodyPaths)
    privatePins.set(path, createHash("sha256").update(await readRootOriginFile(path, 65536, true)).digest("hex"));
  const assertPrivateCustody = async () => {
    for (const [path, expected] of privatePins)
      if (createHash("sha256").update(await readRootOriginFile(path, 65536, true)).digest("hex") !== expected)
        throw Error("SPECIALIST_ORIGIN_PRIVATE_CUSTODY_CHANGED");
  };
  await assertCurrentSourcePins(config, input.signal);
  await assertRootOriginDirectory(config.journalDirectory); await assertRootOriginDirectory(dirname(config.socketPath));
  try { await lstat(config.socketPath); throw Error("SPECIALIST_ORIGIN_EXISTING_ENDPOINT_NOT_REPLACED"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const publications = new Map<string, PublicationOrigins>(), closedPublications = new Map<string, PublicationOrigins>(),
    connections = new Set<Socket>(), starting = new Set<string>();
  const server = createServer(socket => {
    if (connections.size >= MAX_CONNECTIONS || input.signal.aborted) { socket.destroy(); return; }
    connections.add(socket); socket.once("close", () => connections.delete(socket)); socket.pause();
    void (async () => {
      const peer = await readActualOriginPeer(socket, config, input.signal);
      if (peer.uid !== 0 && peer.gid !== config.sourceGid) throw Error("SPECIALIST_ORIGIN_ENDPOINT_PEER_REFUSED");
      const frames = new OriginFrames(socket); let publication: PublicationOrigins | null = null,
        busy = false, failureBusy = false, first = true, count = 0;
      const channel = new AbortController();
      socket.once("close", () => channel.abort(Error("SPECIALIST_ORIGIN_ORIGINAL_CHANNEL_ENDED")));
      frames.onFailure(() => {
        const current = publication;
        if (current) void current.channelClosed().catch(() => undefined).finally(() => {
          const id = current.registration.publicationId;
          if (publications.get(id) === current) publications.delete(id);
          closedPublications.set(id, current);
          if (closedPublications.size > MAX_PUBLICATIONS) closedPublications.delete(closedPublications.keys().next().value!);
        });
      });
      frames.onMessage(raw => {
        if (++count > 8192) { frames.fail("SPECIALIST_ORIGIN_CHANNEL_PROFILE_BOUND"); return; }
        const message = sourceMessageSchema.safeParse(raw);
        if (message.success) {
          const value = message.data;
          if (value.type === "SOURCE_CENSUS") { if (!publication) frames.fail("SPECIALIST_ORIGIN_SOURCE_NOT_REGISTERED"); else publication.acceptCensus(value); return; }
          if (value.type === "SOURCE_EVENT") { if (!publication) frames.fail("SPECIALIST_ORIGIN_SOURCE_NOT_REGISTERED"); else publication.acceptEvent(value); return; }
          if (value.type === "SOURCE_END") { if (!publication) frames.fail("SPECIALIST_ORIGIN_SOURCE_NOT_REGISTERED");
            else void publication.sourceEnd(value).catch(() => frames.fail("SPECIALIST_ORIGIN_SOURCE_END_REFUSED")); return; }
          if (value.type === "SOURCE_DRAINED") { if (!publication) frames.fail("SPECIALIST_ORIGIN_SOURCE_NOT_REGISTERED");
            else void publication.sourceDrained(value).catch(() => frames.fail("SPECIALIST_ORIGIN_SOURCE_DRAIN_REFUSED")); return; }
          const retainedOriginal = publications.get(value.registration.publicationId) ?? closedPublications.get(value.registration.publicationId);
          if (first && !busy && retainedOriginal && peer.uid === config.sourceUid && peer.gid === config.sourceGid
            && retainedOriginal.registration.sourcePid === peer.pid
            && digest(retainedOriginal.registration) === digest(value.registration)) {
            // A definite diagnostic refusal, not socket failure masquerading as
            // a negative. No START, new clock, journal or coverage is invoked.
            first = false; busy = true;
            void (async () => {
              await actualSourceExecutable(socket, peer, config, input.signal);
              await frames.send({ type: "SOURCE_OPEN_REFUSED", requestId: value.requestId,
                publicationId: value.registration.publicationId, registrationDigest: digest(value.registration),
                code: "SPECIALIST_ORIGIN_ORIGINAL_REGISTRATION_REPLAY", newOriginalIssued: false, newCoverageIssued: false });
            })().catch(() => frames.fail("SPECIALIST_ORIGIN_REPLAY_DIAGNOSTIC_UNAVAILABLE")).finally(() => { busy = false; });
            return;
          }
          if (!first || busy || input.historyOnly || publications.size + starting.size >= MAX_PUBLICATIONS
            || publications.has(value.registration.publicationId) || starting.has(value.registration.publicationId)
            || peer.uid !== config.sourceUid) {
            frames.fail("SPECIALIST_ORIGIN_ORIGINAL_REGISTRATION_REPLAY"); return;
          }
          first = false; busy = true; starting.add(value.registration.publicationId);
          void (async () => {
            await actualSourceExecutable(socket, peer, config, input.signal);
            assertActualOriginPeer(peer);
            const remaining = BigInt(value.registration.nativeBootstrap.deadlineMonotonicNanoseconds) - process.hrtime.bigint();
            if (remaining <= 0n || remaining > 60000000000n) throw Error("SPECIALIST_ORIGIN_ORIGINAL_DEADLINE");
            const startSignal = AbortSignal.any([input.signal, channel.signal,
              AbortSignal.timeout(Math.max(1, Number(remaining / 1000000n)))]);
            const started = await input.hooks.onOriginalStart({
              publicationId: value.registration.publicationId, peer, signal: startSignal,
            });
            startSignal.throwIfAborted();
            assertVerifiedOriginalBusinessSource(started.source);
            publication = new PublicationOrigins(input.enrollment, config, qualified, keys, value.registration, peer, frames,
              input.signal, channel.signal, started, input.hooks, privateCustodyPaths, assertPrivateCustody);
            publications.set(value.registration.publicationId, publication); await publication.initialize();
            await frames.send({ type: "SOURCE_READY", requestId: value.requestId, registrationDigest: digest(value.registration) });
          })().catch(() => frames.fail("SPECIALIST_ORIGIN_SOURCE_REGISTRATION_REFUSED")).finally(() => {
            busy = false; starting.delete(value.registration.publicationId);
          });
          return;
        }
        const failedRead = originalFailureReadRequestSchema.safeParse(raw);
        if (failedRead.success) {
          const request = failedRead.data;
          if (failureBusy || request.enrollmentDigest !== input.enrollment.digest
            || publication && publication.registration.publicationId !== request.publicationId) {
            void frames.send({ type: "ORIGINAL_FAILURE_REFUSED", requestId: request.requestId,
              code: "SPECIALIST_ORIGIN_FAILURE_READ_REFUSED" }).catch(() => undefined); return;
          }
          failureBusy = true;
          void (async () => {
            const existing = publication ?? publications.get(request.publicationId) ?? closedPublications.get(request.publicationId);
            let journals: ReadonlyMap<string, OriginalOriginJournal>;
            if (existing) {
              if (existing.registration.originalSourceDigest !== request.originalSourceDigest)
                throw Error("SPECIALIST_ORIGIN_FAILURE_ORIGINAL_MISMATCH");
              journals = await existing.failureJournals();
            } else {
              const archived = new Map<string, OriginalOriginJournal>();
              for (const origin of input.enrollment.body.origins)
                archived.set(origin.id, await OriginalOriginJournal.historical(input.enrollment, origin, request.publicationId, config));
              journals = archived;
            }
            await sendOriginalFailure(frames, request, input.enrollment, journals, keys);
          })().catch(async () => {
            await frames.send({ type: "ORIGINAL_FAILURE_REFUSED", requestId: request.requestId,
              code: "SPECIALIST_ORIGIN_AUTHENTICATED_ORIGINAL_FAULT_UNAVAILABLE" }).catch(() => undefined);
          }).finally(() => { failureBusy = false; });
          return;
        }
        const finalize = originalFinalizeRequestSchema.safeParse(raw);
        if (finalize.success) {
          if (first || busy || !publication || input.historyOnly || finalize.data.enrollmentDigest !== input.enrollment.digest
            || publication.registration.publicationId !== finalize.data.publicationId) {
            frames.fail("SPECIALIST_ORIGIN_FINALIZATION_REFUSED"); return;
          }
          busy = true;
          void (async () => {
            const active = publication;
            if (!active || publications.get(finalize.data.publicationId) !== active)
              throw Error("SPECIALIST_ORIGIN_ORIGINAL_START_HANDLE_ABSENT");
            await active.finalize(peer);
            await frames.send({ type: "ORIGINAL_FINALIZED", requestId: finalize.data.requestId,
              publicationId: finalize.data.publicationId });
          })().catch(async () => { await frames.send({ type: "REFUSED", code: "SPECIALIST_ORIGIN_ORIGINAL_FINALIZATION_UNAVAILABLE" }).catch(() => undefined); })
            .finally(() => { busy = false; });
          return;
        }
        const parsed = collectRequestSchema.safeParse(raw);
        if (!parsed.success || !first || busy || publication) { frames.fail("SPECIALIST_ORIGIN_OPERATION_REFUSED"); return; }
        const request = parsed.data; busy = true;
        void (async () => {
          const origin = input.enrollment.body.origins.find(item => item.id === request.originId);
          if (!origin || request.enrollmentDigest !== input.enrollment.digest) throw Error("SPECIALIST_ORIGIN_NOT_ENROLLED");
          assertQualifiedOriginCollection({ enrollment: input.enrollment, config, qualified, ...request });
          const active = publications.get(request.candidate.publicationId)
            ?? (request.readOnly ? closedPublications.get(request.candidate.publicationId) : undefined);
          let journal: OriginalOriginJournal, live = !request.historical, stillCurrent = () => true;
          if (request.readOnly && active) {
            journal = await active.readOnly(request); live = !journal.sourceEnded;
            stillCurrent = () => active.snapshotReadable();
          } else if (request.historical || request.readOnly) {
            if (active && !await active.archiveReady()) throw Error("SPECIALIST_ORIGIN_ARCHIVE_NOT_CLOSED");
            journal = await OriginalOriginJournal.historical(input.enrollment, origin, request.candidate.publicationId, config);
            const original = await originalOriginAttempt({ enrollment: input.enrollment, config, registration: journal.registration });
            assertCandidateOriginalSource(request.candidate, journal.registration, original);
            live = false;
          } else {
            if (!active || peer.uid !== 0 || peer.pid !== process.pid)
              throw Error("SPECIALIST_ORIGIN_ORIGINAL_COLLECTOR_PROCESS_REQUIRED");
            journal = await active.collect(request);
            stillCurrent = () => active.snapshotLive();
          }
          await sendSnapshot(frames, request, journal, keys.get(origin.id)!, live, stillCurrent);
        })().catch(async () => { await frames.send({ type: "REFUSED", code: "SPECIALIST_ORIGIN_ORIGINAL_COVERAGE_UNAVAILABLE" }).catch(() => undefined); })
          .finally(() => { busy = false; });
      });
      socket.resume();
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(config.socketPath, () => { server.removeListener("error", no); yes(); }); });
  await chown(config.socketPath, 0, config.sourceGid); await chmod(config.socketPath, 0o660);
  let closing: Promise<void> | null = null;
  const close = () => {
    if (!closing) closing = (async () => {
      for (const socket of connections) socket.destroy();
      for (const publication of publications.values()) await publication.channelClosed().catch(() => undefined);
      await new Promise<void>(resolve => server.close(() => resolve()));
    })();
    return closing;
  };
  input.signal.addEventListener("abort", () => { void close(); }, { once: true });
  return { close };
}
