import { z } from "zod";
import { withTenantTransaction, acquireComputeResourceLeases, renewComputeResourceLeases, releaseComputeResourceLeases,
  type ComputeResourceLease } from "@finnor/db";
import type { JobExecutionContext } from "../../../../../apps/worker/src/queue";
import type { PeMutationContext } from "../../types";
import { chargeInstitutionDemand } from "../../allocation-store";
import { ordinaryDevelopment, canonical, digest, type SessionRow, type Certificate } from "./contracts";
import { transaction, requestTx, profileTx, assertDeliveryTx, assertClaimTx, meterStartTx, eventTx,
  artifactTx, insertArtifactTx, assertComputeLeasesTx, bestEffortTerminalAudit, nativeFailureReason } from "./store";
import { inspectOwners, assertOwnerCutTx } from "./owners";
import { loadedBuild } from "./source";
import { produceInstitution, independentlyCheckInstitution } from "./process";
import { buildArtifact, recordCostTx } from "./artifact";
import { admitInstitutionComposition, useInstitutionComposition } from "./consumer";
const JobSchema = z.object({ tenantId: z.string().uuid(), principalId: z.string().uuid(),
  requestId: z.string().uuid(), generation: z.number().int().min(1).max(64) }).strict();

/** Delegation comes from a currently claimed original queue row and an actual
 * active native employee. Payloads never manufacture a test owner or role. */
async function originalWorkerContext(p: z.infer<typeof JobSchema>, e: Readonly<JobExecutionContext>): Promise<PeMutationContext> {
  return withTenantTransaction(p.tenantId, { userId: p.principalId, readOnly: true }, async (_db, c) => {
    const row = (await c.query<{ id: string; role: PeMutationContext["auth"]["role"] }>(
      `SELECT u.id,u.role FROM finnor_os.users u JOIN finnor_os.jobs j ON j.tenant_id=u.tenant_id
       JOIN finnor_os.job_delivery_attempts d ON d.tenant_id=j.tenant_id AND d.job_id=j.id
       WHERE u.tenant_id=$1 AND u.id=$2 AND u.status='active' AND u.role='owner'
       AND j.id=$3 AND j.payload=$4::jsonb AND j.type='link_institution_components_v1' AND j.status='running'
       AND j.claim_token=$5 AND j.claim_fence=$6 AND j.lease_expires_at>clock_timestamp()
       AND d.id=$7 AND d.claim_token=j.claim_token AND d.claim_fence=j.claim_fence AND d.finished_at IS NULL`,
      [p.tenantId, p.principalId, e.jobId, canonical(p), e.claimToken, e.claimFence, e.deliveryAttemptId])).rows[0];
    if (!row) throw Error("Z5_ORIGINAL_AUTHENTICATED_EMPLOYEE_DELEGATION_REQUIRED");
    return { auth: { tenantId: p.tenantId, userId: row.id, employeeId: row.id, role: row.role } };
  });
}
async function interrupt(ctx: PeMutationContext, row: SessionRow, e: Readonly<JobExecutionContext>,
  point: "AFTER_CLAIM" | "AFTER_CERTIFICATE" | "AFTER_REPLACEMENT", signal: AbortSignal) {
  if (process.env.FINNOR_Z5_INTERRUPT_AT !== point) return;
  if (process.env.FINNOR_Z5_EXCLUSIVE_WORKER !== "1" || process.env.FINNOR_Z5_DISPOSABLE_AUTHORITY !== "EXPLICIT")
    throw Error("Z5_OWNED_PHYSICAL_INTERRUPTION_AUTHORITY_REQUIRED");
  await transaction(ctx, async c => {
    const current = await requestTx(ctx, c, row.id);
    await assertDeliveryTx(ctx, c, current, e);
    await eventTx(ctx, c, current, "PHYSICAL_INTERRUPT_READY", e.deliveryAttemptId + ":" + point,
      { point, processId: process.pid, deliveryId: e.deliveryAttemptId, claimFence: e.claimFence,
        originalObligationsRetained: true, originalAllowanceRetained: true });
  });
  // The guarded E2E supervisor SIGKILLs exactly this owned PID, never a broad
  // process match. The production profile cannot enter this boundary.
  await new Promise<void>((_resolve, reject) => {
    if (signal.aborted) { reject(Error("Z5_INTERRUPTED_CLAIM_LOST")); return; }
    signal.addEventListener("abort", () => reject(Error("Z5_INTERRUPTED_CLAIM_LOST")), { once: true });
  });
}
export async function linkInstitutionComponentsJob(raw: Record<string, unknown>, execution?: Readonly<JobExecutionContext>) {
  ordinaryDevelopment();
  const p = JobSchema.parse(raw);
  if (!execution || execution.tenantId !== p.tenantId || execution.protocolVersion !== 1
    || execution.retrySafety !== "locally_idempotent") throw Error("Z5_ACTUAL_DURABLE_JOB_EXECUTION_REQUIRED");
  const e = execution, ctx = await originalWorkerContext(p, e), abort = new AbortController();
  let leases: ComputeResourceLease[] = [], row: SessionRow | null = null, registered = false, disposition = "UNKNOWN";
  let heartbeatClosed = false;
  const started = performance.now(), cpu = process.cpuUsage();
  async function heartbeat() {
    if (heartbeatClosed) return true;
    try {
      const renewing = leases;
      const renewed = await renewComputeResourceLeases(renewing);
      if (heartbeatClosed) return true;
      if (!renewed && renewing === leases) throw Error("Z5_COMPUTE_LEASE_LOST");
      await transaction(ctx, async c => {
        const current = await requestTx(ctx, c, p.requestId);
        await assertDeliveryTx(ctx, c, current, e);
        if (current.generation !== p.generation || current.cancel_requested || current.deadline_at.getTime() <= Date.now()
          || ["STALE", "REVOKED", "CANCELLED", "INCOMPLETE", "UNKNOWN"].includes(current.status))
          throw Error("Z5_ORIGINAL_GENERATION_NOT_CURRENT");
        await profileTx(ctx, c, current.profile_ref);
      });
      if (!heartbeatClosed) await loadedBuild();
      return true;
    } catch {
      if (heartbeatClosed) return true;
      abort.abort(); return false;
    }
  }
  try {
    leases = await acquireComputeResourceLeases({ tenantId: p.tenantId,
      resourceKeys: ["native:z5-institution-linker"], requiredResourceKeys: ["native:z5-institution-linker"],
      workloadClass: "INTERACTIVE", ownerId: "z5:" + e.deliveryAttemptId });
    e.registerHeartbeat(heartbeat);
    const start = await transaction<{ row: SessionRow | null; exhausted?: { row: SessionRow; attempts: number | null } }>(ctx, async c => {
      const current = await requestTx(ctx, c, p.requestId, true);
      await assertDeliveryTx(ctx, c, current, e);
      if (current.generation !== p.generation || current.cancel_requested
        || ["STALE", "REVOKED", "CANCELLED", "INCOMPLETE"].includes(current.status) || current.deadline_at.getTime() <= Date.now()) return { row: null };
      const episode = (await c.query<{ deliveries: number }>(
        "SELECT deliveries FROM finnor_os.z5_link_episodes WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 FOR UPDATE",
        [p.tenantId, p.principalId, current.work_id])).rows[0];
      const prior = (await c.query("SELECT id FROM finnor_os.z5_link_attempts WHERE tenant_id=$1 AND delivery_id=$2",
        [p.tenantId, e.deliveryAttemptId])).rowCount;
      if (!prior && (!episode || episode.deliveries >= 4 || current.deliveries >= 4)) {
        await c.query("UPDATE finnor_os.z5_link_requests SET status='INCOMPLETE' WHERE tenant_id=$1 AND id=$2", [p.tenantId, current.id]);
        disposition = "INCOMPLETE";
        return { row: null, exhausted: { row: await requestTx(ctx, c, current.id), attempts: episode?.deliveries ?? null } };
      }
      if (!prior) {
        await c.query("UPDATE finnor_os.z5_link_episodes SET deliveries=deliveries+1 WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3",
          [p.tenantId, p.principalId, current.work_id]);
        await meterStartTx(ctx, c, current, e);
      }
      await c.query(`UPDATE finnor_os.z5_link_requests SET status='RUNNING',claim_token=$3,claim_fence=$4,
        deliveries=deliveries+$5 WHERE tenant_id=$1 AND id=$2`,
      [p.tenantId, current.id, e.claimToken, e.claimFence, prior ? 0 : 1]);
      const claimed = await requestTx(ctx, c, current.id, true);
      await recordCostTx(ctx, c, claimed, e.deliveryAttemptId, "CLAIM", {
        jobId: e.jobId, deliveryId: e.deliveryAttemptId, fence: e.claimFence, state: "UNKNOWN_IF_INTERRUPTED_BEFORE_DEBIT",
        reusedArtifact: current.artifact_digest, wallMsBeforeClaim: performance.now() - started });
      await eventTx(ctx, c, claimed, "ACTUAL_QUEUE_CLAIMED", "claimed:" + e.deliveryAttemptId,
        { jobId: e.jobId, deliveryId: e.deliveryAttemptId, claimFence: e.claimFence,
          workerId: e.workerId, reusedArtifact: current.artifact_digest, originalEpisode: current.work_id });
      return { row: claimed };
    });
    row = start.row;
    if (!row) {
      if (start.exhausted) await bestEffortTerminalAudit(ctx, async c => {
        const current = await requestTx(ctx, c, start.exhausted!.row.id);
        await assertDeliveryTx(ctx, c, current, e);
        await eventTx(ctx, c, current, "ORIGINAL_EPISODE_EXHAUSTED", "exhausted:" + e.deliveryAttemptId,
          { disposition: "INCOMPLETE", originalAttempts: start.exhausted!.attempts, newAllowance: false, searchWork: 0 });
      });
      return;
    }
    registered = true;
    const charged = await chargeInstitutionDemand(ctx, row.request.parentReservation, {
      responsibilityIdentity: row.request.responsibilityIdentity, phase: "PREPARATION", ordinal: 1,
      units: row.artifact_digest ? 1 : 2, physicalInvocationId: e.deliveryAttemptId });
    await transaction(ctx, async c => {
      const current = await requestTx(ctx, c, p.requestId, true);
      await assertClaimTx(ctx, c, current, e);
      await c.query("UPDATE finnor_os.z5_link_attempts SET charge_ref=$3::jsonb WHERE tenant_id=$1 AND delivery_id=$2",
        [p.tenantId, e.deliveryAttemptId, canonical(charged.charge.ref)]);
      await eventTx(ctx, c, current, "ORIGINAL_S5_DEBIT_COMMITTED", "debit:" + e.deliveryAttemptId,
        { chargeRef: charged.charge.ref, cumulativeEnvelope: row!.request.parentReservation, newAllowance: false });
    });
    await interrupt(ctx, row, e, "AFTER_CLAIM", abort.signal);
    const build = await loadedBuild(), profile = await transaction(ctx, c => profileTx(ctx, c, row!.profile_ref));
    if (build.sourceDigest !== row.source_digest) throw Error("Z5_CLAIMED_SOURCE_CHANGED");
    const fresh = await inspectOwners(ctx, row.request, profile);
    if (digest(fresh) !== digest(row.cut)) throw Error("Z5_ORIGINAL_OWNER_CUT_STALE");
    const producer = build.files.find(f => f.path.endsWith("/z5-institution-linker/kernel.ts"))!,
      checker = build.files.find(f => f.path.endsWith("/z5-institution-linker/checker.py"))!;
    let certificate: Certificate;
    if (row.artifact_digest) certificate = (await transaction(ctx, c => artifactTx(ctx, c, row!))).certificate;
    else {
      if (!await heartbeat()) throw Error("Z5_PRODUCER_DISPATCH_FENCED");
      certificate = await produceInstitution(row.input, producer.sha256, abort.signal, row.deadline_at.getTime());
    }
    if (!await heartbeat()) throw Error("Z5_CHECK_DISPATCH_FENCED");
    const check = await independentlyCheckInstitution(row.input, certificate, checker.sha256, abort.signal, row.deadline_at.getTime());
    const publicationCut = await inspectOwners(ctx, row.request, profile);
    if (digest(publicationCut) !== digest(row.cut)) throw Error("Z5_PUBLICATION_OWNER_CUT_CHANGED");
    if (!await heartbeat()) throw Error("Z5_CERTIFICATE_PERSISTENCE_FENCED");
    const hash = await transaction(ctx, async c => {
      const current = await requestTx(ctx, c, p.requestId, true);
      await assertClaimTx(ctx, c, current, e);
      await assertComputeLeasesTx(ctx, c, leases);
      await assertOwnerCutTx(ctx, c, current.request, profile, publicationCut);
      const usage = process.cpuUsage(cpu);
      const costRef = await recordCostTx(ctx, c, current, e.deliveryAttemptId, "COMPUTE", {
        certificateCosts: certificate.costs, wallMs: performance.now() - started, cpuUserMicros: usage.user,
        cpuSystemMicros: usage.system, parentProcessPeakRssBytes: process.resourceUsage().maxRSS * 1024,
        chargeRef: charged.charge.ref, retainedFailuresCharged: true, interruptionTail: "UNKNOWN_UNLESS_TERMINAL" });
      const artifact = current.artifact_digest ? await artifactTx(ctx, c, current)
        : buildArtifact(current, certificate, check, build, charged.charge.ref, costRef);
      const hash = current.artifact_digest ?? await insertArtifactTx(ctx, c, current, artifact);
      disposition = certificate.disposition;
      await c.query("UPDATE finnor_os.z5_link_requests SET artifact_digest=$3,status=$4 WHERE tenant_id=$1 AND id=$2",
        [p.tenantId, current.id, hash, disposition]);
      await c.query("UPDATE finnor_os.z5_link_attempts SET finished_at=clock_timestamp(),body=body||$3::jsonb WHERE tenant_id=$1 AND delivery_id=$2",
        [p.tenantId, e.deliveryAttemptId, canonical({ disposition, costRef, hardKillTail: "UNKNOWN_AFTER_THIS_POINT" })]);
      await eventTx(ctx, c, current, "INDEPENDENT_ORIGINAL_CERTIFICATE_PERSISTED", "certificate:" + e.deliveryAttemptId,
        { artifactDigest: hash, claimDigest: check.claimDigest, disposition, costRef, originalProduct: certificate.original });
      return hash;
    });
    await interrupt(ctx, row, e, "AFTER_CERTIFICATE", abort.signal);
    if (certificate.disposition === "CHECKED_CANDIDATE") {
      if (!await heartbeat()) throw Error("Z5_S8_CONSUMPTION_FENCED");
      const completedLeases = leases;
      leases = [];
      try { await releaseComputeResourceLeases(completedLeases, "Z5_PRODUCER_CHECKER_STACK_FINISHED"); }
      catch (error) { leases = completedLeases; throw error; }
      await admitInstitutionComposition(ctx, row.id, e, abort.signal);
      if (!await heartbeat()) throw Error("Z5_S4_REPLACEMENT_FENCED");
      await useInstitutionComposition(ctx, row.id, hash, "automatic:" + row.id, e.deliveryAttemptId, e);
      await interrupt(ctx, row, e, "AFTER_REPLACEMENT", abort.signal);
    }
    await transaction(ctx, async c => {
      const current = await requestTx(ctx, c, p.requestId, true);
      await assertDeliveryTx(ctx, c, current, e);
      if (current.cancel_requested || current.generation !== p.generation) throw Error("Z5_ACK_GENERATION_FENCED");
      await eventTx(ctx, c, current, "WORKER_ORIGINAL_RESULT_READY_FOR_QUEUE_ACK", "ack-ready:" + e.deliveryAttemptId,
        { artifactDigest: hash, disposition, nativeQueueAck: "NOT_YET_OBSERVED",
          originalObligationsRetained: true, externalEffects: 0 });
    });
  } catch (error) {
    const reason = nativeFailureReason(error);
    // Claim audit storage can exhaust before the local claim commits. Preserve
    // other preclaim errors, especially the queue's native capacity deferral.
    if (!registered && reason !== "Z5_ORIGINAL_STORAGE_OR_EVENT_BUDGET_EXHAUSTED") throw error;
    const status = /BOUND|BUDGET|DEADLINE/.test(reason) ? "INCOMPLETE" : /STALE|CHANGED|CUT|PROFILE/.test(reason) ? "STALE" : "UNKNOWN";
    try {
      const terminal = await transaction(ctx, async c => {
        const current = await requestTx(ctx, c, p.requestId, true);
        await assertDeliveryTx(ctx, c, current, e);
        if (current.generation !== p.generation || current.cancel_requested || ["STALE", "REVOKED", "CANCELLED"].includes(current.status))
          return null;
        await c.query("UPDATE finnor_os.z5_link_requests SET status=$3 WHERE tenant_id=$1 AND id=$2", [p.tenantId, current.id, status]);
        return current.id;
      });
      if (terminal) await bestEffortTerminalAudit(ctx, async c => {
        const current = await requestTx(ctx, c, terminal);
        await assertDeliveryTx(ctx, c, current, e);
        await eventTx(ctx, c, current, "PHYSICAL_ATTEMPT_REFUSED", "refusal:" + e.deliveryAttemptId,
          { reason, disposition: status, localClaimCommitted: registered,
            interruptionTail: "UNKNOWN", allOldObligationsAndDebitsRetained: true });
        await recordCostTx(ctx, c, current, e.deliveryAttemptId, "REFUSAL", {
          reason, disposition: status, wallMs: performance.now() - started, usage: process.cpuUsage(cpu), money: null, human: null });
      });
    } catch { /* A lost/unavailable fence cannot overwrite another owner. The
      * optional audit cannot roll back an already committed terminal fence. */ }
    throw Error(reason);
  } finally {
    // No handler work remains. The queue still enforces its own claim/ACK fence.
    heartbeatClosed = true;
    abort.abort();
    const completedLeases = leases;
    leases = [];
    await releaseComputeResourceLeases(completedLeases, "Z5_WORKER_FINISHED_OR_REFUSED");
  }
}
