/** Z3 ViabilityStrategy native worker.
 *
 * Owned leaf. One bounded physical delivery: verify the real durable job
 * lease, adopt the session claim fence, run the pinned producer bundle as a
 * child process, run the independent Python checker as a separate child
 * process, then publish candidate, observation and result through the fenced
 * store boundaries. The handler is reconcilable: any fault is recorded
 * against the session and rethrown for queue quarantine; only an explicit
 * viability-recover starts a new delivery, which resumes from durable
 * preimages. Z3 owns no external effect, so recovery never replays one.
 */
import { PROFILE, type Candidate, type CheckReceipt } from "../../../../epistemic-runtime/src/project-z/z3-viability/contracts";
import { canonicalApplicationActor } from "../../application-semantics/store";
import type { JobExecutionContext } from "../../../../../apps/worker/src/queue";
import { JobPayloadSchema, Z3NativeFault, Z3_PRODUCE_JOB, Z3_RECOVER_JOB,
  candidateDigestOf, parseBinding, parseStoredCandidate, parseStoredReceipt, receiptDigestOf, z3Fault,
  type ViabilityBoundaryPoint, type ViabilityClaim, type ViabilityDelivery } from "./contracts";
import { adoptViabilityClaim, assertViabilityJobLease, checkpointViability,
  publishViabilityCandidate, publishViabilityObservation, publishViabilityResult,
  recordViabilityFault, viabilitySession, withViabilityClaim, Z3_TERMINAL_STATUSES,
  type ViabilityMeters } from "./store";
import { viabilityRuntimeIdentity } from "./runtime";
import { runViabilityChild, Z3ChildFault, type ViabilityChildObservation } from "./process";

/** The solver enforces its own internal deadline/operation budget; these are
 * the hard outer wall caps for a stuck child process, never semantic limits. */
const PRODUCER_WALL_MS = 30_000;
const CHECKER_WALL_MS = 300_000;

const PROOF_POINTS: readonly string[] = ["CLAIM", "STRATEGY", "OBSERVATION"];

/** Disposable physical-recovery proof hook. Inert unless the environment
 * carries an explicit fault point; a fault point without the disposable flag,
 * an unknown point, or an authorized-source digest different from the loaded
 * runtime source fails closed instead of running uninstrumented. After the
 * named durable boundary commits, the delivery announces it over IPC and
 * holds for the harness's physical kill; a missing kill within two minutes is
 * itself a failed proof, never a silent completion. */
async function disposableRecoveryBoundary(point: ViabilityBoundaryPoint, sessionId: string,
  sessionFence: number, signal: AbortSignal): Promise<void> {
  const requested = (process.env.FINNOR_Z3_FAULT_POINT ?? "").trim();
  if (!requested) return;
  if (process.env.FINNOR_Z3_DISPOSABLE_RECOVERY !== "1" || !PROOF_POINTS.includes(requested)) {
    z3Fault("Z3_RECOVERY_PROOF_CONFIGURATION");
  }
  if (requested !== point) return;
  const code = await viabilityRuntimeIdentity();
  if ((process.env.FINNOR_Z3_AUTHORIZED_SOURCE ?? "").trim() !== code.digest) {
    z3Fault("Z3_RECOVERY_PROOF_SOURCE_MISMATCH");
  }
  if (typeof process.send !== "function") z3Fault("Z3_RECOVERY_PROOF_IPC_REQUIRED");
  process.send({ kind: "Z3_DURABLE_BOUNDARY", point, sessionId, claimFence: sessionFence, pid: process.pid }, () => undefined);
  await new Promise<never>((_resolve, reject) => {
    const finish = (error: unknown) => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(error); };
    const abort = () => finish(signal.reason ?? new Z3NativeFault("Z3_DELIVERY_ABORTED"));
    const timer = setTimeout(() => finish(new Z3NativeFault("Z3_RECOVERY_PROOF_NOT_TERMINATED")), 120_000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

async function drive(payloadRaw: Record<string, unknown>, actual: Readonly<JobExecutionContext> | undefined,
  type: ViabilityDelivery["jobType"]): Promise<void> {
  let input;
  try { input = JobPayloadSchema.parse(payloadRaw); } catch { z3Fault("Z3_JOB_PAYLOAD_INVALID"); }
  const jobFence = Number(actual?.claimFence);
  if (!actual || actual.tenantId !== input.tenantId || actual.protocolVersion !== 1
    || actual.retrySafety !== "reconcilable" || typeof actual.registerHeartbeat !== "function"
    || !Number.isSafeInteger(jobFence) || jobFence < 1) {
    z3Fault("Z3_ACTUAL_DURABLE_JOB_CONTEXT_REQUIRED");
  }
  const physical = Object.freeze({ ...actual, claimFence: jobFence });
  const delivery: ViabilityDelivery = Object.freeze({ physical, jobType: type });
  const ctx = await canonicalApplicationActor(input.tenantId, input.principalId);
  const first = await viabilitySession(ctx, input.sessionId);
  if (first.work_id !== input.workId) z3Fault("Z3_JOB_PAYLOAD_INVALID");
  if (Z3_TERMINAL_STATUSES.includes(first.status) && !(type === Z3_RECOVER_JOB && first.status === "VIABLE" && first.s4_consumed)) return;
  const started = performance.now();
  const usage = process.resourceUsage();
  let claim: ViabilityClaim = Object.freeze({ ...delivery, sessionFence: 0 });
  let current = first, adopted = false, finished = false;
  const children: ViabilityChildObservation[] = [];
  const controller = new AbortController();
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  const observeLease = async () => {
    const startedAt = performance.now();
    const lease = await assertViabilityJobLease(ctx, current, delivery);
    if (leaseTimer) clearTimeout(leaseTimer);
    // Subtract the whole round trip, conservatively. This timer still kills a
    // child if an owner/currentness guard blocks behind a database lock.
    const remaining = Math.floor(lease.leaseRemainingMs - (performance.now() - startedAt));
    if (remaining < 1) z3Fault("Z3_ACTUAL_DURABLE_DELIVERY_EXPIRED_OR_CHANGED");
    leaseTimer = setTimeout(() => controller.abort(new Z3NativeFault("Z3_DELIVERY_LEASE_EXPIRED")),
      Math.min(2_147_483_647, remaining));
  };
  const deadline = Date.parse(parseBinding(first.binding).deadlineAt);
  const deadlineTimer = setTimeout(() => controller.abort(new Z3NativeFault("Z3_DEADLINE_EXHAUSTED")),
    Math.max(1, Math.min(2_147_483_647, deadline - Date.now())));
  const interrupted = () => controller.abort(new Z3NativeFault("Z3_WORKER_INTERRUPTED"));
  process.once("SIGTERM", interrupted);
  process.once("SIGINT", interrupted);
  const assertNotAborted = () => {
    if (controller.signal.aborted) throw controller.signal.reason ?? new Z3NativeFault("Z3_DELIVERY_ABORTED");
  };
  let guarding: Promise<boolean> | null = null;
  const guard = (): Promise<boolean> => {
    if (finished) return Promise.resolve(true);
    if (controller.signal.aborted) return Promise.resolve(false);
    guarding ??= (async () => {
      try {
        await observeLease();
        if (adopted) await withViabilityClaim(ctx, current, claim, async () => undefined);
        return true;
      } catch (error) { controller.abort(error); return false; }
    })().finally(() => { guarding = null; });
    return guarding;
  };
  // Queue renewal does not invoke callbacks after it loses the lease, hence
  // this independent bounded guard is necessary as well as registerHeartbeat.
  actual.registerHeartbeat(guard);
  const guardTimer = setInterval(() => { void guard(); }, 1000);
  const meters = (): ViabilityMeters => {
    const after = process.resourceUsage();
    return { wallMs: Math.round(performance.now() - started),
      userCpuMicros: after.userCPUTime - usage.userCPUTime,
      systemCpuMicros: after.systemCPUTime - usage.systemCPUTime,
      processMaxRss: after.maxRSS, children: [...children],
      meterBasis: "WORKER_PROCESS_DELTA_NOT_ISOLATED_CHILD_CPU", childCpuMicros: null, childMaxRss: null };
  };
  const wall = (cap: number) => {
    assertNotAborted();
    const remaining = Math.min(cap, Math.floor(deadline - Date.now()));
    if (remaining < 1) z3Fault("Z3_DEADLINE_EXHAUSTED");
    return remaining;
  };
  const boundary = async (point: ViabilityBoundaryPoint) => {
    assertNotAborted();
    await checkpointViability(ctx, current, point, claim);
    await disposableRecoveryBoundary(point, current.id, claim.sessionFence, controller.signal);
    assertNotAborted();
  };
  try {
    await observeLease();
    const runtime = await viabilityRuntimeIdentity(), toolchain = runtime.toolchain;
    if (runtime.digest !== parseBinding(first.binding).codeDigest) z3Fault("Z3_RUNTIME_SOURCE_CHANGED");
    assertNotAborted();
    current = await adoptViabilityClaim(ctx, first, delivery);
    claim = Object.freeze({ ...delivery, sessionFence: Number(current.active_claim_fence) });
    adopted = true;
    await boundary("CLAIM");
    let candidate: Candidate;
    if (current.candidate === null) {
      await toolchain.revalidate();
      const remaining = wall(PRODUCER_WALL_MS);
      const produced = await runViabilityChild({
        command: process.execPath, args: ["--max-old-space-size=512", "--input-type=module", "--eval", toolchain.producer.source, "z3-cli", "produce-batch"],
        inputLine: JSON.stringify({ arena: current.arena, binding: current.binding,
          limits: { deadlineMs: Math.min(PROFILE.deadlineMs, remaining) } }) + "\n",
        wallMs: remaining, signal: controller.signal,
      });
      children.push(produced.observation);
      assertNotAborted();
      candidate = parseStoredCandidate(produced.value);
      current = await publishViabilityCandidate(ctx, current, claim, candidate);
    } else {
      candidate = parseStoredCandidate(current.candidate);
      if (candidateDigestOf(candidate) !== current.candidate_digest) z3Fault("Z3_CANDIDATE_PREIMAGE_INVALID");
    }
    await toolchain.revalidate();
    await boundary("STRATEGY");
    let receipt: CheckReceipt;
    if (current.check_receipt === null) {
      const observed = await runViabilityChild({
        command: toolchain.pythonExecutable, args: ["-I", "-c", toolchain.checker.source, "--batch"],
        inputLine: JSON.stringify({ arena: current.arena, binding: current.binding, candidate }) + "\n",
        wallMs: wall(CHECKER_WALL_MS), signal: controller.signal,
      });
      children.push(observed.observation);
      assertNotAborted();
      receipt = parseStoredReceipt(observed.value);
      current = await publishViabilityObservation(ctx, current, claim, receipt);
    } else {
      receipt = parseStoredReceipt(current.check_receipt);
      if (receiptDigestOf(receipt) !== current.check_digest) z3Fault("Z3_CHECK_PREIMAGE_INVALID");
    }
    await toolchain.revalidate();
    await boundary("OBSERVATION");
    assertNotAborted();
    await publishViabilityResult(ctx, current, claim, candidate, receipt, meters(), toolchain.identity);
  } catch (error) {
    if (error instanceof Z3ChildFault) children.push(error.observation);
    finished = true;
    clearInterval(guardTimer);
    await guarding;
    const cause = controller.signal.aborted ? controller.signal.reason ?? error : error;
    await recordViabilityFault(ctx, input.sessionId, claim, cause, meters());
    if (process.env.FINNOR_Z3_DISPOSABLE_RECOVERY === "1" && process.env.FINNOR_Z3_FAULT_POINT
      && typeof process.send === "function" && cause instanceof Z3NativeFault) {
      process.send({ kind: "Z3_DELIVERY_REFUSAL_OBSERVED", sessionId: input.sessionId,
        pid: process.pid, reason: cause.code }, () => undefined);
    }
    throw cause;
  } finally {
    finished = true;
    clearInterval(guardTimer);
    clearTimeout(deadlineTimer);
    if (leaseTimer) clearTimeout(leaseTimer);
    process.removeListener("SIGTERM", interrupted);
    process.removeListener("SIGINT", interrupted);
    await guarding;
  }
}

export async function runZ3ViabilitySynthesisJob(payload: Record<string, unknown>,
  execution?: Readonly<JobExecutionContext>): Promise<void> {
  return drive(payload, execution, Z3_PRODUCE_JOB);
}

export async function runZ3ViabilityRecoveryJob(payload: Record<string, unknown>,
  execution?: Readonly<JobExecutionContext>): Promise<void> {
  return drive(payload, execution, Z3_RECOVER_JOB);
}
