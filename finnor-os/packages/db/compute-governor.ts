import { randomUUID } from "node:crypto";
import { getPool } from "./index";
import { parseWorkloadClass, type WorkloadClass } from "./compute-contract";

export class ComputeCapacityUnavailableError extends Error {
  readonly retryAfterMs: number;
  constructor(readonly resourceKey: string, retryAfterMs = 5_000) {
    super(`Shared compute capacity is unavailable for ${resourceKey}`);
    this.name = "ComputeCapacityUnavailableError";
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ComputeResourceLease {
  resourceKey: string;
  token: string;
  fence: number;
  ownerId: string;
  leaseSeconds: number;
}

/** Application/API calls default to interactive; worker calls use their explicit
 * service class.  A browser voice call is REALTIME even though it is not a job. */
export function currentComputeClass(channel?: string): WorkloadClass {
  if (process.env.FINNOR_WORKLOAD_CLASS) return parseWorkloadClass(process.env.FINNOR_WORKLOAD_CLASS);
  return channel === "voice" ? "REALTIME" : channel === "background" ? "BACKGROUND" : "INTERACTIVE";
}

/** Acquire every configured policy atomically in deterministic key order.  The
 * caller never owns a DB connection while doing external work.  Missing optional
 * model-specific policy means only the configured global/provider envelopes
 * apply; the model wrapper separately requires the global model policy. */
export async function acquireComputeResourceLeases(input: {
  resourceKeys: string[];
  requiredResourceKeys?: string[];
  tenantId: string | null;
  workloadClass: WorkloadClass;
  ownerId: string;
}): Promise<ComputeResourceLease[]> {
  const keys = [...new Set(input.resourceKeys)].sort();
  if (keys.length === 0) throw new Error("A compute invocation requires at least one resource policy key");
  const tenantKey = input.tenantId ?? "__global__";
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const policies = await client.query<{
      resource_key: string; capacity: number; per_tenant_capacity: number;
      interactive_reserve: number; lease_seconds: number; next_fence: string;
    }>(`
      SELECT resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,next_fence
        FROM compute_resource_policies WHERE resource_key=ANY($1::text[]) AND enabled
       ORDER BY resource_key FOR UPDATE`, [keys]);
    const configured = new Set(policies.rows.map((row) => row.resource_key));
    const missingRequired = [...new Set(input.requiredResourceKeys ?? [])].filter((key) => !configured.has(key));
    if (missingRequired.length) {
      throw new Error(`Mandatory compute resource policy is absent or disabled: ${missingRequired.join(", ")}`);
    }
    for (const policy of policies.rows) {
      const active = await client.query<{ total: string; tenant: string }>(`
        SELECT count(*)::text AS total,
               count(*) FILTER (WHERE tenant_key=$2)::text AS tenant
          FROM compute_resource_leases
         WHERE resource_key=$1 AND released_at IS NULL AND expires_at>clock_timestamp()`,
      [policy.resource_key, tenantKey]);
      const total = Number(active.rows[0]?.total ?? 0);
      const tenant = Number(active.rows[0]?.tenant ?? 0);
      // A low-priority call cannot borrow the foreground reserve: leases are
      // intentionally non-preemptive, so lending it while idle could strand an
      // interactive call that arrives one millisecond later.
      const reserved = policy.interactive_reserve;
      const classLimit = input.workloadClass === "BACKGROUND" || input.workloadClass === "HEAVY"
        ? Math.max(0, policy.capacity - reserved) : policy.capacity;
      if (total >= classLimit || tenant >= policy.per_tenant_capacity) {
        throw new ComputeCapacityUnavailableError(policy.resource_key);
      }
    }
    const leases: ComputeResourceLease[] = [];
    for (const policy of policies.rows) {
      const token = randomUUID();
      const fence = Number(policy.next_fence);
      await client.query("UPDATE compute_resource_policies SET next_fence=next_fence+1 WHERE resource_key=$1", [policy.resource_key]);
      await client.query(`
        INSERT INTO compute_resource_leases(
          resource_key,tenant_key,workload_class,owner_id,lease_token,fence,expires_at
        ) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+($7::int || ' seconds')::interval)`,
      [policy.resource_key, tenantKey, input.workloadClass, input.ownerId, token, fence, policy.lease_seconds]);
      leases.push({ resourceKey: policy.resource_key, token, fence, ownerId: input.ownerId,
        leaseSeconds: policy.lease_seconds });
    }
    await client.query("COMMIT");
    return leases;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Renew only a complete, still-live owned permit set. The transaction ensures
 * that a partial or expired set cannot be presented as a valid global capacity
 * reservation. A stale token/fence cannot revive or release a successor. */
export async function renewComputeResourceLeases(leases: readonly ComputeResourceLease[]): Promise<boolean> {
  if (leases.length === 0) return true;
  const owned = JSON.stringify(leases.map((lease) => ({ resource_key: lease.resourceKey,
    token: lease.token, fence: lease.fence, owner_id: lease.ownerId })));
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const matched = await client.query<{ id: string }>(`
      SELECT l.id FROM compute_resource_leases l
      JOIN jsonb_to_recordset($1::jsonb) AS owned(resource_key text,token uuid,fence bigint,owner_id text)
        ON l.resource_key=owned.resource_key AND l.lease_token=owned.token
       AND l.fence=owned.fence AND l.owner_id=owned.owner_id
     WHERE l.released_at IS NULL AND l.expires_at>clock_timestamp()
     ORDER BY l.resource_key FOR UPDATE OF l`, [owned]);
    if (matched.rows.length !== leases.length) {
      await client.query("ROLLBACK");
      return false;
    }
    const renewed = await client.query(`
      UPDATE compute_resource_leases l
         SET heartbeat_at=clock_timestamp(),
             expires_at=clock_timestamp()+(p.lease_seconds::text||' seconds')::interval
        FROM compute_resource_policies p
       WHERE l.id=ANY($1::uuid[]) AND p.resource_key=l.resource_key`,
    [matched.rows.map((row) => row.id)]);
    if (renewed.rowCount !== leases.length) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function releaseComputeResourceLeases(leases: ComputeResourceLease[], reason: string): Promise<void> {
  if (leases.length === 0) return;
  await getPool().query(`
    UPDATE compute_resource_leases l
       SET released_at=clock_timestamp(),release_reason=$2
      FROM jsonb_to_recordset($1::jsonb) AS owned(resource_key text,token uuid,fence bigint,owner_id text)
     WHERE l.resource_key=owned.resource_key AND l.lease_token=owned.token
       AND l.fence=owned.fence AND l.owner_id=owned.owner_id AND l.released_at IS NULL`,
  [JSON.stringify(leases.map((lease) => ({ resource_key: lease.resourceKey, token: lease.token, fence: lease.fence, owner_id: lease.ownerId }))), reason]);
}

async function executeWithRenewedLeases<T>(
  leases: ComputeResourceLease[], invoke: (capacitySignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const intervalMs = Math.max(1_000, Math.floor(Math.min(...leases.map((lease) => lease.leaseSeconds)) * 1_000 / 3));
  let renewal: Promise<void> | null = null;
  let renewalFailure: Error | null = null;
  const timer = setInterval(() => {
    if (renewal || renewalFailure) return;
    renewal = renewComputeResourceLeases(leases)
      .then((owned) => { if (!owned) throw new Error("Compute capacity lease ownership was lost"); })
      .catch((error: unknown) => {
        renewalFailure = error instanceof Error ? error : new Error(String(error));
        controller.abort(renewalFailure);
      })
      .finally(() => { renewal = null; });
  }, intervalMs);
  let result: T;
  try {
    result = await invoke(controller.signal);
  } finally {
    clearInterval(timer);
    if (renewal) await renewal;
  }
  if (renewalFailure) throw renewalFailure;
  return result;
}

/** Every current model adapter has a bounded physical request (8s; fallback
 * chains share a <=60s deadline).  Policy leases last 120s, exceeding the maximum
 * physical lifetime, so expiry cannot authorize overlapping active calls. */
export async function withGovernedModelInvocation<T>(input: {
  provider: string;
  model: string;
  tenantId?: string;
  channel?: string;
  ownerId?: string;
}, invoke: () => Promise<T>): Promise<T> {
  if (process.env.FINNOR_ENVIRONMENT !== "production" && process.env.P3_GOVERNORS !== "1") return invoke();
  const ownerId = input.ownerId ?? `model:${randomUUID()}`;
  const leases = await acquireComputeResourceLeases({
    resourceKeys: ["model:global", `model-provider:${input.provider}`, `model:${input.provider}:${input.model}`],
    requiredResourceKeys: ["model:global", `model-provider:${input.provider}`],
    tenantId: input.tenantId ?? null,
    workloadClass: currentComputeClass(input.channel),
    ownerId,
  });
  try {
    return await executeWithRenewedLeases(leases, invoke);
  } finally {
    // Failure to release leaves a bounded 120s lease, never unbounded capacity.
    await releaseComputeResourceLeases(leases, "invocation_finished").catch((error) => {
      console.error("[compute-governor] model permit release failed:", error);
    });
  }
}

/** Bound a configured physical provider operation across every API/worker task.
 * The policy lease must exceed the caller's hard request deadline; this helper is
 * intentionally for bounded operations, not an unbounded browser session. */
export async function withGovernedProviderInvocation<T>(input: {
  provider: string;
  tenantId?: string;
  channel?: string;
  ownerId?: string;
}, invoke: (capacitySignal: AbortSignal) => Promise<T>): Promise<T> {
  if (process.env.FINNOR_ENVIRONMENT !== "production" && process.env.P3_GOVERNORS !== "1") return invoke(new AbortController().signal);
  const resourceKey = `provider:${input.provider}`;
  const leases = await acquireComputeResourceLeases({
    resourceKeys: [resourceKey],
    requiredResourceKeys: [resourceKey],
    tenantId: input.tenantId ?? null,
    workloadClass: currentComputeClass(input.channel),
    ownerId: input.ownerId ?? `${resourceKey}:${randomUUID()}`,
  });
  try {
    return await executeWithRenewedLeases(leases, invoke);
  } finally {
    await releaseComputeResourceLeases(leases, "invocation_finished").catch((error) => {
      console.error("[compute-governor] provider permit release failed:", error);
    });
  }
}
