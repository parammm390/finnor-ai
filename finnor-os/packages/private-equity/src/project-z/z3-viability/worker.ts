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
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { PROFILE, type Candidate, type CheckReceipt } from "../../../../epistemic-runtime/src/project-z/z3-viability/contracts";
import { codeIdentity } from "../../evidence-execution/store";
import { canonicalApplicationActor } from "../../application-semantics/store";
import type { JobExecutionContext } from "../../../../../apps/worker/src/queue";
import { JobPayloadSchema, Z3NativeFault, Z3_PRODUCE_JOB, Z3_RECOVER_JOB,
  candidateDigestOf, parseStoredCandidate, parseStoredReceipt, receiptDigestOf, z3Fault,
  type ViabilityBoundaryPoint } from "./contracts";
import { adoptViabilityClaim, assertViabilityJobLease, checkpointViability,
  publishViabilityCandidate, publishViabilityObservation, publishViabilityResult,
  recordViabilityFault, viabilitySession, Z3_TERMINAL_STATUSES,
  type ViabilityBuildIdentity, type ViabilityMeters } from "./store";

/** The solver enforces its own internal deadline/operation budget; these are
 * the hard outer wall caps for a stuck child process, never semantic limits. */
const PRODUCER_WALL_MS = 30_000;
const CHECKER_WALL_MS = 300_000;
const MAX_CHILD_STDOUT = PROFILE.artifactBytes + PROFILE.inputBytes;
const MAX_BUILD_BYTES = PROFILE.artifactBytes;

interface PinnedToolchain {
  producerBundle: string; checkerSource: string; python: string; identity: ViabilityBuildIdentity;
}

function pinnedAsset(envName: string): string {
  const value = process.env[envName]?.trim() ?? "";
  if (!value || !isAbsolute(value)) z3Fault("Z3_PRODUCER_BUILD_UNPINNED");
  return value;
}

async function sha256File(path: string): Promise<string> {
  const bytes = await readFile(path);
  if (!bytes.length || bytes.length > MAX_BUILD_BYTES) z3Fault("Z3_BUILD_ARTIFACT_BOUND");
  return createHash("sha256").update(bytes).digest("hex");
}

/** Producer and checker identities are pinned by content digest from explicit
 * absolute environment paths. There is no source-tree fallback: an unpinned
 * build fails closed before any session mutation. */
async function pinToolchain(): Promise<PinnedToolchain> {
  const producerBundle = pinnedAsset("FINNOR_Z3_PRODUCER_BUNDLE");
  const checkerSource = pinnedAsset("FINNOR_Z3_CHECKER_SOURCE");
  const python = process.env.FINNOR_Z3_PYTHON?.trim() || "python3";
  if (python.includes("/") && !isAbsolute(python)) z3Fault("Z3_PRODUCER_BUILD_UNPINNED");
  const identity: ViabilityBuildIdentity = {
    producerBundleDigest: await sha256File(producerBundle),
    checkerDigest: await sha256File(checkerSource),
    nodeVersion: process.version, pythonExecutable: python,
  };
  return { producerBundle, checkerSource, python, identity };
}

/** One bounded NDJSON row in, exactly one row out. A child is killed at its
 * wall or byte cap, never negotiated with; stderr is discarded so an
 * untrusted diagnostic string can never become a fault identity. */
async function runNdjsonChild(command: string, args: readonly string[], inputLine: string,
  wallMs: number, timeoutCode: string): Promise<unknown> {
  if (Buffer.byteLength(inputLine) > MAX_CHILD_STDOUT) z3Fault("Z3_CHILD_INPUT_BOUND");
  return new Promise((resolve, reject) => {
    let settled = false, stdoutBytes = 0;
    const chunks: Buffer[] = [];
    const stdio: ["pipe", "pipe", "ignore"] = ["pipe", "pipe", "ignore"];
    const child = spawn(command, [...args], {
      stdio, env: { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH ?? "" },
    });
    const fail = (code: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new Z3NativeFault(code));
    };
    const timer = setTimeout(() => fail(timeoutCode), wallMs);
    child.on("error", () => fail("Z3_CHILD_SPAWN_FAILED"));
    child.stdin.on("error", () => fail("Z3_CHILD_STDIN_FAILED"));
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_CHILD_STDOUT) fail("Z3_CHILD_OUTPUT_BOUND");
      else chunks.push(chunk);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 || signal !== null) return reject(new Z3NativeFault("Z3_CHILD_EXIT_NONZERO"));
      const lines = Buffer.concat(chunks).toString("utf8").split("\n").filter((line) => line.trim().length > 0);
      const only: string | undefined = lines[0];
      if (lines.length !== 1 || typeof only !== "string") return reject(new Z3NativeFault("Z3_CHILD_PROTOCOL_ROWS"));
      try { resolve(JSON.parse(only)); } catch { reject(new Z3NativeFault("Z3_CHILD_OUTPUT_MALFORMED")); }
    });
    child.stdin.end(inputLine);
  });
}

const PROOF_POINTS: readonly string[] = ["CLAIM", "STRATEGY", "OBSERVATION"];

/** Disposable physical-recovery proof hook. Inert unless the environment
 * carries an explicit fault point; a fault point without the disposable flag,
 * an unknown point, or an authorized-source digest different from the loaded
 * runtime source fails closed instead of running uninstrumented. After the
 * named durable boundary commits, the delivery announces it over IPC and
 * holds for the harness's physical kill; a missing kill within two minutes is
 * itself a failed proof, never a silent completion. */
async function disposableRecoveryBoundary(point: ViabilityBoundaryPoint, sessionId: string,
  sessionFence: number): Promise<void> {
  const requested = (process.env.FINNOR_Z3_FAULT_POINT ?? "").trim();
  if (!requested) return;
  if (process.env.FINNOR_Z3_DISPOSABLE_RECOVERY !== "1" || !PROOF_POINTS.includes(requested)) {
    z3Fault("Z3_RECOVERY_PROOF_CONFIGURATION");
  }
  if (requested !== point) return;
  const code = await codeIdentity();
  if ((process.env.FINNOR_Z3_AUTHORIZED_SOURCE ?? "").trim() !== code.digest) {
    z3Fault("Z3_RECOVERY_PROOF_SOURCE_MISMATCH");
  }
  if (typeof process.send !== "function") z3Fault("Z3_RECOVERY_PROOF_IPC_REQUIRED");
  process.send({ kind: "Z3_DURABLE_BOUNDARY", point, sessionId, claimFence: sessionFence }, () => undefined);
  await new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Z3NativeFault("Z3_RECOVERY_PROOF_NOT_TERMINATED")), 120_000);
    timer.unref();
  });
}

async function drive(payloadRaw: Record<string, unknown>, actual: Readonly<JobExecutionContext> | undefined,
  type: string): Promise<void> {
  let input;
  try { input = JobPayloadSchema.parse(payloadRaw); } catch { z3Fault("Z3_JOB_PAYLOAD_INVALID"); }
  const jobFence = Number(actual?.claimFence);
  if (!actual || actual.tenantId !== input.tenantId || actual.protocolVersion !== 1
    || actual.retrySafety !== "reconcilable" || !Number.isSafeInteger(jobFence) || jobFence < 1) {
    z3Fault("Z3_ACTUAL_DURABLE_JOB_CONTEXT_REQUIRED");
  }
  const execution = Object.freeze({ ...actual, claimFence: jobFence });
  const ctx = await canonicalApplicationActor(input.tenantId, input.principalId);
  const first = await viabilitySession(ctx, input.sessionId);
  if (first.work_id !== input.workId) z3Fault("Z3_JOB_PAYLOAD_INVALID");
  if (Z3_TERMINAL_STATUSES.includes(first.status)) return;
  const started = performance.now();
  const usage = process.resourceUsage();
  // The session claim fence overlay: adoption increments the session-local
  // fence, and every later boundary publishes under (token, session fence).
  let claim: Readonly<JobExecutionContext> = execution;
  try {
    await assertViabilityJobLease(ctx, first, execution, type);
    const toolchain = await pinToolchain();
    let current = await adoptViabilityClaim(ctx, first, execution);
    claim = Object.freeze({ ...execution, claimFence: Number(current.active_claim_fence) });
    await checkpointViability(ctx, current, "CLAIM", claim);
    await disposableRecoveryBoundary("CLAIM", current.id, claim.claimFence);
    let candidate: Candidate;
    if (current.candidate === null) {
      const produced = await runNdjsonChild(process.execPath, [toolchain.producerBundle, "produce-batch"],
        JSON.stringify({ arena: current.arena, binding: current.binding }) + "\n",
        PRODUCER_WALL_MS, "Z3_PRODUCER_TIMEOUT");
      candidate = parseStoredCandidate(produced);
      current = await publishViabilityCandidate(ctx, current, claim, candidate);
    } else {
      candidate = parseStoredCandidate(current.candidate);
      if (candidateDigestOf(candidate) !== current.candidate_digest) z3Fault("Z3_CANDIDATE_PREIMAGE_INVALID");
    }
    await checkpointViability(ctx, current, "STRATEGY", claim);
    await disposableRecoveryBoundary("STRATEGY", current.id, claim.claimFence);
    let receipt: CheckReceipt;
    if (current.check_receipt === null) {
      const observed = await runNdjsonChild(toolchain.python, [toolchain.checkerSource, "--batch"],
        JSON.stringify({ arena: current.arena, binding: current.binding, candidate }) + "\n",
        CHECKER_WALL_MS, "Z3_CHECKER_TIMEOUT");
      receipt = parseStoredReceipt(observed);
      current = await publishViabilityObservation(ctx, current, claim, receipt);
    } else {
      receipt = parseStoredReceipt(current.check_receipt);
      if (receiptDigestOf(receipt) !== current.check_digest) z3Fault("Z3_CHECK_PREIMAGE_INVALID");
    }
    await checkpointViability(ctx, current, "OBSERVATION", claim);
    await disposableRecoveryBoundary("OBSERVATION", current.id, claim.claimFence);
    const after = process.resourceUsage();
    const meters: ViabilityMeters = {
      wallMs: Math.round(performance.now() - started),
      userCpuMicros: after.userCPUTime - usage.userCPUTime,
      systemCpuMicros: after.systemCPUTime - usage.systemCPUTime,
      processMaxRss: after.maxRSS,
    };
    await publishViabilityResult(ctx, current, claim, candidate, receipt, meters, toolchain.identity);
  } catch (error) {
    await recordViabilityFault(ctx, input.sessionId, claim, error);
    throw error;
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
