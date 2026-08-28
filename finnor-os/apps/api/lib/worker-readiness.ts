import { CURRENT_MIGRATION_HEAD, getPool } from "@finnor/db";

export interface WorkerFleetReadiness {
  migrationHead: string | null;
  healthyWorkers: number;
}

/** The API and worker use one release/migration identity for readiness. */
export async function readWorkerFleetReadiness(): Promise<WorkerFleetReadiness> {
  const result = await getPool().query<{
    migration_head: string | null;
    healthy_workers: number;
  }>(
    `SELECT
       (SELECT max(name) FROM finnor_os._migrations) AS migration_head,
       (SELECT count(*)::int FROM finnor_os.service_release_heartbeats
         WHERE service='worker'
           AND migration_head=$1
           AND ($2::text IS NULL OR release_sha=$2)
           AND last_beat_at>now()-interval '90 seconds') AS healthy_workers`,
    [CURRENT_MIGRATION_HEAD, process.env.FINNOR_COMMIT_SHA?.trim() || null],
  );
  const row = result.rows[0];
  return {
    migrationHead: row?.migration_head ?? null,
    healthyWorkers: Number(row?.healthy_workers ?? 0),
  };
}

function workerUnavailable(message: string): Error & { status: number; code: string } {
  const error = new Error(message) as Error & { status: number; code: string };
  error.status = 503;
  error.code = "worker_fleet_unavailable";
  return error;
}

/** Fail closed before accepting business Work that needs the worker fleet. */
export async function requireWorkerFleetReady(): Promise<void> {
  let readiness: WorkerFleetReadiness;
  try {
    readiness = await readWorkerFleetReadiness();
  } catch {
    throw workerUnavailable("Worker fleet readiness could not be verified");
  }
  if (readiness.migrationHead !== CURRENT_MIGRATION_HEAD || readiness.healthyWorkers < 1) {
    throw workerUnavailable(
      `Worker fleet is unavailable (migration=${readiness.migrationHead ?? "none"}, healthyWorkers=${readiness.healthyWorkers})`,
    );
  }
}
