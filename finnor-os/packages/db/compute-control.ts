import { randomUUID } from "node:crypto";
import { getPool } from "./index";

/** A bounded, fenced singleton lease for scheduler, recovery, and telemetry
 * publication.  It is coordination only; durable jobs remain the source of truth. */
export interface ComputeControlLease {
  leaseName: string;
  ownerId: string;
  token: string;
  fence: number;
}

export async function acquireComputeControlLease(
  leaseName: string,
  ownerId: string,
  ttlSeconds = 90,
): Promise<ComputeControlLease | null> {
  if (!leaseName || !ownerId || ttlSeconds < 15 || ttlSeconds > 3600) throw new Error("Invalid compute control lease envelope");
  const token = randomUUID();
  const result = await getPool().query<{ lease_token: string; fence: string }>(
    `INSERT INTO compute_control_leases(lease_name,owner_id,lease_token,fence,expires_at)
     VALUES($1,$2,$3,1,clock_timestamp()+($4::int || ' seconds')::interval)
     ON CONFLICT(lease_name) DO UPDATE
       SET owner_id=EXCLUDED.owner_id,lease_token=EXCLUDED.lease_token,
           fence=compute_control_leases.fence+1,
           acquired_at=clock_timestamp(),heartbeat_at=clock_timestamp(),
           expires_at=EXCLUDED.expires_at
     WHERE compute_control_leases.expires_at<=clock_timestamp()
     RETURNING lease_token,fence`,
    [leaseName, ownerId, token, ttlSeconds],
  );
  const row = result.rows[0];
  return row ? { leaseName, ownerId, token: row.lease_token, fence: Number(row.fence) } : null;
}

export async function renewComputeControlLease(lease: ComputeControlLease, ttlSeconds = 90): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE compute_control_leases
        SET heartbeat_at=clock_timestamp(),expires_at=clock_timestamp()+($5::int || ' seconds')::interval
      WHERE lease_name=$1 AND owner_id=$2 AND lease_token=$3 AND fence=$4
        AND expires_at>clock_timestamp()`,
    [lease.leaseName, lease.ownerId, lease.token, lease.fence, ttlSeconds],
  );
  return result.rowCount === 1;
}

export async function releaseComputeControlLease(lease: ComputeControlLease): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE compute_control_leases
        SET expires_at=GREATEST(clock_timestamp(),acquired_at+interval '1 microsecond'),
            heartbeat_at=clock_timestamp()
      WHERE lease_name=$1 AND owner_id=$2 AND lease_token=$3 AND fence=$4`,
    [lease.leaseName, lease.ownerId, lease.token, lease.fence],
  );
  return result.rowCount === 1;
}

export interface ComputeControlLeadership {
  isLeader(): boolean;
  stop(): void;
}

/** Every process makes one cheap lease attempt per interval. Only the winner does
 * semantic work; losing leaders immediately stop on failed renewal. */
export function startComputeControlLeadership(
  leaseName: string,
  ownerId: string,
  signal?: AbortSignal,
  onAcquire?: () => void,
  ttlSeconds = 90,
): ComputeControlLeadership {
  let lease: ComputeControlLease | null = null;
  let active = true;
  let inTick = false;
  const tick = async () => {
    if (!active || signal?.aborted || inTick) return;
    inTick = true;
    try {
      if (lease) {
        if (!(await renewComputeControlLease(lease, ttlSeconds))) lease = null;
      } else {
        lease = await acquireComputeControlLease(leaseName, ownerId, ttlSeconds);
        if (lease) onAcquire?.();
      }
    } catch (error) {
      lease = null;
      console.error(`[compute-control] ${leaseName} lease unavailable:`, error);
    } finally {
      inTick = false;
    }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, Math.max(5_000, Math.floor(ttlSeconds * 1000 / 3)));
  const stop = () => {
    active = false;
    clearInterval(timer);
    const owned = lease;
    lease = null;
    if (owned) void releaseComputeControlLease(owned).catch(() => undefined);
  };
  signal?.addEventListener("abort", stop, { once: true });
  return { isLeader: () => active && !signal?.aborted && lease !== null, stop };
}
