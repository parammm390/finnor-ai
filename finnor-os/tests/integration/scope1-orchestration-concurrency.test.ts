import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  beginWorkPlannerAttempt,
  businessEffects,
  closePool,
  createWorkEventWaitTx,
  domainActions,
  integrationEvents,
  jobs,
  persistSelectedWorkPlan,
  workEventWaits,
  workObjectiveLoops,
  workObjectiveSteps,
  workPlanRevisions,
  workRecoveryDecisions,
  workWakeClaims,
  workforceAssignments,
  withTenant,
} from "@finnor/db";
import type { PlanGraph, PlanNode } from "@finnor/planning";
import {
  claimWorkforceAssignment,
  controlWorkObjective,
  createDefaultPluginRegistry,
  ingestIntegrationEvent,
  requestWorkforceAssignment,
  reserveReadyPlanFrontier,
} from "@finnor/orchestration";
import { causalReplayProjection } from "@finnor/read-models";
import { migrate } from "../../packages/db/migrate";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@127.0.0.1:5432/finnor";

async function canConnect(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => undefined); }
}

function hash(label: string): string {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function rawHash(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function queryNode(id: string): PlanNode {
  return {
    id,
    kind: "query",
    dependsOn: [],
    supports: ["criterion:done"],
    preconditions: [],
    expectedEffects: [],
    recovery: { version: 1, on: ["failure", "stale", "timeout", "divergence"], mode: "replan", maxAttempts: 1, neverReplayVerifiedIrreversibleEffect: true },
    request: { intent: "work_list", node: id },
    observation: { version: 1, source: "operational_query", assertion: { status: "ok" }, freshness: "current" },
    semanticHash: hash(`node:${id}`),
    estimatedCostMicros: 10,
    estimatedLatencyMs: 1,
  };
}

function checkNode(id: string): PlanNode {
  return {
    id,
    kind: "check",
    dependsOn: [],
    supports: ["criterion:done"],
    preconditions: [],
    expectedEffects: [],
    recovery: { version: 1, on: ["failure", "stale", "timeout", "divergence"], mode: "replan", maxAttempts: 1, neverReplayVerifiedIrreversibleEffect: true },
    criterionId: `criterion:${id}`,
    assertion: { satisfied: true },
    observation: { version: 1, source: "objective_success", assertion: { satisfied: true }, freshness: "current" },
    semanticHash: hash(`node:${id}`),
    estimatedCostMicros: 0,
    estimatedLatencyMs: 1,
  };
}

function actionNode(id: string, workId: string): PlanNode {
  const payload = { title: `Exact task for ${workId}`, targetId: workId };
  return {
    id,
    kind: "action",
    dependsOn: [],
    supports: ["criterion:done"],
    preconditions: [],
    expectedEffects: [{ kind: "business_effect", assertion: { created: true } }],
    recovery: { version: 1, on: ["failure", "stale", "timeout", "divergence"], mode: "retry", maxAttempts: 3, neverReplayVerifiedIrreversibleEffect: true },
    actionType: "create_task",
    payload,
    groundedPayload: payload,
    predictedReceipt: null,
    authority: "allowed",
    risk: "high",
    irreversible: true,
    observation: { version: 1, source: "provider_observation", assertion: { created: true }, freshness: "current" },
    semanticHash: hash(`node:${id}`),
    estimatedCostMicros: 100,
    estimatedLatencyMs: 10,
  };
}

function waitNode(id: string): PlanNode {
  return {
    id,
    kind: "wait",
    dependsOn: [],
    supports: ["criterion:done"],
    preconditions: [],
    expectedEffects: [{ kind: "event", assertion: { eventType: `scope1.${id}` } }],
    recovery: { version: 1, on: ["failure", "stale", "timeout", "divergence"], mode: "replan", maxAttempts: 1, neverReplayVerifiedIrreversibleEffect: true },
    waitFor: { eventType: `scope1.${id}`, correlationId: `correlation:${id}` },
    observation: { version: 1, source: "integration_event", assertion: { eventType: `scope1.${id}` }, freshness: "event_bound" },
    semanticHash: hash(`node:${id}`),
    estimatedCostMicros: 0,
    estimatedLatencyMs: null,
  };
}

function planGraph(nodes: PlanNode[], label: string): PlanGraph {
  return {
    version: 1,
    goalHash: hash(`goal:${label}`),
    constraintHash: hash(`constraint:${label}`),
    snapshotHash: hash(`snapshot:${label}`),
    nodes,
    edges: nodes.flatMap((node) => node.dependsOn.map((from) => ({ from, to: node.id, kind: "causal_prerequisite" as const, semanticHash: hash(`edge:${from}:${node.id}`) }))),
    completionCoverage: [],
    semanticHash: hash(`graph:${label}:${nodes.map((node) => node.semanticHash).join(":")}`),
  };
}

const available = await canConnect();

describe.skipIf(!available)("Scope 1 persisted orchestration concurrency", () => {
  const tenantId = randomUUID();
  const foreignTenantId = randomUUID();
  const actorId = randomUUID();
  const profileId = randomUUID();
  const profileRevisionId = randomUUID();
  const plugins = createDefaultPluginRegistry();
  let admin: pg.Client;

  interface Fixture {
    workId: string;
    inputId: string;
    loopId: string;
    planRevisionId: string;
    graph: PlanGraph;
  }

  async function fixture(nodesFactory: (workId: string) => PlanNode[], options: { deadlineAt?: Date; maxParallelNodes?: number; maxNodeAttempts?: number } = {}): Promise<Fixture> {
    const workId = randomUUID();
    const inputId = randomUUID();
    const loopId = randomUUID();
    const planRevisionId = randomUUID();
    const instructionId = randomUUID();
    const nodes = nodesFactory(workId);
    const graph = planGraph(nodes, workId);
    await admin.query(
      `INSERT INTO finnor_os.works(id,tenant_id,status,initial_channel,initial_instruction,execution_model,created_by,idempotency_key)
       VALUES($1,$2,'executing','console','Scope 1 concurrency fixture','objective',$3,$4)`,
      [workId, tenantId, actorId, `scope1-work:${workId}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.work_inputs(id,tenant_id,work_id,instruction_id,channel,instruction_text,created_by,idempotency_key)
       VALUES($1,$2,$3,$4,'console','Scope 1 concurrency fixture',$5,$6)`,
      [inputId, tenantId, workId, instructionId, actorId, `scope1-input:${workId}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.work_objective_loops(
         id,tenant_id,work_id,objective,state,revision,step_count,max_steps,max_actions,max_queries,max_planner_failures,max_consecutive_no_progress,
         max_parallel_nodes,max_node_attempts,max_waits,max_estimated_cost_micros,deadline_at,created_by,initial_channel,success_condition
       ) VALUES($1,$2,$3,'Execute the immutable Scope 1 plan','continue',1,0,50,25,50,3,3,$4,$5,12,5000000,$6,$7,'console',$8::jsonb)`,
      [
        loopId,
        tenantId,
        workId,
        options.maxParallelNodes ?? 4,
        options.maxNodeAttempts ?? 100,
        options.deadlineAt ?? new Date(Date.now() + 86_400_000),
        actorId,
        JSON.stringify({ version: 1, statement: "Every selected criterion is verified", mode: "all", source: "explicit", criteria: [] }),
      ],
    );
    await admin.query(
      `INSERT INTO finnor_os.work_plan_revisions(
         id,tenant_id,work_id,work_input_id,objective_loop_id,revision,reason,status,goal_spec,constraint_set,planning_snapshot,candidate_summary,
         validation,plan_graph,score,goal_hash,constraint_hash,world_snapshot_hash,graph_hash,semantic_hash,compiler_version,revision_transition
       ) VALUES($1,$2,$3,$4,$5,1,'initial','active',$6::jsonb,$7::jsonb,$8::jsonb,'{}'::jsonb,'{"version":1}'::jsonb,$9::jsonb,
         '{}'::jsonb,$10,$11,$12,$13,$13,'scope1-test-compiler',$14::jsonb)`,
      [
        planRevisionId,
        tenantId,
        workId,
        inputId,
        loopId,
        JSON.stringify({ version: 1, semanticHash: graph.goalHash }),
        JSON.stringify({ version: 1, semanticHash: graph.constraintHash }),
        JSON.stringify({ version: 1, semanticHash: graph.snapshotHash, verticalKey: "none" }),
        JSON.stringify(graph),
        graph.goalHash,
        graph.constraintHash,
        graph.snapshotHash,
        graph.semanticHash,
        JSON.stringify({ version: 1, parentRevisionId: null, cause: "initial", transitionHash: hash(`transition:${workId}:1`) }),
      ],
    );
    return { workId, inputId, loopId, planRevisionId, graph };
  }

  async function loop(id: string) {
    const [row] = await withTenant(tenantId, (db) => db.select().from(workObjectiveLoops).where(eq(workObjectiveLoops.id, id)).limit(1));
    if (!row) throw new Error("Scope 1 fixture ObjectiveLoop is missing");
    return row;
  }

  async function reserve(f: Fixture, maxReady?: number) {
    return reserveReadyPlanFrontier({
      tenantId,
      workId: f.workId,
      objectiveLoopId: f.loopId,
      expectedObjectiveRevision: 1,
      planRevisionId: f.planRevisionId,
      maxReady,
    });
  }

  async function assign(f: Fixture, node: PlanNode, stepId: string) {
    return requestWorkforceAssignment({
      tenantId,
      workId: f.workId,
      planRevisionId: f.planRevisionId,
      node,
      objectiveLoop: await loop(f.loopId),
      objectiveStepId: stepId,
      plugins,
    });
  }

  beforeAll(async () => {
    await migrate(DATABASE_URL);
    admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query("SET app.test_vertical_mode = 'explicit'");
    await admin.query(
      `INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$3,'Scope 1'),($2,$4,'Scope 1 foreign')`,
      [tenantId, foreignTenantId, `scope1-${tenantId}`, `scope1-foreign-${foreignTenantId}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','Scope 1 Owner')`,
      [actorId, tenantId, `scope1-${actorId}@test.invalid`],
    );
    await admin.query(
      `INSERT INTO finnor_os.tenant_vertical_assignments(tenant_id,vertical_key,version,source_system,created_by)
       VALUES($1,'none',1,'certification:scope1',$3),($2,'none',1,'certification:scope1',$3)`,
      [tenantId, foreignTenantId, actorId],
    );
    await admin.query(`INSERT INTO finnor_os.agent_profiles(id,tenant_id,key,name) VALUES($1,$2,'scope1-query-worker','Scope 1 Query Worker')`, [profileId, tenantId]);
    await admin.query(
      `INSERT INTO finnor_os.agent_profile_revisions(
         id,tenant_id,agent_profile_id,revision,model_route,capability_grants,max_concurrent_assignments,autonomy_limits,planning_hints,status,config_hash,created_by
       ) VALUES($1,$2,$3,1,$4::jsonb,$5::jsonb,32,$6::jsonb,'{}'::jsonb,'active',$7,$8)`,
      [
        profileRevisionId,
        tenantId,
        profileId,
        JSON.stringify({ provider: "orchestration_runtime", model: null, purpose: "objective_execution" }),
        JSON.stringify([{ capability: "query:work_list", kind: "query" }]),
        JSON.stringify({ maxActions: 4, maxQueries: 11, maxReplans: 8, maxPlannerCalls: 11, maxWallClockMs: 86_400_000, maxKnownCostUsd: null, maxKnownTokens: null }),
        hash(`profile:${profileId}:1`),
        actorId,
      ],
    );
  }, 180_000);

  afterAll(async () => {
    await closePool();
    await admin?.end().catch(() => undefined);
  });

  it("lets 100 independent ready nodes progress in bounded atomic batches", async () => {
    const f = await fixture(() => Array.from({ length: 100 }, (_, index) => checkNode(`independent-${String(index).padStart(3, "0")}`)), { maxParallelNodes: 32, maxNodeAttempts: 100 });
    const reservedIds = new Set<string>();
    for (const expected of [32, 32, 32, 4]) {
      const result = await reserve(f, 32);
      expect(result.state).toBe("reserved");
      if (result.state !== "reserved") return;
      expect(result.reservations).toHaveLength(expected);
      for (const item of result.reservations) reservedIds.add(item.step.id);
      await withTenant(tenantId, (db) => db.update(workObjectiveSteps).set({
        phase: "finished",
        executionState: "completed",
        iterationOutcome: "completed",
        verificationResult: { version: 1, state: "verified", evidenceHash: hash(`verification:${result.reservations[0]!.step.id}`) },
        completedAt: new Date(),
      }).where(and(eq(workObjectiveSteps.tenantId, tenantId), eq(workObjectiveSteps.planRevisionId, f.planRevisionId), eq(workObjectiveSteps.executionState, "scheduled"))));
    }
    expect(reservedIds.size).toBe(100);
    const exhausted = await reserve(f, 32);
    expect(exhausted.state).toBe("exhausted");
    const current = await loop(f.loopId);
    expect(current.nodeAttemptCount).toBe(100);
    expect(current.stepCount).toBe(100);
  });

  it("serializes 100 same-node schedulers and 100 physical claim contenders to one winner", async () => {
    const f = await fixture(() => [queryNode("one-node")], { maxParallelNodes: 8 });
    const reservations = await Promise.all(Array.from({ length: 100 }, () => reserve(f, 1)));
    expect(reservations.filter((result) => result.state === "reserved")).toHaveLength(1);
    const reserved = reservations.find((result): result is Extract<typeof result, { state: "reserved" }> => result.state === "reserved")!;
    const requested = await assign(f, f.graph.nodes[0]!, reserved.reservations[0]!.step.id);
    expect(requested.status).toBe("assigned");
    if (requested.status !== "assigned") return;
    const claims = await Promise.all(Array.from({ length: 100 }, (_, index) => claimWorkforceAssignment({
      tenantId,
      assignmentId: requested.assignment.id,
      leaseOwner: `scope1-worker-${index}`,
    })));
    expect(claims.filter((result) => result.status === "claimed")).toHaveLength(1);
    expect(claims.filter((result) => result.status === "busy")).toHaveLength(99);
    const rows = await withTenant(tenantId, (db) => db.select().from(workObjectiveSteps).where(eq(workObjectiveSteps.planRevisionId, f.planRevisionId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attemptNumber: 1, executionState: "running" });
  }, 60_000);

  it("atomically enforces a shared budget across 100 concurrent frontier reservations", async () => {
    const f = await fixture(() => [queryNode("budget-a"), queryNode("budget-b")], { maxParallelNodes: 16 });
    await admin.query(
      `UPDATE finnor_os.work_objective_loops
       SET max_queries=1,max_node_attempts=1,max_estimated_cost_micros=10
       WHERE id=$1`,
      [f.loopId],
    );
    const results = await Promise.all(Array.from({ length: 100 }, () => reserve(f, 16)));
    expect(results.filter((result) => result.state === "reserved")).toHaveLength(1);
    const rows = await withTenant(tenantId, (db) => db.select().from(workObjectiveSteps).where(eq(workObjectiveSteps.planRevisionId, f.planRevisionId)));
    const current = await loop(f.loopId);
    expect(rows).toHaveLength(1);
    expect(current).toMatchObject({ queryCount: 1, nodeAttemptCount: 1, reservedEstimatedCostMicros: 10 });
  }, 60_000);

  it("persists an explicit retry as attempt two with an attributable recovery parent", async () => {
    const retrying: PlanNode = {
      ...queryNode("durable-retry"),
      recovery: { version: 1, on: ["failure", "stale", "timeout", "divergence"], mode: "retry", maxAttempts: 3, neverReplayVerifiedIrreversibleEffect: true },
    };
    const f = await fixture(() => [retrying]);
    const first = await reserve(f, 1);
    expect(first.state).toBe("reserved");
    if (first.state !== "reserved") return;
    const firstStep = first.reservations[0]!.step;
    await withTenant(tenantId, (db) => db.update(workObjectiveSteps).set({
      phase: "finished",
      executionState: "failed",
      iterationOutcome: "failed",
      failure: { code: "READ_FAILED_BEFORE_EFFECT" },
      completedAt: new Date(),
    }).where(eq(workObjectiveSteps.id, firstStep.id)));
    const second = await reserve(f, 1);
    expect(second).toMatchObject({
      state: "reserved",
      reservations: [{ step: { attemptNumber: 2, recoveryParentStepId: firstStep.id }, unit: { attemptNumber: 2, recoveryParentStepId: firstStep.id } }],
    });
    const rows = await withTenant(tenantId, (db) => db.select().from(workObjectiveSteps).where(eq(workObjectiveSteps.planRevisionId, f.planRevisionId)));
    expect(rows.map((row) => row.attemptNumber).sort()).toEqual([1, 2]);
  });

  it("fences a stale Objective generation before it can reserve or advance work", async () => {
    const f = await fixture(() => [queryNode("stale-objective")]);
    await admin.query(`UPDATE finnor_os.work_objective_loops SET revision=2 WHERE id=$1`, [f.loopId]);
    await expect(reserve(f, 1)).rejects.toThrow(/Objective revision changed/i);
    const rows = await withTenant(tenantId, (db) => db.select().from(workObjectiveSteps).where(eq(workObjectiveSteps.planRevisionId, f.planRevisionId)));
    expect(rows).toHaveLength(0);
    expect(await loop(f.loopId)).toMatchObject({ revision: 2, nodeAttemptCount: 0, queryCount: 0 });
  });

  it("makes cancellation racing a physical claim leave no executable stale owner", async () => {
    const f = await fixture(() => [queryNode("cancel-claim")]);
    const reserved = await reserve(f, 1);
    expect(reserved.state).toBe("reserved");
    if (reserved.state !== "reserved") return;
    const requested = await assign(f, f.graph.nodes[0]!, reserved.reservations[0]!.step.id);
    expect(requested.status).toBe("assigned");
    if (requested.status !== "assigned") return;
    const raced = await Promise.allSettled([
      claimWorkforceAssignment({ tenantId, assignmentId: requested.assignment.id, leaseOwner: "racing-worker" }),
      controlWorkObjective({ tenantId, workId: f.workId, command: "cancel", actorId }),
      reserve(f, 1),
    ]);
    expect(raced[1]?.status).toBe("fulfilled");
    expect(raced.filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => String(result.reason))).not.toEqual(expect.arrayContaining([expect.stringMatching(/deadlock/i)]));
    const [assignment] = await withTenant(tenantId, (db) => db.select().from(workforceAssignments).where(eq(workforceAssignments.id, requested.assignment.id)).limit(1));
    const [step] = await withTenant(tenantId, (db) => db.select().from(workObjectiveSteps).where(eq(workObjectiveSteps.id, reserved.reservations[0]!.step.id)).limit(1));
    expect(await loop(f.loopId)).toMatchObject({ state: "cancelled" });
    expect(["completed", "failed", "cancelled", "superseded"]).toContain(assignment!.state);
    expect(["cancelled", "superseded", "failed", "reconciliation_required"]).toContain(step!.executionState);
    expect(step!.claimOwner).toBeNull();
    expect(step!.claimUntil).toBeNull();
  });

  it("supersedes stale logical and physical claims while retaining deterministic child history", async () => {
    const f = await fixture(() => [queryNode("stale-node")]);
    const reserved = await reserve(f, 1);
    expect(reserved.state).toBe("reserved");
    if (reserved.state !== "reserved") return;
    const requested = await assign(f, f.graph.nodes[0]!, reserved.reservations[0]!.step.id);
    expect(requested.status).toBe("assigned");
    if (requested.status !== "assigned") return;
    expect((await claimWorkforceAssignment({ tenantId, assignmentId: requested.assignment.id, leaseOwner: "stale-owner" })).status).toBe("claimed");

    const attempt = await beginWorkPlannerAttempt({ tenantId, workId: f.workId, workInputId: f.inputId, attemptKey: `scope1-child:${f.workId}` });
    const childGraph = planGraph([queryNode("replacement-node")], `${f.workId}:child`);
    type Persist = Parameters<typeof persistSelectedWorkPlan>[0];
    const child = await persistSelectedWorkPlan({
      tenantId,
      workId: f.workId,
      workInputId: f.inputId,
      plannerAttemptId: attempt.id,
      objectiveLoopId: f.loopId,
      parentRevisionId: f.planRevisionId,
      reason: "stale",
      goalSpec: { version: 1, semanticHash: childGraph.goalHash } as Persist["goalSpec"],
      constraintSet: { version: 1, semanticHash: childGraph.constraintHash } as Persist["constraintSet"],
      planningSnapshot: { version: 1, semanticHash: childGraph.snapshotHash, verticalKey: "none" } as Persist["planningSnapshot"],
      candidatePlans: [] as unknown as Persist["candidatePlans"],
      compilationResult: { version: 1, candidates: [], selected: { graph: childGraph } } as unknown as Persist["compilationResult"],
      planGraph: childGraph,
      score: {} as Persist["score"],
      semanticHash: childGraph.semanticHash,
      compilerVersion: "scope1-test-compiler",
    });
    const [oldStep] = await withTenant(tenantId, (db) => db.select().from(workObjectiveSteps).where(eq(workObjectiveSteps.id, reserved.reservations[0]!.step.id)).limit(1));
    const [oldAssignment] = await withTenant(tenantId, (db) => db.select().from(workforceAssignments).where(eq(workforceAssignments.id, requested.assignment.id)).limit(1));
    expect(oldStep).toMatchObject({ executionState: "superseded", iterationOutcome: "blocked" });
    expect(oldAssignment).toMatchObject({ state: "cancelled" });
    expect((child.revisionTransition as Record<string, unknown>).parentRevisionId).toBe(f.planRevisionId);
    expect((child.revisionTransition as Record<string, unknown>).supersededPendingNodes).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: "stale-node" })]));
    expect((await claimWorkforceAssignment({ tenantId, assignmentId: requested.assignment.id, leaseOwner: "late-stale-owner" })).status).toBe("terminal");
  });

  it("preserves a verified irreversible effect across replanning without replaying it", async () => {
    const f = await fixture((workId) => [actionNode("verified-parent-action", workId)]);
    const reserved = await reserve(f, 1);
    expect(reserved.state).toBe("reserved");
    if (reserved.state !== "reserved") return;
    const parentNode = f.graph.nodes[0]!;
    if (parentNode.kind !== "action") throw new Error("Verified replay fixture is not an action");
    const parentStepId = reserved.reservations[0]!.step.id;
    const parentActionId = randomUUID();
    const parentEffectId = randomUUID();
    const effectHash = rawHash(`verified-effect:${parentActionId}`);
    await admin.query(
      `INSERT INTO finnor_os.domain_actions(id,tenant_id,action_type,payload,status,plan_revision_id,plan_node_id,work_id,objective_step_id,initiated_by)
       VALUES($1,$2,$3,$4::jsonb,'completed',$5,$6,$7,$8,$9)`,
      [parentActionId, tenantId, parentNode.actionType, JSON.stringify(parentNode.groundedPayload), f.planRevisionId, parentNode.id, f.workId, parentStepId, actorId],
    );
    await admin.query(
      `INSERT INTO finnor_os.business_effects(id,tenant_id,domain_action_id,semantic_hash,scope_hash,operation_class,effect,status,observed_at)
       VALUES($1,$2,$3,$4,$4,'external_side_effect',$5::jsonb,'verified',now())`,
      [parentEffectId, tenantId, parentActionId, effectHash, JSON.stringify({ schemaVersion: 1, semanticHash: effectHash, source: { domainActionId: parentActionId, actionType: parentNode.actionType, workId: f.workId, objectiveStepId: parentStepId }, targets: [], bindings: [], authority: { policyId: null }, delta: parentNode.groundedPayload })],
    );
    await admin.query(`UPDATE finnor_os.domain_actions SET business_effect_id=$2 WHERE id=$1`, [parentActionId, parentEffectId]);
    await admin.query(
      `UPDATE finnor_os.work_objective_steps
       SET domain_action_id=$2,phase='finished',execution_state='completed',iteration_outcome='continue',
           verification_result=$3::jsonb,completed_at=now()
       WHERE id=$1`,
      [parentStepId, parentActionId, JSON.stringify({ version: 1, state: "verified", evidenceHash: hash(`verified:${parentEffectId}`) })],
    );

    const attempt = await beginWorkPlannerAttempt({ tenantId, workId: f.workId, workInputId: f.inputId, attemptKey: `scope1-preserved:${f.workId}` });
    const childAction: PlanNode = { ...parentNode, id: "verified-child-action" };
    const childQuery: PlanNode = { ...queryNode("after-preserved-effect"), dependsOn: [childAction.id] };
    const childGraph = planGraph([childAction, childQuery], `${f.workId}:preserved-child`);
    type Persist = Parameters<typeof persistSelectedWorkPlan>[0];
    const child = await persistSelectedWorkPlan({
      tenantId,
      workId: f.workId,
      workInputId: f.inputId,
      plannerAttemptId: attempt.id,
      objectiveLoopId: f.loopId,
      parentRevisionId: f.planRevisionId,
      reason: "observation",
      goalSpec: { version: 1, semanticHash: childGraph.goalHash } as Persist["goalSpec"],
      constraintSet: { version: 1, semanticHash: childGraph.constraintHash } as Persist["constraintSet"],
      planningSnapshot: { version: 1, semanticHash: childGraph.snapshotHash, verticalKey: "none" } as Persist["planningSnapshot"],
      candidatePlans: [] as unknown as Persist["candidatePlans"],
      compilationResult: { version: 1, candidates: [], selected: { graph: childGraph } } as unknown as Persist["compilationResult"],
      planGraph: childGraph,
      score: {} as Persist["score"],
      semanticHash: childGraph.semanticHash,
      compilerVersion: "scope1-test-compiler",
    });
    expect((child.revisionTransition as { preservedCompletedNodes?: unknown[] }).preservedCompletedNodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ parentNodeId: parentNode.id, nodeId: childAction.id, semanticHash: parentNode.semanticHash }),
    ]));

    const childReservation = await reserveReadyPlanFrontier({
      tenantId,
      workId: f.workId,
      objectiveLoopId: f.loopId,
      expectedObjectiveRevision: 1,
      planRevisionId: child.id,
      maxReady: 4,
    });
    expect(childReservation.state).toBe("reserved");
    if (childReservation.state !== "reserved") return;
    expect(childReservation.reservations.map((item) => item.unit.node.id)).toEqual([childQuery.id]);
    expect(childReservation.frontier.observations.find((observation) => observation.nodeId === childAction.id)).toMatchObject({
      state: "satisfied",
      historicalEffect: { businessEffectId: parentEffectId },
    });
    const childSteps = await withTenant(tenantId, (db) => db.select().from(workObjectiveSteps).where(eq(workObjectiveSteps.planRevisionId, child.id)));
    expect(childSteps).toHaveLength(1);
    expect(childSteps[0]).toMatchObject({ planNodeId: childQuery.id, attemptNumber: 1 });
    const actions = await withTenant(tenantId, (db) => db.select().from(domainActions).where(eq(domainActions.workId, f.workId)));
    const effects = await withTenant(tenantId, (db) => db.select().from(businessEffects).where(eq(businessEffects.domainActionId, parentActionId)));
    expect(actions).toHaveLength(1);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ id: parentEffectId, status: "verified" });
  });

  it("persists one restart-safe deadline RecoveryDecision", async () => {
    const f = await fixture(() => [queryNode("deadline-node")], { deadlineAt: new Date(Date.now() - 1_000) });
    const first = await reserve(f, 1);
    const replay = await reserve(f, 1);
    expect(first).toMatchObject({ state: "recovery", recoveryDecision: { cause: "deadline", decision: "terminal_failure" } });
    expect(replay).toMatchObject({ state: "recovery", recoveryDecision: { id: first.state === "recovery" ? first.recoveryDecision.id : "" } });
    const rows = await withTenant(tenantId, (db) => db.select().from(workRecoveryDecisions).where(eq(workRecoveryDecisions.planRevisionId, f.planRevisionId)));
    expect(rows).toHaveLength(1);
  });

  it("makes cancellation at an ambiguous effect boundary reconcile instead of replay", async () => {
    const f = await fixture((workId) => [actionNode("ambiguous-action", workId)]);
    const reserved = await reserve(f, 1);
    expect(reserved.state).toBe("reserved");
    if (reserved.state !== "reserved") return;
    const stepId = reserved.reservations[0]!.step.id;
    const actionId = randomUUID();
    const effectId = randomUUID();
    const node = f.graph.nodes[0]!;
    if (node.kind !== "action") throw new Error("Ambiguous fixture is not an action");
    await admin.query(
      `INSERT INTO finnor_os.domain_actions(id,tenant_id,action_type,payload,status,execution_started_at,plan_revision_id,plan_node_id,work_id,objective_step_id,initiated_by)
       VALUES($1,$2,$3,$4::jsonb,'executing',now(),$5,$6,$7,$8,$9)`,
      [actionId, tenantId, node.actionType, JSON.stringify(node.groundedPayload), f.planRevisionId, node.id, f.workId, stepId, actorId],
    );
    const effectHash = rawHash(`effect:${actionId}`);
    await admin.query(
      `INSERT INTO finnor_os.business_effects(id,tenant_id,domain_action_id,semantic_hash,scope_hash,operation_class,effect,status,execution_started_at)
       VALUES($1,$2,$3,$4,$4,'internal_write',$5::jsonb,'executing',now())`,
      [effectId, tenantId, actionId, effectHash, JSON.stringify({ schemaVersion: 1, semanticHash: effectHash, source: { domainActionId: actionId, actionType: node.actionType, workId: f.workId, objectiveStepId: stepId }, targets: [], bindings: [], authority: { policyId: null }, delta: node.groundedPayload })],
    );
    await admin.query(`UPDATE finnor_os.domain_actions SET business_effect_id=$2 WHERE id=$1`, [actionId, effectId]);
    await admin.query(`UPDATE finnor_os.work_objective_steps SET domain_action_id=$2,execution_state='running',claim_owner='cancelling-worker',claim_until=now()+interval '1 minute' WHERE id=$1`, [stepId, actionId]);
    const cancelled = await controlWorkObjective({ tenantId, workId: f.workId, command: "cancel", actorId });
    expect(cancelled.state).toBe("cancelled");
    const [decision] = await withTenant(tenantId, (db) => db.select().from(workRecoveryDecisions).where(eq(workRecoveryDecisions.objectiveStepId, stepId)).limit(1));
    const [step] = await withTenant(tenantId, (db) => db.select().from(workObjectiveSteps).where(eq(workObjectiveSteps.id, stepId)).limit(1));
    expect(decision).toMatchObject({ decision: "reconcile", cause: "cancellation", businessEffectId: effectId });
    expect(step).toMatchObject({ executionState: "reconciliation_required", iterationOutcome: "waiting" });
    expect((await withTenant(tenantId, (db) => db.select().from(workPlanRevisions).where(eq(workPlanRevisions.id, f.planRevisionId)).limit(1)))[0]).toMatchObject({ status: "blocked" });
  });

  it("survives restart and collapses a 100-delivery wake/job storm to one advancement", async () => {
    const f = await fixture(() => [waitNode("restart-wake")]);
    const reserved = await reserve(f, 1);
    expect(reserved.state).toBe("reserved");
    if (reserved.state !== "reserved") return;
    const node = f.graph.nodes[0]!;
    if (node.kind !== "wait") throw new Error("Restart fixture is not a wait node");
    const step = reserved.reservations[0]!.step;
    const earliestAt = new Date(Date.now() - 1_000);
    const created = await withTenant(tenantId, (db) => createWorkEventWaitTx(db, {
      tenantId,
      workId: f.workId,
      objectiveLoopId: f.loopId,
      objectiveStepId: step.id,
      planRevisionId: f.planRevisionId,
      planNodeId: node.id,
      objectiveRevision: 1,
      waitFor: { eventType: "scope1.restart-wake", correlationId: "correlation:restart-wake" },
      conditionSummary: "Wait for the exact restart-safe Scope-1 event.",
      earliestAt,
      deadlineAt: new Date(Date.now() + 60_000),
    }));
    await withTenant(tenantId, (db) => db.update(workObjectiveSteps).set({ executionState: "waiting" }).where(eq(workObjectiveSteps.id, step.id)));

    // Tear down the application pool after the durable wait commits. Ingestion
    // must reconstruct all state from PostgreSQL; no timer or in-memory waiter is
    // available to help it.
    await closePool();
    const deliveries = await Promise.all(Array.from({ length: 100 }, () => ingestIntegrationEvent({
      tenantId,
      source: "scope1-certification",
      sourceEventId: `restart-wake:${f.workId}`,
      eventType: "scope1.restart-wake",
      occurredAt: new Date(),
      workId: f.workId,
      correlationId: "correlation:restart-wake",
      payload: { exact: true },
      trustClass: "trusted_runtime",
    })));
    expect(deliveries.filter((delivery) => !delivery.duplicate)).toHaveLength(1);
    expect(deliveries.flatMap((delivery) => delivery.wakeClaimIds)).toHaveLength(1);
    expect(deliveries.flatMap((delivery) => delivery.matchedWaitIds)).toEqual([created.wait.id]);
    const [waitRows, eventRows, claimRows, jobRows] = await withTenant(tenantId, async (db) => {
      const waits = await db.select().from(workEventWaits).where(eq(workEventWaits.id, created.wait.id));
      const events = await db.select().from(integrationEvents).where(eq(integrationEvents.sourceEventId, `restart-wake:${f.workId}`));
      const claims = await db.select().from(workWakeClaims).where(eq(workWakeClaims.waitId, created.wait.id));
      const wakeJobs = await db.select().from(jobs).where(eq(jobs.idempotencyKey, `objective-wake:${created.wait.id}`));
      return [waits, events, claims, wakeJobs] as const;
    });
    expect(waitRows).toHaveLength(1);
    expect(waitRows[0]).toMatchObject({ status: "satisfied" });
    expect(eventRows).toHaveLength(1);
    expect(claimRows).toHaveLength(1);
    expect(jobRows).toHaveLength(1);
  }, 60_000);

  it("cancels a stale-generation wait instead of reviving obsolete work", async () => {
    const f = await fixture(() => [waitNode("stale-wake")]);
    const reserved = await reserve(f, 1);
    expect(reserved.state).toBe("reserved");
    if (reserved.state !== "reserved") return;
    const node = f.graph.nodes[0]!;
    if (node.kind !== "wait") throw new Error("Stale fixture is not a wait node");
    const step = reserved.reservations[0]!.step;
    const created = await withTenant(tenantId, (db) => createWorkEventWaitTx(db, {
      tenantId,
      workId: f.workId,
      objectiveLoopId: f.loopId,
      objectiveStepId: step.id,
      planRevisionId: f.planRevisionId,
      planNodeId: node.id,
      objectiveRevision: 1,
      waitFor: { eventType: "scope1.stale-wake", correlationId: "correlation:stale-wake" },
      conditionSummary: "This generation will become stale before the event arrives.",
      earliestAt: new Date(Date.now() - 1_000),
      deadlineAt: null,
    }));
    await admin.query(`UPDATE finnor_os.work_plan_revisions SET status='blocked' WHERE id=$1`, [f.planRevisionId]);
    const result = await ingestIntegrationEvent({
      tenantId,
      source: "scope1-certification",
      sourceEventId: `stale-wake:${f.workId}`,
      eventType: "scope1.stale-wake",
      occurredAt: new Date(),
      workId: f.workId,
      correlationId: "correlation:stale-wake",
      trustClass: "trusted_runtime",
    });
    expect(result.wakeClaimIds).toHaveLength(0);
    const [wait] = await withTenant(tenantId, (db) => db.select().from(workEventWaits).where(eq(workEventWaits.id, created.wait.id)).limit(1));
    const claims = await withTenant(tenantId, (db) => db.select().from(workWakeClaims).where(eq(workWakeClaims.waitId, created.wait.id)));
    expect(wait).toMatchObject({ status: "cancelled" });
    expect(claims).toHaveLength(0);
  });

  it("keeps causal replay read-only and fail-closes cross-tenant scheduling", async () => {
    const f = await fixture(() => [queryNode("replay-node")]);
    const reserved = await reserve(f, 1);
    expect(reserved.state).toBe("reserved");
    const before = await admin.query(`SELECT (SELECT count(*)::int FROM finnor_os.domain_actions WHERE work_id=$1) actions,(SELECT count(*)::int FROM finnor_os.business_effects e JOIN finnor_os.domain_actions a ON a.id=e.domain_action_id WHERE a.work_id=$1) effects`, [f.workId]);
    const replay = await causalReplayProjection(tenantId, f.workId, { userId: actorId, role: "owner" });
    const after = await admin.query(`SELECT (SELECT count(*)::int FROM finnor_os.domain_actions WHERE work_id=$1) actions,(SELECT count(*)::int FROM finnor_os.business_effects e JOIN finnor_os.domain_actions a ON a.id=e.domain_action_id WHERE a.work_id=$1) effects`, [f.workId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(replay).toMatchObject({ mode: "read_only", readOnlyGuarantee: { sideEffectsPossible: false } });
    expect(replay?.nodes.some((node) => node.id === `plan-revision:${f.planRevisionId}`)).toBe(true);
    expect(replay?.nodes.some((node) => node.id.startsWith("objective-step:"))).toBe(true);
    await expect(reserveReadyPlanFrontier({ tenantId: foreignTenantId, workId: f.workId, objectiveLoopId: f.loopId, expectedObjectiveRevision: 1, planRevisionId: f.planRevisionId, maxReady: 1 })).rejects.toThrow(/scope mismatch|absent/i);
  });
});
