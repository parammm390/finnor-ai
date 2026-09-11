import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closePool, withTenant, workObjectiveLoops } from "@finnor/db";
import type { PlanNode } from "@finnor/planning";
import {
  claimWorkforceAssignment,
  createDefaultPluginRegistry,
  finalizeWorkforceAssignment,
  generateWorkforceLearningProposals,
  recordLearningObservationForAssignment,
  requestWorkforceAssignment,
} from "@finnor/orchestration";
import { workforceStatus } from "@finnor/read-models";
import {
  computeLearningMetrics,
  evaluateAssignmentEligibility,
  proposalChangeForMetric,
  rankEligibleWorkers,
  type LearningObservation,
  type PlanExecutionBoundary,
  type WorkforceCandidate,
} from "@finnor/workforce";
import { migrate } from "../../packages/db/migrate";

const SOURCE_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@127.0.0.1:5432/finnor";
const REALISTIC_FLEET_SIZE = 64;
const REALISTIC_OBSERVATION_VOLUME = 10_000;

interface Measurement {
  iterations: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
}

function summarize(samples: number[]): Measurement {
  const ordered = [...samples].sort((left, right) => left - right);
  return {
    iterations: samples.length,
    meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    p95Ms: ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * 0.95) - 1)]!,
    maxMs: ordered.at(-1)!,
  };
}

function measureSync(fn: () => void, iterations: number): Measurement {
  for (let index = 0; index < 10; index += 1) fn();
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  return summarize(samples);
}

async function measureAsync(fn: () => Promise<void>, iterations: number): Promise<Measurement> {
  await fn();
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  return summarize(samples);
}

function hash(label: string): string {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function candidate(index: number): WorkforceCandidate {
  const suffix = String(index + 1).padStart(12, "0");
  const profileId = `00000000-0000-4000-8000-${suffix}`;
  return {
    profile: { id: profileId, tenantId: "00000000-0000-4000-8000-000000000001", key: `worker-${index}`, name: `Worker ${index}`, status: "enabled", createdAt: "2030-01-01T00:00:00.000Z" },
    revision: {
      id: `10000000-0000-4000-8000-${suffix}`,
      tenantId: "00000000-0000-4000-8000-000000000001",
      agentProfileId: profileId,
      revision: 1,
      modelRoute: { provider: "orchestration_runtime", model: null, purpose: "objective_execution" },
      capabilityGrants: [{ capability: "query:work_list", kind: "query" }],
      maxConcurrentAssignments: 8,
      autonomyLimits: { maxActions: 3, maxQueries: 8, maxReplans: 6, maxPlannerCalls: 8, maxWallClockMs: 86_400_000 },
      planningHints: {}, learningRevisionId: null, status: "active", configHash: hash(`candidate:${index}`), createdAt: "2030-01-01T00:00:00.000Z",
    },
    currentLoad: index % 4,
    budgetUsage: { actions: 0, queries: 1, replans: 0, plannerCalls: 1, wallClockMs: 1_000 },
    p6BudgetCeilings: { maxActions: 5, maxQueries: 12, maxReplans: 12, maxPlannerCalls: 12, maxWallClockMs: 604_800_000 },
    metric: null,
    routeAvailable: true,
    repeatedWorkerFailures: 0,
    promotedRoutingPreference: 0,
  };
}

const boundary: PlanExecutionBoundary = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  workId: "20000000-0000-4000-8000-000000000001",
  planRevisionId: "30000000-0000-4000-8000-000000000001",
  currentPlanRevisionId: "30000000-0000-4000-8000-000000000001",
  planNodeId: "benchmark-node",
  nodeKind: "query",
  capability: "query:work_list",
  ready: true,
  preconditionsValid: true,
  humanOnly: false,
  authorityRequirement: "query",
  providerAvailable: true,
  policyAllowed: true,
};

const fleet = Array.from({ length: REALISTIC_FLEET_SIZE }, (_, index) => candidate(index));
const observations: LearningObservation[] = Array.from({ length: REALISTIC_OBSERVATION_VOLUME }, (_, index) => {
  const worker = fleet[index % fleet.length]!;
  return {
    id: `observation-${index}`,
    tenantId: boundary.tenantId,
    agentProfileId: worker.profile.id,
    agentRevisionId: worker.revision.id,
    workforceAssignmentId: `assignment-${index}`,
    capability: "query:work_list",
    nodeKind: "query",
    contextClass: `private_equity:query:${Math.floor(index / fleet.length) % 4}`,
    workId: `work-${index}`,
    planRevisionId: `plan-${index}`,
    planNodeId: `node-${index}`,
    outcomeClass: index % 10 === 0 ? "agent_planning_failure" : "verified_completion",
    verified: true,
    sourceRefs: [{ type: "objective_step", id: `step-${index}` }, { type: "plan_node", id: `node-${index}` }],
    contextFeatures: { verticalKey: "private_equity", nodeKind: "query", capability: "query:work_list" },
    measuredMetrics: { latencyMs: 20 + (index % 100), knownCostUsd: null, knownTokens: null, replans: 0, recoveries: 0 },
    occurredAt: new Date(1_893_456_000_000 + index).toISOString(),
    observationHash: hash(`observation:${index}`),
  };
});

describe("P7 pure workforce performance guardrails", () => {
  it("benchmarks hard eligibility across a realistic bounded fleet", () => {
    let eligible = 0;
    const measurement = measureSync(() => {
      eligible = fleet.filter((item) => evaluateAssignmentEligibility(boundary, item).eligible).length;
    }, 500);
    expect(eligible).toBe(REALISTIC_FLEET_SIZE);
    expect(measurement.p95Ms).toBeLessThan(15);
    console.log(`P7_ELIGIBILITY_PERFORMANCE ${JSON.stringify({ fleetSize: REALISTIC_FLEET_SIZE, measurement })}`);
  });

  it("benchmarks deterministic assignment ranking across the same fleet", () => {
    let winner = "";
    const measurement = measureSync(() => { winner = rankEligibleWorkers(boundary, fleet)[0]!.candidate.profile.id; }, 300);
    expect(winner).toBe(fleet[0]!.profile.id);
    expect(measurement.p95Ms).toBeLessThan(25);
    console.log(`P7_RANKING_PERFORMANCE ${JSON.stringify({ fleetSize: REALISTIC_FLEET_SIZE, measurement })}`);
  });

  it("benchmarks deterministic learning aggregation over a bounded realistic window", () => {
    let sliceCount = 0;
    const measurement = measureSync(() => { sliceCount = computeLearningMetrics(observations).length; }, 20);
    expect(sliceCount).toBe(REALISTIC_FLEET_SIZE * 4);
    expect(measurement.p95Ms).toBeLessThan(500);
    console.log(`P7_LEARNING_AGGREGATION_PERFORMANCE ${JSON.stringify({ observationCount: observations.length, sliceCount, measurement })}`);
  });

  it("benchmarks typed proposal calculation without mutating hard policy", () => {
    const metrics = computeLearningMetrics(observations);
    let proposalCount = 0;
    const measurement = measureSync(() => { proposalCount = metrics.map(proposalChangeForMetric).filter(Boolean).length; }, 500);
    expect(proposalCount).toBeGreaterThan(0);
    expect(measurement.p95Ms).toBeLessThan(25);
    console.log(`P7_PROPOSAL_CALCULATION_PERFORMANCE ${JSON.stringify({ metricSliceCount: metrics.length, proposalCount, measurement })}`);
  });
});

async function canConnect(): Promise<boolean> {
  const client = new pg.Client({ connectionString: SOURCE_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => undefined); }
}

function databaseUrl(database: string): string {
  const url = new URL(SOURCE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

const databaseAvailable = await canConnect();

describe.skipIf(!databaseAvailable)("P7 database workforce performance guardrails", () => {
  const database = `finnor_p7_perf_${randomUUID().replaceAll("-", "_")}`;
  const url = databaseUrl(database);
  const tenantId = randomUUID();
  const actorId = randomUUID();
  const plugins = createDefaultPluginRegistry();
  let admin: pg.Client;

  async function fixture() {
    const workId = randomUUID();
    const inputId = randomUUID();
    const loopId = randomUUID();
    const stepId = randomUUID();
    const planRevisionId = randomUUID();
    const nodeId = `node-${randomUUID()}`;
    const node = { id: nodeId, kind: "query", request: { intent: "work_list", recordId: workId } } as unknown as PlanNode;
    const goalHash = hash(`goal:${workId}`);
    const constraintHash = hash(`constraint:${workId}`);
    const snapshotHash = hash(`snapshot:${workId}`);
    const graphHash = hash(`graph:${workId}`);
    await admin.query(`INSERT INTO finnor_os.works(id,tenant_id,status,initial_channel,initial_instruction,execution_model,created_by,idempotency_key) VALUES($1,$2,'executing','console','P7 performance fixture','objective',$3,$4)`, [workId, tenantId, actorId, `p7-perf-work:${workId}`]);
    await admin.query(`INSERT INTO finnor_os.work_inputs(id,tenant_id,work_id,instruction_id,channel,instruction_text,created_by,idempotency_key) VALUES($1,$2,$3,$4,'console','P7 performance fixture',$5,$6)`, [inputId, tenantId, workId, randomUUID(), actorId, `p7-perf-input:${workId}`]);
    await admin.query(`INSERT INTO finnor_os.work_objective_loops(id,tenant_id,work_id,objective,state,revision,step_count,max_steps,max_actions,max_queries,max_planner_failures,max_consecutive_no_progress,deadline_at,created_by,initial_channel,success_condition) VALUES($1,$2,$3,'Execute exact benchmark node','continue',1,1,12,5,12,3,3,now()+interval '1 day',$4,'console',$5::jsonb)`, [loopId, tenantId, workId, actorId, JSON.stringify({ version: 1, statement: "Benchmark node observed", mode: "all", source: "explicit", criteria: [] })]);
    await admin.query(`INSERT INTO finnor_os.work_plan_revisions(id,tenant_id,work_id,work_input_id,objective_loop_id,revision,reason,status,goal_spec,constraint_set,planning_snapshot,candidate_summary,validation,plan_graph,score,goal_hash,constraint_hash,world_snapshot_hash,graph_hash,semantic_hash) VALUES($1,$2,$3,$4,$5,1,'initial','active',$6::jsonb,$7::jsonb,$8::jsonb,'{}'::jsonb,'{"version":1}'::jsonb,$9::jsonb,'{}'::jsonb,$10,$11,$12,$13,$13)`, [planRevisionId, tenantId, workId, inputId, loopId, JSON.stringify({ version: 1, semanticHash: goalHash }), JSON.stringify({ version: 1, semanticHash: constraintHash }), JSON.stringify({ version: 1, semanticHash: snapshotHash, verticalKey: "none" }), JSON.stringify({ version: 1, semanticHash: graphHash, nodes: [node] }), goalHash, constraintHash, snapshotHash, graphHash]);
    await admin.query(`INSERT INTO finnor_os.work_objective_steps(id,tenant_id,objective_loop_id,work_id,step_number,idempotency_key,phase,plan_revision_id,plan_node_id) VALUES($1,$2,$3,$4,1,$5,'deciding',$6,$7)`, [stepId, tenantId, loopId, workId, `p7-perf-step:${stepId}`, planRevisionId, nodeId]);
    const [objectiveLoop] = await withTenant(tenantId, (db) => db.select().from(workObjectiveLoops).where(eq(workObjectiveLoops.id, loopId)).limit(1));
    if (!objectiveLoop) throw new Error("Performance fixture ObjectiveLoop missing");
    return { workId, loopId, stepId, planRevisionId, node, objectiveLoop };
  }

  async function assign(f: Awaited<ReturnType<typeof fixture>>) {
    return requestWorkforceAssignment({ tenantId, workId: f.workId, planRevisionId: f.planRevisionId, node: f.node, objectiveLoop: f.objectiveLoop, objectiveStepId: f.stepId, plugins });
  }

  beforeAll(async () => {
    const source = new pg.Client({ connectionString: SOURCE_URL });
    await source.connect();
    try { await source.query(`CREATE DATABASE ${database}`); } finally { await source.end(); }
    process.env.DATABASE_URL = url;
    await migrate(url);
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query("SET app.test_vertical_mode = 'explicit'");
    await admin.query(`INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'P7 performance')`, [tenantId, `p7-perf-${tenantId}`]);
    await admin.query(`INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','P7 Performance Owner')`, [actorId, tenantId, `p7-perf-${actorId}@test.invalid`]);
    await admin.query(`INSERT INTO finnor_os.tenant_vertical_assignments(tenant_id,vertical_key,version,source_system,created_by) VALUES($1,'none',1,'certification:p7-performance',$2)`, [tenantId, actorId]);
    for (let index = 0; index < REALISTIC_FLEET_SIZE; index += 1) {
      const profileId = randomUUID();
      await admin.query(`INSERT INTO finnor_os.agent_profiles(id,tenant_id,key,name) VALUES($1,$2,$3,$4)`, [profileId, tenantId, `perf-worker-${String(index).padStart(3, "0")}`, `Performance Worker ${index}`]);
      await admin.query(`INSERT INTO finnor_os.agent_profile_revisions(id,tenant_id,agent_profile_id,revision,model_route,capability_grants,max_concurrent_assignments,autonomy_limits,planning_hints,status,config_hash,created_by) VALUES($1,$2,$3,1,$4::jsonb,$5::jsonb,8,$6::jsonb,'{}'::jsonb,'active',$7,$8)`, [randomUUID(), tenantId, profileId, JSON.stringify({ provider: "orchestration_runtime", model: null, purpose: "objective_execution" }), JSON.stringify([{ capability: "query:work_list", kind: "query" }]), JSON.stringify({ maxActions: 3, maxQueries: 8, maxReplans: 6, maxPlannerCalls: 8, maxWallClockMs: 86_400_000, maxKnownCostUsd: null, maxKnownTokens: null }), hash(`perf-config:${profileId}`), actorId]);
    }
  }, 180_000);

  afterAll(async () => {
    await closePool();
    await admin?.end().catch(() => undefined);
    const source = new pg.Client({ connectionString: SOURCE_URL });
    await source.connect();
    try { await source.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await source.end(); }
  }, 30_000);

  it("benchmarks the atomic claim and idempotent same-owner lease path", async () => {
    const f = await fixture();
    const requested = await assign(f);
    expect(requested.status).toBe("assigned");
    if (requested.status !== "assigned") return;
    const owner = "p7-performance-owner";
    const started = performance.now();
    expect((await claimWorkforceAssignment({ tenantId, assignmentId: requested.assignment.id, leaseOwner: owner })).status).toBe("claimed");
    const initialClaimMs = performance.now() - started;
    const replay = await measureAsync(async () => {
      expect((await claimWorkforceAssignment({ tenantId, assignmentId: requested.assignment.id, leaseOwner: owner })).status).toBe("claimed");
    }, 12);
    expect(initialClaimMs).toBeLessThan(500);
    expect(replay.p95Ms).toBeLessThan(250);
    console.log(`P7_ATOMIC_CLAIM_PERFORMANCE ${JSON.stringify({ initialClaimMs, replay })}`);
  });

  it("benchmarks the truthful workforce_status projection for a realistic fleet", async () => {
    let count = 0;
    const measurement = await measureAsync(async () => {
      const result = await workforceStatus(tenantId, { page: { limit: 100 } });
      expect(result.status).toBe("ok");
      expect(result.sourceStatus.status).toBe("complete");
      count = result.workers.length;
    }, 6);
    expect(count).toBe(REALISTIC_FLEET_SIZE);
    expect(measurement.p95Ms).toBeLessThan(1_000);
    console.log(`P7_WORKFORCE_STATUS_PERFORMANCE ${JSON.stringify({ fleetSize: count, measurement })}`);
  });

  it("benchmarks source-backed typed LearningProposal generation and idempotent replay", async () => {
    for (let index = 0; index < 5; index += 1) {
      const f = await fixture();
      const requested = await assign(f);
      expect(requested.status).toBe("assigned");
      if (requested.status !== "assigned") continue;
      const owner = `proposal-worker-${index}`;
      expect((await claimWorkforceAssignment({ tenantId, assignmentId: requested.assignment.id, leaseOwner: owner })).status).toBe("claimed");
      await admin.query(`UPDATE finnor_os.work_objective_steps SET completed_at=now(),iteration_outcome='failed',failure='{"code":"PLANNING_FAILURE"}'::jsonb WHERE id=$1`, [f.stepId]);
      await finalizeWorkforceAssignment({ tenantId, assignmentId: requested.assignment.id, leaseOwner: owner, thrownFailure: new Error("planning failure") });
      expect(await recordLearningObservationForAssignment(tenantId, requested.assignment.id)).not.toBeNull();
    }
    const started = performance.now();
    const created = await generateWorkforceLearningProposals(tenantId, 90);
    const initialGenerationMs = performance.now() - started;
    expect(created.createdProposalIds).toHaveLength(1);
    expect(created.observationsTruncated).toBe(false);
    expect(created.activeProposalsTruncated).toBe(false);
    const replay = await measureAsync(async () => {
      const result = await generateWorkforceLearningProposals(tenantId, 90);
      expect(result.createdProposalIds).toHaveLength(0);
    }, 4);
    expect(initialGenerationMs).toBeLessThan(2_000);
    expect(replay.p95Ms).toBeLessThan(1_000);
    console.log(`P7_PROPOSAL_GENERATION_PERFORMANCE ${JSON.stringify({ observationCount: created.observationCount, initialGenerationMs, replay })}`);
  }, 30_000);
});
