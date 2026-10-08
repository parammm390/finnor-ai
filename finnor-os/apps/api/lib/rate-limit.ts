// Fixed-window rate limiting against api_rate_limits (packages/db/migrations/
// 0006_security_controls.sql) — a real composite PK (bucket_key, window_started_at)
// makes the increment atomic under concurrent requests, not just app-level counting.

import { getPool, queryWithExecutionDeadline, DatabaseExecutionDeadlineError } from "@finnor/db";
import Redis from "ioredis";

const DEFAULT_LIMIT_PER_MINUTE = 120;
const WINDOW_MS = 60_000;
type RedisCounter = {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
  connect?: () => Promise<unknown>;
  status?: string;
};
let redis: RedisCounter | null | undefined;
let redisOverride: RedisCounter | null | undefined;
let redisConnectPromise: Promise<unknown> | null = null;
let redisUnavailableUntil = 0;
const memoryCounts = new Map<string, { count: number; expiresAt: number }>();
const REDIS_RECOVERY_WINDOW_MS = 60_000;

function mayUseProcessLocalFallback(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.FINNOR_ENVIRONMENT !== "production";
}

/** Test seam + explicit resilience behavior. The transactional Postgres counter is
 * the production default: opening one Redis socket from every independently scaled
 * API route exhausts small Redis plans under normal dashboard polling. Redis remains
 * an explicit opt-in (`RATE_LIMIT_BACKEND=redis`) and a test seam. */
export function setRateLimitRedisForTesting(value: RedisCounter | null | undefined): void {
  redisOverride = value;
  redis = undefined;
  redisConnectPromise = null;
  redisUnavailableUntil = 0;
}

function redisClient(): RedisCounter | null {
  if (redisOverride !== undefined) return redisOverride;
  if (redis !== undefined) return redis;
  if (process.env.RATE_LIMIT_BACKEND !== "redis") return (redis = null);
  if (!process.env.REDIS_URL) return (redis = null);
  const client = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false, connectTimeout: 1_000 });
  client.on("error", () => undefined); // failure is handled at the call boundary below
  return (redis = client);
}

async function ensureRedisReady(client: RedisCounter): Promise<void> {
  if (!client.connect || client.status === "ready") return;
  if (!redisConnectPromise) {
    redisConnectPromise = client.connect().catch((error) => {
      redisConnectPromise = null;
      throw error;
    });
  }
  await redisConnectPromise;
}

function memoryCheck(key: string, limit: number): boolean {
  const now = Date.now();
  const existing = memoryCounts.get(key);
  const row = !existing || existing.expiresAt <= now ? { count: 0, expiresAt: now + WINDOW_MS } : existing;
  row.count += 1; memoryCounts.set(key, row);
  return row.count <= limit;
}

export async function checkRateLimit(bucketKey: string, limit = Number(process.env.RATE_LIMIT_PER_MINUTE ?? DEFAULT_LIMIT_PER_MINUTE)): Promise<boolean> {
  const windowStartedAt = new Date(Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS);
  const key = `rate:${bucketKey}:${windowStartedAt.toISOString()}`;
  const client = redisClient();
  if (client && Date.now() >= redisUnavailableUntil) {
    try {
      // `enableOfflineQueue:false` is important for bounded serverless latency,
      // but a lazy ioredis client must be connected before its first command.
      // Without this handshake every cold start rejected INCR as "not writeable"
      // even when Redis itself was healthy.
      await ensureRedisReady(client);
      const count = await client.incr(key);
      if (count === 1) await client.pexpire(key, WINDOW_MS);
      return count <= limit;
    } catch (error) {
      redisUnavailableUntil = Date.now() + REDIS_RECOVERY_WINDOW_MS;
      if (!mayUseProcessLocalFallback()) {
        console.error("[rate-limit] Redis unavailable; production rate limit failed closed", error instanceof Error ? error.message : error);
        return false;
      }
      console.error("[rate-limit] Redis unavailable; using in-memory fallback", error instanceof Error ? error.message : error);
      return memoryCheck(key, limit);
    }
  }
  try {
    const { rows } = await queryWithExecutionDeadline(getPool(),
      `INSERT INTO finnor_os.api_rate_limits (bucket_key, window_started_at, count) VALUES ($1, $2, 1)
       ON CONFLICT (bucket_key, window_started_at) DO UPDATE SET count = finnor_os.api_rate_limits.count + 1
       RETURNING count`, [bucketKey, windowStartedAt],
    );
    return (rows[0]?.count ?? 0) <= limit;
  } catch (error) {
    if (error instanceof DatabaseExecutionDeadlineError) throw error;
    if (!mayUseProcessLocalFallback()) {
      console.error("[rate-limit] durable counter unavailable; production rate limit failed closed", error instanceof Error ? error.message : error);
      return false;
    }
    console.error("[rate-limit] durable fallback unavailable; using in-memory fallback", error instanceof Error ? error.message : error);
    return memoryCheck(key, limit);
  }
}

/** Provider/action budget that is safe across processes. Callers supply the policy
 * limit selected from canonical configuration; this helper contributes only the
 * collision-proof tenant/provider/action bucket shape. */
export async function checkProviderRateLimit(input: {
  tenantId: string;
  provider: string;
  action: string;
  limitPerMinute: number;
}): Promise<boolean> {
  return checkRateLimit(
    `provider:${input.tenantId}:${input.provider}:${input.action}`,
    input.limitPerMinute,
  );
}

/** A4.T5: how long until the CURRENT fixed window rolls over — the honest Retry-After
 *  value for a 429 (this window is fixed-size, not sliding, so "wait until it resets"
 *  is exactly this many seconds, never an estimate). Pure arithmetic, no DB round trip. */
export function secondsUntilWindowReset(): number {
  const elapsedInWindow = Date.now() % WINDOW_MS;
  return Math.ceil((WINDOW_MS - elapsedInWindow) / 1000);
}
