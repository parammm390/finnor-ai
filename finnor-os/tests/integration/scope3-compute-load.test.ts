import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import http from "node:http";
import pg from "pg";
import {
  COMPUTE_CUTOVER_EPOCH,
  PRODUCTION_JOB_CONTRACTS,
  WORKLOAD_CLASSES,
  closePool,
  getPool,
} from "@finnor/db";
import { CLASS_CLAIM_SQL, JobQueue } from "../../apps/worker/src/queue";
import { activeSseConnectionCount, createSseGateway } from "../../apps/worker/src/sse/gateway";
import { readComputePressureSignals } from "../../apps/api/lib/backpressure";
import { migrate } from "../../packages/db/migrate";
import { assertDisposableDatabaseTarget } from "../../packages/db/production-target-guard";
import { seed, SEED_TENANT_ID } from "../../packages/db/seed";

const DB_URL = process.env.DATABASE_URL ?? "";
const PEER_TENANT_ID = "00000000-0000-4000-8000-0000000000c4";
const JOB_COUNT = 100_000;

if (process.env.FINNOR_SCOPE3_CERTIFICATION === "1") {
  assertDisposableDatabaseTarget(DB_URL, "Scope-3 load certification");
  if (process.env.FINNOR_SCOPE3_DISPOSABLE_DB !== "1"
      || !/^\/finnor_scope3_cert_[a-f0-9_]+$/.test(new URL(DB_URL).pathname)) {
    throw new Error("Scope-3 load certification requires its dedicated disposable database harness");
  }
}

async function dbUp(): Promise<boolean> {
  if (!DB_URL) return false;
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const available = await dbUp();

describe.skipIf(!available || process.env.FINNOR_SCOPE3_CERTIFICATION !== "1")("Scope-3 disposable large-backlog load", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await seed(DB_URL);
    await getPool().query(
      `INSERT INTO tenants(id,name) VALUES($1,'Scope 3 noisy-neighbor peer') ON CONFLICT(id) DO NOTHING`,
      [PEER_TENANT_ID],
    );
    await getPool().query(
      `UPDATE compute_plane_cutover SET state='authoritative',accepted_job_epoch=$1,
         minimum_claim_epoch=$1,enforce_known_job_types=true,legacy_tenant_writes_allowed=false,
         activated_release_sha=$2,activated_at=clock_timestamp(),updated_at=clock_timestamp()
       WHERE singleton=true`,
      [COMPUTE_CUTOVER_EPOCH, "b".repeat(40)],
    );
  });

  afterAll(async () => { await closePool(); });

  it("measures 100k mixed queued jobs while all classes progress and an aged peer beats a flood", async () => {
    const insertedAt = Date.now();
    await getPool().query(
      `INSERT INTO jobs(tenant_id,type,payload,idempotency_key,lane,priority,run_at)
       SELECT CASE WHEN n % 4=0 THEN NULL ELSE $1::uuid END,
              CASE n % 4 WHEN 0 THEN 'release_probe' WHEN 1 THEN 'process_instruction'
                   WHEN 2 THEN 'purge_retention' ELSE 'learning_digest' END,
              CASE WHEN n % 4=0 THEN '{}'::jsonb ELSE jsonb_build_object('tenantId',$1::uuid) END,
              'scope3load:'||n::text,'batch',
              CASE WHEN n % 4=3 THEN 100 ELSE 0 END,
              CASE WHEN n % 4=3 THEN now()-interval '20 minutes' ELSE now() END
         FROM generate_series(1,$2::int) AS n`,
      [SEED_TENANT_ID, JOB_COUNT],
    );
    await getPool().query(
      `INSERT INTO jobs(tenant_id,type,payload,idempotency_key,lane,priority,run_at)
       VALUES($1,'learning_digest',jsonb_build_object('tenantId',$1::uuid),$2,'batch',0,
              now()-interval '20 minutes')`,
      [PEER_TENANT_ID, `scope3load:peer:${randomUUID()}`],
    );
    await getPool().query(
      `UPDATE compute_tenant_claim_state SET last_claimed_at=clock_timestamp()
        WHERE workload_class='BACKGROUND' AND tenant_key=$1`, [SEED_TENANT_ID],
    );
    await getPool().query(
      `UPDATE compute_tenant_claim_state SET last_claimed_at=NULL
        WHERE workload_class='BACKGROUND' AND tenant_key=$1`, [PEER_TENANT_ID],
    );

    const counts = await getPool().query<{ workload_class: string; count: string }>(
      `SELECT workload_class,count(*)::text AS count FROM jobs
        WHERE idempotency_key LIKE 'scope3load:%' GROUP BY workload_class`,
    );
    expect(Object.fromEntries(counts.rows.map((row) => [row.workload_class, Number(row.count)]))).toEqual({
      REALTIME: 25_000, INTERACTIVE: 25_000, BACKGROUND: 25_001, HEAVY: 25_000,
    });

    const metricStarted = Date.now();
    const pressure = await Promise.all(WORKLOAD_CLASSES.map((workloadClass) =>
      readComputePressureSignals(SEED_TENANT_ID, workloadClass)));
    for (const signal of pressure) {
      expect(signal.cutoverState).toBe("authoritative");
      expect(signal.eligibleQueued).toBe(signal.workloadClass === "BACKGROUND" ? 25_001 : 25_000);
      expect(signal.freshRunningTasks).toBe(0);
      expect(signal.backlogPerTask).toBe(signal.eligibleQueued);
    }
    const metricMs = Date.now() - metricStarted;

    const types = {
      REALTIME: "release_probe",
      INTERACTIVE: "process_instruction",
      BACKGROUND: "learning_digest",
      HEAVY: "purge_retention",
    } as const;
    const claimStarted = Date.now();
    const workers = WORKLOAD_CLASSES.map((workloadClass) => {
      const queue = new JobQueue(`scope3load:${workloadClass}:${randomUUID()}`, 3, workloadClass);
      const type = types[workloadClass];
      queue.register(type, async () => undefined, PRODUCTION_JOB_CONTRACTS[type]);
      return queue;
    });
    interface ExplainNode { "Node Type": string; "Relation Name"?: string; "Index Name"?: string; Plans?: ExplainNode[] }
    const claimPlans: Record<string, { executionMs: number; jobScans: string[] }> = {};
    for (const worker of workers) {
      const type = types[worker.workloadClass!];
      const plan = await getPool().query<{ "QUERY PLAN": [{ Plan: ExplainNode; "Execution Time": number }] }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${CLASS_CLAIM_SQL}`,
        [JSON.stringify([{ type, protocolVersion: 1 }]), worker.workloadClass,
          worker.priorityAgingSeconds, worker.tenantInflightLimit],
      );
      const root = plan.rows[0]?.["QUERY PLAN"][0];
      expect(root).toBeDefined();
      const nodes: ExplainNode[] = [];
      const visit = (node: ExplainNode): void => { nodes.push(node); node.Plans?.forEach(visit); };
      visit(root!.Plan);
      const jobScans = nodes.filter((node) => node["Relation Name"] === "jobs")
        .map((node) => `${node["Node Type"]}:${node["Index Name"] ?? "none"}`);
      expect(jobScans.length).toBeGreaterThan(0);
      expect(jobScans.every((scan) => !scan.startsWith("Seq Scan:"))).toBe(true);
      claimPlans[worker.workloadClass!] = { executionMs: root!["Execution Time"], jobScans };
    }
    expect(await Promise.all(workers.map((worker) => worker.tick()))).toEqual([true, true, true, true]);
    const claimMs = Date.now() - claimStarted;
    const attempts = await getPool().query<{ workload_class: string; tenant_id: string | null; worker_id: string; status: string }>(
      `SELECT j.workload_class,j.tenant_id,d.worker_id,j.status
         FROM job_delivery_attempts d JOIN jobs j ON j.id=d.job_id
        WHERE j.idempotency_key LIKE 'scope3load:%'`,
    );
    expect(attempts.rows).toHaveLength(4);
    expect(attempts.rows.every((row) => row.status === "completed"
      && row.worker_id.includes(`:${row.workload_class}:`))).toBe(true);
    expect(attempts.rows.find((row) => row.workload_class === "BACKGROUND")?.tenant_id).toBe(PEER_TENANT_ID);

    // Keep actual SSE connections open while 25k BACKGROUND and 25k HEAVY
    // jobs remain queued. This measures the local gateway, not the AWS ALB.
    const priorBypass = process.env.AUTH_DEV_BYPASS;
    process.env.AUTH_DEV_BYPASS = "1";
    const server = createSseGateway();
    const requests: http.ClientRequest[] = [];
    let sseHealthP95Ms = 0;
    try {
      await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
      const port = (server.address() as { port: number }).port;
      const openConnection = () => new Promise<void>((resolveOpen, rejectOpen) => {
        const request = http.get({ host: "127.0.0.1", port, path: "/events",
          headers: { "x-tenant-id": SEED_TENANT_ID } }, (response) => {
          if (response.statusCode !== 200) {
            rejectOpen(new Error(`SSE connection returned ${response.statusCode}`));
            return;
          }
          response.on("data", () => undefined);
          resolveOpen();
        });
        request.on("error", rejectOpen);
        requests.push(request);
      });
      await Promise.all(Array.from({ length: 30 }, openConnection));
      expect(activeSseConnectionCount()).toBe(30);
      const samples = await Promise.all(Array.from({ length: 20 }, async () => {
        const started = performance.now();
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5_000) });
        expect(response.status).toBe(200);
        expect((await response.json() as { realtime?: boolean }).realtime).toBe(true);
        return performance.now() - started;
      }));
      sseHealthP95Ms = [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]!;
      expect(sseHealthP95Ms).toBeLessThan(5_000);
    } finally {
      for (const request of requests) request.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      if (priorBypass === undefined) delete process.env.AUTH_DEV_BYPASS;
      else process.env.AUTH_DEV_BYPASS = priorBypass;
    }

    // These are local disposable-Postgres measurements, not product SLOs or
    // evidence of ECS/CloudWatch propagation in the user's AWS project.
    const measured = { queuedJobs: JOB_COUNT + 1,
      insertionMs: metricStarted - insertedAt, metricMs, fourClassClaimMs: claimMs,
      claimPlans, sseConnections: 30, sseHealthP95Ms,
      backend: "embedded-postgres", liveAwsCertified: false };
    if (!process.env.FINNOR_SCOPE3_LOAD_EVIDENCE_FILE) {
      throw new Error("The dedicated load runner did not provide an evidence path");
    }
    writeFileSync(process.env.FINNOR_SCOPE3_LOAD_EVIDENCE_FILE, JSON.stringify(measured));
  }, 600_000);
});
