/** Hooks attach the actual original objects. No JSON or replacement-signal path. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ComputeResourceLease } from "../../db/compute-governor";
import type { JobExecutionContext } from "../../../apps/worker/src/queue";
import {
  initialJobClaimSchema, initialP3GrantSchema,
  type InitialJobClaim, type InitialP3Grant, type OriginEventKind, type OriginKind,
} from "./specialist-origin-contract";
import { specialistByteDigest } from "./specialist-contract";

export interface OriginalHeartbeatSource {
  readonly leaseLossSignal: AbortSignal;
  readonly lost: boolean;
  sourceBarrier(): Promise<void>;
}
const jobs = new WeakMap<object, OriginalHeartbeatSource>();
const initialJobs = new WeakMap<object, Readonly<InitialJobClaim>>();
const initialExecutions = new WeakMap<object, Readonly<InitialJobClaim>>();
const initialPermits = new WeakMap<object, Readonly<InitialP3Grant>>();
/** Invoke only from the actual SQL claim RETURNING path, before heartbeat starts. */
export function captureActualInitialJobClaim(claimedJob: object, receipt: InitialJobClaim) {
  // These acquisition hooks also see ordinary jobs. Missing instrumentation
  // leaves no receipt; only the protected consumer below must fail closed.
  if (initialJobs.has(claimedJob)) return false;
  const result = initialJobClaimSchema.safeParse(receipt);
  if (!result.success) return false;
  const parsed = result.data;
  if (BigInt(parsed.initialAcquiredUtcMicros) >= BigInt(parsed.initialExpiresUtcMicros))
    return false;
  initialJobs.set(claimedJob, Object.freeze(parsed)); return true;
}
/** Invoke only beside actual acquireComputeLease RETURNING, never at renewal. */
export function captureActualInitialP3Grant(lease: ComputeResourceLease, receipt: InitialP3Grant) {
  const result = initialP3GrantSchema.safeParse(receipt);
  if (!result.success || !lease || typeof lease.token !== "string") return false;
  const parsed = result.data;
  if (initialPermits.has(lease) || parsed.resourceKey !== lease.resourceKey
    || parsed.tokenSha256 !== specialistByteDigest(lease.token) || parsed.fence !== lease.fence
    || parsed.ownerId !== lease.ownerId || BigInt(parsed.initialAcquiredUtcMicros) >= BigInt(parsed.initialExpiresUtcMicros))
    return false;
  initialPermits.set(lease, Object.freeze(parsed)); return true;
}
export function captureActualJobOrigin(
  execution: Readonly<JobExecutionContext>, heartbeat: OriginalHeartbeatSource, claimedJob: object,
) {
  if (!(execution.leaseLossSignal instanceof AbortSignal)
    || execution.leaseLossSignal !== heartbeat.leaseLossSignal || jobs.has(execution))
    return false;
  const receipt = initialJobs.get(claimedJob);
  if (!receipt || receipt.jobId !== execution.jobId || receipt.deliveryAttemptId !== execution.deliveryAttemptId
    || receipt.claimFence !== execution.claimFence || receipt.claimTokenDigest !== specialistByteDigest(execution.claimToken))
    return false;
  jobs.set(execution, heartbeat); initialExecutions.set(execution, receipt); return true;
}
export function readActualOriginalClaimBounds(
  execution: Readonly<JobExecutionContext>, leases: readonly ComputeResourceLease[],
) {
  actualJobOrigin(execution);
  const job = initialExecutions.get(execution), permits = leases.map(lease => initialPermits.get(lease));
  if (!job || leases.length !== 3 || permits.some(value => !value))
    throw Error("SPECIALIST_ORIGIN_GENUINE_INITIAL_SOURCE_RECEIPTS_REQUIRED");
  return Object.freeze({ initialJobClaim: job,
    initialP3Grants: Object.freeze((permits as Readonly<InitialP3Grant>[]).slice()
      .sort((a, b) => a.resourceKey.localeCompare(b.resourceKey))) });
}
export function actualJobOrigin(execution: Readonly<JobExecutionContext>) {
  const source = jobs.get(execution);
  if (!source || source.leaseLossSignal !== execution.leaseLossSignal)
    throw Error("SPECIALIST_ORIGIN_GENUINE_JOB_HANDLE_REQUIRED");
  return source;
}
export interface OriginalP3Source {
  readonly leases: readonly ComputeResourceLease[];
  readonly signal: AbortSignal;
  drain(): Promise<void>;
}
export interface ActualOriginalOriginContext {
  attachP3(source: OriginalP3Source): void;
  p3Exited(): Promise<void>;
  negative(kind: OriginKind, event: OriginEventKind, reason: string, at?: bigint): void;
}
const original = new AsyncLocalStorage<ActualOriginalOriginContext>();
export function withActualOriginalOriginContext<T>(context: ActualOriginalOriginContext, run: () => Promise<T>) {
  return original.run(context, run);
}
/** Called only beside the existing actual governed lease loop, before invoke. */
export function captureActualP3Origin(source: OriginalP3Source) {
  original.getStore()?.attachP3(source);
}
export async function finishActualP3Origin() {
  await original.getStore()?.p3Exited();
}
