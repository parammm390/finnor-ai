import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool } from "@finnor/db";
import {
  buildConstraintSet,
  buildGoalSpec,
  buildPlanningWorldSnapshot,
  compileAndSelectPlans,
  DEFAULT_PLAN_BUDGETS,
  sha256,
  type CandidateCompilationFacts,
  type CandidatePlan,
  type CandidatePlanNode,
  type NodeCompilationFacts,
  type PlanningWorldSnapshot,
} from "@finnor/planning";
import { executeAttentionQueueQuery, executeOperationalQuery } from "@finnor/read-models";
import { migrate } from "../../packages/db/migrate";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@127.0.0.1:5432/finnor";
const TENANT_ID = randomUUID();
const EMPLOYEE_ID = randomUUID();
const WORK_ID = randomUUID();
const INPUT_ID = randomUUID();
const ATTEMPT_ID = randomUUID();
const REALISTIC_WORK_VOLUME = 1_000;

interface Measurement {
  iterations: number;
  totalMs: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
}

function summary(samples: number[]): Measurement {
  const ordered = [...samples].sort((left, right) => left - right);
  const totalMs = samples.reduce((total, sample) => total + sample, 0);
  return {
    iterations: samples.length,
    totalMs,
    meanMs: totalMs / samples.length,
    p95Ms: ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)]!,
    maxMs: ordered[ordered.length - 1]!,
  };
}

function measureSync(fn: () => void, iterations: number): Measurement {
  for (let index = 0; index < 20; index += 1) fn();
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  return summary(samples);
}

async function measureAsync(fn: () => Promise<void>, iterations: number): Promise<Measurement> {
  await fn();
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  return summary(samples);
}

const goal = buildGoalSpec({
  objective: "Read and verify exact Work truth.",
  workId: WORK_ID,
  workInputId: INPUT_ID,
  successCondition: {
    version: 1,
    statement: "The exact Work is present in canonical Work truth.",
    mode: "all",
    source: "explicit",
    criteria: [{ kind: "canonical_query", request: { intent: "work_list", recordId: WORK_ID }, assertion: { path: ["works"], operator: "exists" } }],
  },
});
const criterionId = goal.criteria[0]!.id;
const constraints = buildConstraintSet({
  tenantId: TENANT_ID,
  verticalKey: "none",
  allowedCapabilities: ["query:work_list", "check:objective_success"],
  humanOnlyCapabilities: [],
  prohibitedCapabilities: [],
  authorityRevision: 1,
  budgets: DEFAULT_PLAN_BUDGETS,
  constraints: [],
  deadlineAt: null,
  softPreferences: [],
});

function snapshot(canonicalStateHash = sha256({ workId: WORK_ID, state: "received" })): PlanningWorldSnapshot {
  return buildPlanningWorldSnapshot({
    workId: WORK_ID,
    workInputId: INPUT_ID,
    plannerAttemptId: ATTEMPT_ID,
    tenantId: TENANT_ID,
    verticalKey: "none",
    capturedAt: "2030-01-01T00:00:00.000Z",
    decisionContextHash: sha256({ workId: WORK_ID, inputId: INPUT_ID }),
    canonicalStateHash,
    work: { id: WORK_ID, status: "received", inputId: INPUT_ID },
    authority: { employeeId: EMPLOYEE_ID, revision: 1, roles: ["owner"] },
    capabilities: [
      {
        capability: "query:work_list",
        kind: "query",
        modelProposable: true,
        available: true,
        health: "available",
        risk: "low",
        irreversible: false,
        requiredReferences: [],
        effectClass: null,
        observationStrategy: "operational_query",
        reversibility: "read_only",
        supportedRecoveryModes: ["retry", "replan"],
        externalSideEffect: false,
        authorityRequirement: "query",
      },
      {
        capability: "check:objective_success",
        kind: "check",
        modelProposable: true,
        available: true,
        health: "available",
        risk: "low",
        irreversible: false,
        requiredReferences: [],
        effectClass: null,
        observationStrategy: "objective_success",
        reversibility: "read_only",
        supportedRecoveryModes: ["replan", "escalate"],
        externalSideEffect: false,
        authorityRequirement: "query",
      },
    ],
    currentEffects: [],
    sourceHealth: { status: "complete", missing: [] },
  });
}

function candidate(index: number): CandidatePlan {
  return {
    version: 1,
    candidateKey: `candidate-${index}`,
    nodes: [
      {
        key: `query-${index}`,
        kind: "query",
        request: { intent: "work_list", recordId: WORK_ID, projection: index },
        supports: [criterionId],
      },
      { key: `check-${index}`, kind: "check", criterionId, dependsOn: [`query-${index}`] },
    ],
  };
}

function factsFor(plan: CandidatePlan): CandidateCompilationFacts {
  const facts = (node: CandidatePlanNode): NodeCompilationFacts => ({
    registered: true,
    schemaValid: true,
    schemaErrors: [],
    grounded: true,
    crossTenant: false,
    stale: false,
    authority: "allowed",
    health: "available",
    risk: "low",
    irreversible: false,
    wrongVerticalRoot: false,
    policyAllowed: true,
    preconditionsSatisfied: true,
    deadlineFeasible: true,
    uncertainPrerequisiteNodeKeys: [],
    supportedRecoveryModes: node.kind === "query" ? ["retry", "replan"] : ["replan", "escalate"],
  });
  return { candidateKey: plan.candidateKey, nodes: Object.fromEntries(plan.nodes.map((node) => [node.key, facts(node)])) };
}

function compile(candidateCount: 1 | 2 | 4, world = snapshot()) {
  const candidates = Array.from({ length: candidateCount }, (_, index) => candidate(index + 1));
  return compileAndSelectPlans({ candidates, facts: candidates.map(factsFor), goal, constraints, snapshot: world });
}

async function dbUp(): Promise<boolean> {
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

describe.skipIf(!available)("Phase 6 measured performance guardrails", () => {
  let admin: pg.Client;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    admin = new pg.Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("SET app.test_vertical_mode = 'explicit'");
    await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES ($1,$2,'P6 performance')", [TENANT_ID, `p6-performance-${TENANT_ID}`]);
    await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,display_name) VALUES ($1,$2,$3,'owner','P6 Benchmark Employee')", [EMPLOYEE_ID, TENANT_ID, `p6-performance-${EMPLOYEE_ID}@example.test`]);
    await admin.query(
      "INSERT INTO finnor_os.tenant_vertical_assignments(tenant_id,vertical_key,version,source_system,created_by) VALUES ($1,'none',1,'certification:p6-performance',$2)",
      [TENANT_ID, EMPLOYEE_ID],
    );
    await admin.query(
      `INSERT INTO finnor_os.works(
         id,tenant_id,status,initial_channel,initial_instruction,current_owner_id,assigned_to,idempotency_key,created_at,updated_at
       )
       SELECT gen_random_uuid(),$1::uuid,'received','console','P6 realistic attention volume',$2::uuid,$2::uuid,
              'p6-performance-' || $1::text || '-' || item::text,
              clock_timestamp()-(item::text || ' seconds')::interval,
              clock_timestamp()-(item::text || ' seconds')::interval
         FROM generate_series(1,$3::integer) item`,
      [TENANT_ID, EMPLOYEE_ID, REALISTIC_WORK_VOLUME],
    );
  }, 30_000);

  afterAll(async () => {
    await closePool();
    await admin?.end();
  });

  it("measures bounded candidate planning, PlanCompiler, snapshot construction, and replanning", () => {
    expect(compile(1).selected).not.toBeNull();
    expect(compile(2).selected).not.toBeNull();
    expect(compile(4).selected).not.toBeNull();

    const measurements = {
      worldSnapshot: measureSync(() => { void snapshot(); }, 500),
      oneCandidate: measureSync(() => { void compile(1); }, 300),
      twoCandidates: measureSync(() => { void compile(2); }, 200),
      maximumFourCandidates: measureSync(() => { void compile(4); }, 120),
      replanning: measureSync(() => {
        const changed = snapshot(sha256({ workId: WORK_ID, state: "changed-for-replan" }));
        const result = compile(2, changed);
        if (!result.selected) throw new Error("Replanning benchmark produced no valid selection");
      }, 200),
    };

    expect(measurements.worldSnapshot.p95Ms).toBeLessThan(10);
    expect(measurements.oneCandidate.p95Ms).toBeLessThan(15);
    expect(measurements.twoCandidates.p95Ms).toBeLessThan(25);
    expect(measurements.maximumFourCandidates.p95Ms).toBeLessThan(50);
    expect(measurements.replanning.p95Ms).toBeLessThan(30);
    console.log(`P6_PLANNING_PERFORMANCE ${JSON.stringify(measurements)}`);
  }, 30_000);

  it("measures causal attention at realistic Work volume and preserves the fast read lane", async () => {
    const asOf = new Date();
    let attentionCount = 0;
    let fastReadCount = 0;
    const attention = await measureAsync(async () => {
      const result = await executeAttentionQueueQuery(
        TENANT_ID,
        { intent: "attention_queue", page: { limit: 100 } },
        { employeeId: EMPLOYEE_ID, userId: EMPLOYEE_ID, verticalKey: "none", maxRows: 100 },
        asOf,
      );
      expect(result.status).toBe("ok");
      expect(result.sourceStatus.status).toBe("complete");
      attentionCount = result.items.length;
    }, 5);
    const fastRead = await measureAsync(async () => {
      const result = await executeOperationalQuery(TENANT_ID, { intent: "work_list", page: { limit: 100 } }, { maxRows: 100, now: asOf });
      expect(result.status).toBe("ok");
      fastReadCount = result.count;
    }, 8);

    expect(attentionCount).toBe(100);
    expect(fastReadCount).toBe(100);
    expect(attention.p95Ms).toBeLessThan(2_000);
    expect(fastRead.p95Ms).toBeLessThan(500);
    console.log(`P6_QUERY_PERFORMANCE ${JSON.stringify({ realisticWorkVolume: REALISTIC_WORK_VOLUME, attention, fastRead })}`);
  }, 30_000);
});
