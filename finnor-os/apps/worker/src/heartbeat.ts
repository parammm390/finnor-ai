// A2.T4: worker dead-man switch. Two independent signals on the same 30s cadence —
// a durable DB row /api/vitals reads for staleness (migration 0035), and a
// healthchecks.io ping that alerts externally the moment beats stop arriving (the DB
// row alone can't page anyone; healthchecks.io is the part that actually notices the
// worker died). Every process has its own row so rolling releases and multi-worker
// fleets can be verified without pretending that one fixed process is the fleet.

import { CURRENT_MIGRATION_HEAD, adminDb, getPool, recordCutoverCompatibleHeartbeats, workerHeartbeat, type WorkloadClass, type CutoverHeartbeatInput } from "@finnor/db";
import { getLogger, getRuntimeReleaseMetadata } from "@finnor/tools";
import { hostname } from "node:os";
import { workerConcurrency } from "./queue";
import { activeSseConnectionCount } from "./sse/gateway";

export let WORKER_HEARTBEAT_ID = process.env.FINNOR_WORKER_INSTANCE_ID?.trim()
  || `worker:${hostname()}:${process.pid}`;
export { CURRENT_MIGRATION_HEAD } from "@finnor/db";

/** Bind all claim, lease and release evidence to the actual ECS task. Fargate
 * injects a task-local metadata endpoint; a production task that cannot prove
 * its identity must not contribute a possibly stale anonymous heartbeat. */
export async function initializeWorkerTaskIdentity(): Promise<void> {
  const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!metadataUri) {
    if (process.env.FINNOR_ENVIRONMENT === "production" && process.env.NODE_ENV === "production") {
      throw new Error("ECS task metadata endpoint is required in production");
    }
    return;
  }
  const response = await fetch(`${metadataUri}/task`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`ECS task metadata returned HTTP ${response.status}`);
  const metadata = await response.json() as { TaskARN?: unknown };
  const taskArn = metadata.TaskARN;
  if (typeof taskArn !== "string" || !/^arn:aws[a-z-]*:ecs:[a-z0-9-]+:\d{12}:task\/[A-Za-z0-9/_-]+$/.test(taskArn)) {
    throw new Error("ECS task metadata omitted a valid TaskARN");
  }
  const region = process.env.AWS_REGION;
  if (region && !taskArn.startsWith(`arn:aws:ecs:${region}:`)) throw new Error("ECS task metadata Region differs from configured Region");
  WORKER_HEARTBEAT_ID = `ecs:${taskArn}`;
  process.env.FINNOR_WORKER_INSTANCE_ID = WORKER_HEARTBEAT_ID;
}

export interface WorkerHeartbeatOptions {
  workloadClass: WorkloadClass | null;
  ownsScheduler: () => boolean;
}

const CLASS_CAPABILITIES: Record<WorkloadClass, string[]> = {
  REALTIME: ["jobs", "realtime", "sse"],
  INTERACTIVE: ["jobs", "orchestration", "event-wake", "workflow"],
  BACKGROUND: ["jobs", "recovery", "connection-health", "scheduled-scans"],
  HEAVY: ["jobs", "computer", "artifact"],
};

const CLASS_SERVICES: Record<WorkloadClass, CutoverHeartbeatInput["service"]> = {
  REALTIME: "compute-realtime",
  INTERACTIVE: "compute-interactive",
  BACKGROUND: "compute-background",
  HEAVY: "compute-heavy",
};

async function beat(options: WorkerHeartbeatOptions, draining = false): Promise<void> {
  const now = new Date();
  const release = getRuntimeReleaseMetadata("finnor-worker");
  const capabilities = options.workloadClass
    ? CLASS_CAPABILITIES[options.workloadClass]
    : (process.env.FINNOR_WORKER_CAPABILITIES ?? "jobs,orchestration,computer,event-wake,connection-health,realtime,sse")
      .split(",").map((value) => value.trim()).filter(Boolean);
  const meta = {
    ...release,
    instanceId: WORKER_HEARTBEAT_ID,
    taskArn: WORKER_HEARTBEAT_ID.startsWith("ecs:") ? WORKER_HEARTBEAT_ID.slice(4) : null,
    capabilities,
    serviceClass: options.workloadClass,
    allowedWorkloadClasses: options.workloadClass ? [options.workloadClass] : ["REALTIME", "INTERACTIVE", "BACKGROUND", "HEAVY"],
    processConcurrency: workerConcurrency(),
    draining,
    activeSseConnections: options.workloadClass === "REALTIME" ? activeSseConnectionCount() : 0,
    releaseSha: release.commitSha,
    coreCertificationId: process.env.FINNOR_CORE_CERTIFICATION_ID ?? null,
    deploymentId: process.env.FINNOR_WORKER_DEPLOYMENT_ID ?? null,
    environment: release.environment,
    source: release.source,
  };
  await adminDb()
    .insert(workerHeartbeat)
    .values({ id: WORKER_HEARTBEAT_ID, lastBeatAt: now, meta })
    .onConflictDoUpdate({ target: workerHeartbeat.id, set: { lastBeatAt: now, meta } });
  if (draining) {
    await getPool().query(
      "DELETE FROM service_release_heartbeats WHERE instance_id=$1 AND service=ANY($2::text[])",
      [WORKER_HEARTBEAT_ID, ["worker", "orchestrator", "scheduler-owner", ...Object.values(CLASS_SERVICES)]],
    );
    return;
  }
  const releaseSha = String(meta.releaseSha ?? "unknown");
  const common = {
    instanceId: WORKER_HEARTBEAT_ID,
    releaseSha,
    buildId: release.buildId,
    version: release.version,
    releaseSource: release.source,
    coreCertificationId: process.env.FINNOR_CORE_CERTIFICATION_ID ?? null,
    migrationHead: CURRENT_MIGRATION_HEAD,
    deploymentId: meta.deploymentId,
    environment: String(meta.environment ?? process.env.NODE_ENV ?? "unknown"),
  };
  const roles: CutoverHeartbeatInput[] = [{
    ...common,
    service: options.workloadClass ? CLASS_SERVICES[options.workloadClass] : "worker",
    capabilities: meta.capabilities,
  }];
  if (options.workloadClass === "INTERACTIVE" || options.workloadClass === null) {
    roles.push({ ...common, service: "orchestrator", capabilities: ["planning", "authority", "private-equity", ...meta.capabilities] });
  }
  if (options.ownsScheduler()) {
    roles.push({ ...common, service: "scheduler-owner", capabilities: ["scheduler", ...meta.capabilities] });
  }
  await recordCutoverCompatibleHeartbeats(roles);

  const pingUrl = process.env.HEALTHCHECK_PING_URL;
  if (!pingUrl) return; // ⏸ PARAM signup pending (see JARVIS-CREDENTIALS-LEDGER.md) — no-op, not a fake ping
  try {
    await fetch(pingUrl);
  } catch (err) {
    getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, "[heartbeat] healthchecks.io ping failed");
  }
}

export function startHeartbeat(
  intervalMs = 30_000,
  signal?: AbortSignal,
  options: WorkerHeartbeatOptions = { workloadClass: null, ownsScheduler: () => true },
): { markDraining(): Promise<void> } {
  const log = getLogger();
  const tick = () => {
    if (signal?.aborted) return;
    void beat(options).catch((err) => {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "[heartbeat] upsert failed");
    });
  };
  tick(); // first beat immediately on boot, not 30s after
  const handle = setInterval(tick, intervalMs);
  signal?.addEventListener("abort", () => {
    clearInterval(handle);
    void beat(options, true).catch((err) => {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "[heartbeat] drain beat failed");
    });
  }, { once: true });
  return { markDraining: () => beat(options, true) };
}
