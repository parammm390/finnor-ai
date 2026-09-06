// Queue/worker acceptance (§32.7): a job is picked up, retried on simulated failure per
// its retry policy, and dead-letters after max attempts instead of looping forever.
// Also proves idempotent enqueue.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { getPool, closePool } from "@finnor/db";
import { JobQueue, workerConcurrency } from "../../apps/worker/src/queue";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

async function dbUp(): Promise<boolean> {
  const c = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}
const available = await dbUp();

const TEST_JOB_TYPES = [
  "test_ok",
  "test_idem",
  "test_fail",
  "crashed_worker",
  "crashed_poison_job",
  "drain_test",
  "drain_on_shutdown",
  "lease_renewal_test",
  "unhandled_test",
  "registered_only_test",
];

async function clearQueueTestJobs(): Promise<void> {
  await getPool().query("DELETE FROM jobs WHERE type = ANY($1::text[])", [TEST_JOB_TYPES]);
}

describe.skipIf(!available)("postgres job queue (§32.7)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await clearQueueTestJobs();
  });

  afterAll(async () => {
    await closePool();
  });

  it("runs a queued job to completion", async () => {
    const queue = new JobQueue();
    let ran = 0;
    queue.register("test_ok", async () => {
      ran++;
    });
    await queue.enqueue("test_ok", { hello: "world" });
    expect(await queue.tick()).toBe(true);
    expect(ran).toBe(1);
    const { rows } = await getPool().query("SELECT status FROM jobs WHERE type = 'test_ok'");
    expect(rows[0].status).toBe("completed");
  });

  it("idempotency key makes double-enqueue a no-op", async () => {
    const queue = new JobQueue();
    queue.register("test_idem", async () => undefined);
    await queue.enqueue("test_idem", {}, "same-key");
    await queue.enqueue("test_idem", {}, "same-key");
    const { rows } = await getPool().query("SELECT count(*)::int AS n FROM jobs WHERE type = 'test_idem'");
    expect(rows[0].n).toBe(1);
  });

  it("claims only job types registered by this worker instance", async () => {
    const queue = new JobQueue();
    let ran = 0;
    queue.register("registered_only_test", async () => { ran++; });
    await queue.enqueue("unhandled_test", {}, `unhandled-${Date.now()}`, "interactive", 100);
    await queue.enqueue("registered_only_test", {}, `registered-${Date.now()}`);

    expect(await queue.tick()).toBe(true);
    expect(ran).toBe(1);
    const { rows } = await getPool().query("SELECT status FROM jobs WHERE type = 'unhandled_test'");
    expect(rows).toEqual([{ status: "queued" }]);
  });

  it("failing job retries with backoff and dead-letters after max attempts", async () => {
    await clearQueueTestJobs();
    const queue = new JobQueue();
    let attempts = 0;
    queue.register("test_fail", async () => {
      attempts++;
      throw new Error("simulated failure");
    });
    await getPool().query(
      `INSERT INTO jobs (type, payload, max_attempts) VALUES ('test_fail', '{}', 2)`,
    );
    await queue.tick(); // attempt 1 → requeued with backoff
    let { rows } = await getPool().query("SELECT status FROM jobs WHERE type = 'test_fail'");
    expect(rows[0].status).toBe("queued");
    // Pull the retry forward instead of waiting out the backoff.
    await getPool().query("UPDATE jobs SET run_at = now() WHERE type = 'test_fail'");
    await queue.tick(); // attempt 2 → dead letter
    ({ rows } = await getPool().query("SELECT status, last_error FROM jobs WHERE type = 'test_fail'"));
    expect(rows[0].status).toBe("dead_letter");
    expect(rows[0].last_error).toMatch(/simulated failure/);
    expect(attempts).toBe(2);
  });

  it("reclaims an expired worker lease instead of leaving a crashed job running forever", async () => {
    await clearQueueTestJobs();
    const queue = new JobQueue();
    await getPool().query(
      `INSERT INTO jobs (type, payload, status, attempts, max_attempts, started_at)
       VALUES ('crashed_worker', '{}', 'running', 1, 3, now() - interval '10 minutes')`,
    );
    expect(await queue.recoverExpiredRunningJobs(60)).toBe(1);
    const { rows } = await getPool().query("SELECT status, started_at, last_error FROM jobs WHERE type = 'crashed_worker'");
    expect(rows[0].status).toBe("queued");
    expect(rows[0].started_at).toBeNull();
    expect(rows[0].last_error).toMatch(/lease expired/i);
  });

  it("dead-letters an expired lease that already exhausted its attempts", async () => {
    await clearQueueTestJobs();
    const queue = new JobQueue();
    await getPool().query(
      `INSERT INTO jobs (type, payload, status, attempts, max_attempts, started_at)
       VALUES ('crashed_poison_job', '{}', 'running', 3, 3, now() - interval '10 minutes')`,
    );
    expect(await queue.recoverExpiredRunningJobs(60)).toBe(1);
    const { rows } = await getPool().query("SELECT status FROM jobs WHERE type = 'crashed_poison_job'");
    expect(rows[0].status).toBe("dead_letter");
  });

  it("does not leak a pooled connection on an empty queue (regression: tick() used to return before releasing its client on the empty-queue path — fine locally where the pool caps at 10, but in production's ssl pool, capped at 2, two consecutive empty ticks permanently exhausted it and every later tick hung forever)", async () => {
    await clearQueueTestJobs();
    const queue = new JobQueue();
    // Local dev's pool caps at 10 connections (non-ssl, packages/db/index.ts). Call
    // tick() on a genuinely empty queue more times than that — before the fix, each
    // empty tick leaked one connection and the 11th call would hang forever waiting
    // for a free one that was never coming back.
    for (let i = 0; i < 15; i++) {
      expect(await queue.tick()).toBe(false);
    }
  });

  it("two worker instances drain every job once and interactive work wins over batch", async () => {
    await clearQueueTestJobs();
    const first = new JobQueue(); const second = new JobQueue();
    const completed: string[] = [];
    for (const queue of [first, second]) queue.register("drain_test", async (payload) => { completed.push(String(payload.id)); });
    await first.enqueue("drain_test", { id: "batch-a" }, undefined, "batch");
    await first.enqueue("drain_test", { id: "interactive" }, undefined, "interactive", 100);
    await first.enqueue("drain_test", { id: "batch-b" }, undefined, "batch");
    await Promise.all([first.tick(), second.tick()]);
    await first.tick();
    expect(completed).toHaveLength(3);
    expect(new Set(completed).size).toBe(3);
    expect(completed[0]).toBe("interactive");
    const { rows } = await getPool().query("SELECT count(*)::int AS n FROM jobs WHERE type = 'drain_test' AND status = 'completed'");
    expect(rows[0].n).toBe(3);
  });

  it("bounds each process's worker slots and drains an in-flight claim before SIGTERM shutdown", async () => {
    expect(workerConcurrency("3")).toBe(3);
    expect(workerConcurrency("0")).toBe(1);
    expect(workerConcurrency("99")).toBe(1);
    await clearQueueTestJobs();
    const queue = new JobQueue();
    const controller = new AbortController();
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      queue.register("drain_on_shutdown", async () => {
        resolve();
        await new Promise<void>((done) => { release = done; });
      });
    });
    await queue.enqueue("drain_on_shutdown", {});
    const loop = queue.runLoop(5, controller.signal, 1);
    await started;
    controller.abort(); // no new claim after SIGTERM; current claim must finish.
    release();
    await loop;
    const { rows } = await getPool().query("SELECT status FROM jobs WHERE type = 'drain_on_shutdown'");
    expect(rows[0].status).toBe("completed");
  });

  it("renews a long-running claim so a second worker cannot recover or execute it", async () => {
    await clearQueueTestJobs();
    const owner = new JobQueue("lease-owner", 3);
    const contender = new JobQueue("lease-contender", 3);
    let started!: () => void;
    let release!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const mayFinish = new Promise<void>((resolve) => { release = resolve; });
    let executions = 0;
    owner.register("lease_renewal_test", async () => {
      executions++;
      started();
      await mayFinish;
    });
    contender.register("lease_renewal_test", async () => { executions++; });
    await owner.enqueue("lease_renewal_test", {});

    const running = owner.tick();
    await didStart;
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(await contender.recoverExpiredRunningJobs(3)).toBe(0);
    expect(await contender.tick()).toBe(false);
    const leased = await getPool().query(
      "SELECT lease_owner, lease_heartbeat_at, lease_expires_at > now() AS fresh FROM jobs WHERE type='lease_renewal_test'",
    );
    expect(leased.rows[0]).toMatchObject({ lease_owner: "lease-owner", fresh: true });
    expect(leased.rows[0].lease_heartbeat_at).not.toBeNull();

    release();
    await running;
    expect(executions).toBe(1);
    const completed = await getPool().query("SELECT status,lease_owner FROM jobs WHERE type='lease_renewal_test'");
    expect(completed.rows[0]).toEqual({ status: "completed", lease_owner: null });
  });
});
