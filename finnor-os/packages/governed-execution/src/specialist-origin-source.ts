/** Source-side hooks run inside the actual original worker and P3 lifetime. */
import { AsyncResource } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { setImmediate as immediate, setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import type { JobExecutionContext } from "../../../apps/worker/src/queue";
import type { CanonicalSpecialistAuthority } from "../../capability-evolution/src/specialist-publication-authority";
import { assertCurrentEnrollment, assertVerifiedEnrollment, type VerifiedEnrollment } from "../../capability-evolution/src/specialist-publication-protocol";
import { digest } from "../../capability-evolution/src/contracts";
import {
  actualJobOrigin, readActualOriginalClaimBounds, withActualOriginalOriginContext,
  type ActualOriginalOriginContext, type OriginalP3Source,
} from "./specialist-origin-context";
import {
  assertOriginConfiguration, sourceRegistrationSchema,
  type SourceRegistration, type OriginCensus, type OriginEventKind, type OriginKind,
} from "./specialist-origin-contract";
import { OriginFrames, connectRootOriginEndpoint, readOriginPublicConfiguration } from "./specialist-origin-custody";
import { censusActualOriginalSources, OriginalSourceObservationFailure, publicOriginalP3 } from "./specialist-origin-observers";
import type { SpecialistExecutionBinding, SpecialistHostReference } from "./specialist-contract";
import { visitOriginalOriginOwningFixture, type ActualOriginalOriginOwningView } from "./specialist-origin-owning-fixture";
import { observeOriginalS8Custody } from "./specialist-origin-s8";
import { OriginalFailureRead, originalFailureResponseSchema, type ActualOriginalFailureEvidence } from "./specialist-origin-failure";

const local = new WeakMap<object, OriginalOriginSource>();
const sourceScopes = new Set<OriginalOriginSource>();
const controlSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SOURCE_READY"), requestId: z.string(), registrationDigest: z.string() }).strict(),
  z.object({ type: z.literal("BARRIER"), requestId: z.string(), challenge: z.string().regex(/^[a-f0-9]{64}$/),
    publicationId: z.string(), throughMonotonicNs: z.string().regex(/^\d+$/), requireCommittedOriginal: z.boolean() }).strict(),
  z.object({ type: z.literal("SOURCE_EVENT_ACK"), sourceSequence: z.string() }).strict(),
  z.object({ type: z.literal("SOURCE_END_ACK"), sourceSequence: z.string() }).strict(),
  z.object({ type: z.literal("SOURCE_DRAINED_ACK"), sourceSequence: z.string() }).strict(),
  z.object({ type: z.literal("ORIGINAL_FINALIZED"), requestId: z.string(), publicationId: z.string() }).strict(),
  z.object({ type: z.literal("ORIGINAL_SOURCE_REVOKED"), publicationId: z.string(), enrollmentDigest: z.string() }).strict(),
  z.object({ type: z.literal("REFUSED"), code: z.string() }).strict(),
]);
type SourceAckKind = "SOURCE_EVENT_ACK" | "SOURCE_END_ACK" | "SOURCE_DRAINED_ACK";
class OriginalOriginSource implements ActualOriginalOriginContext {
  private readonly physical = new AsyncResource("finnor.specialist-native-origins", { requireManualDestroy: true });
  private p3: OriginalP3Source | null = null;
  private registration: SourceRegistration | null = null;
  private authority: CanonicalSpecialistAuthority | null = null;
  private ownsAuthority = false;
  private frames: OriginFrames | null = null;
  private sequence = 0n;
  private serial: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private lastWatermark = process.hrtime.bigint();
  private lastCensus: OriginCensus | null = null;
  private s8Lost = false;
  private s8Monitor: Promise<void> | null = null;
  private listeners: Array<() => void> = [];
  private acknowledgements = new Map<string, { kind: SourceAckKind; yes: () => void; no: (error: Error) => void }>();
  private failureReads = new Map<string, OriginalFailureRead>();
  private ready: { requestId: string; yes: () => void; no: (error: Error) => void } | null = null;
  private finalized = false;
  private finalizationAcknowledged = false;
  private finalization: { requestId: string; yes: () => void; no: (error: Error) => void } | null = null;
  private ended = false;
  private controlSignal: AbortSignal | null = null;
  private readonly controlClosed = new AbortController();
  private combined: AbortSignal;
  constructor(readonly input: {
    execution: Readonly<JobExecutionContext>; controller: AbortController; signal: AbortSignal;
  }) {
    actualJobOrigin(input.execution);
    this.combined = input.signal;
    this.observe(input.controller.signal, "CONTROLLER", "ABORT", "ORIGINAL_CONTROLLER_ABORT");
    this.observe(actualJobOrigin(input.execution).leaseLossSignal, "JOB", "AUTHORITY_LOSS", "ORIGINAL_JOB_LEASE_LOSS");
  }
  private observe(signal: AbortSignal, kind: OriginKind, event: OriginEventKind, reason: string) {
    const callback = () => this.negative(kind, event, reason);
    signal.addEventListener("abort", callback, { once: true });
    this.listeners.push(() => signal.removeEventListener("abort", callback));
    if (signal.aborted) callback();
  }
  private owningView(): ActualOriginalOriginOwningView {
    if (!this.registration || !this.p3 || !this.authority || !this.frames)
      throw Error("SPECIALIST_ORIGIN_OWNING_REQUIRES_ACTUAL_LIVE_SOURCE");
    return Object.freeze({
      registration: this.registration, execution: this.input.execution, p3: this.p3,
      controller: this.input.controller, combined: this.combined, originalSignal: this.input.signal,
      authority: this.authority, sourceSocket: this.frames.socket, lastCensus: this.lastCensus,
      drainNegativeRecords: async () => {
        if (this.failure) throw this.failure;
        if (this.ended) throw Error("SPECIALIST_ORIGIN_LIVE_NEGATIVE_DRAIN_REQUIRED");
        await this.serial;
        if (this.failure) throw this.failure;
        if (this.ended) throw Error("SPECIALIST_ORIGIN_LIVE_NEGATIVE_DRAIN_REQUIRED");
      },
      readActualFailureEvidence: () => this.readActualFailureEvidence(),
    });
  }
  attachP3(source: OriginalP3Source) {
    if (this.p3 || this.registration || source.leases.length !== 3 || source.signal.aborted)
      throw Error("SPECIALIST_ORIGIN_ACTUAL_P3_HANDLE_REQUIRED");
    const keys = source.leases.map(lease => lease.resourceKey);
    if (new Set(keys).size !== 3 || !keys.includes("model:global")
      || keys.filter(key => key.startsWith("model-provider:")).length !== 1
      || keys.filter(key => key.startsWith("model:") && key !== "model:global").length !== 1)
      throw Error("SPECIALIST_ORIGIN_ACTUAL_P3_SET_REQUIRED");
    this.p3 = source;
    this.observe(source.signal, "P3", "AUTHORITY_LOSS", "ORIGINAL_P3_CAPACITY_LOST");
  }
  async p3Exited() {
    if (!this.p3) return;
    await this.probeOriginalS8Loss();
    this.negative("P3", "AUTHORITY_LOSS", "ORIGINAL_P3_SCOPE_ENDED");
    await this.serial;
  }
  private async probeOriginalS8Loss() {
    if (this.s8Lost || !this.registration || !this.authority || !this.controlSignal || this.controlSignal.aborted) return false;
    try {
      await observeOriginalS8Custody({
        authority: this.authority, registration: this.registration, requireCommittedOriginal: false, signal: this.controlSignal,
      });
      return true;
    } catch {
      if (this.s8Lost) return false;
      this.s8Lost = true;
      this.negative("S8_AUTHORITY", "AUTHORITY_LOSS", "ORIGINAL_S8_CUSTODY_LOST", this.lastWatermark);
      if (!this.finalizationAcknowledged && !this.input.controller.signal.aborted)
        this.input.controller.abort(Error("SPECIALIST_ORIGIN_ORIGINAL_S8_LOST"));
      await this.serial; return false;
    }
  }
  private startOriginalS8LossMonitor() {
    if (this.s8Monitor || !this.controlSignal) throw Error("SPECIALIST_ORIGIN_S8_OBSERVER_RESTART");
    this.s8Monitor = this.physical.runInAsyncScope(async () => {
      while (!this.ended && !this.controlSignal!.aborted) {
        // Polling can only record a negative. It never advances a healthy
        // watermark, signs a seal, refreshes a grant, or restarts this observer.
        if (!await this.probeOriginalS8Loss()) return;
        try { await pause(100, undefined, { signal: this.controlSignal! }); } catch { return; }
      }
    });
  }
  private fail(code: string) {
    if (this.failure) return;
    this.failure = Error(code); this.ready?.no(this.failure); this.ready = null;
    this.finalization?.no(this.failure); this.finalization = null;
    for (const read of this.failureReads.values()) read.fail(this.failure);
    for (const value of this.acknowledgements.values()) value.no(this.failure);
    this.acknowledgements.clear();
    if (!this.input.controller.signal.aborted) this.input.controller.abort(this.failure);
  }
  private acknowledgement(sequence: string, kind: SourceAckKind) {
    const pending = new Promise<void>((yes, no) => {
      const signal = this.controlSignal;
      if (this.failure || !signal || signal.aborted) { no(this.failure ?? Error("SPECIALIST_ORIGIN_ORIGINAL_ABORTED")); return; }
      const stop = () => { this.acknowledgements.delete(sequence); no(Error("SPECIALIST_ORIGIN_ORIGINAL_ABORTED")); };
      signal.addEventListener("abort", stop, { once: true });
      this.acknowledgements.set(sequence, {
        kind,
        yes: () => { signal.removeEventListener("abort", stop); yes(); },
        no: error => { signal.removeEventListener("abort", stop); no(error); },
      });
    });
    // Observe rejection during the socket write; the ORIGINAL promise is still awaited.
    void pending.catch(() => undefined); return pending;
  }
  negative(kind: OriginKind, event: OriginEventKind, reason: string, at = process.hrtime.bigint()) {
    const sequence = String(++this.sequence);
    const run = this.serial.then(async () => {
      if (!this.frames || !this.registration) throw Error("SPECIALIST_ORIGIN_FAILURE_BEFORE_REGISTRATION");
      const acknowledged = this.acknowledgement(sequence, "SOURCE_EVENT_ACK");
      await this.frames.send({ type: "SOURCE_EVENT", publicationId: this.registration.publicationId,
        sourceSequence: sequence, originKind: kind, event, atMonotonicNs: String(at), reason });
      await acknowledged;
    });
    this.serial = run.catch(() => { this.fail("SPECIALIST_ORIGIN_NEGATIVE_CUSTODY_LOST"); });
  }
  async activate(input: {
    authority: CanonicalSpecialistAuthority; enrollment: VerifiedEnrollment;
    publicationId: string; originalSourceDigest: string;
    binding: SpecialistExecutionBinding; hostReference: SpecialistHostReference;
    nativeBootstrap: unknown; combined: AbortSignal; leases: OriginalP3Source["leases"];
  }) {
    assertCurrentEnrollment(input.enrollment);
    if (this.registration || this.failure || !this.p3
      || input.authority.enrollment !== input.enrollment
      || digest(publicOriginalP3(this.p3)) !== digest(publicOriginalP3({ ...this.p3, leases: input.leases })))
      throw Error("SPECIALIST_ORIGIN_SAME_ORIGINAL_REQUIRED");
    this.authority = input.authority; this.combined = input.combined;
    this.observe(input.combined, "COMBINED_ABORT", "ABORT", "ORIGINAL_COMBINED_ABORT");
    input.combined.throwIfAborted(); this.input.signal.throwIfAborted();
    const config = await readOriginPublicConfiguration(); assertOriginConfiguration(input.enrollment, config);
    const epoch = await input.authority.readEpoch();
    const registration = sourceRegistrationSchema.parse({
      schema: "finnor.specialist.actual-original-source-registration.v1",
      enrollmentDigest: input.enrollment.digest, publicationId: input.publicationId,
      originalSourceDigest: input.originalSourceDigest, binding: input.binding,
      hostReference: input.hostReference, nativeBootstrap: input.nativeBootstrap, sourcePid: process.pid,
      sourceStartedMonotonicNs: String(this.lastWatermark), p3: publicOriginalP3(this.p3), s8Epoch: epoch.epoch,
      s8HistoryDigest: epoch.historyDigest,
      ...readActualOriginalClaimBounds(this.input.execution, this.p3.leases),
    });
    if (registration.sourcePid !== registration.nativeBootstrap.parentPid
      || registration.binding.job.id !== this.input.execution.jobId
      || registration.binding.job.claimFence !== this.input.execution.claimFence)
      throw Error("SPECIALIST_ORIGIN_ACTUAL_ORIGINAL_PROCESS_REQUIRED");
    this.registration = registration;
    const remaining = BigInt(registration.nativeBootstrap.deadlineMonotonicNanoseconds) - process.hrtime.bigint();
    if (remaining <= 0n || remaining > 60000000000n) throw Error("SPECIALIST_ORIGIN_ORIGINAL_DEADLINE");
    // A transport-only drain may persist the actual abort, but never prolongs
    // the original deadline or replaces the model/controller/combined signals.
    this.controlSignal = AbortSignal.any([this.controlClosed.signal,
      AbortSignal.timeout(Math.max(1, Number(remaining / 1000000n)))]);
    await this.physical.runInAsyncScope(async () => {
      const connected = await connectRootOriginEndpoint(config.socketPath, config, this.controlSignal!);
      this.frames = new OriginFrames(connected.socket);
      this.frames.onFailure(() => this.fail("SPECIALIST_ORIGIN_ROOT_SOURCE_CHANNEL_LOST"));
      this.frames.onMessage(raw => {
        try {
          const failure = originalFailureResponseSchema.safeParse(raw);
          if (failure.success) {
            const read = this.failureReads.get(failure.data.requestId);
            if (!read) throw Error("SPECIALIST_ORIGIN_UNSOLICITED_FAILURE_REPLY");
            read.accept(failure.data); return;
          }
          const message = controlSchema.parse(raw);
          if (message.type === "REFUSED") { this.fail("SPECIALIST_ORIGIN_ROOT_REFUSED"); return; }
          if (message.type === "ORIGINAL_SOURCE_REVOKED") {
            if (message.publicationId !== registration.publicationId || message.enrollmentDigest !== registration.enrollmentDigest)
              throw Error("SPECIALIST_ORIGIN_FOREIGN_ROOT_REVOCATION");
            // The real root ACK ends the original model/witness work. Keep
            // later tail faults without aborting another wire for scope exit.
            if (!this.finalizationAcknowledged && !this.input.controller.signal.aborted)
              this.input.controller.abort(Error("SPECIALIST_ORIGIN_ACTUAL_ROOT_SOURCE_REVOKED"));
            return;
          }
          if (message.type === "SOURCE_READY") {
            if (!this.ready || message.requestId !== this.ready.requestId || message.registrationDigest !== digest(registration))
              throw Error("SPECIALIST_ORIGIN_REGISTRATION_SUBSTITUTED");
            this.ready.yes(); this.ready = null; return;
          }
          if (message.type === "ORIGINAL_FINALIZED") {
            if (!this.finalization || message.requestId !== this.finalization.requestId
              || message.publicationId !== registration.publicationId)
              throw Error("SPECIALIST_ORIGIN_ORIGINAL_FINALIZATION_SUBSTITUTED");
            this.finalizationAcknowledged = true;
            this.finalization.yes(); this.finalization = null; return;
          }
          if (message.type === "SOURCE_EVENT_ACK" || message.type === "SOURCE_END_ACK" || message.type === "SOURCE_DRAINED_ACK") {
            const waiting = this.acknowledgements.get(message.sourceSequence);
            if (!waiting || waiting.kind !== message.type) throw Error("SPECIALIST_ORIGIN_UNSOLICITED_SOURCE_ACK");
            this.acknowledgements.delete(message.sourceSequence); waiting.yes(); return;
          }
          void this.physical.runInAsyncScope(() => this.barrier(message))
            .catch(() => this.fail("SPECIALIST_ORIGIN_AUTHORITATIVE_BARRIER_FAILED"));
        } catch { this.fail("SPECIALIST_ORIGIN_SOURCE_CONTROL_INVALID"); }
      });
      const requestId = randomBytes(32).toString("hex");
      const ready = new Promise<void>((yes, no) => { this.ready = { requestId, yes, no }; });
      await this.frames.send({ type: "SOURCE_OPEN", requestId, registration }); await ready;
      this.startOriginalS8LossMonitor();
      await visitOriginalOriginOwningFixture("SOURCE_READY", () => this.owningView());
    });
    this.input.signal.throwIfAborted();
    if (this.failure) throw this.failure;
    this.ownsAuthority = true;
  }
  private async barrier(message: Extract<z.infer<typeof controlSchema>, { type: "BARRIER" }>) {
    const r = this.registration;
    if (!r || !this.p3 || !this.authority || this.ended || message.publicationId !== r.publicationId)
      throw Error("SPECIALIST_ORIGIN_ORIGINAL_BARRIER_REQUIRED");
    const target = BigInt(message.throughMonotonicNs);
    if (target >= BigInt(r.nativeBootstrap.deadlineMonotonicNanoseconds))
      throw Error("SPECIALIST_ORIGIN_ORIGINAL_DEADLINE");
    while (process.hrtime.bigint() <= target) {
      this.input.signal.throwIfAborted(); await immediate(undefined, { signal: this.input.signal });
    }
    await immediate(undefined, { signal: this.input.signal }); await this.serial;
    try {
      await visitOriginalOriginOwningFixture("BEFORE_SOURCE_CENSUS", () => this.owningView());
      const census = await censusActualOriginalSources({
        registration: r, execution: this.input.execution, p3: this.p3, authority: this.authority,
        controller: this.input.controller.signal, combined: this.combined,
        challenge: message.challenge, sourceSequence: String(this.sequence), signal: this.input.signal,
        requireCommittedOriginal: message.requireCommittedOriginal,
      });
      if (BigInt(census.throughMonotonicNs) <= target) throw Error("SPECIALIST_ORIGIN_BARRIER_WATERMARK");
      this.lastWatermark = BigInt(census.throughMonotonicNs); this.lastCensus = census;
      await this.serial;
      if (census.sourceSequence !== String(this.sequence)) throw Error("SPECIALIST_ORIGIN_EVENT_DURING_BARRIER");
      await this.frames!.send({ type: "SOURCE_CENSUS", requestId: message.requestId, census });
      await visitOriginalOriginOwningFixture("AFTER_SOURCE_CENSUS", () => this.owningView());
    } catch (error) {
      const kind = error instanceof OriginalSourceObservationFailure ? error.kind : "COMBINED_ABORT";
      const event = kind === "CONTROLLER" || kind === "COMBINED_ABORT" ? "ABORT"
        : kind === "SOURCE_RUNTIME_HOST" ? "SOURCE_CHANGE" : "AUTHORITY_LOSS";
      this.negative(kind, event, "ORIGINAL_" + kind + "_CENSUS_FAILED", this.lastWatermark);
      await this.serial; throw error;
    }
  }
  matchesOriginal(enrollment: VerifiedEnrollment, publicationId: string) {
    return this.registration?.publicationId === publicationId && this.registration.enrollmentDigest === enrollment.digest;
  }
  private async readActualFailureEvidence(): Promise<ActualOriginalFailureEvidence> {
    if (!this.registration || !this.authority || !this.frames || this.failure || !this.controlSignal || this.controlSignal.aborted)
      throw Error("SPECIALIST_ORIGIN_EXISTING_SOURCE_FAILURE_CHANNEL_UNAVAILABLE");
    // Observe only losses on the same actual inputs. Discard a healthy result:
    // this read never updates lastWatermark, lastCensus or an authority bound.
    if (this.p3) try {
      await censusActualOriginalSources({
        registration: this.registration, execution: this.input.execution, p3: this.p3, authority: this.authority,
        controller: this.input.controller.signal, combined: this.combined,
        challenge: randomBytes(32).toString("hex"), sourceSequence: String(this.sequence), signal: this.controlSignal,
        requireCommittedOriginal: false,
      });
    } catch (error) {
      if (error instanceof OriginalSourceObservationFailure) {
        const kind = error.kind, event = kind === "CONTROLLER" || kind === "COMBINED_ABORT" ? "ABORT"
          : kind === "SOURCE_RUNTIME_HOST" ? "SOURCE_CHANGE" : "AUTHORITY_LOSS";
        this.negative(kind, event, "ORIGINAL_" + kind + "_NEGATIVE_ONLY_READ_FAILED", this.lastWatermark);
      }
    }
    await this.serial;
    const read = new OriginalFailureRead({
      enrollment: this.authority.enrollment, publicationId: this.registration.publicationId,
      originalSourceDigest: this.registration.originalSourceDigest, signal: this.controlSignal,
      expectedRegistration: this.registration,
    });
    this.failureReads.set(read.requestId, read);
    try { await this.frames.send(read.request()); return await read.result; }
    finally { this.failureReads.delete(read.requestId); }
  }
  async finalize(input: { enrollment: VerifiedEnrollment; publicationId: string; signal: AbortSignal }) {
    assertVerifiedEnrollment(input.enrollment); input.signal.throwIfAborted(); this.input.signal.throwIfAborted();
    this.combined.throwIfAborted();
    if (!this.matchesOriginal(input.enrollment, input.publicationId) || !this.frames || this.failure
      || this.finalized || this.finalization || this.ended) throw Error("SPECIALIST_ORIGIN_SAME_SOURCE_FINALIZATION_REQUIRED");
    this.finalized = true;
    await visitOriginalOriginOwningFixture("BEFORE_ORIGINAL_FINALIZE", () => this.owningView());
    input.signal.throwIfAborted(); this.combined.throwIfAborted();
    const requestId = randomBytes(32).toString("hex"), completed = new Promise<void>((yes, no) => {
      this.finalization = { requestId, yes, no };
    });
    await this.frames.send({ type: "ORIGINAL_FINALIZE", requestId, publicationId: input.publicationId,
      enrollmentDigest: input.enrollment.digest });
    await completed;
    await visitOriginalOriginOwningFixture("AFTER_ORIGINAL_FINALIZE", () => this.owningView());
    input.signal.throwIfAborted(); this.combined.throwIfAborted();
  }
  async close() {
    if (this.ended) return;
    this.ended = true;
    let transportClosedByOwner = false;
    try {
      await this.s8Monitor;
      await this.probeOriginalS8Loss();
      await this.serial;
      if (this.frames && this.registration && !this.failure && this.controlSignal && !this.controlSignal.aborted) {
        const sequence = String(++this.sequence), ack = this.acknowledgement(sequence, "SOURCE_END_ACK");
        await this.frames.send({ type: "SOURCE_END", publicationId: this.registration.publicationId,
          sourceSequence: sequence, atMonotonicNs: String(process.hrtime.bigint()) }); await ack;
        for (;;) {
          const pending = this.serial; await pending;
          if (pending === this.serial) break;
        }
        // Stop actual callbacks only after their negative records are fsynced.
        // The final typed frame, not EOF/absence, authorizes an archive end.
        for (const stop of this.listeners) stop(); this.listeners = [];
        const drained = String(++this.sequence), complete = this.acknowledgement(drained, "SOURCE_DRAINED_ACK");
        await this.frames.send({ type: "SOURCE_DRAINED", publicationId: this.registration.publicationId,
          sourceSequence: drained, atMonotonicNs: String(process.hrtime.bigint()) }); await complete;
        if (this.failure) throw this.failure;
        this.controlSignal.throwIfAborted();
        // Only this actual, fully acknowledged shutdown owns the error-free close.
        // Await it before aborting control so its socket abort listener is detached.
        await this.frames.closeOwnedTransport();
        if (this.failure) throw this.failure;
        this.controlSignal.throwIfAborted(); transportClosedByOwner = true;
      }
    } finally {
      for (const stop of this.listeners) stop();
      this.controlClosed.abort(); if (!transportClosedByOwner) this.frames?.socket.destroy();
      if (this.ownsAuthority) await this.authority?.close();
      this.physical.emitDestroy();
    }
  }
}
/** No new model/job/P3 grant, original lifetime, or observer restart. */
export async function withOriginalSpecialistOriginScope<T>(input: {
  execution: Readonly<JobExecutionContext>; controller: AbortController; signal: AbortSignal;
}, run: () => Promise<T>) {
  const source = new OriginalOriginSource(input);
  if (sourceScopes.has(source)) throw Error("SPECIALIST_ORIGIN_SCOPE_REPLAY");
  sourceScopes.add(source); local.set(input.execution, source);
  try { return await withActualOriginalOriginContext(source, run); }
  finally { try { await source.close(); } finally { sourceScopes.delete(source); local.delete(input.execution); } }
}
export async function activateOriginalSpecialistOrigins(input: Parameters<OriginalOriginSource["activate"]>[0] & {
  execution: Readonly<JobExecutionContext>;
}) {
  const source = local.get(input.execution);
  if (!source) throw Error("SPECIALIST_ORIGIN_ORIGINAL_SCOPE_REQUIRED");
  await source.activate(input);
}
/** The retained owner hook must use the actual SOURCE_OPEN socket, not reconnect. */
export async function finalizeOriginalSourcePublication(input: {
  enrollment: VerifiedEnrollment; publicationId: string; signal: AbortSignal;
}): Promise<void> {
  assertVerifiedEnrollment(input.enrollment);
  const matches = Array.from(sourceScopes).filter(source => source.matchesOriginal(input.enrollment, input.publicationId));
  if (matches.length !== 1) throw Error("SPECIALIST_ORIGIN_SAME_LIVE_SOURCE_SOCKET_REQUIRED");
  await matches[0]!.finalize(input);
}
