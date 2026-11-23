/** Fixed data-only guest and one fenced, bounded IAM model boundary. Dev only. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputeResourceLease } from "../../db/compute-governor";
import { withDatabaseExecutionDeadline } from "../../db/execution-deadline";
import { assertNativeBoundedLLMProvider, resolveProviderForRequest, type LLMUsage } from "../../tools/src/llm";
import { currentWorkforceSpecialistCapability, type WorkforceSpecialistCapability } from "../../capability-evolution/src/specialist-consumer";
import { prepareWorkforceSpecialistHost, readWorkforceSpecialistBootstrap,
  type SpecialistKernelUsage } from "./executor-specialist-linux";
import { canonical } from "./protocol";
import { acquireAdmittedSpecialistIamSession, admittedSpecialistIamSessionEvidence,
  assertAdmittedSpecialistIamSessionCurrent, disposeAdmittedSpecialistIamSession,
  type SpecialistIamSessionLease } from "./specialist-iam-session";
import { SPECIALIST_HOST_LIMITS, SPECIALIST_QUALIFICATION_DOMAIN, renderSpecialistInput,
  specialistByteDigest, specialistDigest, specialistExecutionBindingSchema, specialistKernelDeliverySchema,
  specialistKernelRequestSchema, specialistModelIdentitySchema, specialistNativeKernelScript,
  type SpecialistComputation, type SpecialistExecutionBinding, type SpecialistHostReference } from "./specialist-contract";

export interface WorkforceSpecialistRequest {
  binding: SpecialistExecutionBinding; computation: SpecialistComputation;
  task: { deliverable: string; dataScopes: readonly string[]; purposes: readonly string[] };
  rightsRef: string; admission: WorkforceSpecialistCapability; signal: AbortSignal;
  onPrepared(reference: SpecialistHostReference): Promise<void>;
  beforeInvocation(context: { signal: AbortSignal; leases: readonly ComputeResourceLease[];
    hostReference: SpecialistHostReference; nativeBootstrap: unknown }): Promise<void>;
  onOriginalDelivery(context: { result: WorkforceSpecialistResult; signal: AbortSignal }): Promise<void>;
}
export interface WorkforceSpecialistResult {
  value: Record<string, unknown> | null; successful: boolean; errorCode: string | null;
  exitCode: number | null; signal: string | null; elapsedMs: number; possibleModelCall: boolean;
  modelResponseReceived: boolean; modelUsage: LLMUsage | null; kernelUsage: SpecialistKernelUsage | null;
  provenance: Record<string, unknown>;
}
let active = 0;
const safeCode = (error: unknown) => error instanceof Error && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.message)
  ? error.message : "SPECIALIST_PHYSICAL_ATTEMPT_FAILED_OR_UNKNOWN";

export async function launchWorkforceSpecialistExecutor(request: WorkforceSpecialistRequest): Promise<WorkforceSpecialistResult> {
  const binding = specialistExecutionBindingSchema.parse(request.binding);
  if (process.env.FINNOR_ENVIRONMENT === "production") throw Error("SPECIALIST_DEV_PROFILE_NOT_PRODUCTION_ADMISSION");
  request.signal.throwIfAborted();
  if (specialistDigest(request.computation) !== binding.computationDigest
    || specialistDigest(request.computation.context) !== binding.contextDigest
    || !sameCapability(binding, request.admission))
    throw Error("SPECIALIST_EXECUTOR_CONTRACT_SUBSTITUTION");
  const input = renderSpecialistInput(request.computation, request.task);
  for (const [name, value] of Object.entries(request.computation.limits))
    if (value > request.admission.limits[name as keyof typeof request.admission.limits])
      throw Error("SPECIALIST_ADMITTED_ENVELOPE_EXCEEDED");
  const deadlineAt = Date.parse(binding.effectiveDeadline);
  if (!Number.isFinite(deadlineAt) || deadlineAt - Date.now() < 100
    || deadlineAt - Date.now() > request.computation.limits.wallTimeMs)
    throw Error("SPECIALIST_ORIGINAL_ATTEMPT_DEADLINE_INVALID");
  if (active >= 2) throw Error("SPECIALIST_EXECUTOR_CONCURRENCY_LIMIT");
  active++;
  const physicalLoss = new AbortController(), capacityDisposers: (() => void)[] = [];
  const nativeDeadlineNanoseconds = process.hrtime.bigint() + BigInt(Math.max(1, deadlineAt - Date.now())) * 1000000n;
  const started = performance.now(), signal = AbortSignal.any([request.signal, physicalLoss.signal,
    AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()))]);
  let scratch: string | undefined, host: Awaited<ReturnType<typeof prepareWorkforceSpecialistHost>> | undefined;
  let child: ChildProcess | undefined, bootstrap: unknown = null;
  let possibleModelCall = false, modelResponseReceived = false, modelUsage: LLMUsage | null = null;
  let value: Record<string, unknown> | null = null, errorCode: string | null = null;
  let finished: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
  let exited: Promise<typeof finished> | undefined, outputBytes = 0, outputDigest: string | null = null;
  let kernelUsage: SpecialistKernelUsage | null = null;
  let originalReleaseSent = false, cleanupStarted = false;
  let stopCurrentnessMonitor: (() => void) | undefined, currentnessObservations = 0;
  let iamSession: SpecialistIamSessionLease | undefined;
  let iamSessionEvidence: ReturnType<typeof admittedSpecialistIamSessionEvidence> | null = null;
  const snapshot = (publicationPhase: "LIVE_ORIGINAL_CANDIDATE" | "FINAL_PHYSICAL_OBSERVATION"): WorkforceSpecialistResult => ({
    value, successful: errorCode === null && value !== null, errorCode,
    exitCode: finished.code, signal: finished.signal, elapsedMs: performance.now() - started,
    possibleModelCall, modelResponseReceived, modelUsage: modelUsage && { ...modelUsage },
    kernelUsage: kernelUsage && { ...kernelUsage, meterGaps: [...kernelUsage.meterGaps] },
    provenance: { schema: "finnor.s6.workforce-specialist-provenance.v1", bindingDigest: specialistDigest(binding),
      qualificationDomain: SPECIALIST_QUALIFICATION_DOMAIN, productionActive: false,
      modelIdentity: binding.modelIdentity, methodRef: binding.methodRef, admissionRef: binding.admissionRef,
      iamSession: iamSessionEvidence, publicationPhase,
      physicalLifetimeClosed: publicationPhase === "FINAL_PHYSICAL_OBSERVATION" && kernelUsage?.stopped === true,
      inputDigest: input.inputDigest, inputBytes: input.inputBytes, outputDigest, outputBytes,
      modelResponseReceived, scratchRetained: !!scratch && !!child && kernelUsage?.stopped !== true,
      currentnessObservations, currentnessMonitor: { intervalMs: 250, observationBudgetMs: 2000,
        coverage: "S8_CURRENT_HOST_EXISTING_IAM_SOURCE_AND_ORIGINAL_LIVE_GUEST_MEMBERSHIP" },
      physicalSlotReleased: !child || kernelUsage?.stopped === true,
      scriptDigest: specialistByteDigest(specialistNativeKernelScript), hostReference: host?.reference ?? null,
      mechanism: host?.mechanism ?? null, nativeBootstrap: bootstrap,
      originalDeadline: binding.originalDeadline, effectiveDeadline: binding.effectiveDeadline,
      authority: "NONE_OUTPUT_UNTRUSTED", independentCriterionReceivedByProducer: false,
      monetaryCost: null, pricebookRef: null, productionAdmission: "UNADMITTED" },
  });
  const kill = () => {
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  };
  const abort = () => {
    try { kill(); } catch { errorCode ??= "SPECIALIST_PROCESS_STOP_UNKNOWN"; }
    if (host) void host.stop().catch(() => { errorCode ??= "SPECIALIST_CGROUP_STOP_UNKNOWN"; });
  };
  const whileOwned = async <T>(operation: Promise<T>): Promise<T> => {
    let listener: (() => void) | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        listener = () => reject(Error("SPECIALIST_PHYSICAL_LIFETIME_ENDED"));
        signal.addEventListener("abort", listener, { once: true });
        if (signal.aborted) listener();
      })]);
    } finally { if (listener) signal.removeEventListener("abort", listener); }
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    scratch = await realpath(await mkdtemp(join(tmpdir(), "finnor-specialist-")));
    await writeFile(join(scratch, "worker.mjs"), specialistNativeKernelScript, { flag: "wx", mode: 0o400 });
    const wallTimeMs = Math.min(request.computation.limits.wallTimeMs, deadlineAt - Date.now());
    host = await prepareWorkforceSpecialistHost(scratch, await realpath(process.execPath), binding, wallTimeMs, nativeDeadlineNanoseconds);
    if (specialistDigest(host.mechanism) !== binding.mechanismDigest)
      throw Error("SPECIALIST_EXECUTOR_MECHANISM_SUBSTITUTION");
    const scope = () => ({ tenantId: binding.tenantId, principalId: binding.principalId, rightsRef: request.rightsRef,
      spendBudgetRef: binding.budgetRef, methodRef: binding.methodRef, admissionRef: binding.admissionRef,
      modelIdentity: binding.modelIdentity, mechanism: host!.mechanism, deadlineAt, signal });
    await currentWorkforceSpecialistCapability(scope(), request.admission);
    await request.onPrepared(host.reference);
    await host.assertCurrent(); signal.throwIfAborted();
    iamSession = await whileOwned(acquireAdmittedSpecialistIamSession(binding, request.admission, signal));
    iamSessionEvidence = admittedSpecialistIamSessionEvidence(iamSession);
    signal.throwIfAborted();
    child = spawn(host.command, host.args, { cwd: scratch, detached: true,
      env: { HOME: scratch, TMPDIR: scratch, LANG: "C", TZ: "UTC", NODE_ENV: "production" },
      stdio: ["pipe", "pipe", "pipe", host.fd.fd, host.bootstrapFd.fd, host.cgroupFd] });
    exited = new Promise((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", (code, signal) => {
        if (!originalReleaseSent && !cleanupStarted)
          physicalLoss.abort(Error("SPECIALIST_ORIGINAL_GUEST_OR_GUARDIAN_EXITED_BEFORE_RELEASE"));
        resolve({ code, signal });
      });
    });
    // Observe rejection immediately even while the protocol waits for a request.
    void exited.catch(() => undefined);
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    let deliveryResolve!: () => void, deliveryReject!: (error: Error) => void;
    const delivery = new Promise<void>((resolve, reject) => { deliveryResolve = resolve; deliveryReject = reject; });
    void delivery.catch(() => undefined);
    let phase: "INPUT" | "REQUESTED" | "RESPONSE_SENT" | "DELIVERED" = "INPUT", pending = "";
    const delivered = () => phase === "DELIVERED";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const failProtocol = (code: string) => {
      errorCode ??= code; readyReject(Error(code)); deliveryReject(Error(code)); physicalLoss.abort(Error(code));
    };
    const consume = (channel: "stdout" | "stderr", chunk: Buffer) => {
      if (chunk.length > SPECIALIST_HOST_LIMITS.outputBytes - outputBytes) {
        failProtocol("SPECIALIST_GUEST_OUTPUT_BOUND"); return;
      }
      outputBytes += chunk.length;
      if (channel === "stderr") return;
      try { pending += decoder.decode(chunk, { stream: true }); }
      catch { failProtocol("SPECIALIST_KERNEL_OUTPUT_UTF8_INVALID"); return; }
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) return;
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (phase === "INPUT") {
            const parsed = specialistKernelRequestSchema.parse(message);
            if (parsed.inputDigest !== input.inputDigest) throw Error("SPECIALIST_KERNEL_INPUT_SUBSTITUTION");
            phase = "REQUESTED"; readyResolve();
          } else if (phase === "RESPONSE_SENT") {
            value = specialistKernelDeliverySchema.parse(message).value;
            outputDigest = specialistDigest(value); phase = "DELIVERED"; deliveryResolve();
          } else throw Error("SPECIALIST_KERNEL_PROTOCOL_REPLAY");
        } catch { failProtocol("SPECIALIST_KERNEL_PROTOCOL_INVALID"); return; }
      }
    };
    child.stdout!.on("data", (chunk: Buffer) => consume("stdout", chunk));
    child.stderr!.on("data", (chunk: Buffer) => consume("stderr", chunk));
    child.stdin!.on("error", () => { if (!signal.aborted) failProtocol("SPECIALIST_KERNEL_INPUT_CLOSED"); });
    child.stdin!.write(canonical({ schema: "finnor.s6.specialist-kernel-input.v1", inputDigest: input.inputDigest,
      system: input.system, user: input.user, maxResponseBytes: request.computation.limits.maxResponseBytes }) + "\n");
    await whileOwned(Promise.race([ready, exited.then(() => { throw Error("SPECIALIST_GUEST_EXITED_BEFORE_MODEL_REQUEST"); })]));
    signal.throwIfAborted();
    const native = await readWorkforceSpecialistBootstrap(host.bootstrapPath, {
      guardianPid: child.pid, reference: host.reference, filterSha256: host.mechanism.filterSha256, wallTimeMs,
      deadlineMonotonicNanoseconds: String(nativeDeadlineNanoseconds) });
    bootstrap = native;
    await host.assertMembership(native.guardianPid, native.guestPid);
    let monitoring = true, currentnessPending: Promise<void> | undefined;
    let observationTimer: ReturnType<typeof setTimeout> | undefined;
    const monitorStopped = new AbortController(), holdingOriginal = () => !originalReleaseSent;
    const monitorTimer = setInterval(() => {
      if (!monitoring || currentnessPending || signal.aborted) return;
      const budgetMs = Math.max(1, Math.min(2000, deadlineAt - Date.now()));
      const monitorSignal = AbortSignal.any([signal, monitorStopped.signal, AbortSignal.timeout(budgetMs)]);
      observationTimer = setTimeout(() => {
        if (monitoring) physicalLoss.abort(Error("SPECIALIST_CURRENT_ADMISSION_OR_HOST_UNOBSERVABLE"));
      }, budgetMs);
      currentnessPending = (async () => {
        if (holdingOriginal()) {
          try { await host!.assertMembership(native.guardianPid, native.guestPid); }
          catch (error) {
            if (holdingOriginal() || !(error instanceof Error) || error.message !== "SPECIALIST_KERNEL_MEMBERSHIP_CHANGED")
              throw error;
          }
        } else await host!.assertCurrent();
        await assertAdmittedSpecialistIamSessionCurrent(iamSession!, monitorSignal);
        await currentWorkforceSpecialistCapability({ ...scope(), signal: monitorSignal }, request.admission);
        monitorSignal.throwIfAborted(); currentnessObservations++;
      })().catch(() => {
        if (monitoring) physicalLoss.abort(Error("SPECIALIST_CURRENT_ADMISSION_OR_HOST_LOST"));
      }).finally(() => { clearTimeout(observationTimer); currentnessPending = undefined; });
    }, 250);
    stopCurrentnessMonitor = () => {
      monitoring = false; clearInterval(monitorTimer); clearTimeout(observationTimer);
      monitorStopped.abort(Error("SPECIALIST_CURRENTNESS_MONITOR_STOPPED"));
    };
    const provider = resolveProviderForRequest({ provider: binding.modelIdentity.name, purpose: "answer",
      channel: "background", deadlineAt, signal });
    const actual = assertNativeBoundedLLMProvider(provider);
    if (actual.transport !== "bedrock-converse") throw Error("SPECIALIST_NATIVE_IAM_PROVIDER_REQUIRED");
    const modelIdentity = specialistModelIdentitySchema.parse({ ...actual, modelArn: binding.modelIdentity.modelArn });
    if (specialistDigest(modelIdentity) !== specialistDigest(binding.modelIdentity))
      throw Error("SPECIALIST_ACTUAL_MODEL_IDENTITY_CHANGED");
    let wireCount = 0, responseCount = 0;
    const text = await whileOwned(withDatabaseExecutionDeadline(performance.now() + Math.max(1, deadlineAt - Date.now()),
      () => provider.complete({ system: input.system, user: input.user, json: true,
        model: binding.modelIdentity.model, tenantId: binding.tenantId, purpose: "answer", channel: "background",
        deadlineAt, signal, maxOutputTokens: request.computation.limits.maxOutputTokens,
        maxResponseBytes: request.computation.limits.maxResponseBytes, requireGovernance: true,
        specialistIamSession: iamSession,
        onBoundedUsage: usage => {
          if (modelResponseReceived) throw Error("SPECIALIST_NATIVE_USAGE_RECEIPT_REPLAY");
          modelUsage = { ...usage }; modelResponseReceived = true;
          if (usage.model !== binding.modelIdentity.model) throw Error("SPECIALIST_NATIVE_USAGE_MODEL_CHANGED");
        },
        onBoundedResponse: async boundary => {
          boundary.signal.throwIfAborted(); signal.throwIfAborted();
          if (++responseCount !== 1 || wireCount !== 1 || !modelResponseReceived
            || specialistDigest(boundary.usage) !== specialistDigest(modelUsage)
            || Buffer.byteLength(boundary.text) > request.computation.limits.maxResponseBytes)
            throw Error("SPECIALIST_NATIVE_MODEL_BOUNDARY_INVALID");
          phase = "RESPONSE_SENT";
          child!.stdin!.write(canonical({ kind: "MODEL_RESULT", inputDigest: input.inputDigest, text: boundary.text }) + "\n");
          await whileOwned(Promise.race([delivery, exited!.then(() => {
            throw Error("SPECIALIST_GUEST_EXITED_BEFORE_ORIGINAL_DELIVERY");
          })]));
          if (errorCode || !delivered() || pending.length !== 0 || value === null)
            throw Error(errorCode ?? "SPECIALIST_GUEST_DELIVERY_NOT_OBSERVED");
          await host!.assertMembership(native.guardianPid, native.guestPid);
          kernelUsage = await host!.observe();
          if (kernelUsage.stopped || kernelUsage.memoryOomKills !== "0")
            throw Error("SPECIALIST_LIVE_ORIGINAL_KERNEL_INTERVAL_LOST");
          kernelUsage.meterGaps = [...kernelUsage.meterGaps, "ORIGINAL_PHYSICAL_LIFETIME_NOT_CLOSED"];
          boundary.signal.throwIfAborted(); signal.throwIfAborted();
          // The original guest waits on stdin. The governed provider still owns
          // the same P3 permits; no new timer, lease or model request is created.
          await request.onOriginalDelivery({ result: snapshot("LIVE_ORIGINAL_CANDIDATE"), signal: boundary.signal });
          await host!.assertMembership(native.guardianPid, native.guestPid);
          boundary.signal.throwIfAborted(); signal.throwIfAborted();
          originalReleaseSent = true;
          child!.stdin!.end(canonical({ kind: "RELEASE", inputDigest: input.inputDigest }) + "\n");
          finished = await whileOwned(exited!);
          pending += decoder.decode();
          if (errorCode || finished.code !== 0 || pending.length !== 0)
            throw Error(errorCode ?? "SPECIALIST_GUEST_RELEASE_NOT_OBSERVED");
        },
        beforeInvocation: async boundary => {
          if (++wireCount !== 1) throw Error("SPECIALIST_MODEL_BOUNDARY_REPLAY");
          boundary.signal.throwIfAborted();
          const capacityLost = () => physicalLoss.abort(Error("SPECIALIST_P3_OR_MODEL_LIFETIME_LOST"));
          boundary.signal.addEventListener("abort", capacityLost, { once: true });
          capacityDisposers.push(() => boundary.signal.removeEventListener("abort", capacityLost));
          if (boundary.signal.aborted) capacityLost();
          boundary.signal.throwIfAborted();
          await host!.assertMembership(native.guardianPid, native.guestPid);
          await currentWorkforceSpecialistCapability({ ...scope(), signal: boundary.signal }, request.admission);
          // Set before awaiting the durable callback: ambiguous commit is UNKNOWN,
          // never a refunded permit or an automatic second model invocation.
          possibleModelCall = true;
          await request.beforeInvocation({ ...boundary, hostReference: host!.reference, nativeBootstrap: native });
          await host!.assertControls(); boundary.signal.throwIfAborted();
        } })));
    signal.throwIfAborted();
    if (wireCount !== 1 || responseCount !== 1 || !modelResponseReceived || !originalReleaseSent
      || Buffer.byteLength(text) > request.computation.limits.maxResponseBytes)
      throw Error("SPECIALIST_NATIVE_MODEL_BOUNDARY_INVALID");
    signal.throwIfAborted();
  } catch (error) {
    errorCode ??= signal.aborted ? "SPECIALIST_ORIGINAL_LIFETIME_OR_LEASE_LOST" : safeCode(error);
    value = null;
  } finally {
    cleanupStarted = true;
    stopCurrentnessMonitor?.();
    if (iamSession) disposeAdmittedSpecialistIamSession(iamSession);
    abort();
    if (host) {
      try { kernelUsage = await host.cleanup(); }
      catch { kernelUsage = { ...host.usage }; errorCode ??= "SPECIALIST_KERNEL_CLEANUP_OR_METER_UNKNOWN"; value = null; }
    }
    if (exited) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        finished = await Promise.race([exited, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error("SPECIALIST_CHILD_CLOSE_NOT_OBSERVED")), 1000);
        })]);
      } catch { errorCode ??= "SPECIALIST_CHILD_LAUNCH_OR_STOP_UNKNOWN"; value = null; }
      finally { clearTimeout(timer); }
    }
    if (scratch && (!child || kernelUsage?.stopped === true)) {
      try { await rm(scratch, { recursive: true, force: true }); }
      catch { errorCode ??= "SPECIALIST_OWNED_SCRATCH_CLEANUP_FAILED"; value = null; }
    }
    signal.removeEventListener("abort", abort);
    capacityDisposers.forEach(dispose => dispose());
    // An unproven physical stop keeps its local slot occupied. Repeated
    // assignments cannot accumulate an unbounded set of orphaned groups.
    if (!child || kernelUsage?.stopped === true) active--;
  }
  return snapshot("FINAL_PHYSICAL_OBSERVATION");
}

function sameCapability(binding: SpecialistExecutionBinding, admission: WorkforceSpecialistCapability) {
  return specialistDigest(binding.methodRef) === specialistDigest(admission.revisionRef)
    && specialistDigest(binding.admissionRef) === specialistDigest(admission.admissionRef)
    && specialistDigest(binding.budgetRef) === specialistDigest(admission.spendBudgetRef)
    && specialistDigest(binding.modelIdentity) === specialistDigest(admission.modelIdentity)
    && binding.mechanismDigest === specialistDigest(admission.mechanism)
    && binding.sourceClosureDigest === admission.sourceClosureDigest && binding.runtimeDigest === admission.runtimeDigest;
}
