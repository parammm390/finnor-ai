// Proactive scan scheduler (§14 extension) — the ONLY clock-driven trigger anywhere
// in this system; every other job is enqueued reactively (a gate firing, a webhook).
// No new table: reuses the existing `jobs.run_at` (implicit default now()) + the
// unique `idempotency_key` column, via enqueueJob()'s `ON CONFLICT DO NOTHING`.
//
// Design choice over "job re-enqueues itself on completion": a ticker that tries to
// enqueue every scan on every tick, bucketed into a time window via the idempotency
// key, is self-healing — if a scan job gets dead-lettered, the NEXT tick just tries
// again with a fresh bucket, rather than depending on the failed job to have
// re-scheduled its own successor (which would silently break the whole chain
// forever). The unique constraint is what makes "don't fire twice in the same
// window" atomic and safe under multiple ticker instances — never a separate
// read-last-run-then-write-last-run pair, which would race.

import { enqueueJob, getPool, readProductRuntimeAuthority } from "@finnor/db";
import { getLogger } from "@finnor/tools";
import { RetiredVerticalError, isRetiredWaterJob } from "@finnor/shared-types";

export interface ScheduledScan {
  /** Job type — must be registered as a handler in apps/worker/src/index.ts. */
  type: string;
  /** How often this scan should fire, at minimum — the bucket window size. */
  intervalHours: number;
  /** Per-tenant payload for this scan's job. */
  payload: (tenantId: string) => Record<string, unknown>;
}

/** Buckets "now" into a window the size of the interval, so the idempotency key is
 *  stable for the whole window and only changes once the window rolls over. */
function dateBucket(intervalHours: number): string {
  const iso = new Date().toISOString();
  if (intervalHours >= 24) return iso.slice(0, 10); // YYYY-MM-DD
  if (intervalHours >= 1) return iso.slice(0, 13); // YYYY-MM-DDTHH
  return iso.slice(0, 16); // YYYY-MM-DDTHH:MM (sub-hourly, mainly for tests)
}

async function activeTenantIds(): Promise<string[]> {
  await readProductRuntimeAuthority();
  const { rows } = await getPool().query(
    `SELECT t.id
       FROM tenants t
       JOIN tenant_vertical_assignments a ON a.tenant_id=t.id
       JOIN vertical_definitions v ON v.key=a.vertical_key
      WHERE v.active AND (
        a.vertical_key='private_equity'
        OR (a.vertical_key='none' AND a.source_system LIKE 'certification:%')
      )`,
  );
  return rows.map((r) => String(r.id));
}

/** One tick: for every tenant, try to enqueue every scan. Idempotent per (scan,
 *  tenant, window) — safe to call as often as you like, cheap to call redundantly. */
export async function scheduleTick(scans: ScheduledScan[]): Promise<void> {
  const retired = scans.find((scan) => isRetiredWaterJob(scan.type));
  if (retired) throw new RetiredVerticalError("water");
  const tenantIds = await activeTenantIds();
  for (const tenantId of tenantIds) {
    for (const scan of scans) {
      const bucket = dateBucket(scan.intervalHours);
      await enqueueJob(scan.type, scan.payload(tenantId), `scan:${scan.type}:${tenantId}:${bucket}`);
    }
  }
}

/** Starts a background ticker calling scheduleTick on the given cadence. Returns a
 *  stop function. Tick interval is independent of each scan's own intervalHours —
 *  it just needs to be frequent enough that no window is missed (a 15-minute ticker
 *  comfortably covers hourly-or-slower scans without meaningfully increasing DB load,
 *  since a no-op tick is a handful of ON CONFLICT DO NOTHING inserts). */
export function startScheduler(scans: ScheduledScan[], tickMs = 15 * 60_000, signal?: AbortSignal): void {
  const tick = async () => {
    if (signal?.aborted) return;
    try {
      await scheduleTick(scans);
    } catch (err) {
      getLogger().error({ err: err instanceof Error ? err.message : String(err) }, "[scheduler] tick failed");
    }
  };
  void tick(); // run once immediately on boot, don't wait a full interval for the first pass
  const handle = setInterval(tick, tickMs);
  signal?.addEventListener("abort", () => clearInterval(handle));
}

/** A4.T4: same idempotent-bucket mechanism as scheduleTick, but for a GLOBAL job type
 *  (no tenant loop) — worker_heartbeat.ts writes its own row directly instead of going
 *  through the job queue at all; backup_db is different: it's genuinely long-running
 *  and failure-prone (a real network call to GitHub), so it deliberately goes through
 *  the job queue's own attempt/backoff/dead-letter machinery rather than a bare
 *  setInterval callback that would just swallow a failure. */
export function startGlobalScheduler(type: string, intervalHours: number, tickMs = 15 * 60_000, signal?: AbortSignal): void {
  const tick = async () => {
    if (signal?.aborted) return;
    try {
      const bucket = dateBucket(intervalHours);
      await enqueueJob(type, {}, `scan:${type}:global:${bucket}`);
    } catch (err) {
      getLogger().error({ err: err instanceof Error ? err.message : String(err), type }, "[scheduler] global tick failed");
    }
  };
  void tick();
  const handle = setInterval(tick, tickMs);
  signal?.addEventListener("abort", () => clearInterval(handle));
}
