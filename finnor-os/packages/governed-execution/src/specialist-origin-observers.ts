/** Authoritative, read-only censuses of the actual original native sources. */
import { readFile } from "node:fs/promises";
import { getPool } from "../../db";
import { connectWithExecutionDeadline } from "../../db/execution-deadline";
import { digest } from "../../capability-evolution/src/contracts";
import { installedWorkforceSpecialistIdentity } from "../../capability-evolution/src/specialist-source";
import type { CanonicalSpecialistAuthority } from "../../capability-evolution/src/specialist-publication-authority";
import type { JobExecutionContext } from "../../../apps/worker/src/queue";
import { observeWorkforceSpecialistHost } from "./executor-specialist-linux";
import { specialistByteDigest } from "./specialist-contract";
import { actualJobOrigin, type OriginalP3Source } from "./specialist-origin-context";
import { originCensusSchema, type OriginKind, type SourceRegistration } from "./specialist-origin-contract";
import { observeOriginalS8Custody } from "./specialist-origin-s8";

export const publicOriginalP3 = (source: OriginalP3Source) => source.leases.map(lease => ({
  resourceKey: lease.resourceKey, tokenSha256: specialistByteDigest(lease.token), fence: lease.fence,
  ownerId: lease.ownerId, leaseSeconds: lease.leaseSeconds,
})).sort((a, b) => a.resourceKey.localeCompare(b.resourceKey));
export class OriginalSourceObservationFailure extends Error {
  constructor(readonly kind: OriginKind) { super("SPECIALIST_ORIGIN_ACTUAL_" + kind + "_CENSUS_FAILED"); }
}

async function originalRead(sql: string, args: unknown[], signal: AbortSignal) {
  signal.throwIfAborted();
  const client = await connectWithExecutionDeadline(getPool());
  let released = false;
  const stop = () => { if (!released) { released = true; client.release(true); } };
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    const result = await client.query(sql, args);
    signal.throwIfAborted(); return result.rows as Array<Record<string, unknown>>;
  } finally {
    signal.removeEventListener("abort", stop);
    if (!released) { released = true; client.release(); }
  }
}
export async function censusActualOriginalSources(input: {
  registration: SourceRegistration; execution: Readonly<JobExecutionContext>;
  p3: OriginalP3Source; authority: CanonicalSpecialistAuthority;
  controller: AbortSignal; combined: AbortSignal; challenge: string;
  sourceSequence: string; signal: AbortSignal;
  requireCommittedOriginal: boolean;
}) {
  const { registration: r, execution: e } = input;
  let kind: OriginKind = "JOB";
  try {
  const heartbeat = actualJobOrigin(e);
  // This is a lower watermark of completed authoritative reads, not a later
  // callback timestamp. Every read starts after this point and after the target.
  const through = process.hrtime.bigint();
  kind = "CONTROLLER"; input.controller.throwIfAborted();
  kind = "COMBINED_ABORT"; input.combined.throwIfAborted(); input.signal.throwIfAborted();
  kind = "JOB";
  await heartbeat.sourceBarrier();
  if (heartbeat.lost || heartbeat.leaseLossSignal.aborted || e.leaseLossSignal !== heartbeat.leaseLossSignal
    || e.jobId !== r.binding.job.id || e.deliveryAttemptId !== r.binding.job.deliveryAttemptId
    || e.claimFence !== r.binding.job.claimFence || specialistByteDigest(e.claimToken) !== r.binding.job.claimTokenSha256)
    throw Error("SPECIALIST_ORIGIN_ACTUAL_JOB_LOST");
  const jobs = await originalRead(`SELECT j.id,j.status,j.claim_fence::text,j.claim_token::text,j.lease_owner,
      j.lease_expires_at>clock_timestamp() AS lease_live,
      a.outcome='running' AND a.finished_at IS NULL AS delivery_running
    FROM jobs j JOIN job_delivery_attempts a ON a.job_id=j.id AND a.id=$2
      AND a.claim_token=j.claim_token AND a.claim_fence=j.claim_fence
    WHERE j.id=$1 AND j.tenant_id=$3`, [e.jobId, e.deliveryAttemptId, r.binding.tenantId], input.signal);
  const job = jobs[0];
  if (jobs.length !== 1 || !job || job.status !== "running" || job.claim_fence !== String(e.claimFence)
    || job.claim_token !== e.claimToken || job.lease_owner !== e.workerId
    || job.lease_live !== true || job.delivery_running !== true)
    throw Error("SPECIALIST_ORIGIN_ACTUAL_JOB_LOST");
  kind = "P3"; await input.p3.drain(); input.p3.signal.throwIfAborted();
  const current = publicOriginalP3(input.p3);
  if (current.length !== 3 || digest(current) !== digest(r.p3))
    throw Error("SPECIALIST_ORIGIN_ACTUAL_P3_REPLACED");
  const permits = await originalRead(`SELECT l.resource_key,l.lease_token::text,l.fence::text,l.owner_id,
      l.released_at IS NULL AND l.expires_at>clock_timestamp() AS live
    FROM compute_resource_leases l
    JOIN jsonb_to_recordset($1::jsonb) o(resource_key text,token uuid,fence bigint,owner_id text)
      ON l.resource_key=o.resource_key AND l.lease_token=o.token AND l.fence=o.fence AND l.owner_id=o.owner_id
    ORDER BY l.resource_key`, [JSON.stringify(input.p3.leases.map(lease => ({
      resource_key: lease.resourceKey, token: lease.token, fence: lease.fence, owner_id: lease.ownerId,
    })))], input.signal);
  if (permits.length !== 3 || permits.some(row => row.live !== true))
    throw Error("SPECIALIST_ORIGIN_ACTUAL_P3_LOST");
  kind = "S8_AUTHORITY";
  const epoch = await observeOriginalS8Custody({
    authority: input.authority, registration: r, requireCommittedOriginal: input.requireCommittedOriginal, signal: input.signal,
  });
  if (epoch.enrollmentDigest !== r.enrollmentDigest || epoch.epoch !== r.s8Epoch)
    throw Error("SPECIALIST_ORIGIN_ACTUAL_S8_AUTHORITY_LOST");
  kind = "SOURCE_RUNTIME_HOST";
  const identity = await installedWorkforceSpecialistIdentity(),
    host = await observeWorkforceSpecialistHost(r.hostReference),
    bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (host.stopped || identity.sourceClosureDigest !== r.binding.sourceClosureDigest
    || identity.runtimeDigest !== r.binding.runtimeDigest)
    throw Error("SPECIALIST_ORIGIN_ACTUAL_SOURCE_RUNTIME_HOST_LOST");
  kind = "CONTROLLER"; input.controller.throwIfAborted();
  kind = "COMBINED_ABORT"; input.combined.throwIfAborted(); input.signal.throwIfAborted();
  kind = "JOB"; heartbeat.leaseLossSignal.throwIfAborted();
  kind = "P3"; input.p3.signal.throwIfAborted();
  return originCensusSchema.parse({
    schema: "finnor.specialist.actual-original-source-census.v1",
    publicationId: r.publicationId, enrollmentDigest: r.enrollmentDigest, registrationDigest: digest(r),
    sourceSequence: input.sourceSequence, challenge: input.challenge, throughMonotonicNs: String(through),
    controller: { aborted: false }, combinedAbort: { aborted: false },
    job: { jobId: e.jobId, deliveryAttemptId: e.deliveryAttemptId, claimFence: String(e.claimFence),
      claimTokenDigest: specialistByteDigest(e.claimToken), leaseOwner: e.workerId, status: "running",
      leaseLive: true, deliveryRunning: true, heartbeatSourceLive: true },
    p3: { setDigest: digest(current), current, complete: true, capacitySignalAborted: false },
    s8: { enrollmentDigest: epoch.enrollmentDigest, epoch: epoch.epoch, historyDigest: epoch.historyDigest },
    source: { sourceClosureDigest: identity.sourceClosureDigest, runtimeDigest: identity.runtimeDigest,
      hostDigest: digest({ reference: r.hostReference, nativeBootstrap: r.nativeBootstrap }), bootId,
      cgroupDevice: r.hostReference.device, cgroupInode: r.hostReference.inode },
  });
  } catch { throw new OriginalSourceObservationFailure(kind); }
}
