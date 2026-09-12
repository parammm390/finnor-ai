// A2.T4: worker dead-man switch. Two independent signals on the same 30s cadence —
// a durable DB row /api/vitals reads for staleness (migration 0035), and a
// healthchecks.io ping that alerts externally the moment beats stop arriving (the DB
// row alone can't page anyone; healthchecks.io is the part that actually notices the
// worker died). Every process has its own row so rolling releases and multi-worker
// fleets can be verified without pretending that one fixed process is the fleet.

import { CURRENT_MIGRATION_HEAD, adminDb, recordCutoverCompatibleHeartbeat, workerHeartbeat } from "@finnor/db";
import { getLogger, getRuntimeReleaseMetadata } from "@finnor/tools";
import { hostname } from "node:os";

export const WORKER_HEARTBEAT_ID = process.env.FINNOR_WORKER_INSTANCE_ID?.trim()
  || `worker:${hostname()}:${process.pid}`;
export { CURRENT_MIGRATION_HEAD } from "@finnor/db";

async function beat(): Promise<void> {
  const now = new Date();
  const release = getRuntimeReleaseMetadata("finnor-worker");
  const meta = {
    ...release,
    instanceId: WORKER_HEARTBEAT_ID,
    capabilities: (process.env.FINNOR_WORKER_CAPABILITIES ?? "jobs,orchestration,computer,event-wake,connection-health,realtime,sse")
      .split(",").map((value) => value.trim()).filter(Boolean),
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
  await recordCutoverCompatibleHeartbeat({
    ...common,
    service: "worker",
    capabilities: meta.capabilities,
  });
  // The canonical production contract embeds the orchestrator in this worker
  // process.  Attest that owned runtime role separately so the Phase-5 cutover
  // barrier proves the real topology instead of waiting for a process that the
  // deployment contract explicitly says does not exist.
  await recordCutoverCompatibleHeartbeat({
    ...common,
    service: "orchestrator",
    capabilities: ["planning", "authority", "private-equity", ...meta.capabilities],
  });
  // The scheduler is co-owned by this persistent process today, but has a separate
  // provenance row so a future topology split cannot silently bypass the cutover.
  await recordCutoverCompatibleHeartbeat({
    ...common,
    service: "scheduler-owner",
    capabilities: ["scheduler", ...meta.capabilities],
  });

  const pingUrl = process.env.HEALTHCHECK_PING_URL;
  if (!pingUrl) return; // ⏸ PARAM signup pending (see JARVIS-CREDENTIALS-LEDGER.md) — no-op, not a fake ping
  try {
    await fetch(pingUrl);
  } catch (err) {
    getLogger().warn({ err: err instanceof Error ? err.message : String(err) }, "[heartbeat] healthchecks.io ping failed");
  }
}

export function startHeartbeat(intervalMs = 30_000, signal?: AbortSignal): void {
  const log = getLogger();
  const tick = () => {
    if (signal?.aborted) return;
    void beat().catch((err) => {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "[heartbeat] upsert failed");
    });
  };
  tick(); // first beat immediately on boot, not 30s after
  const handle = setInterval(tick, intervalMs);
  signal?.addEventListener("abort", () => clearInterval(handle));
}
