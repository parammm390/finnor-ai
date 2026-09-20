// Postgres-backed job queue (§15–16): FOR UPDATE SKIP LOCKED polling, retry with
// backoff, dead-letter after max attempts. Every handler idempotent.

import { COMPUTE_CUTOVER_EPOCH, ComputeCapacityUnavailableError, classifyTrustedJobInstance, getPool, isProductionJobType, parseWorkloadClass, readProductRuntimeAuthority, resolveTenantVertical, type WorkloadClass } from "@finnor/db";
import { Sentry, logWithTrace } from "@finnor/tools";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { PoolClient } from "pg";
import { RETIRED_WATER_JOB_TYPES, RetiredVerticalError, isRetiredWaterJob } from "@finnor/shared-types";

export type JobRetrySafety = "pure" | "locally_idempotent" | "durably_effect_guarded" | "reconcilable" | "unsafe_legacy";

export interface JobExecutionContext {
  jobId: string;
  tenantId: string | null;
  deliveryAttemptId: string;
  claimToken: string;
  claimFence: number;
  protocolVersion: number;
  workerId: string;
  retrySafety: JobRetrySafety;
  registerHeartbeat(callback: () => Promise<boolean>): void;
}

export type JobHandler = (payload: Record<string, unknown>, context?: Readonly<JobExecutionContext>) => Promise<void>;
export type JobLane = "interactive" | "batch";

export interface JobHandlerContract {
  /** Compatibility is checked in SQL before claim. A future incompatible payload
   * gets a new versioned job type so old binaries cannot claim it either. */
  protocolVersions: readonly number[];
  retrySafety: JobRetrySafety;
  /** Production handlers declare their exact class capability in the canonical
   * compute registry. Test-only handlers may omit this. */
  allowedClasses?: readonly WorkloadClass[];
}

interface RegisteredHandler {
  handler: JobHandler;
  contract: JobHandlerContract;
}

interface ClaimedJob {
  id: string;
  tenantId: string | null;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  protocolVersion: number;
  retrySafety: JobRetrySafety;
  claimToken: string;
  claimFence: number;
  deliveryAttemptId: string;
  workloadClass: WorkloadClass;
}

/** Provider-neutral durable retry hint. Handlers never sleep while holding a worker
 * slot; the queue persists the next eligible run time. */
export class RetryableJobError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RetryableJobError";
    this.retryAfterMs = Math.max(1_000, Math.min(24 * 60 * 60_000, Math.ceil(retryAfterMs)));
  }
}

class WorkerDrainBeforeDispatchError extends Error {
  constructor() {
    super("Worker began draining before job handler dispatch");
    this.name = "WorkerDrainBeforeDispatchError";
  }
}

/** A process-level cap: the database claim remains the cross-process boundary. */
export function workerConcurrency(value = process.env.WORKER_CONCURRENCY): number {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 8 ? parsed : 1;
}

const DEFAULT_TENANT_INFLIGHT: Record<WorkloadClass, number> = {
  REALTIME: 1, INTERACTIVE: 2, BACKGROUND: 2, HEAVY: 1,
};

const DEFAULT_PRIORITY_AGING_SECONDS: Record<WorkloadClass, number> = {
  REALTIME: 5, INTERACTIVE: 60, BACKGROUND: 900, HEAVY: 1800,
};

/** Shared verbatim by execution and the disposable 100k-row query-plan proof. */
export const CLASS_CLAIM_SQL = `
  SELECT j.id,j.tenant_id AS "tenantId",j.type,j.payload,j.attempts,
         j.max_attempts AS "maxAttempts",j.protocol_version AS "protocolVersion",
         j.workload_class AS "workloadClass",j.tenant_key AS "tenantKey"
    FROM compute_tenant_claim_state s
    JOIN LATERAL (
      SELECT eligible.* FROM jobs eligible
       WHERE eligible.workload_class=$2 AND eligible.tenant_key=s.tenant_key
         AND eligible.status='queued' AND eligible.run_at<=now()
         AND EXISTS (
           SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS supported(type text,"protocolVersion" integer)
            WHERE supported.type=eligible.type AND supported."protocolVersion"=eligible.protocol_version
         )
       ORDER BY CASE WHEN eligible.run_at<=now()-($3::int || ' seconds')::interval THEN 0 ELSE 1 END,
                CASE WHEN eligible.run_at<=now()-($3::int || ' seconds')::interval THEN eligible.run_at END,
                eligible.priority DESC,eligible.run_at,eligible.id
       LIMIT 1
    ) j ON true
   WHERE s.workload_class=$2
     AND (SELECT count(*) FROM jobs active
           WHERE active.workload_class=$2 AND active.tenant_key=s.tenant_key
             AND active.status='running')<$4::int
   ORDER BY CASE WHEN j.run_at<=now()-($3::int || ' seconds')::interval THEN 0 ELSE 1 END,
            -- An aged tenant's obligation outranks another tenant's fresh
            -- high-priority flood; priority remains within each tenant.
            CASE WHEN j.run_at<=now()-($3::int || ' seconds')::interval
                 THEN s.last_claimed_at END NULLS FIRST,
            CASE WHEN j.run_at>now()-($3::int || ' seconds')::interval
                 THEN CASE WHEN j.priority>=100 THEN 0 WHEN j.priority>=50 THEN 1 ELSE 2 END END,
            s.last_claimed_at NULLS FIRST,s.tenant_key
   FOR UPDATE OF s SKIP LOCKED
   LIMIT 1`;

function boundedPositive(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : fallback;
}

export class JobQueue {
  private handlers = new Map<string, RegisteredHandler>();
  private authorityCheckedAt = 0;
  private authorityCheck: Promise<void> | null = null;
  private claimGate: Promise<void> = Promise.resolve();
  private emptyUntil = 0;
  readonly tenantInflightLimit: number;
  readonly priorityAgingSeconds: number;

  constructor(
    readonly instanceId = process.env.FINNOR_WORKER_INSTANCE_ID?.trim()
      || `worker:${hostname()}:${process.pid}`,
    readonly leaseSeconds = Math.max(process.env.NODE_ENV === "test" ? 3 : 30, Number(process.env.WORKER_JOB_LEASE_SECONDS ?? 300)),
    readonly workloadClass: WorkloadClass | null = process.env.FINNOR_WORKLOAD_CLASS
      ? parseWorkloadClass(process.env.FINNOR_WORKLOAD_CLASS) : null,
  ) {
    this.tenantInflightLimit = boundedPositive(process.env.FINNOR_TENANT_INFLIGHT_LIMIT,
      workloadClass ? DEFAULT_TENANT_INFLIGHT[workloadClass] : 8, 32);
    this.priorityAgingSeconds = boundedPositive(process.env.FINNOR_PRIORITY_AGING_SECONDS,
      workloadClass ? DEFAULT_PRIORITY_AGING_SECONDS[workloadClass] : 900, 86_400);
  }

  private async checkProductAuthority(): Promise<void> {
    if (Date.now() - this.authorityCheckedAt < 30_000) return;
    this.authorityCheck ??= readProductRuntimeAuthority()
      .then(() => { this.authorityCheckedAt = Date.now(); })
      .finally(() => { this.authorityCheck = null; });
    await this.authorityCheck;
  }

  register(
    type: string,
    handler: JobHandler,
    contract: JobHandlerContract = { protocolVersions: [1], retrySafety: "unsafe_legacy" },
  ): void {
    if (isRetiredWaterJob(type)) throw new RetiredVerticalError("water");
    if (contract.protocolVersions.length === 0
        || contract.protocolVersions.some((version) => !Number.isSafeInteger(version) || version < 1 || version > 1_000)) {
      throw new Error(`Job handler ${type} has an invalid protocol compatibility declaration`);
    }
    if (this.workloadClass && contract.allowedClasses && !contract.allowedClasses.includes(this.workloadClass)) return;
    this.handlers.set(type, {
      handler,
      contract: { ...contract, protocolVersions: [...new Set(contract.protocolVersions)].sort((a, b) => a - b) },
    });
  }

  registeredTypes(): string[] {
    return [...this.handlers.keys()].sort();
  }

  async enqueue(
    type: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
    lane: JobLane = "batch",
    priority = 0,
    protocolVersion = 1,
  ): Promise<void> {
    if (isRetiredWaterJob(type)) throw new RetiredVerticalError("water");
    const registration = this.handlers.get(type);
    if (registration && !registration.contract.protocolVersions.includes(protocolVersion)) {
      throw new Error(`Job handler ${type} is incompatible with protocol ${protocolVersion}`);
    }
    const tenantId = typeof payload.tenantId === "string" ? payload.tenantId : null;
    const classification = classifyTrustedJobInstance({ type, lane });
    if (classification.tenantScope === "tenant" && !tenantId) throw new Error(`${type} requires durable tenant identity`);
    if (isProductionJobType(type) && classification.tenantScope === "global" && tenantId) throw new Error(`${type} is global and cannot carry tenant identity`);
    if (tenantId) await resolveTenantVertical(tenantId);
    await getPool().query(
      `INSERT INTO jobs (tenant_id,type,payload,idempotency_key,lane,priority,protocol_version,retry_safety)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [tenantId, type, JSON.stringify(payload), idempotencyKey ?? null, lane, priority, protocolVersion, registration?.contract.retrySafety ?? "unsafe_legacy"],
    );
  }

  /**
   * A worker can disappear after changing a job to `running` and before its handler
   * returns. Reclaim only work whose lease has expired; never assume it failed or
   * silently discard it. A reclaimed job consumes an attempt exactly like a normal
   * failed run, so poison jobs still reach the dead-letter queue.
   */
  async recoverExpiredRunningJobs(leaseSeconds = this.leaseSeconds): Promise<number> {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      if (this.workloadClass) {
        const cutover = await client.query<{ state: string }>(
          "SELECT state FROM compute_plane_cutover WHERE singleton=true FOR SHARE",
        );
        if (cutover.rows[0]?.state !== "authoritative") {
          await client.query("COMMIT");
          return 0;
        }
      }
      const retired = await client.query<{ id: string }>(
        `SELECT id FROM jobs
          WHERE type=ANY($1::text[]) AND status IN ('queued','running','failed','dead_letter')
            AND ($2::text IS NULL OR workload_class=$2)
          ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100`,
        [RETIRED_WATER_JOB_TYPES, this.workloadClass],
      );
      const retiredIds = retired.rows.map((row) => row.id);
      if (retiredIds.length) {
        await client.query(
          `UPDATE job_delivery_attempts a
              SET outcome='reconciliation_required',finished_at=clock_timestamp(),
                  failure_kind='retired_vertical',failure_detail='Historical Water job is non-executable'
             FROM jobs j
            WHERE j.id=ANY($1::uuid[]) AND a.job_id=j.id AND a.claim_token=j.claim_token
              AND a.finished_at IS NULL`,
          [retiredIds],
        );
        await client.query(
          `UPDATE jobs SET status='quarantined',
             last_error='RETIRED_VERTICAL: historical Water job is non-executable',
             started_at=NULL,lease_owner=NULL,lease_expires_at=NULL,
             lease_heartbeat_at=NULL,claim_token=NULL
           WHERE id=ANY($1::uuid[])`,
          [retiredIds],
        );
      }
      const candidates = await client.query<{ id: string }>(
        `SELECT id FROM jobs
          WHERE status='running'
            AND ($1::text IS NULL OR workload_class=$1)
            AND coalesce(lease_expires_at,started_at+($2::int || ' seconds')::interval)<=now()
          ORDER BY lease_expires_at NULLS LAST,id
          FOR UPDATE SKIP LOCKED LIMIT 100`,
        [this.workloadClass, leaseSeconds],
      );
      const ids = candidates.rows.map((row) => row.id);
      if (ids.length === 0) {
        await client.query("COMMIT");
        return 0;
      }
      await client.query(
        `UPDATE job_delivery_attempts a
            SET outcome=CASE WHEN j.retry_safety IN ('pure','locally_idempotent','durably_effect_guarded')
                               AND j.type <> ALL($2::text[]) AND j.tenant_key<>'__missing_tenant__'
                              THEN 'lease_lost' ELSE 'reconciliation_required' END,
                finished_at=clock_timestamp(),failure_kind='lease_expired',
                failure_detail='Worker lease expired before durable completion'
           FROM jobs j
          WHERE j.id=ANY($1::uuid[]) AND a.job_id=j.id AND a.claim_token=j.claim_token
            AND a.finished_at IS NULL`,
        [ids, RETIRED_WATER_JOB_TYPES],
      );
      const recovered = await client.query(
        `UPDATE jobs
            SET status=CASE
                  WHEN type=ANY($2::text[]) OR tenant_key='__missing_tenant__'
                    OR retry_safety IN ('reconcilable','unsafe_legacy') THEN 'quarantined'
                  WHEN attempts>=max_attempts THEN 'dead_letter'
                  ELSE 'queued' END,
                last_error=CASE
                  WHEN type=ANY($2::text[]) THEN 'RETIRED_VERTICAL: historical Water job is non-executable'
                  WHEN tenant_key='__missing_tenant__' THEN 'SCOPE3_RECOVERY: missing durable tenant identity'
                  WHEN retry_safety IN ('reconcilable','unsafe_legacy') THEN
                    'Worker lease expired after a potentially consequential handler; automatic replay is prohibited'
                  ELSE 'Worker lease expired before the job completed' END,
                run_at=CASE WHEN attempts>=max_attempts THEN run_at
                  ELSE now()+(LEAST(300,30*power(2,GREATEST(attempts,1))) || ' seconds')::interval END,
                started_at=NULL,lease_owner=NULL,lease_expires_at=NULL,
                lease_heartbeat_at=NULL,claim_token=NULL
          WHERE id=ANY($1::uuid[]) AND status='running'`,
        [ids, RETIRED_WATER_JOB_TYPES],
      );
      await client.query("COMMIT");
      return recovered.rowCount ?? 0;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Claim and run one due job. Returns false when the queue is empty. */
  async tick(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false;
    await this.checkProductAuthority();
    if (signal?.aborted) return false;
    // A queue instance may intentionally host only a subset of handlers (tests,
    // lane-specific workers, rolling deploys). It must never claim and poison a job
    // it cannot execute; leave that row queued for a capable worker instead.
    const compatibility = [...this.handlers.entries()].flatMap(([type, registration]) =>
      registration.contract.protocolVersions.map((protocolVersion) => ({ type, protocolVersion })),
    );
    if (compatibility.length === 0) return false;
    // One process-level idle probe, not N identical empty SELECTs per slot. Claim
    // transactions are short; only execution remains concurrent.
    const previousClaim = this.claimGate;
    let releaseClaim!: () => void;
    this.claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
    await previousClaim;
    if (signal?.aborted) {
      releaseClaim();
      return false;
    }
    if (Date.now() < this.emptyUntil) {
      releaseClaim();
      return false;
    }
    let client: PoolClient | null = null;
    let job: ClaimedJob | null = null;
    try {
      client = await getPool().connect();
      try {
        await client.query("BEGIN");
        if (signal?.aborted) {
          await client.query("ROLLBACK");
          return false;
        }
        if (this.workloadClass) {
          // Hold a shared lock through the claim transaction. Activation needs
          // the row's exclusive lock, so no class claimant can race the epoch
          // change while the old monolith is still authoritative.
          const cutover = await client.query<{ state: string }>(
            "SELECT state FROM compute_plane_cutover WHERE singleton=true FOR SHARE",
          );
          if (cutover.rows[0]?.state !== "authoritative") {
            this.emptyUntil = Date.now() + 2_000;
            await client.query("COMMIT");
            return false;
          }
        }
        await client.query("SELECT set_config('finnor.compute_epoch',$1,true), set_config('finnor.workload_class',$2,true)", [
          String(COMPUTE_CUTOVER_EPOCH), this.workloadClass ?? "",
        ]);
        const compatibilityJson = JSON.stringify(compatibility);
        const { rows } = this.workloadClass
          ? await client.query(
            CLASS_CLAIM_SQL,
            [compatibilityJson, this.workloadClass, this.priorityAgingSeconds, this.tenantInflightLimit],
          )
          : await client.query(
            `SELECT id,tenant_id AS "tenantId",type,payload,attempts,
                    max_attempts AS "maxAttempts",protocol_version AS "protocolVersion",
                    workload_class AS "workloadClass",tenant_key AS "tenantKey"
               FROM jobs
              WHERE status='queued' AND run_at<=now()
                AND EXISTS (
                  SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS supported(type text,"protocolVersion" integer)
                   WHERE supported.type=jobs.type AND supported."protocolVersion"=jobs.protocol_version
                )
              ORDER BY CASE lane WHEN 'interactive' THEN 0 ELSE 1 END,priority DESC,run_at,id
              FOR UPDATE SKIP LOCKED LIMIT 1`,
            [compatibilityJson],
          );
        if (rows.length === 0) {
          this.emptyUntil = Date.now() + 2_000;
          await client.query("COMMIT");
          return false;
        }
        const candidate = rows[0] as Omit<ClaimedJob, "retrySafety" | "claimToken" | "claimFence" | "deliveryAttemptId"> & { tenantKey: string };
        const registration = this.handlers.get(candidate.type);
        if (!registration || !registration.contract.protocolVersions.includes(Number(candidate.protocolVersion))) {
          await client.query("ROLLBACK");
          return false;
        }
        const claimToken = randomUUID();
        const claimed = await client.query(
          `UPDATE jobs
              SET status = 'running', attempts = attempts + 1, started_at = now(),
                  lease_owner = $2,
                  lease_expires_at = now() + ($3 || ' seconds')::interval,
                  lease_heartbeat_at = now(),claim_token=$4,
                  claim_fence=claim_fence+1,retry_safety=$5,
                  tenant_id=coalesce(tenant_id,$6::uuid)
            WHERE id=$1 AND status='queued' AND protocol_version=$7
              AND ($8::text IS NULL OR workload_class=$8::text)
          RETURNING id,tenant_id AS "tenantId",type,payload,attempts,
                    max_attempts AS "maxAttempts",protocol_version AS "protocolVersion",
                    retry_safety AS "retrySafety",claim_token AS "claimToken",
                    claim_fence AS "claimFence",workload_class AS "workloadClass"`,
          [candidate.id, this.instanceId, String(this.leaseSeconds), claimToken,
            registration.contract.retrySafety, candidate.tenantId, candidate.protocolVersion, this.workloadClass],
        );
        if (claimed.rows.length !== 1) {
          await client.query("ROLLBACK");
          return false;
        }
        if (this.workloadClass) {
          await client.query(
            `UPDATE compute_tenant_claim_state
                SET last_claimed_at=clock_timestamp(),claim_count=claim_count+1,updated_at=clock_timestamp()
              WHERE workload_class=$1 AND tenant_key=$2`,
            [this.workloadClass, candidate.tenantKey],
          );
        }
        const claimedJob = claimed.rows[0] as Omit<ClaimedJob, "deliveryAttemptId">;
        const delivery = await client.query<{ id: string }>(
          `INSERT INTO job_delivery_attempts(
             job_id,tenant_id,claim_token,claim_fence,worker_id,protocol_version,retry_safety,outcome
           ) VALUES($1,$2,$3,$4,$5,$6,$7,'running') RETURNING id`,
          [claimedJob.id, claimedJob.tenantId, claimedJob.claimToken, claimedJob.claimFence,
            this.instanceId, claimedJob.protocolVersion, claimedJob.retrySafety],
        );
        job = { ...claimedJob, deliveryAttemptId: delivery.rows[0]!.id };
        // SIGTERM may arrive during a database round trip after the loop's
        // earlier check. A claim not yet committed must not become new work for
        // a draining process; the transaction rollback restores queue truth.
        if (signal?.aborted) {
          job = null;
          await client.query("ROLLBACK");
          return false;
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      }
    } finally {
      // The empty-queue path used to return before this ran, leaking one pooled
      // connection per idle poll — with production's max:2 (ssl) pool, two
      // consecutive empty ticks (~4s) permanently exhausted it and every later
      // getPool().connect() call hung forever waiting for a connection that was
      // never coming back, silently wedging the entire queue.
      client?.release();
      releaseClaim();
    }

    const registration = this.handlers.get(job.type);
    const handler = registration?.handler;
    // Phase 16(e): correlation id rides inside payload as _correlationId (enqueueJob's
    // doing) — fall back to the job's own id so every dispatch is greppable even when
    // no caller had a ctx to thread one through (draftKnownAction/system scans).
    const payload = job.payload as Record<string, unknown>;
    const correlationId = (payload._correlationId as string | undefined) ?? job.id;
    // A2.T2: every job's log line carries the same trace/tenant/action fields its
    // Sentry breadcrumb and the eventual DecisionReceipt do — the id printed here is
    // the one to grep for in Axiom/Sentry/the receipt for this exact execution.
    const log = logWithTrace({
      traceId: correlationId,
      tenantId: (payload.tenantId as string | undefined) ?? undefined,
      actionId: (payload.actionId as string | undefined) ?? undefined,
      jobType: job.type,
      jobId: job.id,
    });
    const start = Date.now();
    const claimHeartbeatCallbacks = new Set<() => Promise<boolean>>();
    const renewEveryMs = Math.max(1_000, Math.floor(this.leaseSeconds * 1_000 / 3));
    let leaseLost = false;
    const renewLease = async (): Promise<void> => {
      const result = await getPool().query(
        `WITH renewed AS (
           UPDATE jobs SET lease_expires_at=now()+($5 || ' seconds')::interval,lease_heartbeat_at=now()
            WHERE id=$1 AND status='running' AND lease_owner=$2 AND claim_token=$3 AND claim_fence=$4
            RETURNING id
         )
         UPDATE job_delivery_attempts SET heartbeat_at=now()
          WHERE id=$6 AND claim_token=$3 AND EXISTS (SELECT 1 FROM renewed)`,
        [job!.id, this.instanceId, job!.claimToken, job!.claimFence, String(this.leaseSeconds), job!.deliveryAttemptId],
      );
      if (result.rowCount !== 1) leaseLost = true;
      if (!leaseLost) {
        const outcomes = await Promise.all([...claimHeartbeatCallbacks].map((callback) => callback().catch(() => false)));
        if (outcomes.some((owned) => !owned)) leaseLost = true;
      }
    };
    const renewal = setInterval(() => {
      void renewLease().catch((error) => {
        leaseLost = true;
        log.error({ err: error instanceof Error ? error.message : String(error) }, "job lease renewal failed");
      });
    }, renewEveryMs);
    try {
      await Sentry.withScope(async (scope) => {
        scope.setTag("correlation_id", correlationId);
        scope.setTag("job_type", job.type);
        if (!handler) throw new Error(`No handler registered for job type ${job.type}`);
        if (signal?.aborted) throw new WorkerDrainBeforeDispatchError();
        await handler(payload, Object.freeze({
          jobId: job!.id,
          tenantId: job!.tenantId,
          deliveryAttemptId: job!.deliveryAttemptId,
          claimToken: job!.claimToken,
          claimFence: job!.claimFence,
          protocolVersion: job!.protocolVersion,
          workerId: this.instanceId,
          retrySafety: job!.retrySafety,
          registerHeartbeat: (callback: () => Promise<boolean>) => { claimHeartbeatCallbacks.add(callback); },
        }));
      });
      const ms = Date.now() - start;
      Sentry.addBreadcrumb({ category: "job", message: job.type, data: { ok: true, ms, correlationId } });
      log.info({ ok: true, ms }, `job ${job.type} completed`);
      if (leaseLost) throw new Error("Worker lost the durable job lease before completion could be committed");
      const completed = await getPool().query(
        `WITH finished AS (
           UPDATE jobs SET status='completed',completed_at=now(),started_at=NULL,
                           lease_owner=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL,claim_token=NULL
            WHERE id=$1 AND status='running' AND lease_owner=$2 AND claim_token=$3 AND claim_fence=$4
            RETURNING id
         )
         UPDATE job_delivery_attempts SET outcome='completed',finished_at=clock_timestamp(),heartbeat_at=clock_timestamp()
          WHERE id=$5 AND claim_token=$3 AND EXISTS (SELECT 1 FROM finished)`,
        [job.id, this.instanceId, job.claimToken, job.claimFence, job.deliveryAttemptId],
      );
      if (completed.rowCount !== 1) throw new Error("Worker no longer owns the durable job lease");
    } catch (err) {
      const ms = Date.now() - start;
      if (err instanceof WorkerDrainBeforeDispatchError) {
        // A shutdown can race the COMMIT response. No business handler ran, so
        // restore the queued obligation and logical attempt with a truthful
        // physical-delivery audit row. A stale owner cannot erase a successor.
        const drained = await getPool().query(`
          WITH returned AS (
            UPDATE jobs SET status='queued',attempts=greatest(0,attempts-1),
              started_at=NULL,lease_owner=NULL,lease_expires_at=NULL,
              lease_heartbeat_at=NULL,claim_token=NULL
             WHERE id=$1 AND status='running' AND lease_owner=$2
               AND claim_token=$3 AND claim_fence=$4 RETURNING id
          )
          UPDATE job_delivery_attempts SET outcome='drained_before_dispatch',
            finished_at=clock_timestamp(),failure_kind='worker_draining',
            failure_detail='SIGTERM before handler dispatch'
           WHERE id=$5 AND claim_token=$3 AND EXISTS(SELECT 1 FROM returned)`,
        [job.id, this.instanceId, job.claimToken, job.claimFence, job.deliveryAttemptId]);
        if (drained.rowCount !== 1) throw new Error("Worker lost the durable job lease while returning an undispatched claim");
        log.info({ ms }, `job ${job.type} returned to queue before dispatch on shutdown`);
        return false;
      }
      const capacityDeferred = err instanceof ComputeCapacityUnavailableError;
      const safelyReplayable = job.retrySafety === "pure"
        || job.retrySafety === "locally_idempotent"
        || job.retrySafety === "durably_effect_guarded";
      if (capacityDeferred && safelyReplayable) {
        // No provider request was made: capacity contention is not a business
        // failure or an exhausted retry.  Keep an audit row for the physical
        // delivery but restore the logical attempt and defer durably.
        const jitterMs = Number.parseInt(job.id.replaceAll("-", "").slice(-3), 16) % 3_000;
        const deferMs = Math.min(60_000, err.retryAfterMs + jitterMs);
        await getPool().query(`
          WITH deferred AS (
            UPDATE jobs SET status='queued',attempts=greatest(0,attempts-1),
              run_at=now()+($5::int || ' milliseconds')::interval,
              capacity_defer_count=capacity_defer_count+1,capacity_deferred_at=clock_timestamp(),
              capacity_defer_reason=$6,started_at=NULL,lease_owner=NULL,lease_expires_at=NULL,
              lease_heartbeat_at=NULL,claim_token=NULL
             WHERE id=$1 AND status='running' AND lease_owner=$2 AND claim_token=$3 AND claim_fence=$4
             RETURNING id
          )
          UPDATE job_delivery_attempts SET outcome='capacity_deferred',finished_at=clock_timestamp(),
            failure_kind='capacity_deferred',failure_detail=$6
           WHERE id=$7 AND claim_token=$3 AND EXISTS(SELECT 1 FROM deferred)`,
        [job.id, this.instanceId, job.claimToken, job.claimFence, deferMs, err.resourceKey, job.deliveryAttemptId]);
        log.warn({ resourceKey: err.resourceKey, deferMs, ms }, `job ${job.type} deferred for shared capacity`);
        return true;
      }
      Sentry.addBreadcrumb({ category: "job", message: job.type, data: { ok: false, ms, correlationId } });
      Sentry.captureException(err);
      log.error({ ok: false, ms, err: err instanceof Error ? err.message : String(err) }, `job ${job.type} failed`);
      const attempts = Number(job.attempts);
      const max = Number(job.maxAttempts ?? 3);
      const dead = attempts >= max;
      const automaticallyRetryable = safelyReplayable;
      const nextStatus = automaticallyRetryable ? (dead ? "dead_letter" : "queued") : "quarantined";
      const deliveryOutcome = automaticallyRetryable
        ? dead ? "dead_lettered" : "known_failed"
        : "reconciliation_required";
      const errDetail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      const retryDelayMs = err instanceof RetryableJobError
        ? err.retryAfterMs
        : 30_000 * 2 ** attempts;
      await getPool().query(
        `WITH finished AS (
           UPDATE jobs SET status=$5,last_error=$6,run_at=now()+($7 || ' milliseconds')::interval,
                           started_at=NULL,lease_owner=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL,claim_token=NULL
            WHERE id=$1 AND status='running' AND lease_owner=$2 AND claim_token=$3 AND claim_fence=$4
            RETURNING id
         )
         UPDATE job_delivery_attempts
            SET outcome=$8,finished_at=clock_timestamp(),heartbeat_at=clock_timestamp(),
                failure_kind=$9,failure_detail=$10
          WHERE id=$11 AND claim_token=$3 AND EXISTS (SELECT 1 FROM finished)`,
        [job.id, this.instanceId, job.claimToken, job.claimFence, nextStatus, errDetail,
          String(retryDelayMs), deliveryOutcome,
          err instanceof RetryableJobError ? "retryable" : "handler_error",
          err instanceof Error ? err.message : String(err), job.deliveryAttemptId],
      );
    } finally {
      clearInterval(renewal);
    }
    return true;
  }

  async runLoop(pollMs = 2000, signal?: AbortSignal, concurrency = workerConcurrency()): Promise<void> {
    // Each slot claims through FOR UPDATE SKIP LOCKED. The cap prevents one process
    // from turning an outage into an unbounded set of in-flight provider calls.
    await Promise.all(Array.from({ length: concurrency }, () => this.runSlot(pollMs, signal)));
  }

  private async runSlot(pollMs: number, signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      let worked = false;
      try {
        worked = await this.tick(signal);
      } catch (err) {
        console.error("[worker] tick failed:", err);
      }
      if (!worked && !signal?.aborted) await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
