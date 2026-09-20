import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import pg from "pg";
import {
  COMPUTE_CUTOVER_EPOCH,
  ComputeCapacityUnavailableError,
  PRODUCTION_JOB_CONTRACTS,
  WORKLOAD_CLASSES,
  acquireComputeControlLease,
  acquireComputeResourceLeases,
  closePool,
  getPool,
  releaseComputeControlLease,
  releaseComputeResourceLeases,
  renewComputeControlLease,
  renewComputeResourceLeases,
  withGovernedProviderInvocation,
} from "@finnor/db";
import { readComputePressureSignals } from "../../apps/api/lib/backpressure";
import { JobQueue } from "../../apps/worker/src/queue";
import { startHeartbeat, WORKER_HEARTBEAT_ID } from "../../apps/worker/src/heartbeat";
import { migrate } from "../../packages/db/migrate";
import { assertDisposableDatabaseTarget } from "../../packages/db/production-target-guard";
import { seed, SEED_TENANT_ID } from "../../packages/db/seed";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@127.0.0.1:5432/finnor";
const OTHER_TENANT_ID = "00000000-0000-4000-8000-0000000000c3";
const RELEASE_SHA = "a".repeat(40);

if (process.env.FINNOR_SCOPE3_CERTIFICATION === "1") {
  assertDisposableDatabaseTarget(DB_URL, "Scope-3 compute certification");
  if (process.env.FINNOR_SCOPE3_DISPOSABLE_DB !== "1"
      || !/^\/finnor_scope3_cert_[a-f0-9_]+$/.test(new URL(DB_URL).pathname)) {
    throw new Error("Scope-3 compute certification requires its dedicated disposable database harness");
  }
}

async function dbUp(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const available = await dbUp();

function queueFor(workloadClass: (typeof WORKLOAD_CLASSES)[number], handler: () => Promise<void> = async () => undefined): JobQueue {
  const queue = new JobQueue(`scope3:${workloadClass}:${randomUUID()}`, 3, workloadClass);
  const type = {
    REALTIME: "release_probe",
    INTERACTIVE: "process_instruction",
    BACKGROUND: "learning_digest",
    HEAVY: "purge_retention",
  }[workloadClass] as "release_probe" | "process_instruction" | "learning_digest" | "purge_retention";
  queue.register(type, handler, PRODUCTION_JOB_CONTRACTS[type]);
  return queue;
}

async function enqueue(type: "release_probe" | "process_instruction" | "learning_digest" | "purge_retention", tenantId?: string): Promise<void> {
  const workloadClass = PRODUCTION_JOB_CONTRACTS[type].defaultClass;
  const queue = queueFor(workloadClass);
  await queue.enqueue(type, tenantId ? { tenantId } : {}, `scope3:${randomUUID()}`);
}

// This suite changes the compute cutover fence and resource policies. It must
// run only against the disposable database created by the dedicated harness,
// never concurrently with the repository's shared integration database.
describe.skipIf(!available || process.env.FINNOR_SCOPE3_CERTIFICATION !== "1")("Scope-3 real PostgreSQL compute plane", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await seed(DB_URL);
    await getPool().query(
      `INSERT INTO tenants(id,name) VALUES($1,'Scope 3 fair-claim peer') ON CONFLICT(id) DO NOTHING`,
      [OTHER_TENANT_ID],
    );
    await getPool().query(
      `INSERT INTO tenant_vertical_assignments(tenant_id,vertical_key,version,effective_from,source_system,created_by)
       VALUES($1,'private_equity',1,now(),'certification:scope3','system:certification')
       ON CONFLICT(tenant_id) DO NOTHING`,
      [OTHER_TENANT_ID],
    );
    await getPool().query(
      `UPDATE compute_plane_cutover SET state='authoritative',accepted_job_epoch=$1,
        minimum_claim_epoch=$1,enforce_known_job_types=true,legacy_tenant_writes_allowed=false,
        activated_release_sha=$2,activated_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE singleton=true`,
      [COMPUTE_CUTOVER_EPOCH, RELEASE_SHA],
    );
  });

  beforeEach(async () => {
    await getPool().query(
      `DELETE FROM job_delivery_attempts WHERE job_id IN (SELECT id FROM jobs WHERE idempotency_key LIKE 'scope3:%')`,
    );
    await getPool().query(`DELETE FROM jobs WHERE idempotency_key LIKE 'scope3:%'`);
    await getPool().query(`DELETE FROM compute_resource_leases WHERE owner_id LIKE 'scope3:%'`);
  });

  afterAll(async () => {
    await closePool();
  });

  it("persists trusted instance classification and rejects forged class or unknown type", async () => {
    await getPool().query(
      `INSERT INTO jobs(tenant_id,type,payload,idempotency_key,workload_class,lane)
       VALUES($1,'process_instruction',$2::jsonb,$3,'REALTIME','batch')`,
      [SEED_TENANT_ID, JSON.stringify({ tenantId: SEED_TENANT_ID, workloadClass: "REALTIME" }), `scope3:${randomUUID()}`],
    );
    const classified = await getPool().query<{
      workload_class: string; classification_policy_revision: number; classification_reason: string;
      tenant_key: string; tenant_identity_source: string; required_compute_epoch: number;
    }>(`SELECT workload_class,classification_policy_revision,classification_reason,tenant_key,
              tenant_identity_source,required_compute_epoch FROM jobs WHERE idempotency_key LIKE 'scope3:%'`);
    expect(classified.rows[0]).toMatchObject({
      workload_class: "INTERACTIVE",
      classification_policy_revision: 1,
      classification_reason: "policy:process_instruction:fixed:batch",
      tenant_key: SEED_TENANT_ID,
      tenant_identity_source: "durable_column",
      required_compute_epoch: COMPUTE_CUTOVER_EPOCH,
    });
    await expect(getPool().query(
      `UPDATE jobs SET workload_class='REALTIME' WHERE idempotency_key LIKE 'scope3:%'`,
    )).rejects.toThrow(/classification is immutable/);
    await expect(getPool().query(
      `INSERT INTO jobs(type,payload,idempotency_key) VALUES('scope3_unknown','{}'::jsonb,$1)`,
      [`scope3:${randomUUID()}`],
    )).rejects.toThrow(/no active compute classification policy/);
  });

  it("allows legacy draining before cutover, then fences classless and old-epoch claims", async () => {
    await getPool().query(
      `UPDATE compute_plane_cutover SET state='preparing',accepted_job_epoch=1,
         minimum_claim_epoch=1,enforce_known_job_types=false,legacy_tenant_writes_allowed=true,
         activated_release_sha=NULL,activated_at=NULL,updated_at=clock_timestamp()
       WHERE singleton=true`,
    );
    const oldWorker = new JobQueue(`scope3:old-monolith:${randomUUID()}`, 3, null);
    oldWorker.register("process_instruction", async () => undefined, PRODUCTION_JOB_CONTRACTS.process_instruction);
    try {
      await enqueue("process_instruction", SEED_TENANT_ID);
      expect(await queueFor("INTERACTIVE").tick()).toBe(false);
      expect((await readComputePressureSignals(SEED_TENANT_ID, "INTERACTIVE")).eligibleQueued).toBe(0);
      expect(await oldWorker.tick()).toBe(true);
    } finally {
      await getPool().query(
        `UPDATE compute_plane_cutover SET state='authoritative',accepted_job_epoch=$1,
           minimum_claim_epoch=$1,enforce_known_job_types=true,legacy_tenant_writes_allowed=false,
           activated_release_sha=$2,activated_at=clock_timestamp(),updated_at=clock_timestamp()
         WHERE singleton=true`,
        [COMPUTE_CUTOVER_EPOCH, RELEASE_SHA],
      );
    }
    await enqueue("process_instruction", SEED_TENANT_ID);
    await expect(oldWorker.tick()).rejects.toThrow(/compute claimant class/);
    await expect(getPool().query(
      `UPDATE jobs SET status='running' WHERE idempotency_key LIKE 'scope3:%' AND status='queued'`,
    )).rejects.toThrow(/compute claimant epoch/);
    expect(await queueFor("INTERACTIVE").tick()).toBe(true);
  });

  it("claims each of four classes only with its corresponding class service", async () => {
    await enqueue("release_probe");
    await enqueue("process_instruction", SEED_TENANT_ID);
    await enqueue("learning_digest", SEED_TENANT_ID);
    await enqueue("purge_retention", SEED_TENANT_ID);
    const executed: string[] = [];
    const queues = WORKLOAD_CLASSES.map((workloadClass) => queueFor(workloadClass, async () => { executed.push(workloadClass); }));
    for (const queue of queues) expect(await queue.tick()).toBe(true);
    expect(executed.sort()).toEqual([...WORKLOAD_CLASSES].sort());
    for (const queue of queues) expect(await queue.tick()).toBe(false);
    const outcomes = await getPool().query<{ workload_class: string; status: string; worker_id: string }>(
      `SELECT j.workload_class,j.status,d.worker_id FROM jobs j JOIN job_delivery_attempts d ON d.job_id=j.id
        WHERE j.idempotency_key LIKE 'scope3:%' ORDER BY j.workload_class`,
    );
    expect(outcomes.rows).toHaveLength(4);
    expect(outcomes.rows.every((row) => row.status === "completed" && row.worker_id.includes(row.workload_class))).toBe(true);
  });

  it("stops new claims on shutdown and leaves queued Work for a live class worker", async () => {
    await enqueue("process_instruction", SEED_TENANT_ID);
    const stopped = new AbortController();
    stopped.abort();
    expect(await queueFor("INTERACTIVE").tick(stopped.signal)).toBe(false);
    const before = await getPool().query<{ status: string; attempts: number }>(
      `SELECT status,attempts FROM jobs WHERE idempotency_key LIKE 'scope3:%'`,
    );
    expect(before.rows).toEqual([{ status: "queued", attempts: 0 }]);
    expect(await queueFor("INTERACTIVE").tick()).toBe(true);
    const after = await getPool().query<{ status: string; attempts: number }>(
      `SELECT status,attempts FROM jobs WHERE idempotency_key LIKE 'scope3:%'`,
    );
    expect(after.rows).toEqual([{ status: "completed", attempts: 1 }]);
  });

  it("handles actual SIGTERM by finishing in-flight Work without claiming the next job", async () => {
    await enqueue("process_instruction", SEED_TENANT_ID);
    await enqueue("process_instruction", SEED_TENANT_ID);
    const child = spawn(process.execPath, ["--import", "tsx", resolve("tests/integration/fixtures/scope3-sigterm-child.ts")], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: DB_URL },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    try {
      await new Promise<void>((resolveStarted, rejectStarted) => {
        const timer = setTimeout(() => rejectStarted(new Error(`Signal child did not claim: ${output}`)), 10_000);
        const onOutput = () => {
          if (!output.includes("IN_FLIGHT\n")) return;
          clearTimeout(timer);
          child.stdout?.off("data", onOutput);
          resolveStarted();
        };
        child.stdout?.on("data", onOutput);
        child.once("error", (error) => { clearTimeout(timer); rejectStarted(error); });
        child.once("exit", (code) => {
          if (!output.includes("IN_FLIGHT\n")) { clearTimeout(timer); rejectStarted(new Error(`Signal child exited ${code}: ${output}`)); }
        });
      });
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExited) => {
        child.once("close", (code, signal) => resolveExited({ code, signal }));
      });
      expect(child.kill("SIGTERM")).toBe(true);
      const exit = await exited;
      expect(exit).toEqual({ code: 0, signal: null });
      expect(output).toContain("DRAINED\n");
      const states = await getPool().query<{ status: string; attempts: number }>(
        `SELECT status,attempts FROM jobs WHERE idempotency_key LIKE 'scope3:%' ORDER BY status`,
      );
      expect(states.rows).toEqual([{ status: "completed", attempts: 1 }, { status: "queued", attempts: 0 }]);
      expect(await queueFor("INTERACTIVE").tick()).toBe(true);
      const remaining = await getPool().query<{ queued: number }>(
        `SELECT count(*)::int queued FROM jobs WHERE idempotency_key LIKE 'scope3:%' AND status='queued'`,
      );
      expect(remaining.rows[0]?.queued).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
      }
    }
  }, 25_000);

  it("enforces the local slot cap while concurrent handlers execute", async () => {
    for (let i = 0; i < 6; i += 1) await enqueue("learning_digest", SEED_TENANT_ID);
    const stopping = new AbortController();
    let active = 0;
    let peak = 0;
    let completed = 0;
    const queue = queueFor("BACKGROUND", async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      active -= 1;
      completed += 1;
      if (completed === 6) stopping.abort();
    });
    await queue.runLoop(10, stopping.signal, 2);
    expect(completed).toBe(6);
    expect(peak).toBe(2);
    expect(active).toBe(0);
    const outcome = await getPool().query<{ count: number }>(
      `SELECT count(*)::int count FROM jobs WHERE idempotency_key LIKE 'scope3:%' AND status='completed'`,
    );
    expect(outcome.rows[0]?.count).toBe(6);
  }, 15_000);

  it("rolls back a claim when shutdown arrives during the cutover lock wait", async () => {
    await enqueue("process_instruction", SEED_TENANT_ID);
    const holder = new pg.Client({ connectionString: DB_URL });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("UPDATE compute_plane_cutover SET updated_at=updated_at WHERE singleton=true");
    const stopping = new AbortController();
    const pending = queueFor("INTERACTIVE").tick(stopping.signal);
    try {
      let waiting = false;
      for (let i = 0; i < 100; i += 1) {
        const activity = await getPool().query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_stat_activity
            WHERE pid<>pg_backend_pid() AND wait_event_type='Lock'
              AND query LIKE 'SELECT state FROM compute_plane_cutover%'`,
        );
        if (Number(activity.rows[0]?.count) > 0) { waiting = true; break; }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      }
      expect(waiting).toBe(true);
      stopping.abort();
      await holder.query("COMMIT");
      expect(await pending).toBe(false);
      const queued = await getPool().query<{ status: string; attempts: number }>(
        `SELECT status,attempts FROM jobs WHERE idempotency_key LIKE 'scope3:%'`,
      );
      expect(queued.rows).toEqual([{ status: "queued", attempts: 0 }]);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
      await pending.catch(() => undefined);
    }
  }, 15_000);

  it("returns a committed but undispatched claim when draining wins the dispatch race", async () => {
    await enqueue("process_instruction", SEED_TENANT_ID);
    const stopping = new AbortController();
    let handlerCalls = 0;
    const queue = queueFor("INTERACTIVE", async () => { handlerCalls += 1; });
    const pool = getPool();
    const patched = new Map<pg.PoolClient, pg.PoolClient["query"]>();
    const deliveryInserted = new Set<pg.PoolClient>();
    const onAcquire = (client: pg.PoolClient) => {
      if (patched.has(client)) return;
      const original = client.query;
      patched.set(client, original);
      const query = original.bind(client) as (...args: unknown[]) => unknown;
      client.query = ((...args: unknown[]) => {
        const sql = args[0];
        if (typeof sql === "string" && sql.includes("INSERT INTO job_delivery_attempts")) {
          deliveryInserted.add(client);
        }
        const result = query(...args);
        return sql === "COMMIT" && deliveryInserted.has(client)
          ? Promise.resolve(result).then((value) => { stopping.abort(); return value; })
          : result;
      }) as typeof client.query;
    };
    pool.on("acquire", onAcquire);
    try {
      expect(await queue.tick(stopping.signal)).toBe(false);
    } finally {
      pool.off("acquire", onAcquire);
      for (const [client, query] of patched) client.query = query;
    }
    expect(handlerCalls).toBe(0);
    const row = await getPool().query<{ status: string; attempts: number; outcome: string }>(
      `SELECT j.status,j.attempts,d.outcome FROM jobs j
         JOIN job_delivery_attempts d ON d.job_id=j.id
        WHERE j.idempotency_key LIKE 'scope3:%'`,
    );
    expect(row.rows).toEqual([{ status: "queued", attempts: 0, outcome: "drained_before_dispatch" }]);
    expect(await queueFor("INTERACTIVE").tick()).toBe(true);
  });

  it("bounds four physical task processes to four DB sessions and releases a crashed holder", async () => {
    const names = Array.from({ length: 4 }, () => `scope3-db-child-${randomUUID()}`);
    const children: ChildProcess[] = [];
    const countSessions = async () => {
      const result = await getPool().query<{ count: number }>(
        `SELECT count(*)::int count FROM pg_stat_activity WHERE application_name = ANY($1::text[])`,
        [names],
      );
      return result.rows[0]?.count ?? 0;
    };
    const waitReady = (child: ChildProcess) => new Promise<void>((resolveReady, rejectReady) => {
      let output = "";
      const timer = setTimeout(() => rejectReady(new Error(`DB child did not become ready: ${output}`)), 10_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("READY\n")) { clearTimeout(timer); resolveReady(); }
      });
      child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.once("error", (error) => { clearTimeout(timer); rejectReady(error); });
      child.once("exit", (code) => {
        if (!output.includes("READY\n")) { clearTimeout(timer); rejectReady(new Error(`DB child exited ${code}: ${output}`)); }
      });
    });
    try {
      for (const name of names) {
        const child = spawn(process.execPath, ["--import", "tsx", resolve("tests/integration/fixtures/scope3-db-capacity-child.ts")], {
          cwd: process.cwd(),
          env: { ...process.env, DATABASE_URL: DB_URL, FINNOR_SCOPE3_DB_CHILD_NAME: name },
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.push(child);
      }
      await Promise.all(children.map(waitReady));
      expect(await countSessions()).toBe(4);
      for (let sample = 0; sample < 5; sample += 1) {
        expect(await countSessions()).toBeLessThanOrEqual(4);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
      children[0]!.kill("SIGKILL");
      let reclaimed = false;
      for (let sample = 0; sample < 100; sample += 1) {
        if (await countSessions() === 3) { reclaimed = true; break; }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
      expect(reclaimed).toBe(true);
    } finally {
      await Promise.all(children.map((child) => new Promise<void>((resolveExit) => {
        if (child.exitCode !== null || child.signalCode !== null) { resolveExit(); return; }
        child.once("close", () => resolveExit());
        child.kill("SIGKILL");
      })));
    }
  }, 25_000);

  it("fails saturated DB pool waits within a bounded deadline without opening extra sessions", async () => {
    const name = `scope3-db-saturated-${randomUUID()}`;
    const pool = new pg.Pool({ connectionString: DB_URL, max: 1,
      application_name: name, connectionTimeoutMillis: 250 });
    const holder = await pool.connect();
    try {
      const started = Date.now();
      const queued = await Promise.allSettled(Array.from({ length: 20 }, () => pool.query("SELECT 1")));
      expect(queued.every((result) => result.status === "rejected"
        && /timeout exceeded when trying to connect/i.test(String(result.reason)))).toBe(true);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(pool.totalCount).toBe(1);
      const sessions = await getPool().query<{ count: number }>(
        `SELECT count(*)::int count FROM pg_stat_activity WHERE application_name=$1`, [name],
      );
      expect(sessions.rows[0]?.count).toBe(1);
    } finally {
      holder.release();
      await pool.end();
    }
  }, 5_000);

  it("keeps 100 simultaneously contending class workers inside their claim boundary", async () => {
    const fixtures = WORKLOAD_CLASSES.flatMap((workloadClass) =>
      Array.from({ length: 25 }, () => workloadClass));
    const types = {
      REALTIME: "release_probe",
      INTERACTIVE: "process_instruction",
      BACKGROUND: "learning_digest",
      HEAVY: "purge_retention",
    } as const;
    await Promise.all(fixtures.map((workloadClass) => enqueue(
      types[workloadClass], workloadClass === "REALTIME" ? undefined : SEED_TENANT_ID,
    )));
    const workers = fixtures.map((workloadClass) => queueFor(workloadClass));
    expect(new Set(workers.map((worker) => worker.instanceId)).size).toBe(100);
    const contended = await Promise.all(workers.map((worker) => worker.tick()));
    expect(contended.some(Boolean)).toBe(true);
    // Tenant fairness intentionally serializes a tenant's simultaneous claims.
    // Drain the remaining fixtures with eligible class workers; asserting only
    // the first few successful claims would miss late cross-class leakage.
    for (const workloadClass of WORKLOAD_CLASSES) {
      const drain = queueFor(workloadClass);
      for (let i = 0; i < 25; i += 1) {
        if (!await drain.tick()) break;
      }
    }
    const attempts = await getPool().query<{ id: string; workload_class: string; status: string; worker_id: string }>(
      `SELECT j.id,j.workload_class,j.status,d.worker_id
         FROM job_delivery_attempts d JOIN jobs j ON j.id=d.job_id
        WHERE j.idempotency_key LIKE 'scope3:%'`,
    );
    expect(attempts.rows).toHaveLength(100);
    expect(new Set(attempts.rows.map((row) => row.workload_class))).toEqual(new Set(WORKLOAD_CLASSES));
    expect(new Set(attempts.rows.map((row) => row.id)).size).toBe(attempts.rows.length);
    expect(attempts.rows.every((row) => row.status === "completed" && row.worker_id.includes(`:${row.workload_class}:`))).toBe(true);
  }, 60_000);

  it("uses a durable fair cursor so a tenant flood cannot bury another tenant", async () => {
    const producer = queueFor("BACKGROUND");
    for (let i = 0; i < 40; i += 1) {
      await producer.enqueue("learning_digest", { tenantId: SEED_TENANT_ID }, `scope3:${randomUUID()}`, "batch", 100);
    }
    await producer.enqueue("learning_digest", { tenantId: OTHER_TENANT_ID }, `scope3:${randomUUID()}`, "batch", 0);
    await getPool().query(
      `UPDATE jobs SET run_at=now()-interval '1 hour'
        WHERE type='learning_digest' AND idempotency_key LIKE 'scope3:%'`,
    );
    await getPool().query(
      `UPDATE compute_tenant_claim_state SET last_claimed_at=clock_timestamp()
        WHERE workload_class='BACKGROUND' AND tenant_key=$1`, [SEED_TENANT_ID],
    );
    await getPool().query(
      `UPDATE compute_tenant_claim_state SET last_claimed_at=NULL
        WHERE workload_class='BACKGROUND' AND tenant_key=$1`, [OTHER_TENANT_ID],
    );
    const worker = queueFor("BACKGROUND");
    expect(await worker.tick()).toBe(true);
    const first = await getPool().query<{ tenant_id: string }>(
      `SELECT j.tenant_id FROM job_delivery_attempts d JOIN jobs j ON j.id=d.job_id
        WHERE j.idempotency_key LIKE 'scope3:%' ORDER BY d.started_at,d.id LIMIT 1`,
    );
    expect(first.rows[0]?.tenant_id).toBe(OTHER_TENANT_ID);
    const peer = await getPool().query<{ status: string }>(
      `SELECT status FROM jobs WHERE type='learning_digest' AND tenant_id=$1 AND idempotency_key LIKE 'scope3:%'`,
      [OTHER_TENANT_ID],
    );
    expect(peer.rows).toEqual([{ status: "completed" }]);
  });

  it("preserves deterministic priority order inside one fresh tenant class", async () => {
    const producer = queueFor("BACKGROUND");
    const low = `scope3:${randomUUID()}`;
    const high = `scope3:${randomUUID()}`;
    await producer.enqueue("learning_digest", { tenantId: SEED_TENANT_ID }, low, "batch", 0);
    await producer.enqueue("learning_digest", { tenantId: SEED_TENANT_ID }, high, "batch", 100);
    await getPool().query(
      `UPDATE jobs SET run_at=now()-interval '1 second'
        WHERE idempotency_key=ANY($1::text[])`, [[low, high]],
    );
    expect(await queueFor("BACKGROUND").tick()).toBe(true);
    const first = await getPool().query<{ idempotency_key: string }>(
      `SELECT j.idempotency_key FROM job_delivery_attempts d
         JOIN jobs j ON j.id=d.job_id WHERE j.idempotency_key=ANY($1::text[])`, [[low, high]],
    );
    expect(first.rows).toEqual([{ idempotency_key: high }]);
  });

  it("keeps global jobs in an explicit fair bucket independent of tenant backlog", async () => {
    const tenantProducer = queueFor("BACKGROUND");
    for (let i = 0; i < 20; i += 1) {
      await tenantProducer.enqueue("learning_digest", { tenantId: SEED_TENANT_ID }, `scope3:${randomUUID()}`);
    }
    const globalProducer = queueFor("REALTIME");
    await globalProducer.enqueue("release_probe", {}, `scope3:${randomUUID()}`);
    const global = await getPool().query<{ tenant_id: string | null; tenant_key: string; workload_class: string }>(
      `SELECT tenant_id,tenant_key,workload_class FROM jobs
        WHERE type='release_probe' AND idempotency_key LIKE 'scope3:%'`,
    );
    expect(global.rows).toEqual([{ tenant_id: null, tenant_key: "__global__", workload_class: "REALTIME" }]);
    expect(await queueFor("REALTIME").tick()).toBe(true);
    const background = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM jobs WHERE type='learning_digest'
         AND status='queued' AND idempotency_key LIKE 'scope3:%'`,
    );
    expect(Number(background.rows[0]?.count)).toBe(20);
  });

  it("excludes future and incompatible jobs from canonical eligible backlog and age", async () => {
    const producer = queueFor("INTERACTIVE");
    await producer.enqueue("process_instruction", { tenantId: SEED_TENANT_ID }, `scope3:${randomUUID()}`);
    await producer.enqueue("process_instruction", { tenantId: SEED_TENANT_ID }, `scope3:${randomUUID()}`);
    await getPool().query(
      `UPDATE jobs SET run_at=now()+interval '1 day' WHERE id=(
         SELECT id FROM jobs WHERE idempotency_key LIKE 'scope3:%' ORDER BY id LIMIT 1)`,
    );
    const pressure = await readComputePressureSignals(SEED_TENANT_ID, "INTERACTIVE");
    expect(pressure.cutoverState).toBe("authoritative");
    expect(pressure.eligibleQueued).toBe(1);
    expect(pressure.tenantEligibleQueued).toBe(1);
    expect(pressure.oldestEligibleAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(pressure.oldestEligibleAgeSeconds).toBeLessThan(60);
    expect(pressure.telemetryStatus).toBe("missing");
    const background = await readComputePressureSignals(SEED_TENANT_ID, "BACKGROUND");
    expect(background.eligibleQueued).toBe(0);
  });

  it("defers physical capacity contention without burning the logical attempt", async () => {
    const producer = queueFor("INTERACTIVE");
    await producer.enqueue("process_instruction", { tenantId: SEED_TENANT_ID }, `scope3:${randomUUID()}`);
    const worker = queueFor("INTERACTIVE", async () => {
      throw new ComputeCapacityUnavailableError("model:global", 5_000);
    });
    expect(await worker.tick()).toBe(true);
    const outcome = await getPool().query<{
      status: string; attempts: number; capacity_defer_count: number; retry_in_future: boolean;
      outcome: string; failure_kind: string;
    }>(`SELECT j.status,j.attempts,j.capacity_defer_count,j.run_at>now() AS retry_in_future,
              d.outcome,d.failure_kind FROM jobs j JOIN job_delivery_attempts d ON d.job_id=j.id
        WHERE j.idempotency_key LIKE 'scope3:%'`);
    expect(outcome.rows).toEqual([{
      status: "queued", attempts: 0, capacity_defer_count: 1, retry_in_future: true,
      outcome: "capacity_deferred", failure_kind: "capacity_deferred",
    }]);
    expect(await worker.tick()).toBe(false);
  });

  it("globally fences configured provider permits and recovers a crashed holder after expiry", async () => {
    await getPool().query(
      `UPDATE compute_resource_policies SET capacity=1,per_tenant_capacity=1,interactive_reserve=0,lease_seconds=15
        WHERE resource_key='provider:microsoft-graph'`,
    );
    const first = await acquireComputeResourceLeases({
      resourceKeys: ["provider:microsoft-graph"], requiredResourceKeys: ["provider:microsoft-graph"],
      tenantId: SEED_TENANT_ID, workloadClass: "INTERACTIVE", ownerId: `scope3:${randomUUID()}`,
    });
    await expect(acquireComputeResourceLeases({
      resourceKeys: ["provider:microsoft-graph"], requiredResourceKeys: ["provider:microsoft-graph"],
      tenantId: OTHER_TENANT_ID, workloadClass: "INTERACTIVE", ownerId: `scope3:${randomUUID()}`,
    })).rejects.toBeInstanceOf(ComputeCapacityUnavailableError);
    await getPool().query(
      `UPDATE compute_resource_leases SET expires_at=clock_timestamp()+interval '1 second'
        WHERE lease_token=$1`, [first[0]!.token],
    );
    expect(await renewComputeResourceLeases(first)).toBe(true);
    const renewed = await getPool().query<{ seconds_left: number }>(
      `SELECT extract(epoch FROM expires_at-clock_timestamp())::int AS seconds_left
         FROM compute_resource_leases WHERE lease_token=$1`, [first[0]!.token],
    );
    expect(renewed.rows[0]!.seconds_left).toBeGreaterThanOrEqual(10);
    expect(await renewComputeResourceLeases([{ ...first[0]!, fence: first[0]!.fence + 1 }])).toBe(false);
    await getPool().query(
      `UPDATE compute_resource_leases
          SET acquired_at=clock_timestamp()-interval '2 seconds',
              expires_at=clock_timestamp()-interval '1 second'
        WHERE lease_token=$1`,
      [first[0]!.token],
    );
    expect(await renewComputeResourceLeases(first)).toBe(false);
    const successor = await acquireComputeResourceLeases({
      resourceKeys: ["provider:microsoft-graph"], requiredResourceKeys: ["provider:microsoft-graph"],
      tenantId: OTHER_TENANT_ID, workloadClass: "INTERACTIVE", ownerId: `scope3:${randomUUID()}`,
    });
    expect(successor).toHaveLength(1);
    expect(successor[0]!.fence).toBeGreaterThan(first[0]!.fence);
    await releaseComputeResourceLeases(successor, "scope3_test_finished");
  });

  it("isolates a saturated provider from another configured provider", async () => {
    await getPool().query(
      `UPDATE compute_resource_policies SET capacity=1,per_tenant_capacity=1,interactive_reserve=0
        WHERE resource_key='provider:microsoft-graph'`,
    );
    await getPool().query(
      `INSERT INTO compute_resource_policies(
         resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source
       ) VALUES('provider:scope3-independent',1,1,0,60,'disposable certification fixture')
       ON CONFLICT(resource_key) DO UPDATE SET enabled=true,capacity=1,per_tenant_capacity=1`,
    );
    const blocker = await acquireComputeResourceLeases({
      resourceKeys: ["provider:microsoft-graph"], requiredResourceKeys: ["provider:microsoft-graph"],
      tenantId: SEED_TENANT_ID, workloadClass: "INTERACTIVE", ownerId: `scope3:${randomUUID()}`,
    });
    const prior = process.env.P3_GOVERNORS;
    process.env.P3_GOVERNORS = "1";
    try {
      await expect(withGovernedProviderInvocation({
        provider: "microsoft-graph", tenantId: OTHER_TENANT_ID,
      }, async () => "should-not-run")).rejects.toBeInstanceOf(ComputeCapacityUnavailableError);
      expect(await withGovernedProviderInvocation({
        provider: "scope3-independent", tenantId: OTHER_TENANT_ID,
      }, async () => "unrelated-progress")).toBe("unrelated-progress");
    } finally {
      await releaseComputeResourceLeases(blocker, "scope3_test_finished");
      if (prior === undefined) delete process.env.P3_GOVERNORS;
      else process.env.P3_GOVERNORS = prior;
    }
  });

  it("aborts a provider invocation when owned permit renewal loses its fence", async () => {
    await getPool().query(
      `UPDATE compute_resource_policies SET capacity=1,per_tenant_capacity=1,
        interactive_reserve=0,lease_seconds=15 WHERE resource_key='provider:microsoft-graph'`,
    );
    const prior = process.env.P3_GOVERNORS;
    process.env.P3_GOVERNORS = "1";
    const ownerId = `scope3:lease-loss:${randomUUID()}`;
    let started!: () => void;
    const invoked = new Promise<void>((resolve) => { started = resolve; });
    try {
      const operation = withGovernedProviderInvocation({
        provider: "microsoft-graph", tenantId: SEED_TENANT_ID, ownerId,
      }, async (capacitySignal) => {
        started();
        await new Promise<never>((_, reject) => {
          capacitySignal.addEventListener("abort", () => reject(capacitySignal.reason), { once: true });
        });
      });
      await invoked;
      await getPool().query(
        `UPDATE compute_resource_leases
            SET acquired_at=clock_timestamp()-interval '2 seconds',
                expires_at=clock_timestamp()-interval '1 second'
          WHERE owner_id=$1`, [ownerId],
      );
      await expect(operation).rejects.toThrow(/lease ownership was lost/);
      const lease = await getPool().query<{ released_at: Date | null }>(
        `SELECT released_at FROM compute_resource_leases WHERE owner_id=$1`, [ownerId],
      );
      expect(lease.rows).toHaveLength(1);
      expect(lease.rows[0]!.released_at).not.toBeNull();
    } finally {
      if (prior === undefined) delete process.env.P3_GOVERNORS;
      else process.env.P3_GOVERNORS = prior;
    }
  }, 15_000);

  it("reserves model capacity for foreground and enforces per-tenant limits", async () => {
    await getPool().query(
      `UPDATE compute_resource_policies SET capacity=2,per_tenant_capacity=1,interactive_reserve=1
        WHERE resource_key='model:global'`,
    );
    const background = await acquireComputeResourceLeases({
      resourceKeys: ["model:global"], requiredResourceKeys: ["model:global"],
      tenantId: SEED_TENANT_ID, workloadClass: "BACKGROUND", ownerId: `scope3:${randomUUID()}`,
    });
    await expect(acquireComputeResourceLeases({
      resourceKeys: ["model:global"], requiredResourceKeys: ["model:global"],
      tenantId: OTHER_TENANT_ID, workloadClass: "BACKGROUND", ownerId: `scope3:${randomUUID()}`,
    })).rejects.toBeInstanceOf(ComputeCapacityUnavailableError);
    const foreground = await acquireComputeResourceLeases({
      resourceKeys: ["model:global"], requiredResourceKeys: ["model:global"],
      tenantId: OTHER_TENANT_ID, workloadClass: "INTERACTIVE", ownerId: `scope3:${randomUUID()}`,
    });
    await expect(acquireComputeResourceLeases({
      resourceKeys: ["model:global"], requiredResourceKeys: ["model:global"],
      tenantId: OTHER_TENANT_ID, workloadClass: "INTERACTIVE", ownerId: `scope3:${randomUUID()}`,
    })).rejects.toBeInstanceOf(ComputeCapacityUnavailableError);
    await releaseComputeResourceLeases([...background, ...foreground], "scope3_test_finished");
  });

  it("writes truthful per-class heartbeat roles and removes them on drain", async () => {
    const services = {
      REALTIME: "compute-realtime", INTERACTIVE: "compute-interactive",
      BACKGROUND: "compute-background", HEAVY: "compute-heavy",
    } as const;
    for (const workloadClass of WORKLOAD_CLASSES) {
      const stopping = new AbortController();
      const heartbeat = startHeartbeat(60_000, stopping.signal, {
        workloadClass, ownsScheduler: () => workloadClass === "BACKGROUND",
      });
      try {
        let rows: Array<{ service: string }> = [];
        let meta: { serviceClass?: string; allowedWorkloadClasses?: string[]; draining?: boolean } = {};
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const found = await getPool().query<{ meta: typeof meta }>(
            `SELECT meta FROM worker_heartbeat WHERE id=$1`, [WORKER_HEARTBEAT_ID],
          );
          meta = found.rows[0]?.meta ?? {};
          const roles = await getPool().query<{ service: string }>(
            `SELECT service FROM service_release_heartbeats WHERE instance_id=$1 ORDER BY service`,
            [WORKER_HEARTBEAT_ID],
          );
          rows = roles.rows;
          if (meta.serviceClass === workloadClass && rows.some((row) => row.service === services[workloadClass])) break;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
        }
        expect(meta).toMatchObject({ serviceClass: workloadClass, allowedWorkloadClasses: [workloadClass], draining: false });
        expect(rows.map((row) => row.service).sort()).toEqual([
          services[workloadClass],
          ...(workloadClass === "INTERACTIVE" ? ["orchestrator"] : []),
          ...(workloadClass === "BACKGROUND" ? ["scheduler-owner"] : []),
        ].sort());
      } finally {
        stopping.abort();
        await heartbeat.markDraining();
      }
      const remaining = await getPool().query<{ count: number }>(
        `SELECT count(*)::int count FROM service_release_heartbeats WHERE instance_id=$1`,
        [WORKER_HEARTBEAT_ID],
      );
      expect(remaining.rows[0]?.count).toBe(0);
    }
  }, 15_000);

  it("elects one fenced scheduler owner and transfers only after expiry", async () => {
    const name = `scope3:scheduler:${randomUUID()}`;
    const first = await acquireComputeControlLease(name, `scope3:${randomUUID()}`, 15);
    expect(first).not.toBeNull();
    expect(await acquireComputeControlLease(name, `scope3:${randomUUID()}`, 15)).toBeNull();
    expect(await renewComputeControlLease(first!, 15)).toBe(true);
    await getPool().query(
      `UPDATE compute_control_leases
          SET acquired_at=clock_timestamp()-interval '2 seconds',
              expires_at=clock_timestamp()-interval '1 second'
        WHERE lease_name=$1`,
      [name],
    );
    const successor = await acquireComputeControlLease(name, `scope3:${randomUUID()}`, 15);
    expect(successor?.fence).toBeGreaterThan(first!.fence);
    expect(await renewComputeControlLease(first!, 15)).toBe(false);
    expect(await releaseComputeControlLease(successor!)).toBe(true);
  });
});
