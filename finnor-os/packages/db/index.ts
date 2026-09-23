// Database client factory. Two access modes:
//  - tenantDb(tenantId): sets the RLS GUC `app.tenant_id` per transaction — every query
//    in application code paths that touch tenant data goes through this. No service-role bypass.
//  - adminDb(): migrations/seed/queue only (jobs table is not tenant data; payloads carry tenant_id).

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { CURRENT_MIGRATION_HEAD } from "./migration-head";
import { PRODUCTION_JOB_CONTRACTS, classifyTrustedJobInstance, isProductionJobType } from "./compute-contract";
export { MAX_BACKGROUND_SCAN_BATCH, MAX_HIGH_EGRESS_ROWS, MAX_INSTRUCTION_EVENT_PAGE, MAX_WORK_AGGREGATE_ROWS } from "./read-limits";
import { MAX_HIGH_EGRESS_ROWS, MAX_WORK_AGGREGATE_ROWS } from "./read-limits";
import {
  CANONICAL_ENTITY_TYPES,
  assertExecutableVertical,
  isRetiredWaterAction,
  isRetiredWaterJob,
  RetiredVerticalError,
  type AttachWorkEntityInput,
  type CanonicalEntityRef,
  type CanonicalTruthRegistration,
  type CanonicalOperationalQueryIntent,
  type DecisionContextSnapshot,
  type EmployeeConversationChannel,
  type EmployeeConversationMessage,
  type EmployeeConversationThreadSummary,
  type EmployeePersonalMemory,
  type TenantVerticalIdentity,
} from "@finnor/shared-types";

export * from "./schema";
export * from "./migration-head";
export * from "./event-fabric";
export * from "./compute-contract";
export * from "./compute-control";
export * from "./compute-governor";
export { schema };

export type Db = NodePgDatabase<typeof schema>;

/**
 * node-postgres quirk: an `sslmode=` query param in the connection string overrides
 * an explicit `ssl` config object, and Supabase's chain is self-signed from Node's
 * point of view. Strip the param and configure ssl explicitly instead — except
 * `sslmode=disable` is read as an explicit override before stripping (the standard
 * Postgres convention for "this endpoint genuinely doesn't speak TLS, don't ask it to").
 *
 * Non-local endpoints must use TLS unless the caller explicitly supplies the standard
 * PostgreSQL `sslmode=disable` override. Provider hostnames are never treated as proof
 * that plaintext transport is safe.
 */
export function pgConnectionConfig(url: string): pg.ClientConfig {
  const sslDisabled = /[?&]sslmode=disable\b/.test(url);
  const cleaned = url.replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, "");
  const skipSsl = sslDisabled || cleaned.includes("localhost") || cleaned.includes("127.0.0.1");
  return {
    connectionString: cleaned,
    ...(skipSsl ? {} : { ssl: { rejectUnauthorized: true } }),
  };
}

/**
 * "Skip SSL" and "safe to hold many connections per invocation" are NOT the same
 * question, and treating them as one was a real bug found running the Task 6.4 load
 * test at scale, 2026-07-20. `localhost`/`127.0.0.1` is the only genuinely unshared,
 * unpooled target (local dev, CI's own ephemeral single-tenant container) — every
 * other target in this system, including private and public managed poolers, is a shared
 * pooled resource, exactly like Supabase's Supavisor pooler already was. A generous
 * per-invocation `max` against a shared pool multiplies with every concurrent
 * serverless invocation — under real load this starved PgBouncer's own pool far faster
 * than raising PgBouncer's pool size alone could fix.
 */
function isUnpooledLocal(url: string): boolean {
  return url.includes("localhost") || url.includes("127.0.0.1");
}

let pool: pg.Pool | null = null;
let poolConnectionString: string | null = null;

export function getPool(): pg.Pool {
  const url =
    process.env.DATABASE_URL ??
    process.env.POSTGRES_URL_NON_POOLING ??
    process.env.POSTGRES_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  // Managed-secret boot can replace DATABASE_URL after an import-time helper has
  // already touched the pool. Never keep the pre-secret connection alive: it may be
  // a migration/owner URL rather than the restricted application role. New callers
  // get a pool for the current environment while the old pool drains safely.
  if (pool && poolConnectionString !== url) {
    const stalePool = pool;
    pool = null;
    poolConnectionString = null;
    void stalePool.end().catch(() => undefined);
  }
  if (!pool) {
    // Cloud (Vercel + Supabase store): POSTGRES_URL_NON_POOLING is a direct session-mode
    // connection — required because we set search_path per session, which a transaction-
    // mode pooler would reset between clients. We run our own small pg.Pool regardless.
    const cfg = pgConnectionConfig(url);
    // Every session-mode pooler this app talks to caps total concurrent backend connections
    // low relative to how many serverless invocations can run at once. A generous
    // per-invocation max against a shared pool multiplies with concurrency and starves
    // it fast — only a genuinely unshared localhost/127.0.0.1 target gets to be
    // generous. See isUnpooledLocal()'s own comment for the real bug this fixed.
    const unpooledLocal = isUnpooledLocal(url);
    // The REAL root cause found running Task 6.4's load test at scale, 2026-07-20 --
    // not pool size, a missing timeout. Neither `connectionTimeoutMillis` nor a
    // statement_timeout was ever set, so node-postgres's default is "wait forever" for
    // both "get a client from the pool" and "how long can one query run." Under real
    // overload this doesn't degrade gracefully — it queues WITHOUT BOUND: a client
    // that's already given up (k6's own 60s HTTP timeout) doesn't stop the server-side
    // handler from still running and still holding its spot in a pooled connection's
    // queue, so the backlog only grows, never drains, confirmed directly against
    // PgBouncer's own admin console (`SHOW POOLS`) staying pinned at cl_active=sv_
    // active=pool_size with a 100+ second maxwait, unchanged 20+ seconds after the
    // load generator had already stopped sending new requests. avg_query_time was a
    // healthy 87ms the whole time — the database was never actually the bottleneck.
    // Fail fast under saturation instead: a real, bounded error the app already
    // handles gracefully (degraded/SAMPLE DATA badges) beats an unbounded queue that
    // makes every other request wait behind requests nobody is listening for anymore.
    const idleTimeoutOverride = Number(process.env.FINNOR_DB_IDLE_TIMEOUT_MS);
    const idleTimeoutMillis = Number.isFinite(idleTimeoutOverride) && idleTimeoutOverride > 0
      ? Math.min(idleTimeoutOverride, 60_000)
      : unpooledLocal
        ? undefined
        : 1_000;
    pool = new pg.Pool({
      ...cfg,
      // Vercel can run enough API instances concurrently that even two sessions per
      // instance exhaust Supavisor's 40-session production pool (observed as
      // EMAXCONNSESSION under Bridge polling). Production functions therefore use
      // one short-lived session each; localhost/CI remains intentionally generous.
      max: unpooledLocal ? 10 : 1,
      idleTimeoutMillis,
      // CI and local test runners must fail with a real connection error when their
      // disposable database is unavailable. Leaving localhost unbounded made Vitest
      // stall before collection forever after a stopped dev database.
      connectionTimeoutMillis: 5_000,
    });
    // Do not issue client.query() from the pool's connect event: node-postgres does
    // not await it, so a first caller can race that setup query. Restricted runtime
    // roles receive their default search_path when provisioned; tenant paths set their
    // own search_path and timeout synchronously inside the transaction below.
    // node-postgres's own docs: an idle client's background 'error' event (e.g. the
    // pooler or network dropping a connection that's just sitting in the pool, not
    // mid-query) has no other listener and crashes the ENTIRE process if unhandled --
    // found running this for real (a real staging chaos test crashed outright on
    // exactly this, `Connection terminated unexpectedly`, an idle-pool background
    // error, not a query failure). More likely now that pooled connections carry a
    // real idleTimeoutMillis instead of living forever. Every in-flight query already
    // gets its own real error from its own call site (withTenant's try/catch etc.) --
    // this handler exists solely so a background idle-connection drop degrades
    // (that one connection gets recycled) instead of taking the whole process down.
    pool.on("error", (err) => {
      console.error("[db] idle pooled connection error (non-fatal, connection recycled):", err.message);
    });
    poolConnectionString = url;
  }
  return pool;
}

export function adminDb(): Db {
  return drizzle(getPool(), { schema });
}

export type TenantTransactionIsolation = "read committed" | "repeatable read" | "serializable";

export interface TenantTransactionOptions {
  userId?: string;
  isolation?: TenantTransactionIsolation;
  readOnly?: boolean;
}

/**
 * The reusable authenticated transaction boundary for vertical-owned canonical
 * mutations.  It exposes the already-scoped pg client only so a vertical can use
 * its package-local schema without making Core import that implementation.
 */
export async function withTenantTransaction<T>(
  tenantId: string,
  options: TenantTransactionOptions,
  fn: (db: Db, client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  const isolation = options.isolation ?? "read committed";
  const begin = `BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}${options.readOnly ? " READ ONLY" : ""}`;
  try {
    await client.query(begin);
    await client.query("SET LOCAL search_path = finnor_os, public");
    await client.query("SET LOCAL statement_timeout = 10000");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    if (options.userId) await client.query("SELECT set_config('app.user_id', $1, true)", [options.userId]);
    const context = await client.query<{ tenant_id: string | null }>("SELECT current_setting('app.tenant_id', true) AS tenant_id");
    if (context.rows[0]?.tenant_id !== tenantId) {
      throw new Error("Tenant RLS context was not established on the query connection");
    }
    const db = drizzle(client, { schema });
    const result = await fn(db, client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run `fn` inside a transaction with the tenant RLS context set.
 * RLS policies (migrations/0000_init.sql) scope every tenant table to
 * current_setting('app.tenant_id') — set with set_config(..., true) so it is
 * transaction-local and cannot leak across pooled connections.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (db: Db) => Promise<T>,
  userId?: string,
): Promise<T> {
  return withTenantTransaction(tenantId, { userId }, (db) => fn(db));
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    poolConnectionString = null;
  }
}

export const PHASE5_CUTOVER_PROTOCOL = 5 as const;

export interface ProductRuntimeAuthoritySnapshot {
  epoch: number;
  state: string;
  activeProductVertical: string;
  minimumCutoverProtocol: number;
  waterIntakeFrozenAt: string | null;
  waterRetiredAt: string | null;
}

export interface ProductRuntimeAuthority extends ProductRuntimeAuthoritySnapshot {
  state: "preparing" | "water_intake_frozen" | "water_retired";
  activeProductVertical: "private_equity";
}

/** Read the persisted authority row without treating its values as executable.
 * Readiness uses this snapshot so a wrong or transitional value remains visible
 * in deployment truth instead of being collapsed into an "unavailable" error. */
export async function readProductRuntimeAuthoritySnapshot(): Promise<ProductRuntimeAuthoritySnapshot | null> {
  const result = await getPool().query<{
    epoch: number;
    state: string;
    active_product_vertical: string;
    minimum_cutover_protocol: number;
    water_intake_frozen_at: Date | null;
    water_retired_at: Date | null;
  }>(
    `SELECT epoch,state,active_product_vertical,minimum_cutover_protocol,
            water_intake_frozen_at,water_retired_at
       FROM finnor_os.product_runtime_authority
      WHERE authority_key='product'`,
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    epoch: Number(row.epoch),
    state: row.state,
    activeProductVertical: row.active_product_vertical,
    minimumCutoverProtocol: Number(row.minimum_cutover_protocol),
    waterIntakeFrozenAt: row.water_intake_frozen_at?.toISOString() ?? null,
    waterRetiredAt: row.water_retired_at?.toISOString() ?? null,
  };
}

/** Read the one durable product authority. Every executable runtime role calls this
 * boundary; missing migration/state fails closed instead of falling back to Water. */
export async function readProductRuntimeAuthority(): Promise<ProductRuntimeAuthority> {
  const row = await readProductRuntimeAuthoritySnapshot();
  if (
    !row
    || row.epoch < PHASE5_CUTOVER_PROTOCOL
    || row.minimumCutoverProtocol < PHASE5_CUTOVER_PROTOCOL
    || row.activeProductVertical !== "private_equity"
    || !["preparing", "water_intake_frozen", "water_retired"].includes(row.state)
  ) {
    throw new Error("Product runtime authority is unavailable");
  }
  return row as ProductRuntimeAuthority;
}

export interface CutoverHeartbeatInput {
  service: "api" | "worker" | "orchestrator" | "supplier-canary" | "scheduler-owner"
    | "compute-realtime" | "compute-interactive" | "compute-background" | "compute-heavy";
  instanceId: string;
  releaseSha: string;
  buildId: string;
  version: string;
  releaseSource: string;
  coreCertificationId?: string | null;
  migrationHead?: string;
  deploymentId?: string | null;
  capabilities?: string[];
  environment: string;
}

/** Upsert a role's compatible-release proof against the current persisted epoch.
 * The activation function independently validates freshness, protocol, migration,
 * and a single shared release across every required role. */
export async function recordCutoverCompatibleHeartbeat(input: CutoverHeartbeatInput): Promise<void> {
  await recordCutoverCompatibleHeartbeats([input]);
}

/** One authority read and one batched upsert per process heartbeat, independent
 * of how many truthful runtime roles that process owns. */
export async function recordCutoverCompatibleHeartbeats(inputs: readonly CutoverHeartbeatInput[]): Promise<void> {
  if (inputs.length === 0) return;
  const authority = await readProductRuntimeAuthority();
  await getPool().query(
    `INSERT INTO finnor_os.service_release_heartbeats
       (service,instance_id,release_sha,build_id,version,release_source,core_certification_id,
        migration_head,deployment_id,capabilities,environment,cutover_protocol,product_epoch,last_beat_at)
     SELECT item.service,item.instance_id,item.release_sha,item.build_id,item.version,
            item.release_source,item.core_certification_id,item.migration_head,
            item.deployment_id,item.capabilities,item.environment,$2::int,$3::int,now()
       FROM jsonb_to_recordset($1::jsonb) AS item(
         service text,instance_id text,release_sha text,build_id text,version text,
         release_source text,core_certification_id text,migration_head text,
         deployment_id text,capabilities text[],environment text)
     ON CONFLICT (service,instance_id) DO UPDATE SET
       release_sha=EXCLUDED.release_sha,build_id=EXCLUDED.build_id,version=EXCLUDED.version,
       release_source=EXCLUDED.release_source,core_certification_id=EXCLUDED.core_certification_id,
       migration_head=EXCLUDED.migration_head,deployment_id=EXCLUDED.deployment_id,
       capabilities=EXCLUDED.capabilities,environment=EXCLUDED.environment,
       cutover_protocol=EXCLUDED.cutover_protocol,product_epoch=EXCLUDED.product_epoch,last_beat_at=now()`,
    [JSON.stringify(inputs.map((input) => ({
      service: input.service,
      instance_id: input.instanceId,
      release_sha: input.releaseSha,
      build_id: input.buildId,
      version: input.version,
      release_source: input.releaseSource,
      core_certification_id: input.coreCertificationId ?? null,
      migration_head: input.migrationHead ?? CURRENT_MIGRATION_HEAD,
      deployment_id: input.deploymentId ?? null,
      capabilities: input.capabilities ?? [],
      environment: input.environment,
    }))), PHASE5_CUTOVER_PROTOCOL, authority.epoch],
  );
}

/** Read a tenant's persisted product identity for audit/history without granting it
 * runtime authority. Most callers must use resolveTenantVertical instead. */
export async function resolveHistoricalTenantVertical(tenantId: string): Promise<TenantVerticalIdentity> {
  return withTenantTransaction(tenantId, { readOnly: true, isolation: "repeatable read" }, async (_db, client) => {
    // Preserve the canonical tenant lookup contract for callers that use the
    // vertical-aware dispatcher.  A missing tenant is different from a real
    // tenant whose vertical assignment has not been configured yet; keeping
    // those errors distinct avoids changing existing read-plane behavior while
    // still making the vertical boundary explicit.
    const tenant = await client.query<{ id: string }>(
      `SELECT id FROM finnor_os.tenants WHERE id=$1`,
      [tenantId],
    );
    if (!tenant.rows[0]) throw new Error("Tenant not found");
    const result = await client.query<{
      tenant_id: string;
      vertical_key: string;
      version: number;
      effective_from: Date;
      source_system: string;
      source_ref: string | null;
    }>(
      `SELECT tenant_id,vertical_key,version,effective_from,source_system,source_ref
         FROM finnor_os.tenant_vertical_assignments
        WHERE tenant_id=$1`,
      [tenantId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Tenant vertical identity is missing");
    return {
      tenantId: row.tenant_id,
      verticalKey: row.vertical_key,
      version: row.version,
      effectiveFrom: row.effective_from.toISOString(),
      sourceSystem: row.source_system,
      sourceRef: row.source_ref,
    };
  });
}

/** Resolve the authenticated tenant's executable business vertical. Historical
 * Water assignments remain truthful in storage but are never executable. */
export async function resolveTenantVertical(tenantId: string): Promise<TenantVerticalIdentity> {
  await readProductRuntimeAuthority();
  const identity = await resolveHistoricalTenantVertical(tenantId);
  // The disposable integration fixture keeps the pre-Phase-5 Water contract
  // covered while the production runtime remains fail-closed.  Its assignment
  // carries a test-only provenance marker; no production/migration assignment
  // can enter this branch.
  const legacyWaterFixture = process.env.AUTH_DEV_BYPASS === "1"
    && identity.verticalKey === "water"
    && identity.sourceSystem === "test:legacy-water-compat";
  if (!legacyWaterFixture) assertExecutableVertical(identity.verticalKey);
  if (identity.verticalKey === "none" && process.env.NODE_ENV !== "test" && !identity.sourceSystem.startsWith("certification:")) {
    throw new Error("The Core-only vertical is restricted to internal certification");
  }
  return identity;
}

/**
 * Explicit vertical reassignment boundary.  The database refuses a switch while
 * canonical rows owned by the current vertical exist, so changing a label can
 * never reinterpret Water truth as PE truth (or vice versa).
 */
export async function configureTenantVertical(params: {
  tenantId: string;
  verticalKey: string;
  expectedVersion: number;
  createdBy: string;
  sourceSystem?: string;
  sourceRef?: string;
}): Promise<TenantVerticalIdentity> {
  assertExecutableVertical(params.verticalKey);
  return withTenantTransaction(params.tenantId, { isolation: "serializable" }, async (_db, client) => {
    const result = await client.query<{
      tenant_id: string;
      vertical_key: string;
      version: number;
      effective_from: Date;
      source_system: string;
      source_ref: string | null;
    }>(
      `SELECT * FROM finnor_os.configure_tenant_vertical($1,$2,$3,$4,$5,$6)`,
      [params.tenantId, params.verticalKey, params.expectedVersion, params.createdBy, params.sourceSystem ?? "finnor", params.sourceRef ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Tenant vertical update returned no canonical identity");
    return {
      tenantId: row.tenant_id,
      verticalKey: row.vertical_key,
      version: row.version,
      effectiveFrom: row.effective_from.toISOString(),
      sourceSystem: row.source_system,
      sourceRef: row.source_ref,
    };
  });
}

export async function listCanonicalTruthRegistrations(tenantId: string): Promise<CanonicalTruthRegistration[]> {
  return withTenantTransaction(tenantId, { readOnly: true, isolation: "repeatable read" }, async (_db, client) => {
    const result = await client.query<{
      entity_type: string;
      vertical_key: string | null;
      source_schema: "finnor_os";
      source_table: string;
      writable_owner: string;
      mutation_boundary: string;
      work_attachable: boolean;
    }>(
      `SELECT entity_type,vertical_key,source_schema,source_table,writable_owner,mutation_boundary,work_attachable
         FROM finnor_os.canonical_truth_registry
        WHERE active AND (vertical_key IS NULL OR vertical_key=finnor_os.active_tenant_vertical($1))
        ORDER BY entity_type`,
      [tenantId],
    );
    return result.rows.map((row) => ({
      entityType: row.entity_type,
      verticalKey: row.vertical_key,
      sourceSchema: row.source_schema,
      sourceTable: row.source_table,
      writableOwner: row.writable_owner,
      mutationBoundary: row.mutation_boundary,
      workAttachable: row.work_attachable,
    }));
  });
}

/** Idempotent job enqueue — safe to call twice with the same key (§16). `correlationId`
 *  (Phase 16e) rides inside payload as `_correlationId` rather than a new column — the
 *  worker reads it back off `job.payload` at dispatch time (see apps/worker/src/queue.ts),
 *  so no migration is needed and every existing caller that omits it is unaffected. */
export async function enqueueJob(
  type: string,
  payload: Record<string, unknown>,
  idempotencyKey?: string,
  correlationId?: string,
  lane: "interactive" | "batch" = "batch",
  priority = 0,
): Promise<void> {
  if (isRetiredWaterJob(type) || (typeof payload.actionType === "string" && isRetiredWaterAction(payload.actionType))) {
    throw new RetiredVerticalError("water");
  }
  const classification = classifyTrustedJobInstance({ type, lane });
  const tenantId = typeof payload.tenantId === "string" ? payload.tenantId : null;
  if (classification.tenantScope === "tenant" && !tenantId) throw new Error(`${type} requires durable tenant identity`);
  if (isProductionJobType(type) && classification.tenantScope === "global" && tenantId) throw new Error(`${type} is global and cannot carry tenant identity`);
  if (tenantId) await resolveTenantVertical(tenantId);
  const fullPayload = correlationId ? { ...payload, _correlationId: correlationId } : payload;
  const protocolVersion = isProductionJobType(type)
    ? PRODUCTION_JOB_CONTRACTS[type].protocolVersions[0] ?? 1 : 1;
  await getPool().query(
    `INSERT INTO jobs (tenant_id, type, payload, idempotency_key, lane, priority, protocol_version) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [tenantId, type, JSON.stringify(fullPayload), idempotencyKey ?? null, lane, priority, protocolVersion],
  );
}

/** Scheduled variant of enqueueJob. The run time is part of the durable job row,
 * so a waiting objective survives every API/worker process restart. */
export async function enqueueJobAt(
  type: string,
  payload: Record<string, unknown>,
  runAt: Date,
  idempotencyKey: string,
  correlationId?: string,
  lane: "interactive" | "batch" = "batch",
  priority = 0,
): Promise<void> {
  if (Number.isNaN(runAt.getTime())) throw new Error("Scheduled job runAt is invalid");
  if (isRetiredWaterJob(type) || (typeof payload.actionType === "string" && isRetiredWaterAction(payload.actionType))) {
    throw new RetiredVerticalError("water");
  }
  const classification = classifyTrustedJobInstance({ type, lane });
  const tenantId = typeof payload.tenantId === "string" ? payload.tenantId : null;
  if (classification.tenantScope === "tenant" && !tenantId) throw new Error(`${type} requires durable tenant identity`);
  if (isProductionJobType(type) && classification.tenantScope === "global" && tenantId) throw new Error(`${type} is global and cannot carry tenant identity`);
  if (tenantId) await resolveTenantVertical(tenantId);
  const fullPayload = correlationId ? { ...payload, _correlationId: correlationId } : payload;
  const protocolVersion = isProductionJobType(type)
    ? PRODUCTION_JOB_CONTRACTS[type].protocolVersions[0] ?? 1 : 1;
  await getPool().query(
    `INSERT INTO jobs (tenant_id, type, payload, run_at, idempotency_key, lane, priority, protocol_version) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (idempotency_key) DO UPDATE SET run_at=LEAST(jobs.run_at, EXCLUDED.run_at)
     WHERE jobs.status='queued'`,
    [tenantId, type, JSON.stringify(fullPayload), runAt, idempotencyKey, lane, priority, protocolVersion],
  );
}

/** Read-only access to truthful historical Water operation evidence. Runtime
 * creation, approval, dispatch, recovery, and cancellation were retired in P5. */
export async function businessOperationAggregate(tenantId: string, operationId: string): Promise<Record<string, unknown> | null> {
  return withTenant(tenantId, async (db) => {
    const [operation] = await db.select().from(schema.businessOperations)
      .where(and(eq(schema.businessOperations.tenantId, tenantId), eq(schema.businessOperations.id, operationId))).limit(1);
    if (!operation) return null;
    const targetsPlus = await db.select().from(schema.businessOperationTargets)
      .where(and(eq(schema.businessOperationTargets.tenantId, tenantId), eq(schema.businessOperationTargets.operationId, operationId)))
      .orderBy(asc(schema.businessOperationTargets.ordinal), asc(schema.businessOperationTargets.id))
      .limit(MAX_HIGH_EGRESS_ROWS + 1);
    const eventsPlus = await db.select().from(schema.businessOperationEvents)
      .where(and(eq(schema.businessOperationEvents.tenantId, tenantId), eq(schema.businessOperationEvents.operationId, operationId)))
      .orderBy(asc(schema.businessOperationEvents.sequence), asc(schema.businessOperationEvents.id))
      .limit(MAX_HIGH_EGRESS_ROWS + 1);
    const targets = targetsPlus.slice(0, MAX_HIGH_EGRESS_ROWS);
    const events = eventsPlus.slice(0, MAX_HIGH_EGRESS_ROWS);
    const [receipt] = await db.select().from(schema.decisionReceipts)
      .where(and(eq(schema.decisionReceipts.tenantId, tenantId), eq(schema.decisionReceipts.operationId, operationId))).limit(1);
    return {
      operation,
      targets,
      events,
      receipt: receipt ?? null,
      read: {
        limit: MAX_HIGH_EGRESS_ROWS,
        complete: targetsPlus.length <= MAX_HIGH_EGRESS_ROWS && eventsPlus.length <= MAX_HIGH_EGRESS_ROWS,
        truncatedTables: [
          ...(targetsPlus.length > MAX_HIGH_EGRESS_ROWS ? ["business_operation_targets"] : []),
          ...(eventsPlus.length > MAX_HIGH_EGRESS_ROWS ? ["business_operation_events"] : []),
        ],
      },
    };
  });
}

// Upgrade 2: durable Work kernel. These primitives live beside withTenant so the
// API, orchestrator, voice intake, and workflow runtime can share one transactional
// lifecycle implementation without creating package dependency cycles.
// ---------------------------------------------------------------------------

export const WORK_STATUSES = [
  "received", "understanding", "planning", "ready", "actionable",
  "awaiting_approval", "executing", "waiting", "blocked", "completed", "failed", "cancelled", "recovery",
] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

export function isImmutableWorkStatus(status: WorkStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export class WorkTransitionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkTransitionConflictError";
  }
}

export interface ReceiveWorkParams {
  tenantId: string;
  instruction: string;
  channel: "voice" | "text" | "console";
  sessionId?: string;
  instructionId?: string;
  workId?: string;
  userId?: string;
  idempotencyKey?: string;
  activeContext?: Record<string, unknown>;
  authorityContext?: Record<string, unknown>;
}

export interface ReceivedWork {
  workId: string;
  workInputId: string;
  instructionId: string;
  created: boolean;
  duplicate: boolean;
  status: WorkStatus;
  finalOutcome: unknown;
}

export interface HandoffWorkParams {
  tenantId: string;
  workId: string;
  actorId: string;
  targetEmployeeId: string;
  authorityContext: Record<string, unknown>;
  expectedOwnerId?: string;
  note?: string;
}

export interface HandoffWorkResult {
  workId: string;
  previousOwnerId: string | null;
  currentOwnerId: string;
  eventSequence: number | null;
  duplicate: boolean;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isUuid(value: string | undefined): value is string {
  return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
}

const PROVENANCE_BYTE_LIMIT = 65_536;

function boundedProvenance(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > PROVENANCE_BYTE_LIMIT) {
    throw new Error(`Provenance snapshot exceeds the ${PROVENANCE_BYTE_LIMIT}-byte bound`);
  }
  return value as Record<string, unknown>;
}

function provenanceHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function provenanceCapturedAt(value: Record<string, unknown> | null, fallback = new Date()): Date {
  const candidate = typeof value?.capturedAt === "string" ? new Date(value.capturedAt) : fallback;
  return Number.isNaN(candidate.getTime()) ? fallback : candidate;
}

const canonicalEntityTypes = new Set<string>(CANONICAL_ENTITY_TYPES);

export function canonicalRefsFromContext(value: unknown): CanonicalEntityRef[] {
  const context = jsonObject(value);
  const refs: CanonicalEntityRef[] = [];
  const candidates = [
    ...(Array.isArray(context.entityRefs) ? context.entityRefs : []),
    ...(context.focusedEntity ? [context.focusedEntity] : []),
    ...(Array.isArray(context.selectedEntities) ? context.selectedEntities : []),
    ...(Array.isArray(context.excludedEntities) ? context.excludedEntities : []),
  ];
  for (const candidate of candidates) {
      const ref = jsonObject(candidate);
      if (typeof ref.entityType === "string" && canonicalEntityTypes.has(ref.entityType) && typeof ref.entityId === "string" && isUuid(ref.entityId)) {
        refs.push({ entityType: ref.entityType as CanonicalEntityRef["entityType"], entityId: ref.entityId });
      }
  }
  return [...new Map(refs.map((ref) => [`${ref.entityType}:${ref.entityId}`, ref])).values()];
}

export async function attachWorkEntityTx(
  db: Db,
  params: { tenantId: string; workId: string; entity: AttachWorkEntityInput },
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{1,62}$/.test(params.entity.entityType) || !isUuid(params.entity.entityId)) {
    throw new Error("Invalid canonical entity reference");
  }
  const available = await db.execute<{ available: boolean }>(sql`
    SELECT finnor_os.canonical_entity_work_attachable(${params.tenantId}::uuid, ${params.entity.entityType}) AS available
  `);
  if (!available.rows[0]?.available) throw new Error("Canonical entity type is not registered for the tenant's active vertical");
  await db.insert(schema.workEntityLinks).values({
    tenantId: params.tenantId,
    workId: params.workId,
    entityType: params.entity.entityType,
    entityId: params.entity.entityId,
    relationship: params.entity.relationship ?? "about",
    source: params.entity.source ?? "runtime",
  }).onConflictDoNothing({
    target: [schema.workEntityLinks.workId, schema.workEntityLinks.entityType, schema.workEntityLinks.entityId, schema.workEntityLinks.relationship],
  });
}

export async function attachWorkEntity(
  tenantId: string,
  workId: string,
  entity: AttachWorkEntityInput,
): Promise<void> {
  await withTenant(tenantId, (db) => attachWorkEntityTx(db, { tenantId, workId, entity }));
}

/** The load-bearing intake claim. A Work and its first input are committed before
 * any caller may invoke the planner. Both client instruction ids and explicit
 * idempotency keys are unique claims, so a network retry cannot create a second Work. */
export async function receiveWork(params: ReceiveWorkParams): Promise<ReceivedWork> {
  // This is the canonical intake boundary shared by text, voice, objectives, and
  // system-created Work. Refuse a retired persisted identity before any row exists.
  await resolveTenantVertical(params.tenantId);
  const desiredWorkId = params.workId ?? params.instructionId ?? randomUUID();
  const desiredInstructionId = params.instructionId ?? randomUUID();
  const contextSnapshot = boundedProvenance(params.activeContext);
  const contextSnapshotHash = contextSnapshot ? provenanceHash(contextSnapshot) : null;
  const contextCapturedAt = contextSnapshot ? provenanceCapturedAt(contextSnapshot) : null;
  return withTenant(params.tenantId, async (db) => {
    // Work cannot be created before the input's two idempotency claims are known to
    // be free. Serialize both claims so callers using different work/idempotency IDs
    // for the same instruction cannot race each other into an orphan Work.
    const claimKeys = [
      `instruction:${params.tenantId}:${desiredInstructionId}`,
      ...(params.idempotencyKey ? [`idempotency:${params.tenantId}:${params.idempotencyKey}`] : []),
    ].sort();
    for (const claimKey of claimKeys) {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${claimKey}, 0))`);
    }

    const duplicateForInput = async (input: typeof schema.workInputs.$inferSelect): Promise<ReceivedWork> => {
      const [canonicalWork] = await db.select().from(schema.works).where(and(
        eq(schema.works.tenantId, params.tenantId),
        eq(schema.works.id, input.workId),
      )).limit(1);
      if (!canonicalWork) throw new Error("Durable Work input references a missing Work");
      return {
        workId: canonicalWork.id,
        workInputId: input.id,
        instructionId: input.instructionId,
        created: false,
        duplicate: true,
        status: canonicalWork.status,
        finalOutcome: canonicalWork.finalOutcome,
      };
    };

    const matchingInputs = await db.select().from(schema.workInputs).where(and(
      eq(schema.workInputs.tenantId, params.tenantId),
      or(
        eq(schema.workInputs.instructionId, desiredInstructionId),
        params.idempotencyKey ? eq(schema.workInputs.idempotencyKey, params.idempotencyKey) : undefined,
      ),
    ));
    const distinctInputs = [...new Map(matchingInputs.map((input) => [input.id, input])).values()];
    if (distinctInputs.length > 1) {
      throw new Error("Work input idempotency claims resolve to different canonical inputs");
    }
    if (distinctInputs[0]) return duplicateForInput(distinctInputs[0]);

    const [validUser] = isUuid(params.userId)
      ? await db.select({ id: schema.users.id }).from(schema.users).where(and(eq(schema.users.tenantId, params.tenantId), eq(schema.users.id, params.userId))).limit(1)
      : [];

    let [work] = params.idempotencyKey
      ? await db.select().from(schema.works).where(and(eq(schema.works.tenantId, params.tenantId), eq(schema.works.idempotencyKey, params.idempotencyKey))).limit(1)
      : [];
    if (!work && params.workId) {
      [work] = await db.select().from(schema.works).where(and(eq(schema.works.tenantId, params.tenantId), eq(schema.works.id, params.workId))).limit(1);
      if (!work) {
        const [foreign] = await db.select({ id: schema.works.id }).from(schema.works).where(eq(schema.works.id, params.workId)).limit(1);
        if (foreign) throw new Error("Work not found");
      }
    }

    let created = false;
    if (!work) {
      const [inserted] = await db
        .insert(schema.works)
        .values({
          id: desiredWorkId,
          tenantId: params.tenantId,
          status: "received",
          sessionId: params.sessionId ?? null,
          initialChannel: params.channel,
          initialInstruction: params.instruction,
          createdBy: validUser?.id ?? null,
          currentOwnerId: validUser?.id ?? null,
          authorityContext: params.authorityContext ?? {},
          activeContext: params.activeContext ?? {},
          idempotencyKey: params.idempotencyKey ?? null,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) {
        work = inserted;
        created = true;
        await db.insert(schema.workEvents).values({
          tenantId: params.tenantId,
          workId: inserted.id,
          seq: 1,
          eventType: "received",
          fromStatus: null,
          toStatus: "received",
          payload: { channel: params.channel, sessionId: params.sessionId ?? null, actorId: validUser?.id ?? null, authority: params.authorityContext ?? {} },
        });
      } else {
        [work] = await db.select().from(schema.works).where(and(
          eq(schema.works.tenantId, params.tenantId),
          params.idempotencyKey ? eq(schema.works.idempotencyKey, params.idempotencyKey) : eq(schema.works.id, desiredWorkId),
        )).limit(1);
      }
    }
    if (!work) throw new Error("Unable to create or resolve durable Work");

    for (const entity of canonicalRefsFromContext(params.activeContext)) {
      await attachWorkEntityTx(db, {
        tenantId: params.tenantId,
        workId: work.id,
        entity: { ...entity, source: "work_intake.active_context" },
      });
    }
    if (validUser?.id) {
      await attachWorkEntityTx(db, {
        tenantId: params.tenantId,
        workId: work.id,
        entity: { entityType: "user", entityId: validUser.id, relationship: "about", source: "work_intake.employee" },
      });
    }

    const inputId = desiredInstructionId;
    const [input] = await db.insert(schema.workInputs).values({
      id: inputId,
      tenantId: params.tenantId,
      workId: work.id,
      instructionId: desiredInstructionId,
      channel: params.channel,
      sessionId: params.sessionId ?? work.sessionId,
      instructionText: params.instruction,
      createdBy: validUser?.id ?? null,
      idempotencyKey: params.idempotencyKey ?? null,
      contextSnapshot,
      contextSnapshotHash,
      contextCapturedAt,
    }).onConflictDoNothing().returning();
    if (!input) {
      const [raced] = await db.select().from(schema.workInputs).where(and(
        eq(schema.workInputs.tenantId, params.tenantId),
        or(
          eq(schema.workInputs.instructionId, desiredInstructionId),
          params.idempotencyKey ? eq(schema.workInputs.idempotencyKey, params.idempotencyKey) : undefined,
        ),
      )).limit(1);
      if (!raced) throw new Error("Unable to persist Work input");
      return duplicateForInput(raced);
    }

    // instruction_sessions remains the backward-compatible trace projection. Every
    // new voice and text input now gets one, including server-minted voice inputs.
    await db.insert(schema.instructionSessions).values({
      id: desiredInstructionId,
      tenantId: params.tenantId,
      workId: work.id,
      sessionId: params.sessionId ?? work.sessionId,
      userId: validUser?.id ?? null,
      authorityContext: params.authorityContext ?? work.authorityContext ?? {},
      instructionText: params.instruction,
      source: params.channel === "voice" ? "voice" : "typed",
    }).onConflictDoUpdate({
      target: schema.instructionSessions.id,
      set: { workId: work.id, updatedAt: new Date() },
    });

    let currentStatus = work.status;
    if (!created) {
      await db.execute(sql`SELECT id FROM ${schema.works} WHERE ${schema.works.id} = ${work.id} FOR UPDATE`);
      const [latest] = await db.select({ maxSeq: sql<number>`coalesce(max(${schema.workEvents.seq}), 0)::int` }).from(schema.workEvents).where(eq(schema.workEvents.workId, work.id));
      const resumesFailure = work.status === "failed";
      if (resumesFailure) currentStatus = "recovery";
      await db.insert(schema.workEvents).values({
        tenantId: params.tenantId,
        workId: work.id,
        seq: (latest?.maxSeq ?? 0) + 1,
        eventType: resumesFailure ? "recovery_input_received" : "input_received",
        fromStatus: work.status,
        toStatus: resumesFailure ? "recovery" : work.status,
        payload: { workInputId: input.id, instructionId: desiredInstructionId, channel: params.channel },
      });
      await db.update(schema.works).set({
        ...(resumesFailure ? {
          status: "recovery" as const,
          recovery: { status: "input_received", workInputId: input.id, at: new Date().toISOString() },
        } : {}),
        ...(params.activeContext && Object.keys(params.activeContext).length > 0
          ? { activeContext: { ...jsonObject(work.activeContext), ...params.activeContext } }
          : {}),
        updatedAt: new Date(),
      }).where(eq(schema.works.id, work.id));
    }

    return { workId: work.id, workInputId: input.id, instructionId: desiredInstructionId, created, duplicate: false, status: currentStatus, finalOutcome: work.finalOutcome };
  });
}

/** Transfer responsibility for an existing Work without replacing its objective,
 * inputs, causal history, active context, or durable children. The current owner is
 * the only employee who may hand it off; the row lock and optional expected owner
 * make two concurrent handoffs deterministic. The target's fresh authority snapshot
 * is persisted so a restarted objective worker continues as that employee. */
export async function handoffWork(params: HandoffWorkParams): Promise<HandoffWorkResult> {
  return withTenant(params.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${schema.works} WHERE ${schema.works.id}=${params.workId} AND ${schema.works.tenantId}=${params.tenantId} FOR UPDATE`);
    const [work] = await db.select().from(schema.works).where(and(
      eq(schema.works.tenantId, params.tenantId),
      eq(schema.works.id, params.workId),
    )).limit(1);
    if (!work) throw new Error("Work not found");

    const employeeIds = [...new Set([params.actorId, params.targetEmployeeId])];
    const employees = await db.select({ id: schema.users.id, status: schema.users.status }).from(schema.users).where(and(
      eq(schema.users.tenantId, params.tenantId),
      inArray(schema.users.id, employeeIds),
    ));
    const actor = employees.find((employee) => employee.id === params.actorId);
    const target = employees.find((employee) => employee.id === params.targetEmployeeId);
    if (!actor || actor.status !== "active") throw new Error("The current Work owner is not an active employee in this tenant");
    if (!target || target.status !== "active") throw new Error("The handoff target is not an active employee in this tenant");

    const previousOwnerId = work.currentOwnerId ?? work.createdBy;
    if (params.expectedOwnerId && previousOwnerId !== params.expectedOwnerId) {
      throw new Error("Work owner changed before the handoff could be applied");
    }
    if (previousOwnerId !== params.actorId) throw new Error("Only the current Work owner may hand off responsibility");
    if (previousOwnerId === params.targetEmployeeId) {
      return { workId: work.id, previousOwnerId, currentOwnerId: params.targetEmployeeId, eventSequence: null, duplicate: true };
    }

    const [latest] = await db.select({ maxSeq: sql<number>`coalesce(max(${schema.workEvents.seq}), 0)::int` })
      .from(schema.workEvents).where(eq(schema.workEvents.workId, work.id));
    const eventSequence = (latest?.maxSeq ?? 0) + 1;
    await db.update(schema.works).set({
      currentOwnerId: params.targetEmployeeId,
      assignedTo: params.targetEmployeeId,
      authorityContext: params.authorityContext,
      updatedAt: new Date(),
    }).where(and(eq(schema.works.tenantId, params.tenantId), eq(schema.works.id, work.id)));
    await attachWorkEntityTx(db, {
      tenantId: params.tenantId,
      workId: work.id,
      entity: { entityType: "user", entityId: params.targetEmployeeId, relationship: "target", source: "work_handoff" },
    });
    await db.insert(schema.workEvents).values({
      tenantId: params.tenantId,
      workId: work.id,
      seq: eventSequence,
      eventType: "employee_handoff",
      fromStatus: work.status,
      toStatus: work.status,
      payload: {
        fromEmployeeId: previousOwnerId,
        toEmployeeId: params.targetEmployeeId,
        actorId: params.actorId,
        note: params.note ?? null,
        priorAuthorityRevision: jsonObject(work.authorityContext).revision ?? null,
        authorityRevision: params.authorityContext.revision ?? null,
        authorityRoles: params.authorityContext.roles ?? [],
      },
    });
    return { workId: work.id, previousOwnerId, currentOwnerId: params.targetEmployeeId, eventSequence, duplicate: false };
  });
}

export interface TransitionWorkPatch {
  finalOutcome?: unknown;
  failure?: unknown;
  recovery?: unknown;
  activeContext?: Record<string, unknown>;
  executionModel?: "query" | "atomic_effect" | "objective";
  /** Optional optimistic fence for failures that may only claim a received Work. */
  expectedStatus?: WorkStatus;
  /** Optimistic generation fence for instruction-owned transitions. */
  expectedWorkInputId?: string;
}

/** Transaction-scoped Work transition for callers that must commit lifecycle truth
 * together with another required durable write, such as the job that delivers it. */
export async function transitionWorkTx(
  db: Db,
  tenantId: string,
  workId: string,
  toStatus: WorkStatus,
  eventType: string,
  payload: Record<string, unknown> = {},
  patch: TransitionWorkPatch = {},
): Promise<void> {
  await db.execute(sql`SELECT id FROM ${schema.works} WHERE ${schema.works.id} = ${workId} AND ${schema.works.tenantId} = ${tenantId} FOR UPDATE`);
  const [work] = await db.select().from(schema.works).where(and(eq(schema.works.id, workId), eq(schema.works.tenantId, tenantId))).limit(1);
  if (!work) throw new Error("Work not found");
  if (patch.expectedStatus && work.status !== patch.expectedStatus) {
    throw new WorkTransitionConflictError(`Work ${workId} is ${work.status}; expected ${patch.expectedStatus}`);
  }
  if (patch.expectedWorkInputId) {
    const [latestInput] = await db.select({ id: schema.workInputs.id })
      .from(schema.workInputs)
      .where(and(eq(schema.workInputs.tenantId, tenantId), eq(schema.workInputs.workId, workId)))
      .orderBy(desc(schema.workInputs.createdAt), desc(schema.workInputs.id))
      .limit(1);
    if (latestInput?.id !== patch.expectedWorkInputId) {
      throw new WorkTransitionConflictError(`Work input ${patch.expectedWorkInputId} is no longer active`);
    }
  }
  if ((work.status === "completed" || work.status === "cancelled") && toStatus !== work.status) {
    const [latestEvent] = await db.select({ eventType: schema.workEvents.eventType, payload: schema.workEvents.payload })
      .from(schema.workEvents)
      .where(and(eq(schema.workEvents.tenantId, tenantId), eq(schema.workEvents.workId, workId)))
      .orderBy(desc(schema.workEvents.seq))
      .limit(1);
    const eventInputId = jsonObject(latestEvent?.payload).workInputId;
    const explicitlyContinued = patch.expectedWorkInputId
      && (latestEvent?.eventType === "input_received" || latestEvent?.eventType === "recovery_input_received")
      && eventInputId === patch.expectedWorkInputId;
    if (!explicitlyContinued) {
      throw new WorkTransitionConflictError(`Terminal Work ${workId} cannot transition from ${work.status} to ${toStatus} without a newer active input`);
    }
  }
  if (work.status === "failed" && !["failed", "recovery", "cancelled"].includes(toStatus)) {
    throw new WorkTransitionConflictError(`Failed Work ${workId} must enter explicit recovery before transitioning to ${toStatus}`);
  }
  const [latest] = await db.select({ maxSeq: sql<number>`coalesce(max(${schema.workEvents.seq}), 0)::int` }).from(schema.workEvents).where(eq(schema.workEvents.workId, workId));
  await db.update(schema.works).set({
    status: toStatus,
    updatedAt: new Date(),
    ...(patch.finalOutcome !== undefined ? { finalOutcome: patch.finalOutcome as object } : {}),
    ...(patch.failure !== undefined ? { failure: patch.failure as object } : {}),
    ...(patch.recovery !== undefined ? { recovery: patch.recovery as object } : {}),
    ...(patch.activeContext ? { activeContext: { ...jsonObject(work.activeContext), ...patch.activeContext } } : {}),
    ...(patch.executionModel ? { executionModel: patch.executionModel } : {}),
  }).where(eq(schema.works.id, workId));
  await db.insert(schema.workEvents).values({
    tenantId,
    workId,
    seq: (latest?.maxSeq ?? 0) + 1,
    eventType,
    fromStatus: work.status,
    toStatus,
    payload,
  });
}

export async function transitionWork(
  tenantId: string,
  workId: string,
  toStatus: WorkStatus,
  eventType: string,
  payload: Record<string, unknown> = {},
  patch: TransitionWorkPatch = {},
): Promise<void> {
  await withTenant(tenantId, (db) => transitionWorkTx(db, tenantId, workId, toStatus, eventType, payload, patch));
}

/** Persist the exact backward-compatible API response without manufacturing a
 * lifecycle transition. Intake retries can therefore replay the original shape. */
export async function recordWorkResponse(tenantId: string, workId: string, response: Record<string, unknown>): Promise<void> {
  await withTenant(tenantId, async (db) => {
    const [work] = await db.select({ finalOutcome: schema.works.finalOutcome }).from(schema.works).where(and(eq(schema.works.id, workId), eq(schema.works.tenantId, tenantId))).limit(1);
    if (!work) throw new Error("Work not found");
    await db.update(schema.works).set({
      finalOutcome: { ...jsonObject(work.finalOutcome), response },
      updatedAt: new Date(),
    }).where(and(eq(schema.works.id, workId), eq(schema.works.tenantId, tenantId)));
  });
}

const WORK_RECOVERY_CLAIM_TTL_MS = 15 * 60_000;

/** Atomically leases failed Work for one recovery request and returns the exact input
 * that lease owns. Distinct HTTP idempotency keys therefore cannot both reach the
 * planner. A process that dies before orchestration advances the Work can be taken
 * over only after the bounded lease expires. */
export async function claimWorkRecovery(params: {
  tenantId: string;
  workId: string;
  attemptKey: string;
  requestedBy: string;
}): Promise<{
  claimed: boolean;
  activeAttemptKey: string;
  status: "claimed" | "planning" | "succeeded" | "failed" | "timed_out";
  input: typeof schema.workInputs.$inferSelect | null;
}> {
  return withTenant(params.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${schema.works} WHERE ${schema.works.id}=${params.workId} AND ${schema.works.tenantId}=${params.tenantId} FOR UPDATE`);
    const [work] = await db.select().from(schema.works).where(and(
      eq(schema.works.id, params.workId),
      eq(schema.works.tenantId, params.tenantId),
    )).limit(1);
    if (!work) throw new Error("Work not found");

    const [existingAttempt] = await db.select({ attemptKey: schema.workPlannerAttempts.attemptKey, status: schema.workPlannerAttempts.status })
      .from(schema.workPlannerAttempts)
      .where(and(
        eq(schema.workPlannerAttempts.workId, params.workId),
        eq(schema.workPlannerAttempts.attemptKey, params.attemptKey),
      ))
      .limit(1);
    if (existingAttempt) return { claimed: false, activeAttemptKey: existingAttempt.attemptKey, status: existingAttempt.status, input: null };

    const previousRecovery = jsonObject(work.recovery);
    const activeAttemptKey = typeof previousRecovery.attemptKey === "string" ? previousRecovery.attemptKey : "";
    const claimedAtMs = typeof previousRecovery.claimedAt === "string" ? Date.parse(previousRecovery.claimedAt) : Number.NaN;
    const stale = !Number.isFinite(claimedAtMs) || Date.now() - claimedAtMs >= WORK_RECOVERY_CLAIM_TTL_MS;
    if (work.status === "recovery" && !stale) {
      return { claimed: false, activeAttemptKey: activeAttemptKey || params.attemptKey, status: "planning", input: null };
    }
    if (work.status !== "failed" && work.status !== "recovery") {
      throw new WorkTransitionConflictError(`Work ${params.workId} is ${work.status}; only failed Work can be retried`);
    }

    const [input] = await db.select().from(schema.workInputs).where(and(
      eq(schema.workInputs.tenantId, params.tenantId),
      eq(schema.workInputs.workId, params.workId),
    )).orderBy(desc(schema.workInputs.createdAt), desc(schema.workInputs.id)).limit(1);
    if (!input) throw new WorkTransitionConflictError("Work has no durable input to retry");

    const now = new Date();
    const [latest] = await db.select({ maxSeq: sql<number>`coalesce(max(${schema.workEvents.seq}), 0)::int` })
      .from(schema.workEvents).where(eq(schema.workEvents.workId, params.workId));
    await db.update(schema.works).set({
      status: "recovery",
      recovery: {
        status: "claimed",
        requestedBy: params.requestedBy,
        attemptKey: params.attemptKey,
        claimedAt: now.toISOString(),
        ...(work.status === "recovery" ? { reclaimedFrom: activeAttemptKey || null } : {}),
      },
      updatedAt: now,
    }).where(and(eq(schema.works.id, params.workId), eq(schema.works.tenantId, params.tenantId)));
    await db.insert(schema.workEvents).values({
      tenantId: params.tenantId,
      workId: params.workId,
      seq: (latest?.maxSeq ?? 0) + 1,
      eventType: work.status === "recovery" ? "retry_claim_recovered" : "retry_requested",
      fromStatus: work.status,
      toStatus: "recovery",
      payload: { requestedBy: params.requestedBy, attemptKey: params.attemptKey, workInputId: input.id },
    });
    return { claimed: true, activeAttemptKey: params.attemptKey, status: "claimed", input };
  });
}

export async function beginWorkPlannerAttempt(params: {
  tenantId: string;
  workId: string;
  workInputId: string;
  attemptKey: string;
  /** Already assembled, tenant-scoped operating context. It is reduced to the
   * bounded immutable DecisionContextSnapshot inside this transaction. */
  decisionContext?: unknown;
}): Promise<{
  id: string;
  attempt: number;
  claimed: boolean;
  status: "planning" | "succeeded" | "failed" | "timed_out";
  decisionContextSnapshot: DecisionContextSnapshot | null;
  decisionContextHash: string | null;
}> {
  return withTenant(params.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${schema.works} WHERE ${schema.works.id} = ${params.workId} AND ${schema.works.tenantId} = ${params.tenantId} FOR UPDATE`);
    const [work] = await db.select().from(schema.works).where(and(eq(schema.works.id, params.workId), eq(schema.works.tenantId, params.tenantId))).limit(1);
    if (!work) throw new Error("Work not found");
    const [existing] = await db.select().from(schema.workPlannerAttempts).where(and(eq(schema.workPlannerAttempts.workId, params.workId), eq(schema.workPlannerAttempts.attemptKey, params.attemptKey))).limit(1);
    if (existing) return {
      id: existing.id,
      attempt: existing.attempt,
      claimed: false,
      status: existing.status,
      decisionContextSnapshot: existing.decisionContextSnapshot as DecisionContextSnapshot | null,
      decisionContextHash: existing.decisionContextHash,
    };
    const [input] = await db.select().from(schema.workInputs).where(and(eq(schema.workInputs.id, params.workInputId), eq(schema.workInputs.workId, params.workId))).limit(1);
    const snapshot = await decisionContextSnapshot(db, work, input, params.decisionContext);
    const [latest] = await db.select({ maxAttempt: sql<number>`coalesce(max(${schema.workPlannerAttempts.attempt}), 0)::int` }).from(schema.workPlannerAttempts).where(eq(schema.workPlannerAttempts.workId, params.workId));
    const [created] = await db.insert(schema.workPlannerAttempts).values({
      tenantId: params.tenantId,
      workId: params.workId,
      workInputId: params.workInputId,
      attempt: (latest?.maxAttempt ?? 0) + 1,
      attemptKey: params.attemptKey,
      status: "planning",
      decisionContextSnapshot: snapshot,
      decisionContextHash: provenanceHash(snapshot),
      decisionContextCapturedAt: new Date(snapshot.capturedAt),
    }).returning();
    return {
      id: created!.id,
      attempt: created!.attempt,
      claimed: true,
      status: created!.status,
      decisionContextSnapshot: snapshot,
      decisionContextHash: provenanceHash(snapshot),
    };
  });
}

export async function finishWorkPlannerAttempt(params: {
  tenantId: string;
  attemptId: string;
  status: "succeeded" | "failed" | "timed_out";
  plannerResult?: Record<string, unknown>;
  failure?: Record<string, unknown>;
}): Promise<void> {
  await withTenant(params.tenantId, (db) => db.update(schema.workPlannerAttempts).set({
    status: params.status,
    plannerResult: params.plannerResult ?? null,
    failure: params.failure ?? null,
    completedAt: new Date(),
  }).where(and(eq(schema.workPlannerAttempts.id, params.attemptId), eq(schema.workPlannerAttempts.tenantId, params.tenantId))));
}

export interface PersistSelectedWorkPlanParams {
  tenantId: string;
  workId: string;
  workInputId: string;
  plannerAttemptId: string;
  objectiveLoopId?: string | null;
  parentRevisionId?: string | null;
  reason: "initial" | "observation" | "failure" | "stale" | "timeout" | "redirect";
  goalSpec: object;
  constraintSet: object;
  planningSnapshot: object;
  candidatePlans: unknown[];
  compilationResult: object;
  planGraph: object;
  score: object;
  semanticHash: string;
  compilerVersion?: string;
}

type PlanNodeProjection = { id: string; semanticHash: string; kind: string };

function persistedPlanNodes(value: unknown): PlanNodeProjection[] {
  const nodes = jsonObject(value).nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((value) => {
    const node = jsonObject(value);
    return typeof node.id === "string" && typeof node.semanticHash === "string" && typeof node.kind === "string"
      ? [{ id: node.id, semanticHash: node.semanticHash, kind: node.kind }]
      : [];
  }).sort((left, right) => left.semanticHash.localeCompare(right.semanticHash) || left.id.localeCompare(right.id));
}

async function planRevisionTransition(
  db: Db,
  params: PersistSelectedWorkPlanParams,
  parent: typeof schema.workPlanRevisions.$inferSelect | undefined,
): Promise<Record<string, unknown>> {
  const currentNodes = persistedPlanNodes(params.planGraph);
  if (!parent) {
    const body = {
      version: 1,
      parentRevisionId: null,
      cause: params.reason,
      worldSnapshot: { from: null, to: String(jsonObject(params.planningSnapshot).semanticHash ?? "") },
      preservedCompletedNodes: [],
      preservedNodes: [],
      invalidatedNodes: [],
      supersededPendingNodes: [],
      newNodes: currentNodes.map((node) => ({ nodeId: node.id, semanticHash: node.semanticHash, kind: node.kind })),
    };
    return { ...body, transitionHash: `sha256:${provenanceHash(body)}` };
  }
  const parentNodes = persistedPlanNodes(parent.planGraph);
  const parentBySemantic = new Map(parentNodes.map((node) => [node.semanticHash, node]));
  const currentBySemantic = new Map(currentNodes.map((node) => [node.semanticHash, node]));
  const completedSteps = await db.select({
    planNodeId: schema.workObjectiveSteps.planNodeId,
    iterationOutcome: schema.workObjectiveSteps.iterationOutcome,
    failure: schema.workObjectiveSteps.failure,
    completedAt: schema.workObjectiveSteps.completedAt,
    verificationResult: schema.workObjectiveSteps.verificationResult,
    successVerification: schema.workObjectiveSteps.successVerification,
  }).from(schema.workObjectiveSteps).where(and(
    eq(schema.workObjectiveSteps.tenantId, params.tenantId),
    eq(schema.workObjectiveSteps.workId, params.workId),
    eq(schema.workObjectiveSteps.planRevisionId, parent.id),
    sql`${schema.workObjectiveSteps.completedAt} IS NOT NULL`,
  ));
  const safelyCompleted = new Set(completedSteps.filter((step) => {
    const verification = jsonObject(step.verificationResult ?? step.successVerification);
    return verification.state === "verified"
      || (["continue", "completed"].includes(step.iterationOutcome ?? "") && Object.keys(jsonObject(step.failure)).length === 0);
  }).map((step) => step.planNodeId).filter((id): id is string => Boolean(id)));
  const preservedNodes = currentNodes.flatMap((node) => {
    const previous = parentBySemantic.get(node.semanticHash);
    return previous ? [{ parentNodeId: previous.id, nodeId: node.id, semanticHash: node.semanticHash, kind: node.kind }] : [];
  });
  const body = {
    version: 1,
    parentRevisionId: parent.id,
    cause: params.reason,
    worldSnapshot: { from: parent.worldSnapshotHash, to: String(jsonObject(params.planningSnapshot).semanticHash ?? "") },
    preservedCompletedNodes: preservedNodes.filter((node) => safelyCompleted.has(node.parentNodeId)),
    preservedNodes,
    invalidatedNodes: parentNodes.filter((node) => !currentBySemantic.has(node.semanticHash)).map((node) => ({ nodeId: node.id, semanticHash: node.semanticHash, kind: node.kind })),
    supersededPendingNodes: parentNodes.filter((node) => !safelyCompleted.has(node.id)).map((node) => ({ nodeId: node.id, semanticHash: node.semanticHash, kind: node.kind })),
    newNodes: currentNodes.filter((node) => !parentBySemantic.has(node.semanticHash)).map((node) => ({ nodeId: node.id, semanticHash: node.semanticHash, kind: node.kind })),
  };
  return { ...body, transitionHash: `sha256:${provenanceHash(body)}` };
}

/** Atomically selects one immutable graph. A competing planner may replay the same
 * semantic selection, but it cannot create a second active revision. Replanning
 * must name and supersede the exact current parent. */
export async function persistSelectedWorkPlan(params: PersistSelectedWorkPlanParams): Promise<typeof schema.workPlanRevisions.$inferSelect> {
  return withTenant(params.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${schema.works} WHERE ${schema.works.id}=${params.workId} AND ${schema.works.tenantId}=${params.tenantId} FOR UPDATE`);
    const [attempt] = await db.select().from(schema.workPlannerAttempts).where(and(
      eq(schema.workPlannerAttempts.tenantId, params.tenantId),
      eq(schema.workPlannerAttempts.id, params.plannerAttemptId),
      eq(schema.workPlannerAttempts.workId, params.workId),
    )).limit(1);
    if (!attempt || attempt.workInputId !== params.workInputId) throw new Error("Planner attempt does not belong to this exact Work/Input");
    const [semanticReplay] = await db.select().from(schema.workPlanRevisions).where(and(
      eq(schema.workPlanRevisions.tenantId, params.tenantId),
      eq(schema.workPlanRevisions.workId, params.workId),
      eq(schema.workPlanRevisions.semanticHash, params.semanticHash),
    )).limit(1);
    if (semanticReplay) {
      if (semanticReplay.status !== "active") throw new Error("A historical PlanRevision cannot be re-selected as current");
      await db.update(schema.workPlannerAttempts).set({
        goalSpec: boundedJson(params.goalSpec, 131_072) as object,
        constraintSet: boundedJson(params.constraintSet, 131_072) as object,
        planningSnapshot: boundedJson(params.planningSnapshot, 262_144) as object,
        candidatePlans: boundedJson(params.candidatePlans, 262_144) as object,
        compilationResult: boundedJson(params.compilationResult, 262_144) as object,
        selectedPlanRevisionId: semanticReplay.id,
      }).where(and(eq(schema.workPlannerAttempts.tenantId, params.tenantId), eq(schema.workPlannerAttempts.id, params.plannerAttemptId)));
      return semanticReplay;
    }
    const [active] = await db.select().from(schema.workPlanRevisions).where(and(
      eq(schema.workPlanRevisions.tenantId, params.tenantId),
      eq(schema.workPlanRevisions.workId, params.workId),
      eq(schema.workPlanRevisions.status, "active"),
    )).limit(1);
    const parentId = params.parentRevisionId ?? null;
    let transitionParent = active;
    if (active && active.id !== parentId) throw new Error("A different active PlanRevision already owns this Work");
    if (!active && parentId) {
      const [historicalParent] = await db.select().from(schema.workPlanRevisions).where(and(
        eq(schema.workPlanRevisions.tenantId, params.tenantId),
        eq(schema.workPlanRevisions.workId, params.workId),
        eq(schema.workPlanRevisions.id, parentId),
      )).limit(1);
      const [latestHistorical] = await db.select({ id: schema.workPlanRevisions.id }).from(schema.workPlanRevisions).where(and(
        eq(schema.workPlanRevisions.tenantId, params.tenantId),
        eq(schema.workPlanRevisions.workId, params.workId),
      )).orderBy(desc(schema.workPlanRevisions.revision)).limit(1);
      if (!historicalParent || latestHistorical?.id !== historicalParent.id || !["superseded", "blocked", "failed"].includes(historicalParent.status)) {
        throw new Error("Replanning parent is not the latest resumable historical PlanRevision");
      }
      transitionParent = historicalParent;
    }
    if (active) {
      await db.update(schema.workPlanRevisions).set({ status: "superseded" }).where(and(
        eq(schema.workPlanRevisions.tenantId, params.tenantId),
        eq(schema.workPlanRevisions.id, active.id),
        eq(schema.workPlanRevisions.status, "active"),
      ));
      // Plan replacement fences both physical ownership (the P7 status trigger)
      // and the exact logical attempts. Historical successful/verified attempts
      // remain immutable evidence; only unfinished attempts are retired.
      await db.update(schema.workObjectiveSteps).set({
        phase: "finished",
        executionState: "superseded",
        iterationOutcome: "blocked",
        decisionReason: `Logical attempt superseded by child PlanRevision selected for ${params.reason}.`,
        failure: { code: "PLAN_SUPERSEDED", planRevisionId: active.id, cause: params.reason },
        claimOwner: null,
        claimUntil: null,
        completedAt: new Date(),
      }).where(and(
        eq(schema.workObjectiveSteps.tenantId, params.tenantId),
        eq(schema.workObjectiveSteps.workId, params.workId),
        eq(schema.workObjectiveSteps.planRevisionId, active.id),
        sql`${schema.workObjectiveSteps.completedAt} IS NULL`,
      ));
    }
    const [latest] = await db.select({ revision: sql<number>`coalesce(max(${schema.workPlanRevisions.revision}),0)::int` })
      .from(schema.workPlanRevisions).where(and(eq(schema.workPlanRevisions.tenantId, params.tenantId), eq(schema.workPlanRevisions.workId, params.workId)));
    const revision = (latest?.revision ?? 0) + 1;
    if ((revision === 1) !== (parentId === null)) throw new Error("Only the first PlanRevision may omit a parent");
    const transition = await planRevisionTransition(db, params, transitionParent);
    const [created] = await db.insert(schema.workPlanRevisions).values({
      tenantId: params.tenantId,
      workId: params.workId,
      workInputId: params.workInputId,
      plannerAttemptId: params.plannerAttemptId,
      objectiveLoopId: params.objectiveLoopId ?? null,
      revision,
      parentRevisionId: parentId,
      reason: params.reason,
      status: "active",
      goalSpec: boundedJson(params.goalSpec, 131_072) as object,
      constraintSet: boundedJson(params.constraintSet, 131_072) as object,
      planningSnapshot: boundedJson(params.planningSnapshot, 262_144) as object,
      candidateSummary: boundedJson({
        candidates: jsonObject(params.compilationResult).candidates ?? [],
        selected: jsonObject(params.compilationResult).selected ?? null,
      }, 262_144) as object,
      validation: boundedJson(params.compilationResult, 262_144) as object,
      planGraph: boundedJson(params.planGraph, 262_144) as object,
      score: boundedJson(params.score, 32_768) as object,
      goalHash: String(jsonObject(params.goalSpec).semanticHash ?? ""),
      constraintHash: String(jsonObject(params.constraintSet).semanticHash ?? ""),
      worldSnapshotHash: String(jsonObject(params.planningSnapshot).semanticHash ?? ""),
      graphHash: params.semanticHash,
      semanticHash: params.semanticHash,
      compilerVersion: params.compilerVersion ?? "unknown-legacy-compiler",
      revisionTransition: boundedJson(transition, 131_072) as object,
    }).returning();
    if (!created) throw new Error("Unable to persist selected PlanRevision");
    await db.update(schema.workPlannerAttempts).set({
      goalSpec: boundedJson(params.goalSpec, 131_072) as object,
      constraintSet: boundedJson(params.constraintSet, 131_072) as object,
      planningSnapshot: boundedJson(params.planningSnapshot, 262_144) as object,
      candidatePlans: boundedJson(params.candidatePlans, 262_144) as object,
      compilationResult: boundedJson(params.compilationResult, 262_144) as object,
      selectedPlanRevisionId: created.id,
    }).where(and(eq(schema.workPlannerAttempts.tenantId, params.tenantId), eq(schema.workPlannerAttempts.id, params.plannerAttemptId)));
    return created;
  });
}

export async function recordRejectedWorkPlan(params: Omit<PersistSelectedWorkPlanParams, "workInputId" | "planGraph" | "score" | "semanticHash" | "parentRevisionId" | "reason">): Promise<void> {
  await withTenant(params.tenantId, (db) => db.update(schema.workPlannerAttempts).set({
    goalSpec: boundedJson(params.goalSpec, 131_072) as object,
    constraintSet: boundedJson(params.constraintSet, 131_072) as object,
    planningSnapshot: boundedJson(params.planningSnapshot, 262_144) as object,
    candidatePlans: boundedJson(params.candidatePlans, 262_144) as object,
    compilationResult: boundedJson(params.compilationResult, 262_144) as object,
  }).where(and(
    eq(schema.workPlannerAttempts.tenantId, params.tenantId),
    eq(schema.workPlannerAttempts.id, params.plannerAttemptId),
    eq(schema.workPlannerAttempts.workId, params.workId),
  )));
}

export async function activeWorkPlanRevision(tenantId: string, workId: string): Promise<typeof schema.workPlanRevisions.$inferSelect | null> {
  const [row] = await withTenant(tenantId, (db) => db.select().from(schema.workPlanRevisions).where(and(
    eq(schema.workPlanRevisions.tenantId, tenantId),
    eq(schema.workPlanRevisions.workId, workId),
    eq(schema.workPlanRevisions.status, "active"),
  )).limit(1));
  return row ?? null;
}

export async function completeWorkPlanRevision(params: { tenantId: string; planRevisionId: string; completionProof: Record<string, unknown> }): Promise<boolean> {
  if (params.completionProof.version !== 1 || params.completionProof.verified !== true) throw new Error("A verified CompletionProof is required");
  return withTenant(params.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${schema.workPlanRevisions} WHERE ${schema.workPlanRevisions.id}=${params.planRevisionId} AND ${schema.workPlanRevisions.tenantId}=${params.tenantId} FOR UPDATE`);
    const [revision] = await db.select().from(schema.workPlanRevisions).where(and(
      eq(schema.workPlanRevisions.tenantId, params.tenantId),
      eq(schema.workPlanRevisions.id, params.planRevisionId),
    )).limit(1);
    if (!revision || revision.status !== "active") return false;
    const verification = jsonObject(params.completionProof.verification);
    if (params.completionProof.finalPlanRevisionId !== revision.id || params.completionProof.planRevisionId !== revision.id
      || params.completionProof.planSemanticHash !== revision.graphHash || params.completionProof.goalSemanticHash !== revision.goalHash
      || verification.state !== "verified" || typeof params.completionProof.verifiedAt !== "string"
      || !/^sha256:[0-9a-f]{64}$/.test(String(params.completionProof.successConditionHash ?? ""))) {
      throw new Error("CompletionProof identity does not match the active PlanRevision and verified Objective result");
    }
    const rows = await db.update(schema.workPlanRevisions).set({
      status: "completed",
      completionProof: boundedJson(params.completionProof, 262_144) as object,
      completedAt: new Date(),
    }).where(and(
      eq(schema.workPlanRevisions.tenantId, params.tenantId),
      eq(schema.workPlanRevisions.id, params.planRevisionId),
      eq(schema.workPlanRevisions.status, "active"),
    )).returning({ id: schema.workPlanRevisions.id });
    return rows.length === 1;
  });
}

async function decisionContextSnapshot(
  db: Db,
  work: typeof schema.works.$inferSelect,
  input: typeof schema.workInputs.$inferSelect | undefined,
  suppliedContext?: unknown,
): Promise<DecisionContextSnapshot> {
  const supplied = jsonObject(suppliedContext);
  const rawContext = supplied.interactionContext ?? input?.contextSnapshot ?? work.activeContext;
  const context = boundedProvenance(rawContext);
  const refs = canonicalRefsFromContext(rawContext);
  const focused = jsonObject(context?.focusedEntity);
  const selected = Array.isArray(context?.selectedEntities) ? context.selectedEntities : [];
  const excluded = Array.isArray(context?.excludedEntities) ? context.excludedEntities : [];
  const relationshipFor = (ref: CanonicalEntityRef): DecisionContextSnapshot["entities"][number]["relationship"] => {
    if (focused.entityType === ref.entityType && focused.entityId === ref.entityId) return "focused";
    if (selected.some((candidate) => {
      const row = jsonObject(candidate);
      return row.entityType === ref.entityType && row.entityId === ref.entityId;
    })) return "selected";
    if (excluded.some((candidate) => {
      const row = jsonObject(candidate);
      return row.entityType === ref.entityType && row.entityId === ref.entityId;
    })) return "excluded";
    return "referenced";
  };
  const userIds = refs.filter((ref) => ref.entityType === "user").map((ref) => ref.entityId);
  // This function runs on one transaction-bound pg client. Query it in order;
  // concurrent client.query calls are deprecated and can interleave state.
  const userRows = userIds.length > 0
    ? await db.select({ id: schema.users.id, displayName: schema.users.displayName, email: schema.users.email, status: schema.users.status }).from(schema.users).where(inArray(schema.users.id, userIds))
    : [];
  const authorityState = await db.select({ revision: schema.authorityStates.revision }).from(schema.authorityStates).where(eq(schema.authorityStates.tenantId, work.tenantId)).limit(1);
  const userById = new Map(userRows.map((row) => [row.id, row]));
  const entities = refs.slice(0, 100).map((ref) => {
    const user = ref.entityType === "user" ? userById.get(ref.entityId) : undefined;
    return {
      entityType: ref.entityType,
      entityId: ref.entityId,
      relationship: relationshipFor(ref),
      label: user?.displayName ?? user?.email ?? null,
      status: user?.status ?? null,
      occurredAt: null,
      sourceTable: user ? "users" : null,
    };
  });
  const authority = Object.keys(jsonObject(supplied.authority)).length > 0 ? jsonObject(supplied.authority) : jsonObject(work.authorityContext);
  const revision = typeof authority.revision === "number" ? authority.revision : authorityState[0]?.revision ?? null;
  const roles = Array.isArray(authority.roles) ? authority.roles.filter((role): role is string => typeof role === "string").slice(0, 20) : [];
  const capturedAt = new Date().toISOString();
  const interactionContext = context?.version === 1 ? context : null;
  const missing = [
    ...(interactionContext ? [] : ["interaction_context"]),
    ...(entities.some((entity) => entity.label === null) ? ["entity_labels"] : []),
    ...(revision === null ? ["authority_revision"] : []),
  ];
  return {
    version: 1,
    capturedAt,
    interactionContext: interactionContext as DecisionContextSnapshot["interactionContext"],
    entities,
    cohort: jsonObject(context?.cohort).executionId && typeof jsonObject(context?.cohort).executionId === "string"
      ? {
          executionId: String(jsonObject(context?.cohort).executionId),
          intent: String(jsonObject(context?.cohort).queryIntent ?? "work_list"),
          status: "succeeded",
          rowCount: Number(jsonObject(context?.cohort).count ?? 0),
          completedAt: null,
        }
      : null,
    canonicalEvidence: refs.slice(0, 100).map((ref) => ({ kind: "entity_reference", source: "work_entity_links", ref: `${work.id}:${ref.entityType}:${ref.entityId}`, asOf: capturedAt })),
    canonicalSummaries: Array.isArray(supplied.canonicalSummaries) && supplied.canonicalSummaries.length > 0
      ? supplied.canonicalSummaries.slice(0, 40).map((summary, index) => {
          const row = jsonObject(summary);
          return {
            name: typeof row.name === "string" ? row.name : `canonical_${index + 1}`,
            source: typeof row.source === "string" ? row.source : "operating_context",
            asOf: typeof row.asOf === "string" ? row.asOf : capturedAt,
            dataHash: provenanceHash(row.data ?? row),
          };
        })
      : [{ name: "work_context", source: "works.active_context", asOf: capturedAt, dataHash: provenanceHash(rawContext ?? {}) }],
    authority: { employeeId: work.currentOwnerId ?? work.createdBy, revision, roles },
    health: { status: missing.length === 0 ? "complete" : "partial", missing },
  };
}

export async function latestWorkInput(tenantId: string, workId: string): Promise<typeof schema.workInputs.$inferSelect | null> {
  const [row] = await withTenant(tenantId, (db) => db.select().from(schema.workInputs).where(and(eq(schema.workInputs.tenantId, tenantId), eq(schema.workInputs.workId, workId))).orderBy(desc(schema.workInputs.createdAt), desc(schema.workInputs.id)).limit(1));
  return row ?? null;
}

/** Cheap tenant-scoped existence check for routes that must reconcile before
 * materializing the full Work aggregate. */
export async function workExists(tenantId: string, workId: string): Promise<boolean> {
  const [row] = await withTenant(tenantId, (db) => db.select({ id: schema.works.id }).from(schema.works).where(and(eq(schema.works.tenantId, tenantId), eq(schema.works.id, workId))).limit(1));
  return Boolean(row);
}

/** Recomputes Work from durable child records. This is called after every existing
 * executor/workflow transition, so Work never claims completion while a real run is
 * active or an approval is still outstanding. */
export async function reconcileWorkStatus(tenantId: string, workId: string): Promise<WorkStatus> {
  const snapshot = await withTenant(tenantId, async (db) => {
    // Reconciliation only needs status predicates and counts. Fetching every child
    // row here made one status refresh proportional to the entire Work history and
    // was one of the production paths that could turn append-only tables into an
    // egress source. Grouping in PostgreSQL preserves the exact state-machine
    // predicates without moving the history across the network.
    const actionStatusRows = await db.select({ status: schema.domainActions.status, count: sql<number>`count(*)::int` })
      .from(schema.domainActions)
      .where(and(eq(schema.domainActions.tenantId, tenantId), eq(schema.domainActions.workId, workId)))
      .groupBy(schema.domainActions.status);
    const runStatusRows = await db.select({ status: schema.workflowRuns.status, count: sql<number>`count(*)::int` })
      .from(schema.workflowRuns)
      .where(and(eq(schema.workflowRuns.tenantId, tenantId), eq(schema.workflowRuns.workId, workId)))
      .groupBy(schema.workflowRuns.status);
    const repairStatusRows = await db.select({ status: schema.planRepairs.status, count: sql<number>`count(*)::int` })
      .from(schema.planRepairs)
      .where(and(eq(schema.planRepairs.tenantId, tenantId), eq(schema.planRepairs.workId, workId)))
      .groupBy(schema.planRepairs.status);
    const operationStatusRows = await db.select({ status: schema.businessOperations.status, count: sql<number>`count(*)::int` })
      .from(schema.businessOperations)
      .where(and(eq(schema.businessOperations.tenantId, tenantId), eq(schema.businessOperations.workId, workId)))
      .groupBy(schema.businessOperations.status);
    const [objectiveLoop] = await db.select({ id: schema.workObjectiveLoops.id, state: schema.workObjectiveLoops.state }).from(schema.workObjectiveLoops).where(and(eq(schema.workObjectiveLoops.tenantId, tenantId), eq(schema.workObjectiveLoops.workId, workId))).limit(1);
    const [work] = await db.select().from(schema.works).where(and(eq(schema.works.tenantId, tenantId), eq(schema.works.id, workId))).limit(1);
    const statusGroup = (rows: Array<{ status: string; count: number }>) => ({
      counts: new Map(rows.map((row) => [row.status, Number(row.count)])),
      total: rows.reduce((total, row) => total + Number(row.count), 0),
    });
    return {
      actions: statusGroup(actionStatusRows),
      runs: statusGroup(runStatusRows),
      repairs: statusGroup(repairStatusRows),
      operations: statusGroup(operationStatusRows),
      objectiveLoop,
      work,
    };
  });
  if (!snapshot.work) throw new Error("Work not found");
  // Terminal parent truth is immutable until an explicit continuation/recovery
  // input changes it. Late child evidence may be inspected, but reconciliation
  // must never resurrect or relabel completed, failed, or cancelled Work.
  if (isImmutableWorkStatus(snapshot.work.status)) return snapshot.work.status;
  if (snapshot.objectiveLoop) {
    const status: WorkStatus = snapshot.objectiveLoop.state === "continue"
      ? "executing"
      : snapshot.objectiveLoop.state;
    if (status !== snapshot.work.status) {
      await transitionWork(tenantId, workId, status, "objective_loop_reconciled", {
        objectiveLoopId: snapshot.objectiveLoop.id,
        objectiveState: snapshot.objectiveLoop.state,
      }, status === "completed" ? { finalOutcome: { objectiveLoopId: snapshot.objectiveLoop.id, state: "completed" } } : status === "failed" ? { failure: { objectiveLoopId: snapshot.objectiveLoop.id, state: "failed" } } : {});
    }
    return status;
  }
  if (snapshot.actions.total === 0 && snapshot.runs.total === 0) return snapshot.work.status;

  const has = (group: { counts: Map<string, number> }, statuses: string[]) => statuses.some((status) => (group.counts.get(status) ?? 0) > 0);
  const all = (group: { counts: Map<string, number>; total: number }, statuses: string[]) =>
    group.total === 0 || statuses.reduce((count, status) => count + (group.counts.get(status) ?? 0), 0) === group.total;
  let status: WorkStatus;
  if (has(snapshot.repairs, ["planning", "proposed"]) || has(snapshot.operations, ["needs_human_review"])) status = "recovery";
  else if (has(snapshot.operations, ["queued", "running"]) || has(snapshot.runs, ["running", "compensating"]) || has(snapshot.actions, ["approved", "executing"])) status = "executing";
  else if (has(snapshot.actions, ["pending", "needs_human_review"]) || has(snapshot.runs, ["paused", "escalated"])) status = "awaiting_approval";
  else if (has(snapshot.actions, ["draft"])) status = "actionable";
  else if (has(snapshot.actions, ["failed", "blocked_integration_unavailable"]) || has(snapshot.runs, ["failed"]) || has(snapshot.operations, ["failed"])) status = "failed";
  else if (snapshot.actions.total > 0 && all(snapshot.actions, ["rejected"]) && all(snapshot.runs, ["cancelled"]) && all(snapshot.operations, ["cancelled"])) status = "cancelled";
  else if (snapshot.actions.total > 0 && all(snapshot.actions, ["completed", "rejected"]) && all(snapshot.runs, ["completed", "compensated", "cancelled"]) && all(snapshot.operations, ["completed", "completed_with_failures", "cancelled"])) status = "completed";
  else status = snapshot.work.status;

  const counts = {
    actions: Object.fromEntries(snapshot.actions.counts),
    workflows: Object.fromEntries(snapshot.runs.counts),
    operations: Object.fromEntries(snapshot.operations.counts),
  };
  if (status !== snapshot.work.status) {
    await transitionWork(tenantId, workId, status, "children_reconciled", counts, status === "completed" || status === "cancelled" ? { finalOutcome: counts } : status === "failed" ? { failure: counts } : {});
  }
  return status;
}

export type WorkAggregate = Record<string, unknown> & {
  planRevisions: Array<typeof schema.workPlanRevisions.$inferSelect>;
  businessEffects: Array<typeof schema.businessEffects.$inferSelect>;
  entityLinks: Array<typeof schema.workEntityLinks.$inferSelect>;
  queryExecutions: Array<typeof schema.workQueryExecutions.$inferSelect>;
  operations: Array<typeof schema.businessOperations.$inferSelect>;
  operationTargets: Array<typeof schema.businessOperationTargets.$inferSelect>;
  operationEvents: Array<typeof schema.businessOperationEvents.$inferSelect>;
  objectiveLoop: typeof schema.workObjectiveLoops.$inferSelect | null;
  objectiveSteps: Array<typeof schema.workObjectiveSteps.$inferSelect>;
  objectivePlannerAttempts: Array<typeof schema.workObjectivePlannerAttempts.$inferSelect>;
  workforceAssignments: Array<typeof schema.workforceAssignments.$inferSelect>;
  recoveryDecisions: Array<typeof schema.workRecoveryDecisions.$inferSelect>;
  eventWaits: Array<typeof schema.workEventWaits.$inferSelect>;
  wakeClaims: Array<typeof schema.workWakeClaims.$inferSelect>;
  integrationEvents: Array<typeof schema.integrationEvents.$inferSelect>;
  read: {
    limit: number;
    complete: boolean;
    truncatedTables: string[];
  };
};

export async function workAggregate(tenantId: string, workId: string): Promise<WorkAggregate | null> {
  return withTenant(tenantId, async (db) => {
    const [work] = await db.select().from(schema.works).where(and(eq(schema.works.tenantId, tenantId), eq(schema.works.id, workId))).limit(1);
    if (!work) return null;
    const truncatedTables: string[] = [];
    const bounded = <T>(table: string, rows: T[]): T[] => {
      if (rows.length > MAX_WORK_AGGREGATE_ROWS) truncatedTables.push(table);
      return rows.slice(0, MAX_WORK_AGGREGATE_ROWS);
    };
    const inputs = bounded("work_inputs", await db.select().from(schema.workInputs).where(eq(schema.workInputs.workId, workId)).orderBy(asc(schema.workInputs.createdAt), asc(schema.workInputs.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1));
    const plannerAttempts = bounded("work_planner_attempts", await db.select().from(schema.workPlannerAttempts).where(eq(schema.workPlannerAttempts.workId, workId)).orderBy(asc(schema.workPlannerAttempts.attempt), asc(schema.workPlannerAttempts.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1));
    const planRevisions = bounded("work_plan_revisions", await db.select().from(schema.workPlanRevisions).where(and(eq(schema.workPlanRevisions.tenantId, tenantId), eq(schema.workPlanRevisions.workId, workId))).orderBy(asc(schema.workPlanRevisions.revision), asc(schema.workPlanRevisions.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1));
    const events = bounded("work_events", await db.select().from(schema.workEvents).where(eq(schema.workEvents.workId, workId)).orderBy(asc(schema.workEvents.seq), asc(schema.workEvents.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1));
    const actions = bounded("domain_actions", await db.select().from(schema.domainActions).where(eq(schema.domainActions.workId, workId)).orderBy(asc(schema.domainActions.createdAt), asc(schema.domainActions.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1));
    const actionIds = actions.map((row) => row.id);
    const businessEffects = actionIds.length === 0 ? [] : bounded("business_effects", await db.select().from(schema.businessEffects).where(and(
      eq(schema.businessEffects.tenantId, tenantId),
      inArray(schema.businessEffects.domainActionId, actionIds),
    )).orderBy(asc(schema.businessEffects.createdAt), asc(schema.businessEffects.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1));
    const approvals = actionIds.length === 0 ? [] : bounded("action_log", await db.select().from(schema.actionLog).where(and(inArray(schema.actionLog.domainActionId, actionIds), inArray(schema.actionLog.step, ["gate", "confirmed", "rejected", "escalated", "policy_ungated_authorized"])) ).orderBy(asc(schema.actionLog.timestamp), asc(schema.actionLog.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1));
    const workflowRuns = bounded("workflow_runs", await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.workId, workId)).orderBy(asc(schema.workflowRuns.createdAt), asc(schema.workflowRuns.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1));
    const runIds = workflowRuns.map((row) => row.id);
    const workflowSteps = runIds.length === 0 ? [] : bounded("workflow_steps", await db.select().from(schema.workflowSteps).where(inArray(schema.workflowSteps.workflowRunId, runIds)).orderBy(asc(schema.workflowSteps.sequence), asc(schema.workflowSteps.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1));
    const receipts = bounded("decision_receipts", await db.select().from(schema.decisionReceipts).where(eq(schema.decisionReceipts.workId, workId)).orderBy(asc(schema.decisionReceipts.createdAt), asc(schema.decisionReceipts.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1));
    const repairs = bounded("plan_repairs", await db.select().from(schema.planRepairs).where(eq(schema.planRepairs.workId, workId)).orderBy(asc(schema.planRepairs.createdAt), asc(schema.planRepairs.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1));
    const queryExecutions = bounded("work_query_executions", await db.select().from(schema.workQueryExecutions).where(and(
      eq(schema.workQueryExecutions.tenantId, tenantId),
      eq(schema.workQueryExecutions.workId, workId),
    )).orderBy(asc(schema.workQueryExecutions.startedAt), asc(schema.workQueryExecutions.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1));
    const entityLinks = bounded("work_entity_links", await db.select().from(schema.workEntityLinks).where(and(
      eq(schema.workEntityLinks.tenantId, tenantId),
      eq(schema.workEntityLinks.workId, workId),
    )).orderBy(asc(schema.workEntityLinks.createdAt), asc(schema.workEntityLinks.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1));
    const operations = bounded("business_operations", await db.select().from(schema.businessOperations).where(and(eq(schema.businessOperations.tenantId, tenantId), eq(schema.businessOperations.workId, workId))).orderBy(asc(schema.businessOperations.createdAt), asc(schema.businessOperations.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1));
    const operationIds = operations.map((operation) => operation.id);
    const operationTargets = operationIds.length === 0 ? [] : bounded("business_operation_targets", await db.select().from(schema.businessOperationTargets).where(and(eq(schema.businessOperationTargets.tenantId, tenantId), inArray(schema.businessOperationTargets.operationId, operationIds))).orderBy(asc(schema.businessOperationTargets.ordinal), asc(schema.businessOperationTargets.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1));
    const operationEvents = operationIds.length === 0 ? [] : bounded("business_operation_events", await db.select().from(schema.businessOperationEvents).where(and(eq(schema.businessOperationEvents.tenantId, tenantId), inArray(schema.businessOperationEvents.operationId, operationIds))).orderBy(asc(schema.businessOperationEvents.sequence), asc(schema.businessOperationEvents.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1));
    const [objectiveLoop] = await db.select().from(schema.workObjectiveLoops).where(and(eq(schema.workObjectiveLoops.tenantId, tenantId), eq(schema.workObjectiveLoops.workId, workId))).limit(1);
    const objectiveSteps = objectiveLoop ? bounded("work_objective_steps", await db.select().from(schema.workObjectiveSteps).where(and(eq(schema.workObjectiveSteps.tenantId, tenantId), eq(schema.workObjectiveSteps.objectiveLoopId, objectiveLoop.id))).orderBy(asc(schema.workObjectiveSteps.stepNumber), asc(schema.workObjectiveSteps.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1)) : [];
    const objectivePlannerAttempts = objectiveLoop ? bounded("work_objective_planner_attempts", await db.select().from(schema.workObjectivePlannerAttempts).where(and(eq(schema.workObjectivePlannerAttempts.tenantId, tenantId), eq(schema.workObjectivePlannerAttempts.objectiveLoopId, objectiveLoop.id))).orderBy(asc(schema.workObjectivePlannerAttempts.startedAt), asc(schema.workObjectivePlannerAttempts.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1)) : [];
    const workforceAssignmentRows = bounded("workforce_assignments", await db.select().from(schema.workforceAssignments).where(and(eq(schema.workforceAssignments.tenantId, tenantId), eq(schema.workforceAssignments.workId, workId))).orderBy(asc(schema.workforceAssignments.createdAt), asc(schema.workforceAssignments.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1));
    const recoveryDecisions = bounded("work_recovery_decisions", await db.select().from(schema.workRecoveryDecisions).where(and(eq(schema.workRecoveryDecisions.tenantId, tenantId), eq(schema.workRecoveryDecisions.workId, workId))).orderBy(asc(schema.workRecoveryDecisions.createdAt), asc(schema.workRecoveryDecisions.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1));
    const eventWaits = bounded("work_event_waits", await db.select().from(schema.workEventWaits).where(and(eq(schema.workEventWaits.tenantId, tenantId), eq(schema.workEventWaits.workId, workId))).orderBy(asc(schema.workEventWaits.createdAt), asc(schema.workEventWaits.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1));
    const wakeClaims = bounded("work_wake_claims", await db.select().from(schema.workWakeClaims).where(and(eq(schema.workWakeClaims.tenantId, tenantId), eq(schema.workWakeClaims.workId, workId))).orderBy(asc(schema.workWakeClaims.claimedAt), asc(schema.workWakeClaims.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1));
    const wakeEventIds = wakeClaims.map((claim) => claim.integrationEventId);
    const integrationEvents = bounded("integration_events", await db.select().from(schema.integrationEvents).where(and(
      eq(schema.integrationEvents.tenantId, tenantId),
      wakeEventIds.length > 0
        ? or(eq(schema.integrationEvents.workId, workId), inArray(schema.integrationEvents.id, wakeEventIds))
        : eq(schema.integrationEvents.workId, workId),
    )).orderBy(asc(schema.integrationEvents.occurredAt), asc(schema.integrationEvents.id)).limit(MAX_WORK_AGGREGATE_ROWS + 1));
    return { work, inputs, plannerAttempts, planRevisions, actions, businessEffects, approvals, workflowRuns, workflowSteps, receipts, repairs, events, queryExecutions, entityLinks, operations, operationTargets, operationEvents, objectiveLoop: objectiveLoop ?? null, objectiveSteps, objectivePlannerAttempts, workforceAssignments: workforceAssignmentRows, recoveryDecisions, eventWaits, wakeClaims, integrationEvents, read: { limit: MAX_WORK_AGGREGATE_ROWS, complete: truncatedTables.length === 0, truncatedTables } };
  });
}

// ---------------------------------------------------------------------------
// Upgrade 3: durable operational-query execution receipts. These are deliberately
// separate from beginWorkPlannerAttempt/finishWorkPlannerAttempt: a direct typed
// read is never an LLM planner attempt, even when it is attached to a Work.
// ---------------------------------------------------------------------------

export type WorkQueryIntent = CanonicalOperationalQueryIntent;

export interface BeginWorkQueryExecutionParams {
  tenantId: string;
  workId: string;
  workInputId?: string | null;
  intent: WorkQueryIntent;
  request: Record<string, unknown>;
  executionKey: string;
}

export interface WorkQueryExecutionClaim {
  id: string;
  workId: string;
  workInputId: string | null;
  executionKey: string;
  status: "running" | "succeeded" | "failed";
  claimed: boolean;
  resultSummary: unknown;
  rowCount: number;
}

function boundedJson(value: unknown, maxBytes: number): unknown {
  if (value === undefined) return null;
  try {
    const serialized = JSON.stringify(value);
    if (serialized && Buffer.byteLength(serialized, "utf8") <= maxBytes) return value;
  } catch {
    // A non-serializable error/result must not prevent the durable failure receipt.
  }
  return { bounded: true, truncated: true };
}

/** Canonical JSON comparison for the request portion of an idempotency receipt.
 * Request objects are small typed values, so sorting object keys is sufficient;
 * array order remains meaningful and undefined object members are omitted just as
 * JSONB serialization omits them. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function assertSameWorkQueryExecution(
  existing: { intent: string; request: unknown; workInputId: string | null },
  params: BeginWorkQueryExecutionParams,
): void {
  if (existing.intent !== params.intent || existing.workInputId !== (params.workInputId ?? null) || canonicalJson(existing.request) !== canonicalJson(params.request)) {
    throw new Error("executionKey is already bound to a different operational query");
  }
}

function validateWorkQueryExecutionKey(executionKey: string): void {
  if (!executionKey.trim() || executionKey.length > 256) throw new Error("executionKey must be non-empty and at most 256 characters");
}

/** Claims one idempotent query execution under a tenant Work. The Work/Input
 * ownership checks are explicit even though RLS also protects these tables. */
export async function beginWorkQueryExecution(params: BeginWorkQueryExecutionParams): Promise<WorkQueryExecutionClaim> {
  validateWorkQueryExecutionKey(params.executionKey);
  return withTenant(params.tenantId, async (db) => {
    const [work] = await db.select({ id: schema.works.id }).from(schema.works).where(and(
      eq(schema.works.id, params.workId),
      eq(schema.works.tenantId, params.tenantId),
    )).limit(1);
    if (!work) throw new Error("Work not found");

    if (params.workInputId) {
      const [input] = await db.select({ id: schema.workInputs.id }).from(schema.workInputs).where(and(
        eq(schema.workInputs.id, params.workInputId),
        eq(schema.workInputs.workId, params.workId),
        eq(schema.workInputs.tenantId, params.tenantId),
      )).limit(1);
      if (!input) throw new Error("Work input not found");
    }

    const [existing] = await db.select().from(schema.workQueryExecutions).where(and(
      eq(schema.workQueryExecutions.tenantId, params.tenantId),
      eq(schema.workQueryExecutions.workId, params.workId),
      eq(schema.workQueryExecutions.executionKey, params.executionKey),
    )).limit(1);
    if (existing) {
      assertSameWorkQueryExecution(existing, params);
      return {
        id: existing.id,
        workId: existing.workId,
        workInputId: existing.workInputId,
        executionKey: existing.executionKey,
        status: existing.status,
        claimed: false,
        resultSummary: existing.resultSummary,
        rowCount: existing.rowCount,
      };
    }

    const [created] = await db.insert(schema.workQueryExecutions).values({
      tenantId: params.tenantId,
      workId: params.workId,
      workInputId: params.workInputId ?? null,
      intent: params.intent,
      request: params.request,
      executionKey: params.executionKey,
      status: "running",
      rowCount: 0,
    }).onConflictDoNothing().returning();
    if (created) {
      return {
        id: created.id,
        workId: created.workId,
        workInputId: created.workInputId,
        executionKey: created.executionKey,
        status: created.status,
        claimed: true,
        resultSummary: created.resultSummary,
        rowCount: created.rowCount,
      };
    }

    // A concurrent claimant won the unique (work_id, execution_key) race. Resolve
    // the winner within the same tenant transaction rather than creating a second
    // durable row or treating the race as a query failure.
    const [raced] = await db.select().from(schema.workQueryExecutions).where(and(
      eq(schema.workQueryExecutions.tenantId, params.tenantId),
      eq(schema.workQueryExecutions.workId, params.workId),
      eq(schema.workQueryExecutions.executionKey, params.executionKey),
    )).limit(1);
    if (!raced) throw new Error("Unable to resolve work query execution claim");
    assertSameWorkQueryExecution(raced, params);
    return {
      id: raced.id,
      workId: raced.workId,
      workInputId: raced.workInputId,
      executionKey: raced.executionKey,
      status: raced.status,
      claimed: false,
      resultSummary: raced.resultSummary,
      rowCount: raced.rowCount,
    };
  });
}

export interface FinishWorkQueryExecutionParams {
  tenantId: string;
  executionId: string;
  status: "succeeded" | "failed";
  rowCount: number;
  durationMs: number;
  resultSummary?: unknown;
  failure?: unknown;
}

/** Completes a query execution with a bounded summary and no raw result payload. */
export async function finishWorkQueryExecution(params: FinishWorkQueryExecutionParams): Promise<void> {
  if (!Number.isInteger(params.rowCount) || params.rowCount < 0) throw new Error("rowCount must be a non-negative integer");
  if (!Number.isFinite(params.durationMs) || params.durationMs < 0) throw new Error("durationMs must be non-negative");
  await withTenant(params.tenantId, async (db) => {
    await db.update(schema.workQueryExecutions).set({
      status: params.status,
      resultSummary: params.status === "succeeded" ? boundedJson(params.resultSummary, 16_000) as object : null,
      rowCount: params.rowCount,
      durationMs: Math.round(params.durationMs),
      failure: params.status === "failed" ? boundedJson(params.failure, 8_000) as object : null,
      completedAt: new Date(),
    }).where(and(
      eq(schema.workQueryExecutions.id, params.executionId),
      eq(schema.workQueryExecutions.tenantId, params.tenantId),
    ));
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireEmployeeOwner(ownerEmployeeId: string): void {
  if (!UUID_PATTERN.test(ownerEmployeeId)) throw new Error("canonical_human_principal_required");
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function conversationMessage(row: typeof schema.employeeConversationMessages.$inferSelect): EmployeeConversationMessage {
  return {
    id: row.id,
    threadId: row.threadId,
    sequence: row.sequence,
    role: row.role,
    channel: row.channel,
    originalText: row.originalText,
    instructionId: row.instructionId,
    workId: row.workId,
    workInputId: row.workInputId,
    resolutionSnapshot: row.resolutionSnapshot && typeof row.resolutionSnapshot === "object" ? row.resolutionSnapshot as Record<string, unknown> : null,
    resolutionProvenance: Array.isArray(row.resolutionProvenance) ? row.resolutionProvenance as Array<Record<string, unknown>> : [],
    companyTruthSnapshot: row.companyTruthSnapshot && typeof row.companyTruthSnapshot === "object" ? row.companyTruthSnapshot as Record<string, unknown> : null,
    outcomeRefs: Array.isArray(row.outcomeRefs) ? row.outcomeRefs as Array<Record<string, unknown>> : [],
    createdAt: iso(row.createdAt),
  };
}

function conversationThread(row: typeof schema.employeeConversationThreads.$inferSelect): EmployeeConversationThreadSummary {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    revision: row.revision,
    activeWorkId: row.activeWorkId,
    activeObjectiveLoopId: row.activeObjectiveLoopId,
    lastActivityAt: iso(row.lastActivityAt),
    createdAt: iso(row.createdAt),
  };
}

function personalMemory(row: typeof schema.employeePersonalMemories.$inferSelect): EmployeePersonalMemory {
  return {
    id: row.id,
    memoryType: row.memoryType,
    subjectKey: row.subjectKey,
    proposition: row.proposition,
    structuredValue: row.structuredValue as Record<string, unknown>,
    sourceThreadId: row.sourceThreadId,
    sourceMessageId: row.sourceMessageId,
    provenance: row.provenance as Record<string, unknown>,
    validFrom: iso(row.validFrom),
    supersededAt: row.supersededAt ? iso(row.supersededAt) : null,
    supersededById: row.supersededById,
  };
}

export interface CreateEmployeeConversationThreadParams {
  tenantId: string;
  ownerEmployeeId: string;
  title?: string;
  originTransportKey?: string;
}

export async function createEmployeeConversationThread(params: CreateEmployeeConversationThreadParams): Promise<EmployeeConversationThreadSummary> {
  requireEmployeeOwner(params.ownerEmployeeId);
  return withTenant(params.tenantId, async (db) => {
    const [principal] = await db.select({ id: schema.users.id }).from(schema.users).where(and(
      eq(schema.users.tenantId, params.tenantId),
      eq(schema.users.id, params.ownerEmployeeId),
      eq(schema.users.status, "active"),
    )).limit(1);
    if (!principal) throw new Error("canonical_human_principal_not_active");

    if (params.originTransportKey) {
      const [existing] = await db.select().from(schema.employeeConversationThreads).where(and(
        eq(schema.employeeConversationThreads.tenantId, params.tenantId),
        eq(schema.employeeConversationThreads.ownerEmployeeId, params.ownerEmployeeId),
        eq(schema.employeeConversationThreads.originTransportKey, params.originTransportKey),
      )).limit(1);
      if (existing) return conversationThread(existing);
    }

    const [created] = await db.insert(schema.employeeConversationThreads).values({
      tenantId: params.tenantId,
      ownerEmployeeId: params.ownerEmployeeId,
      title: params.title?.trim().slice(0, 500) || null,
      originTransportKey: params.originTransportKey?.slice(0, 500) || null,
    }).onConflictDoNothing().returning();
    if (created) return conversationThread(created);

    const [raced] = await db.select().from(schema.employeeConversationThreads).where(and(
      eq(schema.employeeConversationThreads.tenantId, params.tenantId),
      eq(schema.employeeConversationThreads.ownerEmployeeId, params.ownerEmployeeId),
      eq(schema.employeeConversationThreads.originTransportKey, params.originTransportKey!),
    )).limit(1);
    if (!raced) throw new Error("Unable to create conversation thread");
    return conversationThread(raced);
  }, params.ownerEmployeeId);
}

export async function listEmployeeConversationThreads(
  tenantId: string,
  ownerEmployeeId: string,
  limit = 30,
): Promise<EmployeeConversationThreadSummary[]> {
  requireEmployeeOwner(ownerEmployeeId);
  const boundedLimit = Math.max(1, Math.min(limit, 100));
  return withTenant(tenantId, async (db) => {
    const rows = await db.select().from(schema.employeeConversationThreads).where(and(
      eq(schema.employeeConversationThreads.tenantId, tenantId),
      eq(schema.employeeConversationThreads.ownerEmployeeId, ownerEmployeeId),
    )).orderBy(desc(schema.employeeConversationThreads.lastActivityAt), desc(schema.employeeConversationThreads.id)).limit(boundedLimit);
    return rows.map(conversationThread);
  }, ownerEmployeeId);
}

export interface LoadedEmployeeConversationThread {
  thread: EmployeeConversationThreadSummary & {
    summaryThroughSequence: number;
    activeReferences: Array<Record<string, unknown>>;
    unresolvedReferences: Array<Record<string, unknown>>;
    outcomeRefs: Array<Record<string, unknown>>;
  };
  messages: EmployeeConversationMessage[];
}

export async function loadEmployeeConversationThread(params: {
  tenantId: string;
  ownerEmployeeId: string;
  threadId: string;
  messageLimit?: number;
  beforeSequence?: number;
}): Promise<LoadedEmployeeConversationThread | null> {
  requireEmployeeOwner(params.ownerEmployeeId);
  const messageLimit = Math.max(1, Math.min(params.messageLimit ?? 50, 200));
  return withTenant(params.tenantId, async (db) => {
    const [thread] = await db.select().from(schema.employeeConversationThreads).where(and(
      eq(schema.employeeConversationThreads.tenantId, params.tenantId),
      eq(schema.employeeConversationThreads.ownerEmployeeId, params.ownerEmployeeId),
      eq(schema.employeeConversationThreads.id, params.threadId),
    )).limit(1);
    if (!thread) return null;
    const before = params.beforeSequence && params.beforeSequence > 0
      ? sql`${schema.employeeConversationMessages.sequence} < ${Math.floor(params.beforeSequence)}`
      : sql`true`;
    const rows = await db.select().from(schema.employeeConversationMessages).where(and(
      eq(schema.employeeConversationMessages.tenantId, params.tenantId),
      eq(schema.employeeConversationMessages.ownerEmployeeId, params.ownerEmployeeId),
      eq(schema.employeeConversationMessages.threadId, params.threadId),
      before,
    )).orderBy(desc(schema.employeeConversationMessages.sequence)).limit(messageLimit);
    return {
      thread: {
        ...conversationThread(thread),
        summaryThroughSequence: thread.summaryThroughSequence,
        activeReferences: Array.isArray(thread.activeReferences) ? thread.activeReferences as Array<Record<string, unknown>> : [],
        unresolvedReferences: Array.isArray(thread.unresolvedReferences) ? thread.unresolvedReferences as Array<Record<string, unknown>> : [],
        outcomeRefs: Array.isArray(thread.outcomeRefs) ? thread.outcomeRefs as Array<Record<string, unknown>> : [],
      },
      messages: rows.reverse().map(conversationMessage),
    };
  }, params.ownerEmployeeId);
}

export interface AppendEmployeeConversationMessageParams {
  tenantId: string;
  ownerEmployeeId: string;
  threadId: string;
  role: "user" | "assistant";
  channel: EmployeeConversationChannel;
  originalText: string;
  idempotencyKey: string;
  instructionId?: string;
  workId?: string;
  workInputId?: string;
  transportSessionId?: string;
  transportProvenance?: Record<string, unknown>;
  resolutionSnapshot?: Record<string, unknown>;
  resolutionProvenance?: Array<Record<string, unknown>>;
  companyTruthSnapshot?: Record<string, unknown>;
  outcomeRefs?: Array<Record<string, unknown>>;
}

export async function appendEmployeeConversationMessage(
  params: AppendEmployeeConversationMessageParams,
): Promise<{ message: EmployeeConversationMessage; duplicate: boolean }> {
  requireEmployeeOwner(params.ownerEmployeeId);
  const text = params.originalText;
  if (!text.trim() || Buffer.byteLength(text, "utf8") > 65_536) throw new Error("conversation_message_invalid");
  return withTenant(params.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${schema.employeeConversationThreads} WHERE ${schema.employeeConversationThreads.id}=${params.threadId} AND ${schema.employeeConversationThreads.tenantId}=${params.tenantId} AND ${schema.employeeConversationThreads.ownerEmployeeId}=${params.ownerEmployeeId} FOR UPDATE`);
    const [thread] = await db.select({ id: schema.employeeConversationThreads.id }).from(schema.employeeConversationThreads).where(and(
      eq(schema.employeeConversationThreads.id, params.threadId),
      eq(schema.employeeConversationThreads.tenantId, params.tenantId),
      eq(schema.employeeConversationThreads.ownerEmployeeId, params.ownerEmployeeId),
    )).limit(1);
    if (!thread) throw new Error("conversation_thread_not_found");
    const [existing] = await db.select().from(schema.employeeConversationMessages).where(and(
      eq(schema.employeeConversationMessages.threadId, params.threadId),
      eq(schema.employeeConversationMessages.idempotencyKey, params.idempotencyKey),
    )).limit(1);
    if (existing) return { message: conversationMessage(existing), duplicate: true };
    const [last] = await db.select({ sequence: schema.employeeConversationMessages.sequence }).from(schema.employeeConversationMessages).where(
      eq(schema.employeeConversationMessages.threadId, params.threadId),
    ).orderBy(desc(schema.employeeConversationMessages.sequence)).limit(1);
    const sequence = (last?.sequence ?? 0) + 1;
    const [created] = await db.insert(schema.employeeConversationMessages).values({
      tenantId: params.tenantId,
      ownerEmployeeId: params.ownerEmployeeId,
      threadId: params.threadId,
      sequence,
      role: params.role,
      channel: params.channel,
      authorEmployeeId: params.role === "user" ? params.ownerEmployeeId : null,
      originalText: text,
      instructionId: params.instructionId ?? null,
      workId: params.workId ?? null,
      workInputId: params.workInputId ?? null,
      idempotencyKey: params.idempotencyKey.slice(0, 500),
      transportSessionId: params.transportSessionId?.slice(0, 500) ?? null,
      transportProvenance: boundedJson(params.transportProvenance ?? {}, 16_000) as object,
      resolutionSnapshot: params.resolutionSnapshot ? boundedJson(params.resolutionSnapshot, 32_000) as object : null,
      resolutionProvenance: boundedJson(params.resolutionProvenance ?? [], 32_000) as object[],
      companyTruthSnapshot: params.companyTruthSnapshot ? boundedJson(params.companyTruthSnapshot, 32_000) as object : null,
      outcomeRefs: boundedJson(params.outcomeRefs ?? [], 32_000) as object[],
    }).returning();
    if (!created) throw new Error("Unable to append conversation message");
    const now = new Date();
    await db.update(schema.employeeConversationThreads).set({
      ...(sequence === 1 && params.role === "user" ? { title: text.replace(/\s+/g, " ").trim().slice(0, 120) } : {}),
      revision: sql`${schema.employeeConversationThreads.revision}+1`,
      lastActivityAt: now,
      updatedAt: now,
    }).where(eq(schema.employeeConversationThreads.id, params.threadId));
    return { message: conversationMessage(created), duplicate: false };
  }, params.ownerEmployeeId);
}

export async function updateEmployeeConversationThreadContext(params: {
  tenantId: string;
  ownerEmployeeId: string;
  threadId: string;
  activeReferences?: Array<Record<string, unknown>>;
  unresolvedReferences?: Array<Record<string, unknown>>;
  activeWorkId?: string | null;
  activeObjectiveLoopId?: string | null;
  outcomeRefs?: Array<Record<string, unknown>>;
  summary?: string | null;
  summaryThroughSequence?: number;
}): Promise<void> {
  requireEmployeeOwner(params.ownerEmployeeId);
  await withTenant(params.tenantId, async (db) => {
    const now = new Date();
    const rows = await db.update(schema.employeeConversationThreads).set({
      ...(params.activeReferences ? { activeReferences: boundedJson(params.activeReferences, 64_000) as object[] } : {}),
      ...(params.unresolvedReferences ? { unresolvedReferences: boundedJson(params.unresolvedReferences, 32_000) as object[] } : {}),
      ...(params.activeWorkId !== undefined ? { activeWorkId: params.activeWorkId } : {}),
      ...(params.activeObjectiveLoopId !== undefined ? { activeObjectiveLoopId: params.activeObjectiveLoopId } : {}),
      ...(params.outcomeRefs ? { outcomeRefs: boundedJson(params.outcomeRefs, 64_000) as object[] } : {}),
      ...(params.summary !== undefined ? { summary: params.summary?.slice(0, 65_536) ?? null } : {}),
      ...(params.summaryThroughSequence !== undefined ? { summaryThroughSequence: Math.max(0, Math.floor(params.summaryThroughSequence)) } : {}),
      revision: sql`${schema.employeeConversationThreads.revision}+1`,
      lastActivityAt: now,
      updatedAt: now,
    }).where(and(
      eq(schema.employeeConversationThreads.tenantId, params.tenantId),
      eq(schema.employeeConversationThreads.ownerEmployeeId, params.ownerEmployeeId),
      eq(schema.employeeConversationThreads.id, params.threadId),
    )).returning({ id: schema.employeeConversationThreads.id });
    if (!rows.length) throw new Error("conversation_thread_not_found");
  }, params.ownerEmployeeId);
}

export async function updateEmployeeConversationMessageContext(params: {
  tenantId: string;
  ownerEmployeeId: string;
  threadId: string;
  messageId: string;
  workId?: string | null;
  workInputId?: string | null;
  resolutionSnapshot?: Record<string, unknown> | null;
  resolutionProvenance?: Array<Record<string, unknown>>;
  companyTruthSnapshot?: Record<string, unknown> | null;
  outcomeRefs?: Array<Record<string, unknown>>;
}): Promise<void> {
  requireEmployeeOwner(params.ownerEmployeeId);
  await withTenant(params.tenantId, async (db) => {
    const rows = await db.update(schema.employeeConversationMessages).set({
      ...(params.workId !== undefined ? { workId: params.workId } : {}),
      ...(params.workInputId !== undefined ? { workInputId: params.workInputId } : {}),
      ...(params.resolutionSnapshot !== undefined ? { resolutionSnapshot: params.resolutionSnapshot ? boundedJson(params.resolutionSnapshot, 32_000) as object : null } : {}),
      ...(params.resolutionProvenance ? { resolutionProvenance: boundedJson(params.resolutionProvenance, 32_000) as object[] } : {}),
      ...(params.companyTruthSnapshot !== undefined ? { companyTruthSnapshot: params.companyTruthSnapshot ? boundedJson(params.companyTruthSnapshot, 32_000) as object : null } : {}),
      ...(params.outcomeRefs ? { outcomeRefs: boundedJson(params.outcomeRefs, 32_000) as object[] } : {}),
    }).where(and(
      eq(schema.employeeConversationMessages.tenantId, params.tenantId),
      eq(schema.employeeConversationMessages.ownerEmployeeId, params.ownerEmployeeId),
      eq(schema.employeeConversationMessages.threadId, params.threadId),
      eq(schema.employeeConversationMessages.id, params.messageId),
    )).returning({ id: schema.employeeConversationMessages.id });
    if (!rows.length) throw new Error("conversation_message_not_found");
  }, params.ownerEmployeeId);
}

export async function searchEmployeeConversationMessages(params: {
  tenantId: string;
  ownerEmployeeId: string;
  query: string;
  threadId?: string;
  limit?: number;
}): Promise<EmployeeConversationMessage[]> {
  requireEmployeeOwner(params.ownerEmployeeId);
  const terms = params.query.replace(/[^\p{L}\p{N}@._ -]+/gu, " ").trim().slice(0, 500);
  if (!terms) return [];
  const limit = Math.max(1, Math.min(params.limit ?? 20, 50));
  return withTenant(params.tenantId, async (db) => {
    const rows = await db.select().from(schema.employeeConversationMessages).where(and(
      eq(schema.employeeConversationMessages.tenantId, params.tenantId),
      eq(schema.employeeConversationMessages.ownerEmployeeId, params.ownerEmployeeId),
      params.threadId ? eq(schema.employeeConversationMessages.threadId, params.threadId) : sql`true`,
      sql`to_tsvector('simple',${schema.employeeConversationMessages.originalText}) @@ plainto_tsquery('simple',${terms})`,
    )).orderBy(desc(schema.employeeConversationMessages.createdAt)).limit(limit);
    return rows.map(conversationMessage);
  }, params.ownerEmployeeId);
}

export async function listEmployeePersonalMemories(params: {
  tenantId: string;
  ownerEmployeeId: string;
  subjectKey?: string;
  includeSuperseded?: boolean;
  limit?: number;
}): Promise<EmployeePersonalMemory[]> {
  requireEmployeeOwner(params.ownerEmployeeId);
  const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
  return withTenant(params.tenantId, async (db) => {
    const rows = await db.select().from(schema.employeePersonalMemories).where(and(
      eq(schema.employeePersonalMemories.tenantId, params.tenantId),
      eq(schema.employeePersonalMemories.ownerEmployeeId, params.ownerEmployeeId),
      params.subjectKey ? eq(schema.employeePersonalMemories.subjectKey, params.subjectKey) : sql`true`,
      params.includeSuperseded ? sql`true` : isNull(schema.employeePersonalMemories.supersededAt),
    )).orderBy(desc(schema.employeePersonalMemories.validFrom)).limit(limit);
    return rows.map(personalMemory);
  }, params.ownerEmployeeId);
}

export async function rememberExplicitEmployeeMemory(params: {
  tenantId: string;
  ownerEmployeeId: string;
  sourceThreadId: string;
  sourceMessageId: string;
  role: "user" | "assistant";
  memoryType: "preference" | "proposition";
  subjectKey: string;
  proposition: string;
  structuredValue: Record<string, unknown>;
  provenance: Record<string, unknown>;
}): Promise<EmployeePersonalMemory | null> {
  requireEmployeeOwner(params.ownerEmployeeId);
  if (params.role !== "user") return null;
  if (!params.subjectKey.trim() || !params.proposition.trim()) throw new Error("personal_memory_invalid");
  return withTenant(params.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${schema.employeeConversationThreads} WHERE ${schema.employeeConversationThreads.id}=${params.sourceThreadId} AND ${schema.employeeConversationThreads.ownerEmployeeId}=${params.ownerEmployeeId} FOR UPDATE`);
    const [current] = await db.select().from(schema.employeePersonalMemories).where(and(
      eq(schema.employeePersonalMemories.tenantId, params.tenantId),
      eq(schema.employeePersonalMemories.ownerEmployeeId, params.ownerEmployeeId),
      eq(schema.employeePersonalMemories.subjectKey, params.subjectKey),
      isNull(schema.employeePersonalMemories.supersededAt),
    )).limit(1);
    const structuredValue = boundedJson(params.structuredValue, 16_000) as object;
    if (current && current.proposition === params.proposition && JSON.stringify(current.structuredValue) === JSON.stringify(structuredValue)) {
      return personalMemory(current);
    }
    const id = randomUUID();
    const now = new Date();
    if (current) {
      await db.update(schema.employeePersonalMemories).set({ supersededAt: now, supersededById: id }).where(eq(schema.employeePersonalMemories.id, current.id));
    }
    const [created] = await db.insert(schema.employeePersonalMemories).values({
      id,
      tenantId: params.tenantId,
      ownerEmployeeId: params.ownerEmployeeId,
      sourceThreadId: params.sourceThreadId,
      sourceMessageId: params.sourceMessageId,
      memoryType: params.memoryType,
      subjectKey: params.subjectKey.slice(0, 500),
      proposition: params.proposition.slice(0, 10_000),
      structuredValue,
      provenance: boundedJson(params.provenance, 16_000) as object,
      validFrom: now,
    }).returning();
    if (!created) throw new Error("Unable to persist personal memory");
    return personalMemory(created);
  }, params.ownerEmployeeId);
}

export * from "./operational-deltas";
