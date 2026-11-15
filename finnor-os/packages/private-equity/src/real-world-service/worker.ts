import { transitionWorkTx } from "@finnor/db";
import type { PeMutationContext } from "../types";
import type { PoolClient } from "pg";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import { recordServiceComputeOccupation } from "../allocation-store";
import { readEnterpriseDurableObligation } from "../enterprise-obligations";
import { validateEnterpriseAllocation } from "../enterprise-allocation";
import { canonical, hash } from "./contracts";
import { ServiceJobSchema, type ServiceJobPayload } from "./boundaries";
import { compileServiceProgram } from "./compiler";
import { checkServiceProgram } from "./checker";
import { serviceIdentity, requireServiceProfile } from "./identity";
import { consumeServiceProgram, servicePredicate } from "./consumer";
import { persistServiceCompute, persistServiceProjection } from "./meter";
import { serviceTx, serviceRequest, currentServiceCut, serviceArtifact, enqueueService, type ServiceRequestRow } from "./store";

async function liveDelivery(c: PoolClient, row: ServiceRequestRow, payload: ServiceJobPayload,
  execution: Readonly<JobExecutionContext>, compile: boolean) {
  return !!(await c.query(`SELECT j.id FROM finnor_os.jobs j
   JOIN finnor_os.job_delivery_attempts a ON a.tenant_id=j.tenant_id AND a.job_id=j.id AND a.id=$6
   WHERE j.tenant_id=$1 AND j.id=$2 AND j.claim_token=$3 AND j.claim_fence=$4
    AND j.type=$5 AND j.protocol_version=1 AND j.status='running' AND j.lease_expires_at>clock_timestamp()
    AND a.claim_token=j.claim_token AND a.claim_fence=j.claim_fence AND a.finished_at IS NULL
    AND j.payload->>'requestId'=$7 AND j.payload->>'principalId'=$8
    AND (j.payload->>'generation')::integer=$9
    AND (j.payload->>'wakeRevision')::bigint=$10 FOR SHARE OF j,a`,
  [payload.tenantId, execution.jobId, execution.claimToken, execution.claimFence,
    compile ? "compile_real_world_service_v1" : "advance_real_world_service_v1", execution.deliveryAttemptId,
    row.id, row.principal_id, payload.generation, payload.wakeRevision])).rows[0];
}
async function claim(ctx: PeMutationContext, payload: ServiceJobPayload, execution: Readonly<JobExecutionContext>,
  compile: boolean, publish: boolean) {
  return serviceTx(ctx, async c => {
    const row = await serviceRequest(ctx, payload.requestId, c, true);
    const job = await liveDelivery(c, row, payload, execution, compile);
    if (!job || row.generation !== payload.generation || Number(row.wake_revision) !== payload.wakeRevision
      || ["CANCELLED", "INVALIDATED", "FAILED"].includes(row.status)
      || compile && Date.now() >= row.compile_deadline.getTime()
      || publish && (row.claim_token !== execution.claimToken || Number(row.claim_fence) !== execution.claimFence))
      throw Error("W3_PHYSICAL_CLAIM_GENERATION_OR_WAKE_FENCED");
    await currentServiceCut(ctx, row, c);
    if (!publish) {
      await c.query(`UPDATE finnor_os.w3_service_requests SET status='RUNNING',claim_token=$3,claim_fence=$4,
       updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
      [row.tenant_id, row.id, execution.claimToken, execution.claimFence]);
      row.claim_token = execution.claimToken; row.claim_fence = String(execution.claimFence);
    }
    return row;
  });
}
async function run(payloadRaw: Record<string, unknown>, execution: Readonly<JobExecutionContext> | undefined, compile: boolean) {
  requireServiceProfile();
  const payload = ServiceJobSchema.parse(payloadRaw);
  if (!execution || execution.protocolVersion !== 1 || execution.retrySafety !== (compile ? "locally_idempotent" : "reconcilable")
    || payload.tenantId !== execution.tenantId) throw Error("W3_NATIVE_WORKER_CLAIM_REQUIRED");
  const ctx: PeMutationContext = { auth: { tenantId: payload.tenantId, userId: payload.principalId,
    employeeId: payload.principalId, role: "owner" },
    provenance: { sourceSystem: "POSTZ.W3", createdBy: payload.principalId } };
  const started = performance.now(), startedAt = new Date().toISOString(), cpu = process.cpuUsage();
  let row: ServiceRequestRow | null = null, charge = null, rightsRef = "", status = "ENTRY", predicate: string | null = null;
  try {
    row = await claim(ctx, payload, execution, compile, false);
    const obligation = await readEnterpriseDurableObligation(ctx, row.budget_obligation_ref);
    rightsRef = obligation.rightsRef;
    if ((await validateEnterpriseAllocation(ctx, row.parent_allocation)).status !== "CURRENT")
      throw Error("W3_ORIGINAL_S5_ALLOCATION_NOT_CURRENT");
    charge = (await recordServiceComputeOccupation(ctx, obligation, {
      requestId: row.id, generation: row.generation, jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId,
      claimToken: execution.claimToken, claimFence: execution.claimFence, stage: compile ? "COMPILE_CHECK" : "OBSERVE_CONSUME",
    })).charge.ref;
    if (compile) {
      const cut = await serviceTx(ctx, c => currentServiceCut(ctx, row!, c));
      const identity = await serviceIdentity(), now = Date.now();
      const body = compileServiceProgram(cut.outcome, cut.providers, identity, now);
      const check = checkServiceProgram(cut.outcome, cut.providers, body, identity, now);
      if (check.disposition !== "CHECKED_DEVELOPMENT") throw Error("W3_INDEPENDENT_PROGRAM_CHECK_REJECTED");
      await claim(ctx, payload, execution, true, true);
      await serviceTx(ctx, async (c, db) => {
        const current = await serviceRequest(ctx, row!.id, c, true);
        if (current.generation !== payload.generation || Number(current.wake_revision) !== payload.wakeRevision
          || current.claim_token !== execution.claimToken || Number(current.claim_fence) !== execution.claimFence
          || !await liveDelivery(c, current, payload, execution, true)) throw Error("W3_PUBLICATION_CLAIM_FENCED");
        const fresh = await currentServiceCut(ctx, current, c);
        if (checkServiceProgram(fresh.outcome, fresh.providers, body, identity, Date.now()).disposition !== "CHECKED_DEVELOPMENT")
          throw Error("W3_SOURCE_CHANGED_BEFORE_PUBLICATION");
        const prior = (await c.query<{ id: string; body_digest: string }>(`SELECT id,body_digest
         FROM finnor_os.w3_service_artifacts WHERE tenant_id=$1 AND request_id=$2 AND generation=$3`,
        [row!.tenant_id, row!.id, row!.generation])).rows[0];
        if (prior && prior.body_digest !== check.candidateDigest) throw Error("W3_IMMUTABLE_PUBLICATION_CONFLICT");
        const artifactId = prior?.id ?? (await c.query<{ id: string }>(`INSERT INTO finnor_os.w3_service_artifacts
         (tenant_id,principal_id,request_id,generation,body,body_digest,check_result)
         VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb) RETURNING id`,
        [row!.tenant_id, row!.principal_id, row!.id, row!.generation, canonical(body), check.candidateDigest, canonical(check)])).rows[0]!.id;
        const next = (await c.query<ServiceRequestRow>(`UPDATE finnor_os.w3_service_requests
         SET artifact_id=$3,status=$4,wake_revision=wake_revision+1,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2 AND claim_token=$5 AND claim_fence=$6
          AND clock_timestamp()<compile_deadline AND clock_timestamp()<original_deadline
          AND clock_timestamp()<(SELECT lease_expires_at FROM finnor_os.jobs
           WHERE tenant_id=$1 AND id=$7 AND claim_token=$5 AND claim_fence=$6 AND status='running') RETURNING *`,
        [row!.tenant_id, row!.id, artifactId, body.search.disposition === "COMPLETE" ? "CHECKED" : "PARTIAL",
          execution.claimToken, execution.claimFence, execution.jobId])).rows[0];
        if (!next) throw Error("W3_PUBLICATION_CLAIM_FENCED");
        await enqueueService(c, next, false);
        await transitionWorkTx(db, row!.tenant_id, row!.work_id, "executing", "real_world_service_checked",
          { requestId: row!.id, artifactDigest: check.candidateDigest, originalBusinessAssignments: 1,
            originalInstanceCount: cut.outcome.demands.length, selectedInstances: body.selection.length,
            physicalDeliveryEstablished: false, admissionGranted: false }, { expectedWorkInputId: row!.work_input_id });
      });
      status = "CHECKED_DEVELOPMENT";
    } else {
      const result = await consumeServiceProgram(ctx, row.id, async () => { await claim(ctx, payload, execution, false, true) });
      await claim(ctx, payload, execution, false, true);
      await serviceTx(ctx, async (c, db) => {
        const current = await serviceRequest(ctx, row!.id, c, true);
        if (current.generation !== payload.generation || current.claim_token !== execution.claimToken
          || Number(current.claim_fence) !== execution.claimFence || Number(current.wake_revision) !== payload.wakeRevision
          || !await liveDelivery(c, current, payload, execution, false)) throw Error("W3_OBSERVATION_PUBLICATION_FENCED");
        const artifact = await serviceArtifact(ctx, current, c);
        const digest = hash({ requestId: row!.id, artifact: artifact?.body_digest ?? null, projection: result.projection, gaps: result.gaps });
        const measured = await persistServiceProjection(ctx, current, {
          projection: result.projection, gaps: result.gaps, artifactDigest: artifact?.body_digest ?? null, digest, rightsRef,
        }, c);
        const updated = await c.query(`UPDATE finnor_os.w3_service_requests SET status=$3,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2 AND claim_token=$4 AND claim_fence=$5
          AND clock_timestamp()<(SELECT lease_expires_at FROM finnor_os.jobs
           WHERE tenant_id=$1 AND id=$6 AND claim_token=$4 AND claim_fence=$5 AND status='running')`,
        [row!.tenant_id, row!.id, result.gaps.length ? "PARTIAL" : "CHECKED",
          execution.claimToken, execution.claimFence, execution.jobId]);
        if (updated.rowCount !== 1) throw Error("W3_OBSERVATION_PUBLICATION_FENCED");
        const reconciling = result.projection?.operationallyComplete && !result.projection.financiallyReconciled;
        const occupation = await c.query(`UPDATE finnor_os.work_programme_occupations
         SET status=$4,revision=revision+CASE WHEN status IS DISTINCT FROM $4 THEN 1 ELSE 0 END,
          updated_at=clock_timestamp() WHERE tenant_id=$1 AND work_id=$2 AND owner='POSTZ.W3' AND programme_id=$3`,
        [row!.tenant_id, row!.work_id, row!.id, reconciling ? "RECONCILING" : "PROGRESS"]);
        if (occupation.rowCount !== 1) throw Error("W3_ORIGINAL_WORK_OCCUPATION_REQUIRED");
        if (!measured.semanticReplay) await transitionWorkTx(db, row!.tenant_id, row!.work_id, reconciling ? "recovery" : "executing",
          "real_world_service_observed", { requestId: row!.id, measurementRef: measured.record.ref,
            operationallyComplete: result.projection?.operationallyComplete ?? false,
            financiallyReconciled: result.projection?.financiallyReconciled ?? false,
            evidenceClass: "CONTROLLED", fieldValidated: false, originalBusinessAssignments: 1 },
          { expectedWorkInputId: row!.work_input_id });
      });
      status = "OBSERVED_NOT_FIELD_QUALIFIED";
    }
  } catch (error) {
    predicate = servicePredicate(error); status = "REFUSED_RESPONSIBILITY_RETAINED";
    if (!predicate.includes("FENCED")) throw error;
  } finally {
    if (row) {
      if (!rightsRef) rightsRef = (await readEnterpriseDurableObligation(ctx, row.budget_obligation_ref)).rightsRef;
      const used = process.cpuUsage(cpu);
      await persistServiceCompute(ctx, row, execution, { startedAt, elapsedMs: performance.now() - started,
        cpuMicroseconds: used.user + used.system, stage: compile ? "COMPILE_CHECK" : "OBSERVE_CONSUME",
        status, predicate, charge, rightsRef });
    }
  }
}
export const compileRealWorldServiceJob = (payload: Record<string, unknown>, execution?: Readonly<JobExecutionContext>) =>
  run(payload, execution, true);
export const advanceRealWorldServiceJob = (payload: Record<string, unknown>, execution?: Readonly<JobExecutionContext>) =>
  run(payload, execution, false);
