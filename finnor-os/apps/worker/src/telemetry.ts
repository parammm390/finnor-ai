import { COMPUTE_CLASS_SCALE_TARGETS, COMPUTE_CUTOVER_EPOCH, CURRENT_MIGRATION_HEAD, contractsForClass, getPool, startComputeControlLeadership, type WorkloadClass } from "@finnor/db";
import { getRuntimeReleaseMetadata } from "@finnor/tools";
import { WORKER_HEARTBEAT_ID } from "./heartbeat";

/** Engineering scale targets, not historical product SLO promises.  They are
 * intentionally configuration-controlled and must be certified under load. */
export const CLASS_SCALE_TARGETS = COMPUTE_CLASS_SCALE_TARGETS;

export interface ComputeTelemetrySnapshot {
  workloadClass: WorkloadClass;
  eligibleQueued: number;
  oldestEligibleAgeSeconds: number;
  runningJobs: number;
  activeSseConnections: number;
  freshRunningTasks: number;
  backlogPerTask: number;
  scalePressure: number;
  observedAt: string;
}

export function deriveComputeScalePressure(input: {
  workloadClass: WorkloadClass;
  eligibleQueued: number;
  oldestEligibleAgeSeconds: number;
  freshRunningTasks: number;
  runningJobs: number;
  activeSseConnections: number;
}): { backlogPerTask: number; scalePressure: number } {
  const backlogPerTask = input.eligibleQueued / Math.max(1, input.freshRunningTasks);
  const target = CLASS_SCALE_TARGETS[input.workloadClass];
  return {
    backlogPerTask,
    // ECS can stop any task during scale-in. Do not authorize a scale-in while
    // even one task owns an in-flight job or persistent SSE connection.
    scalePressure: Math.max(input.oldestEligibleAgeSeconds / target.ageSeconds,
      backlogPerTask / target.backlogPerTask,
      input.freshRunningTasks === 0 && input.eligibleQueued > 0 ? 2 : 0,
      input.runningJobs > 0 || input.activeSseConnections > 0 ? 1 : 0),
  };
}

export async function collectComputeTelemetry(workloadClass: WorkloadClass): Promise<ComputeTelemetrySnapshot> {
  const releaseSha = getRuntimeReleaseMetadata("finnor-worker").commitSha;
  const compatibility = JSON.stringify(contractsForClass(workloadClass).flatMap(([type, contract]) =>
    contract.protocolVersions.map((protocolVersion) => ({ type, protocolVersion }))));
  const result = await getPool().query<{
    queued: string; oldest_age: string | null; running: string; task_count: string; active_connections: string;
  }>(`
    WITH supported AS (
      SELECT type, "protocolVersion" AS protocol_version
        FROM jsonb_to_recordset($2::jsonb) AS row(type text,"protocolVersion" integer)
    ), eligible AS (
      SELECT j.run_at FROM jobs j JOIN supported s
        ON s.type=j.type AND s.protocol_version=j.protocol_version
       WHERE j.workload_class=$1 AND j.status='queued' AND j.run_at<=now()
         AND j.tenant_key<>'__missing_tenant__' AND j.required_compute_epoch<=$5
         AND EXISTS (SELECT 1 FROM compute_plane_cutover WHERE singleton=true AND state='authoritative')
    ), active AS (
      SELECT count(*) AS running FROM jobs
       WHERE workload_class=$1 AND status='running'
    ), capacity AS (
      SELECT w.meta FROM service_release_heartbeats h
        JOIN worker_heartbeat w ON w.id=h.instance_id
       WHERE h.service='compute-'||lower($1) AND h.release_sha=$3
         AND h.migration_head=$4 AND h.last_beat_at>now()-interval '45 seconds'
         AND w.last_beat_at>now()-interval '45 seconds'
         AND w.meta->>'serviceClass'=$1 AND w.meta->>'draining'='false'
         AND w.meta->>'taskArn' IS NOT NULL
    ), connections AS (
      SELECT coalesce(sum(CASE WHEN jsonb_typeof(meta->'activeSseConnections')='number'
        THEN (meta->>'activeSseConnections')::int ELSE 0 END),0) AS active_connections
        FROM capacity WHERE $1='REALTIME'
    )
    SELECT (SELECT count(*) FROM eligible)::text AS queued,
           (SELECT greatest(0,extract(epoch FROM now()-min(run_at))) FROM eligible)::text AS oldest_age,
           (SELECT running FROM active)::text AS running,
           (SELECT count(*) FROM capacity)::text AS task_count,
           (SELECT active_connections FROM connections)::text AS active_connections`,
  [workloadClass, compatibility, releaseSha, CURRENT_MIGRATION_HEAD, COMPUTE_CUTOVER_EPOCH]);
  const row = result.rows[0];
  if (!row) throw new Error(`No compute telemetry aggregate for ${workloadClass}`);
  const eligibleQueued = Number(row.queued);
  const oldestEligibleAgeSeconds = Number(row.oldest_age ?? 0);
  const freshRunningTasks = Number(row.task_count);
  const runningJobs = Number(row.running);
  const activeSseConnections = Number(row.active_connections);
  const { backlogPerTask, scalePressure } = deriveComputeScalePressure({
    workloadClass,
    eligibleQueued,
    oldestEligibleAgeSeconds,
    freshRunningTasks,
    runningJobs,
    activeSseConnections,
  });
  return {
    workloadClass,
    eligibleQueued,
    oldestEligibleAgeSeconds,
    runningJobs,
    activeSseConnections,
    freshRunningTasks,
    backlogPerTask,
    scalePressure,
    observedAt: new Date().toISOString(),
  };
}

/** CloudWatch Embedded Metric Format: one elected publisher per class, no
 * high-cardinality dimensions.  Missing publication is intentionally not zero;
 * the scale-in alarm treats missing data as non-breaching. */
export function emitComputeMetrics(snapshot: ComputeTelemetrySnapshot): void {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.parse(snapshot.observedAt),
      CloudWatchMetrics: [{
        Namespace: "FINNOR/ComputePlane",
        Dimensions: [["Environment", "ServiceClass"]],
        Metrics: [
          { Name: "EligibleQueued", Unit: "Count" },
          { Name: "OldestEligibleAgeSeconds", Unit: "Seconds" },
          { Name: "RunningJobs", Unit: "Count" },
          { Name: "ActiveSseConnections", Unit: "Count" },
          { Name: "FreshRunningTasks", Unit: "Count" },
          { Name: "BacklogPerTask", Unit: "Count" },
          { Name: "ScalePressure", Unit: "None" },
          { Name: "TelemetryDegraded", Unit: "Count" },
        ],
      }],
    },
    Environment: process.env.FINNOR_ENVIRONMENT ?? "unknown",
    ServiceClass: snapshot.workloadClass,
    EligibleQueued: snapshot.eligibleQueued,
    OldestEligibleAgeSeconds: snapshot.oldestEligibleAgeSeconds,
    RunningJobs: snapshot.runningJobs,
    ActiveSseConnections: snapshot.activeSseConnections,
    FreshRunningTasks: snapshot.freshRunningTasks,
    BacklogPerTask: snapshot.backlogPerTask,
    ScalePressure: snapshot.scalePressure,
    TelemetryDegraded: 0,
  }));
}

export function startComputeTelemetry(workloadClass: WorkloadClass, signal: AbortSignal): void {
  if (process.env.P3_DISABLE_TELEMETRY === "1") return;
  const leadership = startComputeControlLeadership(`telemetry:${workloadClass}`, WORKER_HEARTBEAT_ID, signal);
  let publishing = false;
  const publish = async () => {
    if (!leadership.isLeader() || publishing || signal.aborted) return;
    publishing = true;
    try {
      const snapshot = await collectComputeTelemetry(workloadClass);
      if (!leadership.isLeader()) return;
      const releaseSha = getRuntimeReleaseMetadata("finnor-worker").commitSha;
      await getPool().query(`
        INSERT INTO compute_telemetry_publications(publisher_id,release_sha,status,snapshot,published_at,error)
        VALUES($1,$2,'healthy',$3::jsonb,clock_timestamp(),NULL)
        ON CONFLICT(publisher_id) DO UPDATE
          SET release_sha=EXCLUDED.release_sha,status=EXCLUDED.status,snapshot=EXCLUDED.snapshot,
              published_at=EXCLUDED.published_at,error=NULL`,
      [`${workloadClass}:${WORKER_HEARTBEAT_ID}`, releaseSha, JSON.stringify(snapshot)]);
      emitComputeMetrics(snapshot);
    } catch (error) {
      console.error(`[compute-telemetry] ${workloadClass} publication failed:`, error);
      // Failure is an explicit unsafe-scale-in signal, never a fabricated zero.
      // If the DB is down this update may fail too; missing CloudWatch datapoints
      // are configured as non-breaching for the scale-in alarm.
      const message = error instanceof Error ? error.message : String(error);
      await getPool().query(`
        INSERT INTO compute_telemetry_publications(publisher_id,release_sha,status,snapshot,published_at,error)
        VALUES($1,$2,'degraded','{}'::jsonb,clock_timestamp(),$3)
        ON CONFLICT(publisher_id) DO UPDATE
          SET status='degraded',published_at=EXCLUDED.published_at,error=EXCLUDED.error`,
      [`${workloadClass}:${WORKER_HEARTBEAT_ID}`, getRuntimeReleaseMetadata("finnor-worker").commitSha, message.slice(0, 1_000)]).catch(() => undefined);
      console.log(JSON.stringify({
        _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: "FINNOR/ComputePlane",
          Dimensions: [["Environment", "ServiceClass"]], Metrics: [
            { Name: "ScalePressure", Unit: "None" }, { Name: "TelemetryDegraded", Unit: "Count" },
          ] }] },
        Environment: process.env.FINNOR_ENVIRONMENT ?? "unknown",
        ServiceClass: workloadClass,
        ScalePressure: 1,
        TelemetryDegraded: 1,
      }));
    } finally {
      publishing = false;
    }
  };
  const timer = setInterval(() => { void publish(); }, 60_000);
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  setTimeout(() => { void publish(); }, 3_000);
}
