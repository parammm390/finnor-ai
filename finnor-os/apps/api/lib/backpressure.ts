import {
  COMPUTE_CLASS_SCALE_TARGETS,
  COMPUTE_CUTOVER_EPOCH,
  COMPUTE_TELEMETRY_FRESHNESS_SECONDS,
  CURRENT_MIGRATION_HEAD,
  contractsForClass,
  getPool,
  type JobObligationKind,
  type WorkloadClass,
} from "@finnor/db";

export type WorkAcceptancePhase = "before_acceptance" | "after_acceptance";
export type BackpressureAction = "admit" | "defer_optional" | "preserve_accepted";

export interface ComputePressureSignals {
  workloadClass: WorkloadClass;
  eligibleQueued: number | null;
  tenantEligibleQueued: number | null;
  oldestEligibleAgeSeconds: number | null;
  runningJobs: number | null;
  freshRunningTasks: number | null;
  effectiveProcessSlots: number | null;
  backlogPerTask: number | null;
  globalGovernorSaturated: boolean | null;
  tenantGovernorSaturated: boolean | null;
  telemetryStatus: "healthy" | "degraded" | "missing" | "stale" | "unavailable";
  telemetryAgeSeconds: number | null;
  cutoverState: "preparing" | "authoritative" | "unknown";
  observedAt: string;
  readError?: string;
}

export interface ComputeBackpressureDecision {
  action: BackpressureAction;
  saturated: boolean;
  reasons: string[];
  signals: ComputePressureSignals;
}

function compatibilityForClass(workloadClass: WorkloadClass): string {
  return JSON.stringify(contractsForClass(workloadClass).flatMap(([type, contract]) =>
    contract.protocolVersions.map((protocolVersion) => ({ type, protocolVersion }))));
}

function unavailableSignals(workloadClass: WorkloadClass, error: unknown): ComputePressureSignals {
  return {
    workloadClass,
    eligibleQueued: null,
    tenantEligibleQueued: null,
    oldestEligibleAgeSeconds: null,
    runningJobs: null,
    freshRunningTasks: null,
    effectiveProcessSlots: null,
    backlogPerTask: null,
    globalGovernorSaturated: null,
    tenantGovernorSaturated: null,
    telemetryStatus: "unavailable",
    telemetryAgeSeconds: null,
    cutoverState: "unknown",
    observedAt: new Date().toISOString(),
    readError: error instanceof Error ? error.message : String(error),
  };
}

/** One canonical, class-aware pressure read shared by intake and /api/vitals.
 * Eligibility is based on due time plus the exact handler/protocol compatibility
 * contract. Future retries, unknown handlers, and other classes cannot inflate it. */
export async function readComputePressureSignals(
  tenantId: string,
  workloadClass: WorkloadClass,
): Promise<ComputePressureSignals> {
  const expectedReleaseSha = process.env.FINNOR_COMMIT_SHA?.trim() || null;
  try {
    const result = await getPool().query<{
      eligible_queued: string;
      tenant_eligible_queued: string;
      oldest_eligible_age_seconds: string | null;
      running_jobs: string;
      fresh_running_tasks: string;
      effective_process_slots: string;
      global_governor_saturated: boolean;
      tenant_governor_saturated: boolean;
      telemetry_status: "healthy" | "degraded" | null;
      telemetry_age_seconds: string | null;
      cutover_state: "preparing" | "authoritative" | null;
    }>(`
      WITH supported AS (
        SELECT type,"protocolVersion" AS protocol_version
          FROM jsonb_to_recordset($3::jsonb) AS row(type text,"protocolVersion" integer)
      ), eligible AS (
        SELECT j.run_at,j.tenant_id
          FROM jobs j JOIN supported s
            ON s.type=j.type AND s.protocol_version=j.protocol_version
         WHERE j.workload_class=$2 AND j.status='queued' AND j.run_at<=now()
           AND j.tenant_key<>'__missing_tenant__' AND j.required_compute_epoch<=$6
           AND EXISTS (SELECT 1 FROM compute_plane_cutover WHERE singleton=true AND state='authoritative')
      ), capacity AS (
        SELECT w.meta
          FROM service_release_heartbeats h
          JOIN worker_heartbeat w ON w.id=h.instance_id
         WHERE h.service='compute-'||lower($2) AND h.migration_head=$4
           AND ($5::text IS NULL OR h.release_sha=$5)
           AND h.last_beat_at>now()-interval '45 seconds'
           AND w.last_beat_at>now()-interval '45 seconds'
           AND w.meta->>'serviceClass'=$2 AND w.meta->>'draining'='false'
           AND w.meta->>'taskArn' IS NOT NULL
      ), governor AS (
        SELECT p.capacity,p.per_tenant_capacity,
               count(l.id) FILTER (WHERE l.released_at IS NULL AND l.expires_at>clock_timestamp()) AS active_total,
               count(l.id) FILTER (WHERE l.released_at IS NULL AND l.expires_at>clock_timestamp()
                 AND l.tenant_key=$1) AS active_tenant
          FROM compute_resource_policies p
          LEFT JOIN compute_resource_leases l ON l.resource_key=p.resource_key
         WHERE p.resource_key='model:global' AND p.enabled
         GROUP BY p.capacity,p.per_tenant_capacity
      ), publication AS (
        SELECT status,published_at
          FROM compute_telemetry_publications
         WHERE publisher_id LIKE $2||':%'
         ORDER BY published_at DESC LIMIT 1
      )
      SELECT (SELECT count(*) FROM eligible)::text AS eligible_queued,
             (SELECT count(*) FROM eligible WHERE tenant_id=$1::uuid)::text AS tenant_eligible_queued,
             (SELECT greatest(0,extract(epoch FROM now()-min(run_at))) FROM eligible)::text AS oldest_eligible_age_seconds,
             (SELECT count(*) FROM jobs WHERE workload_class=$2 AND status='running')::text AS running_jobs,
             (SELECT count(*) FROM capacity)::text AS fresh_running_tasks,
             (SELECT coalesce(sum(CASE WHEN (meta->>'processConcurrency')~'^[0-9]+$'
               THEN (meta->>'processConcurrency')::int ELSE 0 END),0) FROM capacity)::text AS effective_process_slots,
             coalesce((SELECT active_total>=capacity FROM governor),false) AS global_governor_saturated,
             coalesce((SELECT active_tenant>=per_tenant_capacity FROM governor),false) AS tenant_governor_saturated,
             (SELECT status FROM publication) AS telemetry_status,
             (SELECT greatest(0,extract(epoch FROM now()-published_at)) FROM publication)::text AS telemetry_age_seconds,
             (SELECT state FROM compute_plane_cutover WHERE singleton=true) AS cutover_state`,
    [tenantId, workloadClass, compatibilityForClass(workloadClass), CURRENT_MIGRATION_HEAD, expectedReleaseSha, COMPUTE_CUTOVER_EPOCH]);
    const row = result.rows[0];
    if (!row) throw new Error("compute pressure query returned no aggregate");
    const eligibleQueued = Number(row.eligible_queued);
    const freshRunningTasks = Number(row.fresh_running_tasks);
    const telemetryAgeSeconds = row.telemetry_age_seconds === null ? null : Number(row.telemetry_age_seconds);
    const telemetryStatus = row.telemetry_status === null
      ? "missing"
      : telemetryAgeSeconds !== null && telemetryAgeSeconds > COMPUTE_TELEMETRY_FRESHNESS_SECONDS
        ? "stale"
        : row.telemetry_status;
    return {
      workloadClass,
      eligibleQueued,
      tenantEligibleQueued: Number(row.tenant_eligible_queued),
      oldestEligibleAgeSeconds: row.oldest_eligible_age_seconds === null ? 0 : Number(row.oldest_eligible_age_seconds),
      runningJobs: Number(row.running_jobs),
      freshRunningTasks,
      effectiveProcessSlots: Number(row.effective_process_slots),
      backlogPerTask: eligibleQueued / Math.max(1, freshRunningTasks),
      globalGovernorSaturated: row.global_governor_saturated,
      tenantGovernorSaturated: row.tenant_governor_saturated,
      telemetryStatus,
      telemetryAgeSeconds,
      cutoverState: row.cutover_state ?? "unknown",
      observedAt: new Date().toISOString(),
    };
  } catch (error) {
    // Unknown/degraded is explicit. It must never be fabricated as zero pressure,
    // and an observation failure after Work acceptance cannot erase the obligation.
    return unavailableSignals(workloadClass, error);
  }
}

export function decideComputeBackpressure(input: {
  phase: WorkAcceptancePhase;
  obligationKind: JobObligationKind;
  signals: ComputePressureSignals;
}): ComputeBackpressureDecision {
  const target = COMPUTE_CLASS_SCALE_TARGETS[input.signals.workloadClass];
  const reasons: string[] = [];
  if (input.signals.oldestEligibleAgeSeconds !== null && input.signals.oldestEligibleAgeSeconds >= target.ageSeconds) reasons.push("oldest_eligible_age_target_exceeded");
  if (input.signals.backlogPerTask !== null && input.signals.backlogPerTask >= target.backlogPerTask) reasons.push("backlog_per_healthy_task_target_exceeded");
  if (input.signals.freshRunningTasks === 0 && (input.signals.eligibleQueued ?? 0) > 0) reasons.push("eligible_backlog_without_healthy_capacity");
  if (input.signals.globalGovernorSaturated) reasons.push("global_model_governor_saturated");
  if (input.signals.tenantGovernorSaturated) reasons.push("tenant_model_governor_saturated");
  if (["missing", "stale", "degraded", "unavailable"].includes(input.signals.telemetryStatus)) reasons.push(`telemetry_${input.signals.telemetryStatus}`);
  // Unknown telemetry is not proof of spare capacity. Optional, not-yet-accepted
  // work may wait; accepted required Work remains durable and must not be shed.
  const saturated = reasons.length > 0;
  if (!saturated) return { action: "admit", saturated: false, reasons, signals: input.signals };
  if (input.phase === "before_acceptance") {
    return { action: input.obligationKind === "coalescible" ? "defer_optional" : "admit", saturated: true, reasons, signals: input.signals };
  }
  return { action: "preserve_accepted", saturated: true, reasons, signals: input.signals };
}

/** Backward-compatible call site name. This is an observation after durable Work
 * acceptance; by construction it never throws a 429 or relabels required Work as
 * failed. Worker/governor paths own any durable delay. */
export async function enforceBatchBackpressure(input: {
  tenantId: string;
  workloadClass: WorkloadClass;
  phase: WorkAcceptancePhase;
  obligationKind: JobObligationKind;
}): Promise<ComputeBackpressureDecision> {
  return decideComputeBackpressure({
    phase: input.phase,
    obligationKind: input.obligationKind,
    signals: await readComputePressureSignals(input.tenantId, input.workloadClass),
  });
}
