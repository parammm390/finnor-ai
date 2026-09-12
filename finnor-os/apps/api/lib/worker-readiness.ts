import { CURRENT_MIGRATION_HEAD, PHASE5_CUTOVER_PROTOCOL, getPool } from "@finnor/db";

export interface WorkerFleetReadiness {
  migrationHead: string | null;
  healthyWorkers: number;
  freshRuntimes: number;
  releaseShas: string[];
  productEpochs: number[];
  mixedReleaseRuntimes: number;
  mixedProductEpochRuntimes: number;
  mixedMigrationRuntimes: number;
  incompatibleProtocolRuntimes: number;
}

const CUTOVER_RUNTIME_SERVICES = ["api", "worker", "orchestrator", "supplier-canary", "scheduler-owner"] as const;

/** The API and worker use one release/migration identity for readiness. */
export async function readWorkerFleetReadiness(expectedReleaseSha = process.env.FINNOR_COMMIT_SHA?.trim() || null): Promise<WorkerFleetReadiness> {
  const result = await getPool().query<{
    migration_head: string | null;
    healthy_workers: number;
    fresh_runtimes: number;
    release_shas: string[] | null;
    product_epochs: number[] | null;
    mixed_release_runtimes: number;
    mixed_product_epoch_runtimes: number;
    mixed_migration_runtimes: number;
    incompatible_protocol_runtimes: number;
  }>(
    `WITH authority AS (
       SELECT epoch,minimum_cutover_protocol
         FROM finnor_os.product_runtime_authority
        WHERE authority_key='product'
     ), fresh AS (
       SELECT h.*
         FROM finnor_os.service_release_heartbeats h
        WHERE h.service=ANY($4::text[])
          AND h.last_beat_at>now()-interval '90 seconds'
     )
     SELECT
       (SELECT max(name) FROM finnor_os._migrations) AS migration_head,
       count(*) FILTER (
         WHERE service='worker'
           AND migration_head=$1
           AND ($2::text IS NULL OR release_sha=$2)
           AND cutover_protocol>=greatest($3,(SELECT minimum_cutover_protocol FROM authority))
           AND product_epoch=(SELECT epoch FROM authority)
       )::int AS healthy_workers,
       count(*)::int AS fresh_runtimes,
       coalesce(array_agg(DISTINCT release_sha ORDER BY release_sha)
         FILTER (WHERE release_sha IS NOT NULL),ARRAY[]::text[]) AS release_shas,
       coalesce(array_agg(DISTINCT product_epoch ORDER BY product_epoch)
         FILTER (WHERE product_epoch IS NOT NULL),ARRAY[]::integer[]) AS product_epochs,
       count(*) FILTER (WHERE $2::text IS NOT NULL AND release_sha IS DISTINCT FROM $2)::int AS mixed_release_runtimes,
       count(*) FILTER (WHERE product_epoch IS DISTINCT FROM (SELECT epoch FROM authority))::int AS mixed_product_epoch_runtimes,
       count(*) FILTER (WHERE migration_head IS DISTINCT FROM $1)::int AS mixed_migration_runtimes,
       count(*) FILTER (
         WHERE cutover_protocol<greatest($3,coalesce((SELECT minimum_cutover_protocol FROM authority),$3))
       )::int AS incompatible_protocol_runtimes
       FROM fresh`,
    [CURRENT_MIGRATION_HEAD, expectedReleaseSha, PHASE5_CUTOVER_PROTOCOL, CUTOVER_RUNTIME_SERVICES],
  );
  const row = result.rows[0];
  return {
    migrationHead: row?.migration_head ?? null,
    healthyWorkers: Number(row?.healthy_workers ?? 0),
    freshRuntimes: Number(row?.fresh_runtimes ?? 0),
    releaseShas: row?.release_shas ?? [],
    productEpochs: (row?.product_epochs ?? []).map(Number),
    mixedReleaseRuntimes: Number(row?.mixed_release_runtimes ?? 0),
    mixedProductEpochRuntimes: Number(row?.mixed_product_epoch_runtimes ?? 0),
    mixedMigrationRuntimes: Number(row?.mixed_migration_runtimes ?? 0),
    incompatibleProtocolRuntimes: Number(row?.incompatible_protocol_runtimes ?? 0),
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
