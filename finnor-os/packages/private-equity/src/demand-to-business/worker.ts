import { transitionWorkTx } from "@finnor/db";
import type { PoolClient } from "pg";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import type { PeMutationContext } from "../types";
import { recordGrowthComputeOccupation } from "../allocation-store";
import { readEnterpriseDurableObligation } from "../enterprise-obligations";
import { validateEnterpriseAllocation } from "../enterprise-allocation";
import { canonical, hash, type NativeRef } from "./contracts";
import { growthJobSchema, type GrowthJobPayload } from "./boundaries";
import { compileOperatingProgram } from "./compiler";
import { checkOperatingProgram } from "./checker";
import { growthIdentity, requireGrowthProfile } from "./identity";
import { consumeGrowthProgram, growthPredicate } from "./consumer";
import { persistGrowthCompute, persistGrowthProjection } from "./meter";
import { growthTx, growthRequest, currentGrowthCut, growthArtifact, enqueueGrowth, type GrowthRequestRow } from "./store";

async function liveDelivery(c: PoolClient, row: GrowthRequestRow, payload: GrowthJobPayload,
  execution: Readonly<JobExecutionContext>, compile: boolean) {
  return !!(await c.query(`SELECT j.id FROM finnor_os.jobs j
   JOIN finnor_os.job_delivery_attempts a ON a.tenant_id=j.tenant_id AND a.job_id=j.id AND a.id=$6
   WHERE j.tenant_id=$1 AND j.id=$2 AND j.claim_token=$3 AND j.claim_fence=$4
    AND j.type=$5 AND j.protocol_version=1 AND j.status='running' AND j.lease_expires_at>clock_timestamp()
    AND a.claim_token=j.claim_token AND a.claim_fence=j.claim_fence AND a.finished_at IS NULL
    AND j.payload->>'requestId'=$7 AND j.payload->>'principalId'=$8
    AND (j.payload->>'generation')::integer=$9 AND (j.payload->>'wakeRevision')::bigint=$10 FOR SHARE OF j,a`,
  [payload.tenantId, execution.jobId, execution.claimToken, execution.claimFence,
    compile ? "compile_market_operating_program_v1" : "advance_market_operating_program_v1",
    execution.deliveryAttemptId, row.id, row.principal_id, payload.generation, payload.wakeRevision])).rows[0];
}
async function claim(ctx: PeMutationContext, payload: GrowthJobPayload, execution: Readonly<JobExecutionContext>,
  compile: boolean, publish: boolean) {
  return growthTx(ctx, async c => {
    const row = await growthRequest(ctx, payload.requestId, c, true);
    if (!await liveDelivery(c, row, payload, execution, compile) || row.generation !== payload.generation
      || Number(row.wake_revision) !== payload.wakeRevision || row.status === "FAILED"
      || compile && Date.now() >= row.compile_deadline.getTime()
      || publish && (row.claim_token !== execution.claimToken || Number(row.claim_fence) !== execution.claimFence))
      throw Error("W4_PHYSICAL_CLAIM_GENERATION_OR_WAKE_FENCED");
    if (compile) await currentGrowthCut(ctx, row, c);
    if (!publish) {
      await c.query(`UPDATE finnor_os.w4_business_requests SET status='RUNNING',claim_token=$3,claim_fence=$4,
       updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`,
      [row.tenant_id, row.id, execution.claimToken, execution.claimFence]);
      row.claim_token = execution.claimToken; row.claim_fence = String(execution.claimFence);
    }
    return row;
  });
}
async function run(raw: Record<string, unknown>, execution: Readonly<JobExecutionContext> | undefined, compile: boolean) {
  requireGrowthProfile();
  const payload = growthJobSchema.parse(raw);
  if (!execution || execution.protocolVersion !== 1 || payload.tenantId !== execution.tenantId
    || execution.retrySafety !== (compile ? "locally_idempotent" : "reconcilable")) throw Error("W4_NATIVE_WORKER_CLAIM_REQUIRED");
  const ctx: PeMutationContext = { auth: { tenantId: payload.tenantId, userId: payload.principalId,
    employeeId: payload.principalId, role: "owner" },
    provenance: { sourceSystem: "POSTZ.W4", createdBy: payload.principalId } };
  const started = performance.now(), startedAt = new Date().toISOString(), cpu = process.cpuUsage();
  let row: GrowthRequestRow | null = null, charge: NativeRef | null = null, rightsRef = "", status = "ENTRY", predicate: string | null = null;
  try {
    if (compile) {
      const replay = await growthTx(ctx, async c => {
        const original = await growthRequest(ctx, payload.requestId, c);
        if (original.generation !== payload.generation || !original.artifact_id) return null;
        if (!await liveDelivery(c, original, payload, execution, true))
          throw Error("W4_PHYSICAL_PUBLICATION_REPLAY_FENCED");
        const artifact = await growthArtifact(ctx, original, c);
        if (!artifact || artifact.generation !== payload.generation) throw Error("W4_IMMUTABLE_PUBLICATION_REPLAY_INVALID");
        return original;
      });
      if (replay) {
        row = replay; rightsRef = (await readEnterpriseDurableObligation(ctx, row.budget_obligation_ref)).rightsRef;
        status = "REPLAY_PRIOR_IMMUTABLE_GENERATION";
        return;
      }
    }
    row = await claim(ctx, payload, execution, compile, false);
    const obligation = await readEnterpriseDurableObligation(ctx, row.budget_obligation_ref);
    rightsRef = obligation.rightsRef;
    if ((await validateEnterpriseAllocation(ctx, row.parent_allocation)).status !== "CURRENT")
      throw Error("W4_ORIGINAL_S5_ALLOCATION_NOT_CURRENT");
    charge = (await recordGrowthComputeOccupation(ctx, obligation, { requestId: row.id, generation: row.generation,
      wakeRevision: payload.wakeRevision, jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId,
      claimToken: execution.claimToken, claimFence: execution.claimFence, stage: compile ? "COMPILE_CHECK" : "OBSERVE_CONSUME" })).charge.ref;
    if (compile) {
      const cut = await growthTx(ctx, c => currentGrowthCut(ctx, row!, c));
      const identity = await growthIdentity(), now = Date.now();
      const body = compileOperatingProgram(cut.input, identity, now);
      const check = checkOperatingProgram(cut.input, body, identity, now);
      if (check.disposition !== "CHECKED_DEVELOPMENT") throw Error("W4_INDEPENDENT_PROGRAM_CHECK_REJECTED");
      await claim(ctx, payload, execution, true, true);
      await growthTx(ctx, async (c, db) => {
        const current = await growthRequest(ctx, row!.id, c, true);
        if (current.generation !== payload.generation || Number(current.wake_revision) !== payload.wakeRevision
          || current.claim_token !== execution.claimToken || Number(current.claim_fence) !== execution.claimFence
          || !await liveDelivery(c, current, payload, execution, true)) throw Error("W4_PUBLICATION_CLAIM_FENCED");
        const fresh = await currentGrowthCut(ctx, current, c);
        if (checkOperatingProgram(fresh.input, body, identity, Date.now()).disposition !== "CHECKED_DEVELOPMENT")
          throw Error("W4_ORIGINAL_SOURCE_CHANGED_BEFORE_PUBLICATION");
        const prior = (await c.query<{ id: string; body_digest: string }>(`SELECT id,body_digest
         FROM finnor_os.w4_business_artifacts WHERE tenant_id=$1 AND request_id=$2 AND generation=$3`,
        [current.tenant_id, current.id, current.generation])).rows[0];
        if (prior && prior.body_digest !== check.candidateDigest) throw Error("W4_IMMUTABLE_PUBLICATION_CONFLICT");
        const artifactId = prior?.id ?? (await c.query<{ id: string }>(`INSERT INTO finnor_os.w4_business_artifacts
         (tenant_id,principal_id,request_id,generation,body,body_digest,check_result)
         VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb) RETURNING id`,
        [current.tenant_id, current.principal_id, current.id, current.generation, canonical(body),
          check.candidateDigest, canonical(check)])).rows[0]!.id;
        const next = (await c.query<GrowthRequestRow>(`UPDATE finnor_os.w4_business_requests
         SET artifact_id=$3,status=$4,wake_revision=wake_revision+1,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2 AND claim_token=$5 AND claim_fence=$6
          AND clock_timestamp()<compile_deadline AND clock_timestamp()<original_deadline
          AND clock_timestamp()<(SELECT lease_expires_at FROM finnor_os.jobs
           WHERE tenant_id=$1 AND id=$7 AND claim_token=$5 AND claim_fence=$6 AND status='running') RETURNING *`,
        [current.tenant_id, current.id, artifactId, body.search.complete ? "CHECKED" : "PARTIAL",
          execution.claimToken, execution.claimFence, execution.jobId])).rows[0];
        if (!next) throw Error("W4_PUBLICATION_CLAIM_FENCED");
        await enqueueGrowth(c, next, false);
        await transitionWorkTx(db, current.tenant_id, current.work_id, "executing", "growth_program_checked",
          { requestId: current.id, artifactDigest: check.candidateDigest, originalBusinessAssignments: 1,
            assignedPopulation: body.assignedExposure.length, feasibleOffers: body.offers.length,
            genuineDemandEstablished: false, admissionGranted: false }, { expectedWorkInputId: current.work_input_id });
      });
      status = "CHECKED_DEVELOPMENT";
    } else {
      const result = await consumeGrowthProgram(ctx, row.id, async () => { await claim(ctx, payload, execution, false, true) });
      await claim(ctx, payload, execution, false, true);
      await growthTx(ctx, async (c, db) => {
        const current = await growthRequest(ctx, row!.id, c, true);
        if (current.generation !== payload.generation || Number(current.wake_revision) !== payload.wakeRevision
          || current.claim_token !== execution.claimToken || Number(current.claim_fence) !== execution.claimFence
          || !await liveDelivery(c, current, payload, execution, false)) throw Error("W4_OBSERVATION_PUBLICATION_FENCED");
        const artifact = await growthArtifact(ctx, current, c);
        const digest = hash({ requestId: current.id, artifact: artifact?.body_digest ?? null,
          projection: result.projection, gaps: result.gaps });
        const measured = await persistGrowthProjection(ctx, current, { ...result,
          artifactDigest: artifact?.body_digest ?? null, digest, rightsRef }, c);
        const p = result.projection, stopped = p?.decision === "STOP" || p?.decision === "STOP_NEW_EXPOSURE_RETAIN_OBLIGATIONS";
        const pending = p?.commitments.some(commitment => commitment.continuingObligations.length) ?? true;
        const nextStatus = p?.currentness === "STALE" ? "STALE" : stopped ? "STOPPED" : result.gaps.length ? "PARTIAL" : "CHECKED";
        const updated = await c.query(`UPDATE finnor_os.w4_business_requests SET status=$3,failure=NULL,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2 AND claim_token=$4 AND claim_fence=$5
          AND clock_timestamp()<(SELECT lease_expires_at FROM finnor_os.jobs
           WHERE tenant_id=$1 AND id=$6 AND claim_token=$4 AND claim_fence=$5 AND status='running')`,
        [current.tenant_id, current.id, nextStatus, execution.claimToken, execution.claimFence, execution.jobId]);
        if (updated.rowCount !== 1) throw Error("W4_OBSERVATION_PUBLICATION_FENCED");
        const occupationStatus = pending ? "RECONCILING" : stopped ? "STOPPED" : "PROGRESS";
        const occupied = await c.query(`UPDATE finnor_os.work_programme_occupations
         SET status=$4,revision=revision+CASE WHEN status IS DISTINCT FROM $4 THEN 1 ELSE 0 END,
          updated_at=clock_timestamp() WHERE tenant_id=$1 AND work_id=$2 AND owner='POSTZ.W4' AND programme_id=$3`,
        [current.tenant_id, current.work_id, current.id, occupationStatus]);
        if (occupied.rowCount !== 1) throw Error("W4_ORIGINAL_WORK_OCCUPATION_REQUIRED");
        if (!measured.semanticReplay) await transitionWorkTx(db, current.tenant_id, current.work_id,
          pending || stopped ? "recovery" : "executing", "growth_program_observed",
          { requestId: current.id, measurementRef: measured.record.ref, decision: p?.decision ?? "HOLD_UNKNOWN",
            commitments: p?.counts.accepted ?? 0, continuingCustomerObligations: pending,
            evidenceClass: "CONTROLLED", fieldValidated: false, originalBusinessAssignments: 1 },
          { expectedWorkInputId: current.work_input_id });
      });
      status = "OBSERVED_NOT_MARKET_OR_PROFIT_QUALIFIED";
    }
  } catch (error) {
    predicate = growthPredicate(error); status = "REFUSED_RESPONSIBILITY_RETAINED";
    if (row && !predicate.includes("FENCED")) await growthTx(ctx, async c => {
      await c.query(`UPDATE finnor_os.w4_business_requests SET failure=$5,status='UNKNOWN',updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND id=$2 AND claim_token=$3 AND claim_fence=$4
        AND EXISTS(SELECT 1 FROM finnor_os.jobs j WHERE j.tenant_id=$1 AND j.id=$6
         AND j.claim_token=$3 AND j.claim_fence=$4 AND j.status='running' AND j.lease_expires_at>clock_timestamp())`,
      [row!.tenant_id, row!.id, execution.claimToken, execution.claimFence, predicate, execution.jobId]);
    });
    if (!predicate.includes("FENCED")) throw error;
  } finally {
    if (row && rightsRef) {
      const used = process.cpuUsage(cpu);
      await persistGrowthCompute(ctx, row, execution, { startedAt, elapsedMs: performance.now() - started,
        cpuMicroseconds: used.user + used.system, stage: compile ? "COMPILE_CHECK" : "OBSERVE_CONSUME",
        status, predicate, charge, rightsRef });
    }
  }
}
export const compileMarketOperatingProgramJob = (payload: Record<string, unknown>, execution?: Readonly<JobExecutionContext>) =>
  run(payload, execution, true);
export const advanceMarketOperatingProgramJob = (payload: Record<string, unknown>, execution?: Readonly<JobExecutionContext>) =>
  run(payload, execution, false);
