import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  agentProfileRevisions,
  closePool,
  workforceAssignments,
  withTenant,
  workObjectiveLoops,
} from "@finnor/db";
import type { PlanNode } from "@finnor/planning";
import {
  claimWorkforceAssignment,
  createDefaultPluginRegistry,
  deterministicPlanActionId,
  finalizeWorkforceAssignment,
  generateWorkforceLearningProposals,
  isWorkforceAssignmentCurrent,
  promoteLearningProposal,
  reassignWorkforceAssignment,
  requestWorkforceAssignment,
} from "@finnor/orchestration";
import { migrate } from "../../packages/db/migrate";

const SOURCE_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@127.0.0.1:5432/finnor";

async function canConnect(): Promise<boolean> {
  const client = new pg.Client({ connectionString: SOURCE_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => undefined); }
}

function databaseUrl(database: string, user = "finnor", password = "finnor"): string {
  const url = new URL(SOURCE_URL);
  url.pathname = `/${database}`;
  url.username = user;
  url.password = password;
  return url.toString();
}

function hash(label: string): string {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

const available = await canConnect();

describe.skipIf(!available)("P7 assignment, crash, reassignment, and learning concurrency", () => {
  const database = `finnor_p7_runtime_${randomUUID().replaceAll("-", "_")}`;
  const url = databaseUrl(database);
  const tenantId = randomUUID();
  const foreignTenantId = randomUUID();
  const actorId = randomUUID();
  const roleId = randomUUID();
  const profileA = "00000000-0000-4000-8000-000000000010";
  const profileB = "00000000-0000-4000-8000-000000000020";
  const actionProfile = "00000000-0000-4000-8000-000000000030";
  const routeProfile = "00000000-0000-4000-8000-000000000040";
  const plugins = createDefaultPluginRegistry();
  const actor = { tenantId, userId: actorId, employeeId: actorId, role: "owner" as const };
  let admin: pg.Client;
  const revisions = new Map<string, string>();

  async function createProfile(profileId: string, capability: string, kind: "query" | "action", provider = "orchestration_runtime"): Promise<string> {
    const revisionId = randomUUID();
    await admin.query(
      `INSERT INTO finnor_os.agent_profiles(id,tenant_id,key,name) VALUES($1,$2,$3,$4)`,
      [profileId, tenantId, `worker-${profileId.slice(-4)}`, `Worker ${profileId.slice(-4)}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.agent_profile_revisions(
         id,tenant_id,agent_profile_id,revision,model_route,capability_grants,max_concurrent_assignments,autonomy_limits,planning_hints,status,config_hash,created_by
       ) VALUES($1,$2,$3,1,$4::jsonb,$5::jsonb,32,$6::jsonb,'{}'::jsonb,'active',$7,$8)`,
      [
        revisionId,
        tenantId,
        profileId,
        JSON.stringify({ provider, model: null, purpose: "objective_execution" }),
        JSON.stringify([{ capability, kind }]),
        JSON.stringify({ maxActions: 3, maxQueries: 8, maxReplans: 6, maxPlannerCalls: 8, maxWallClockMs: 86_400_000, maxKnownCostUsd: null, maxKnownTokens: null }),
        hash(`config:${profileId}:1`),
        actorId,
      ],
    );
    revisions.set(profileId, revisionId);
    return revisionId;
  }

  async function fixture(kind: "query" | "action" = "query") {
    const workId = randomUUID();
    const inputId = randomUUID();
    const loopId = randomUUID();
    const stepId = randomUUID();
    const planRevisionId = randomUUID();
    const nodeId = `node-${randomUUID()}`;
    const instructionId = randomUUID();
    const payload = { title: `P7 exact task ${workId}` };
    const node = (kind === "query"
      ? { id: nodeId, kind: "query", request: { intent: "work_list", recordId: workId } }
      : { id: nodeId, kind: "action", actionType: "create_task", payload, groundedPayload: payload }) as unknown as PlanNode;
    const goalHash = hash(`goal:${workId}`);
    const constraintHash = hash(`constraint:${workId}`);
    const snapshotHash = hash(`snapshot:${workId}`);
    const graphHash = hash(`graph:${workId}`);
    await admin.query(
      `INSERT INTO finnor_os.works(id,tenant_id,status,initial_channel,initial_instruction,execution_model,created_by,idempotency_key)
       VALUES($1,$2,'executing','console','P7 concurrency fixture','objective',$3,$4)`,
      [workId, tenantId, actorId, `p7-work:${workId}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.work_inputs(id,tenant_id,work_id,instruction_id,channel,instruction_text,created_by,idempotency_key)
       VALUES($1,$2,$3,$4,'console','P7 concurrency fixture',$5,$6)`,
      [inputId, tenantId, workId, instructionId, actorId, `p7-input:${workId}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.work_objective_loops(
         id,tenant_id,work_id,objective,state,revision,step_count,max_steps,max_actions,max_queries,max_planner_failures,max_consecutive_no_progress,deadline_at,created_by,initial_channel,success_condition
       ) VALUES($1,$2,$3,'Execute one exact P6 node','continue',1,1,12,4,11,3,3,now()+interval '1 day',$4,'console',$5::jsonb)`,
      [loopId, tenantId, workId, actorId, JSON.stringify({ version: 1, statement: "Exact node is durably observed", mode: "all", source: "explicit", criteria: [] })],
    );
    await admin.query(
      `INSERT INTO finnor_os.work_plan_revisions(
         id,tenant_id,work_id,work_input_id,objective_loop_id,revision,reason,status,goal_spec,constraint_set,planning_snapshot,candidate_summary,validation,plan_graph,score,goal_hash,constraint_hash,world_snapshot_hash,graph_hash,semantic_hash
       ) VALUES($1,$2,$3,$4,$5,1,'initial','active',$6::jsonb,$7::jsonb,$8::jsonb,'{}'::jsonb,'{"version":1}'::jsonb,$9::jsonb,'{}'::jsonb,$10,$11,$12,$13,$13)`,
      [
        planRevisionId, tenantId, workId, inputId, loopId,
        JSON.stringify({ version: 1, semanticHash: goalHash }),
        JSON.stringify({ version: 1, semanticHash: constraintHash }),
        JSON.stringify({ version: 1, semanticHash: snapshotHash, verticalKey: "none" }),
        JSON.stringify({ version: 1, semanticHash: graphHash, nodes: [node] }),
        goalHash, constraintHash, snapshotHash, graphHash,
      ],
    );
    await admin.query(
      `INSERT INTO finnor_os.work_objective_steps(id,tenant_id,objective_loop_id,work_id,step_number,idempotency_key,phase,plan_revision_id,plan_node_id)
       VALUES($1,$2,$3,$4,1,$5,'deciding',$6,$7)`,
      [stepId, tenantId, loopId, workId, `p7-step:${stepId}`, planRevisionId, nodeId],
    );
    const [objectiveLoop] = await withTenant(tenantId, (db) => db.select().from(workObjectiveLoops).where(eq(workObjectiveLoops.id, loopId)).limit(1));
    if (!objectiveLoop) throw new Error("fixture ObjectiveLoop missing");
    return { workId, inputId, loopId, stepId, planRevisionId, nodeId, node, payload, objectiveLoop };
  }

  async function requestAssignment(f: Awaited<ReturnType<typeof fixture>>) {
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
    await admin.query(
      `INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$3,'P7 runtime'),($2,$4,'P7 foreign')`,
      [tenantId, foreignTenantId, `p7-${tenantId}`, `p7-foreign-${foreignTenantId}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','P7 Owner')`,
      [actorId, tenantId, `p7-${actorId}@test.invalid`],
    );
    await admin.query(
      `INSERT INTO finnor_os.tenant_vertical_assignments(tenant_id,vertical_key,version,source_system,created_by)
       VALUES($1,'none',1,'certification:p7',$3),($2,'none',1,'certification:p7',$3)`,
      [tenantId, foreignTenantId, actorId],
    );
    await admin.query(
      `INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name,legacy_role) VALUES($1,$2,'p7-owner','P7 Owner','owner')`,
      [roleId, tenantId],
    );
    await admin.query(
      `INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,'{"kind":"tenant"}'::jsonb)`,
      [tenantId, actorId, roleId],
    );
    await createProfile(profileA, "query:work_list", "query");
    await createProfile(profileB, "query:work_list", "query");
    await createProfile(actionProfile, "create_task", "action");
  }, 180_000);

  afterAll(async () => {
    await closePool();
    await admin?.end().catch(() => undefined);
    const source = new pg.Client({ connectionString: SOURCE_URL });
    await source.connect();
    try { await source.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await source.end(); }
  }, 30_000);

  it("serializes two assignment requests, two lease owners, and a duplicate same-owner job", async () => {
    const f = await fixture();
    const requested = await Promise.all([requestAssignment(f), requestAssignment(f)]);
    expect(requested.every((row) => row.status === "assigned")).toBe(true);
    const assigned = requested.filter((row): row is Extract<typeof row, { status: "assigned" }> => row.status === "assigned");
    expect(new Set(assigned.map((row) => row.assignment.id)).size).toBe(1);
    expect(assigned.map((row) => row.created).sort()).toEqual([false, true]);
    const assignmentId = assigned[0]!.assignment.id;
    const [left, right] = await Promise.all([
      claimWorkforceAssignment({ tenantId, assignmentId, leaseOwner: "worker-left" }),
      claimWorkforceAssignment({ tenantId, assignmentId, leaseOwner: "worker-right" }),
    ]);
    expect([left.status, right.status].sort()).toEqual(["busy", "claimed"]);
    const winner = left.status === "claimed" ? left : right.status === "claimed" ? right : null;
    expect(winner).not.toBeNull();
    const replay = await claimWorkforceAssignment({ tenantId, assignmentId, leaseOwner: winner!.leaseOwner });
    expect(replay.status).toBe("claimed");
    expect((await admin.query(`SELECT count(*)::int count FROM finnor_os.jobs WHERE idempotency_key=$1`, [`workforce:${assignmentId}:attempt:1`])).rows[0].count).toBe(1);
  });

  it("recovers an active expired lease without overwriting assignment history", async () => {
    const f = await fixture();
    const first = await requestAssignment(f);
    expect(first.status).toBe("assigned");
    if (first.status !== "assigned") return;
    const claimed = await claimWorkforceAssignment({ tenantId, assignmentId: first.assignment.id, leaseOwner: "crashed-before-action" });
    expect(claimed.status).toBe("claimed");
    await admin.query(`UPDATE finnor_os.workforce_assignments SET lease_until=now()-interval '1 second' WHERE id=$1`, [first.assignment.id]);
    expect((await claimWorkforceAssignment({ tenantId, assignmentId: first.assignment.id, leaseOwner: "recovery-worker" })).status).toBe("expired");
    const replacement = await requestAssignment(f);
    expect(replacement.status).toBe("assigned");
    if (replacement.status !== "assigned") return;
    expect(replacement.assignment.id).not.toBe(first.assignment.id);
    expect(replacement.assignment.previousAssignmentId).toBe(first.assignment.id);
    expect((await admin.query(`SELECT state,reassignment_reason FROM finnor_os.workforce_assignments WHERE id=$1`, [first.assignment.id])).rows[0]).toEqual({ state: "reassigned", reassignment_reason: "LEASE_EXPIRED" });
  });

  it("fences an old worker when explicit operator reassignment races it", async () => {
    const f = await fixture();
    const first = await requestAssignment(f);
    expect(first.status).toBe("assigned");
    if (first.status !== "assigned") return;
    const claimed = await claimWorkforceAssignment({ tenantId, assignmentId: first.assignment.id, leaseOwner: "old-worker" });
    expect(claimed.status).toBe("claimed");
    const [a, b] = await Promise.all([
      reassignWorkforceAssignment({ tenantId, assignmentId: first.assignment.id, actor, note: "Operator-directed recovery" }),
      reassignWorkforceAssignment({ tenantId, assignmentId: first.assignment.id, actor, note: "Operator-directed recovery" }),
    ]);
    expect(a.id).toBe(b.id);
    expect(a).toMatchObject({ state: "reassigned", reassignmentReason: "OPERATOR_REQUESTED" });
    expect(await isWorkforceAssignmentCurrent({ tenantId, assignmentId: first.assignment.id, leaseOwner: "old-worker", planRevisionId: f.planRevisionId, planNodeId: f.nodeId, agentRevisionId: first.assignment.agentRevisionId })).toBe(false);
    const replacement = await requestAssignment(f);
    expect(replacement.status).toBe("assigned");
    if (replacement.status !== "assigned") return;
    expect(replacement.assignment.previousAssignmentId).toBe(first.assignment.id);
    await finalizeWorkforceAssignment({ tenantId, assignmentId: first.assignment.id, leaseOwner: "old-worker", thrownFailure: new Error("late old worker") });
    expect((await admin.query(`SELECT state FROM finnor_os.workforce_assignments WHERE id=$1`, [first.assignment.id])).rows[0].state).toBe("reassigned");
  });

  it("hard-excludes a worker after two exact execution failures and preserves both failed owners", async () => {
    const f = await fixture();
    const failedIds: string[] = [];
    await admin.query(`UPDATE finnor_os.agent_profiles SET status='disabled' WHERE id=$1`, [profileB]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const requested = await requestAssignment(f);
      expect(requested.status).toBe("assigned");
      if (requested.status !== "assigned") return;
      expect(requested.assignment.agentProfileId).toBe(profileA);
      failedIds.push(requested.assignment.id);
      const claimed = await claimWorkforceAssignment({ tenantId, assignmentId: requested.assignment.id, leaseOwner: `failing-worker-${attempt}` });
      expect(claimed.status).toBe("claimed");
      await finalizeWorkforceAssignment({ tenantId, assignmentId: requested.assignment.id, leaseOwner: `failing-worker-${attempt}`, thrownFailure: new Error(`failure-${attempt}`) });
    }
    await admin.query(`UPDATE finnor_os.agent_profiles SET status='enabled' WHERE id=$1`, [profileB]);
    const replacement = await requestAssignment(f);
    expect(replacement.status).toBe("assigned");
    if (replacement.status !== "assigned") return;
    expect(replacement.assignment.agentProfileId).toBe(profileB);
    expect(replacement.assignment.previousAssignmentId).toBe(failedIds[1]);
    const history = await withTenant(tenantId, (db) => db.select().from(workforceAssignments).where(inArray(workforceAssignments.id, failedIds)));
    expect(history.map((row) => row.state).sort()).toEqual(["failed", "failed"]);
  });

  it("reassigns an existing owner when its provider route disappears or its autonomy budget is exhausted", async () => {
    const priorGroqKey = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = "p7-test-route-only";
    await admin.query(`UPDATE finnor_os.agent_profiles SET status='disabled' WHERE id IN ($1,$2)`, [profileA, profileB]);
    const routeRevision = await createProfile(routeProfile, "query:work_list", "query", "groq");
    const routeFixture = await fixture();
    const routed = await requestAssignment(routeFixture);
    expect(routed.status).toBe("assigned");
    if (routed.status !== "assigned") return;
    expect(routed.assignment.agentRevisionId).toBe(routeRevision);
    delete process.env.GROQ_API_KEY;
    expect((await claimWorkforceAssignment({ tenantId, assignmentId: routed.assignment.id, leaseOwner: "route-check" })).status).toBe("reassigned");
    const unavailable = await requestAssignment(routeFixture);
    expect(unavailable.status).toBe("unassigned");
    expect((await admin.query(`SELECT state,reassignment_reason FROM finnor_os.workforce_assignments WHERE id=$1`, [routed.assignment.id])).rows[0])
      .toEqual({ state: "reassigned", reassignment_reason: "MODEL_ROUTE_UNAVAILABLE" });
    if (priorGroqKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = priorGroqKey;
    await admin.query(`UPDATE finnor_os.agent_profiles SET status='enabled' WHERE id IN ($1,$2)`, [profileA, profileB]);

    const budgetFixture = await fixture();
    const budgeted = await requestAssignment(budgetFixture);
    expect(budgeted.status).toBe("assigned");
    if (budgeted.status !== "assigned") return;
    await admin.query(`UPDATE finnor_os.work_objective_loops SET query_count=8 WHERE id=$1`, [budgetFixture.loopId]);
    expect((await claimWorkforceAssignment({ tenantId, assignmentId: budgeted.assignment.id, leaseOwner: "budget-check" })).status).toBe("reassigned");
    const exhausted = await requestAssignment({ ...budgetFixture, objectiveLoop: { ...budgetFixture.objectiveLoop, queryCount: 8 } });
    expect(exhausted.status).toBe("unassigned");
    expect((await admin.query(`SELECT state,reassignment_reason FROM finnor_os.workforce_assignments WHERE id=$1`, [budgeted.assignment.id])).rows[0])
      .toEqual({ state: "reassigned", reassignment_reason: "AUTONOMY_BUDGET_EXHAUSTED" });
  });

  it("recovers a crash after DomainAction creation without creating a second action", async () => {
    const f = await fixture("action");
    const requested = await requestAssignment(f);
    expect(requested.status).toBe("assigned");
    if (requested.status !== "assigned") return;
    expect((await claimWorkforceAssignment({ tenantId, assignmentId: requested.assignment.id, leaseOwner: "crashed-after-action" })).status).toBe("claimed");
    const actionId = deterministicPlanActionId(f.planRevisionId, f.nodeId);
    await admin.query(
      `INSERT INTO finnor_os.domain_actions(id,tenant_id,action_type,payload,status,plan_revision_id,plan_node_id,work_id,objective_step_id,initiated_by)
       VALUES($1,$2,'create_task',$3::jsonb,'draft',$4,$5,$6,$7,$8)`,
      [actionId, tenantId, JSON.stringify(f.payload), f.planRevisionId, f.nodeId, f.workId, f.stepId, actorId],
    );
    await admin.query(`UPDATE finnor_os.workforce_assignments SET domain_action_id=$2,lease_until=now()-interval '1 second' WHERE id=$1`, [requested.assignment.id, actionId]);
    expect((await claimWorkforceAssignment({ tenantId, assignmentId: requested.assignment.id, leaseOwner: "recover-after-action" })).status).toBe("expired");
    const replacement = await requestAssignment(f);
    expect(replacement.status).toBe("assigned");
    await expect(admin.query(
      `INSERT INTO finnor_os.domain_actions(id,tenant_id,action_type,payload,status,plan_revision_id,plan_node_id,work_id,objective_step_id,initiated_by)
       VALUES($1,$2,'create_task',$3::jsonb,'draft',$4,$5,$6,$7,$8)`,
      [randomUUID(), tenantId, JSON.stringify(f.payload), f.planRevisionId, f.nodeId, f.workId, f.stepId, actorId],
    )).rejects.toThrow(/unique|duplicate/i);
    expect((await admin.query(`SELECT count(*)::int count FROM finnor_os.domain_actions WHERE plan_revision_id=$1 AND plan_node_id=$2`, [f.planRevisionId, f.nodeId])).rows[0].count).toBe(1);
  });

  it("cannot duplicate a DomainAction or verified BusinessEffect after a post-effect crash", async () => {
    const f = await fixture("action");
    const requested = await requestAssignment(f);
    expect(requested.status).toBe("assigned");
    if (requested.status !== "assigned") return;
    const claimed = await claimWorkforceAssignment({ tenantId, assignmentId: requested.assignment.id, leaseOwner: "crashed-after-effect" });
    expect(claimed.status).toBe("claimed");
    const actionId = deterministicPlanActionId(f.planRevisionId, f.nodeId);
    const effectId = randomUUID();
    await admin.query(
      `INSERT INTO finnor_os.domain_actions(id,tenant_id,action_type,payload,status,plan_revision_id,plan_node_id,work_id,objective_step_id,initiated_by)
       VALUES($1,$2,'create_task',$3::jsonb,'completed',$4,$5,$6,$7,$8)`,
      [actionId, tenantId, JSON.stringify(f.payload), f.planRevisionId, f.nodeId, f.workId, f.stepId, actorId],
    );
    const effectHash = createHash("sha256").update(`effect:${actionId}`).digest("hex");
    await admin.query(
      `INSERT INTO finnor_os.business_effects(id,tenant_id,domain_action_id,semantic_hash,scope_hash,operation_class,effect,status,observed_result,verification,observed_at)
       VALUES($1,$2,$3,$4,$4,'internal_write',$5::jsonb,'verified','{"created":true}'::jsonb,'{"verified":true}'::jsonb,now())`,
      [effectId, tenantId, actionId, effectHash, JSON.stringify({ schemaVersion: 1, semanticHash: effectHash, source: { domainActionId: actionId, actionType: "create_task", workId: f.workId, objectiveStepId: f.stepId }, targets: [], bindings: [], authority: { policyId: null }, delta: f.payload })],
    );
    await admin.query(`UPDATE finnor_os.domain_actions SET business_effect_id=$2 WHERE id=$1`, [actionId, effectId]);
    await admin.query(`UPDATE finnor_os.workforce_assignments SET domain_action_id=$2,lease_until=now()-interval '1 second' WHERE id=$1`, [requested.assignment.id, actionId]);
    expect((await claimWorkforceAssignment({ tenantId, assignmentId: requested.assignment.id, leaseOwner: "post-effect-recovery" })).status).toBe("expired");
    await expect(admin.query(
      `INSERT INTO finnor_os.domain_actions(id,tenant_id,action_type,payload,status,plan_revision_id,plan_node_id,work_id,objective_step_id,initiated_by)
       VALUES($1,$2,'create_task',$3::jsonb,'completed',$4,$5,$6,$7,$8)`,
      [randomUUID(), tenantId, JSON.stringify(f.payload), f.planRevisionId, f.nodeId, f.workId, f.stepId, actorId],
    )).rejects.toThrow(/unique|duplicate/i);
    await expect(admin.query(
      `INSERT INTO finnor_os.business_effects(tenant_id,domain_action_id,semantic_hash,scope_hash,operation_class,effect,status)
       VALUES($1,$2,$3,$3,'internal_write',$4::jsonb,'verified')`,
      [tenantId, actionId, effectHash, JSON.stringify({ source: { domainActionId: actionId }, targets: [], bindings: [], authority: {}, delta: {} })],
    )).rejects.toThrow(/unique|duplicate/i);
    const counts = await admin.query(`SELECT (SELECT count(*)::int FROM finnor_os.domain_actions WHERE plan_revision_id=$1 AND plan_node_id=$2) actions,(SELECT count(*)::int FROM finnor_os.business_effects WHERE domain_action_id=$3) effects`, [f.planRevisionId, f.nodeId, actionId]);
    expect(counts.rows[0]).toEqual({ actions: 1, effects: 1 });
  });

  it("converges a replan/assignment race with no dispatchable stale owner", async () => {
    const f = await fixture();
    const racer = new pg.Client({ connectionString: url });
    await racer.connect();
    try {
      const [assignmentResult] = await Promise.allSettled([
        requestAssignment(f),
        racer.query(`UPDATE finnor_os.work_plan_revisions SET status='superseded' WHERE id=$1`, [f.planRevisionId]),
      ]);
      if (assignmentResult.status === "fulfilled" && assignmentResult.value.status === "assigned") {
        expect((await claimWorkforceAssignment({ tenantId, assignmentId: assignmentResult.value.assignment.id, leaseOwner: "stale-dispatch" })).status).toBe("terminal");
      }
      const active = await withTenant(tenantId, (db) => db.select().from(workforceAssignments).where(and(
        eq(workforceAssignments.planRevisionId, f.planRevisionId), inArray(workforceAssignments.state, ["queued", "claimed", "running", "waiting"]),
      )));
      expect(active).toEqual([]);
    } finally { await racer.end(); }
  });

  it("keeps old revision attribution while learning digest and promotion races converge", async () => {
    const oldRevisionId = revisions.get(profileA)!;
    for (let index = 0; index < 5; index += 1) {
      const f = await fixture();
      const assignmentId = randomUUID();
      const occurredAt = new Date(Date.now() - (5 - index) * 1_000);
      await admin.query(`UPDATE finnor_os.work_objective_steps SET phase='finished',iteration_outcome='failed',decision_reason='durable business outcome failure',completed_at=$2 WHERE id=$1`, [f.stepId, occurredAt]);
      await admin.query(
        `INSERT INTO finnor_os.workforce_assignments(
           id,tenant_id,work_id,plan_revision_id,plan_node_id,objective_loop_id,objective_step_id,agent_profile_id,agent_revision_id,capability,node_kind,state,budget_snapshot,assignment_reason,assignment_score,completed_at,failure
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'query:work_list','query','failed','{}'::jsonb,'P7 learning fixture','{}'::jsonb,$10,'{"code":"BUSINESS_OUTCOME_FAILURE"}'::jsonb)`,
        [assignmentId, tenantId, f.workId, f.planRevisionId, f.nodeId, f.loopId, f.stepId, profileA, oldRevisionId, occurredAt],
      );
      await admin.query(
        `INSERT INTO finnor_os.learning_observations(
           tenant_id,agent_profile_id,agent_revision_id,workforce_assignment_id,capability,node_kind,context_class,work_id,plan_revision_id,plan_node_id,outcome_class,verified,source_refs,context_features,measured_metrics,occurred_at,observation_hash
         ) VALUES($1,$2,$3,$4,'query:work_list','query','none:query',$5,$6,$7,'business_outcome_failure',true,$8::jsonb,'{"verticalKey":"none"}'::jsonb,'{"latencyMs":100}'::jsonb,$9,$10)`,
        [tenantId, profileA, oldRevisionId, assignmentId, f.workId, f.planRevisionId, f.nodeId, JSON.stringify([{ type: "objective_step", id: f.stepId }, { type: "plan_node", id: f.nodeId }]), occurredAt, hash(`observation:${assignmentId}`)],
      );
    }
    const digests = await Promise.all([generateWorkforceLearningProposals(tenantId), generateWorkforceLearningProposals(tenantId)]);
    expect(digests.flatMap((row) => row.createdProposalIds)).toHaveLength(1);
    const proposals = await admin.query(`SELECT id FROM finnor_os.learning_proposals WHERE tenant_id=$1 AND target_agent_revision_id=$2`, [tenantId, oldRevisionId]);
    expect(proposals.rowCount).toBe(1);
    const proposalId = proposals.rows[0].id as string;
    const promoted = await Promise.all([
      promoteLearningProposal({ tenantId, proposalId, actor }),
      promoteLearningProposal({ tenantId, proposalId, actor }),
    ]);
    expect(new Set(promoted.map((row) => row.learningRevision.id)).size).toBe(1);
    expect(new Set(promoted.map((row) => row.agentRevision.id)).size).toBe(1);
    expect(promoted[0]!.agentRevision.revision).toBe(2);
    expect((await admin.query(`SELECT status FROM finnor_os.agent_profile_revisions WHERE id=$1`, [oldRevisionId])).rows[0].status).toBe("superseded");
    expect((await admin.query(`SELECT count(*)::int count FROM finnor_os.learning_observations WHERE agent_revision_id=$1`, [oldRevisionId])).rows[0].count).toBe(5);
  });

  it("fences a running assignment when its pinned agent revision changes and preserves both revisions", async () => {
    await admin.query(`UPDATE finnor_os.agent_profiles SET status='disabled' WHERE id=$1`, [profileA]);
    const f = await fixture();
    const first = await requestAssignment(f);
    expect(first.status).toBe("assigned");
    if (first.status !== "assigned") return;
    expect(first.assignment.agentProfileId).toBe(profileB);
    expect((await claimWorkforceAssignment({ tenantId, assignmentId: first.assignment.id, leaseOwner: "old-revision-worker" })).status).toBe("claimed");
    const oldRevisionId = first.assignment.agentRevisionId;
    await admin.query(`UPDATE finnor_os.agent_profile_revisions SET status='superseded' WHERE id=$1`, [oldRevisionId]);
    expect((await admin.query(`SELECT state,reassignment_reason FROM finnor_os.workforce_assignments WHERE id=$1`, [first.assignment.id])).rows[0])
      .toEqual({ state: "reassigned", reassignment_reason: "AGENT_REVISION_SUPERSEDED" });
    const newRevisionId = randomUUID();
    await admin.query(
      `INSERT INTO finnor_os.agent_profile_revisions(
         id,tenant_id,agent_profile_id,revision,model_route,capability_grants,max_concurrent_assignments,autonomy_limits,planning_hints,status,config_hash,created_by
       ) SELECT $1,tenant_id,agent_profile_id,2,model_route,capability_grants,max_concurrent_assignments,autonomy_limits,planning_hints,'active',$2,created_by
         FROM finnor_os.agent_profile_revisions WHERE id=$3`,
      [newRevisionId, hash(`config:${profileB}:2`), oldRevisionId],
    );
    const replacement = await requestAssignment(f);
    expect(replacement.status).toBe("assigned");
    if (replacement.status !== "assigned") return;
    expect(replacement.assignment.agentRevisionId).toBe(newRevisionId);
    expect(replacement.assignment.previousAssignmentId).toBe(first.assignment.id);
    const revisionRows = await withTenant(tenantId, (db) => db.select().from(agentProfileRevisions).where(eq(agentProfileRevisions.agentProfileId, profileB)));
    expect(revisionRows.map((row) => [row.revision, row.status]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([[1, "superseded"], [2, "active"]]);
    await admin.query(`UPDATE finnor_os.agent_profiles SET status='enabled' WHERE id=$1`, [profileA]);
  });

  it("rejects forged success, AI/human identity overlap, hard-learning mutation, and cross-tenant reads", async () => {
    await expect(admin.query(`INSERT INTO finnor_os.agent_profiles(id,tenant_id,key,name) VALUES($1,$2,'human-overlap','Human overlap')`, [actorId, tenantId])).rejects.toThrow(/human user identity/i);
    await expect(admin.query(`INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','AI overlap')`, [profileB, tenantId, `overlap-${randomUUID()}@test.invalid`])).rejects.toThrow(/AgentProfile identity/i);
    const failed = await admin.query(`SELECT * FROM finnor_os.workforce_assignments WHERE tenant_id=$1 AND state='failed' ORDER BY created_at LIMIT 1`, [tenantId]);
    expect(failed.rowCount).toBe(1);
    const row = failed.rows[0];
    await expect(admin.query(
      `INSERT INTO finnor_os.learning_observations(
         tenant_id,agent_profile_id,agent_revision_id,workforce_assignment_id,capability,node_kind,context_class,work_id,plan_revision_id,plan_node_id,outcome_class,verified,source_refs,context_features,measured_metrics,occurred_at,observation_hash
       ) VALUES($1,$2,$3,$4,$5,$6,'none:query',$7,$8,$9,'verified_completion',true,$10::jsonb,'{}'::jsonb,'{}'::jsonb,now(),$11)`,
      [tenantId, row.agent_profile_id, row.agent_revision_id, row.id, row.capability, row.node_kind, row.work_id, row.plan_revision_id, row.plan_node_id, JSON.stringify([{ type: "objective_step", id: row.objective_step_id }, { type: "plan_node", id: row.plan_node_id }]), hash(`forged:${row.id}`)],
    )).rejects.toThrow(/durable P6\/Core completion evidence/i);
    const revision = await admin.query(`SELECT id FROM finnor_os.learning_revisions WHERE tenant_id=$1 LIMIT 1`, [tenantId]);
    expect(revision.rowCount).toBe(1);
    await expect(admin.query(`UPDATE finnor_os.learning_revisions SET guidance='{"authorityOverride":true}'::jsonb WHERE id=$1`, [revision.rows[0].id])).rejects.toThrow(/immutable/i);

    await admin.query(`INSERT INTO finnor_os.agent_profiles(tenant_id,key,name) VALUES($1,'foreign-worker','Foreign worker')`, [foreignTenantId]);
    const restricted = new pg.Client({ connectionString: databaseUrl(database, "finnor_app", "finnor_app") });
    await restricted.connect();
    try {
      await restricted.query("BEGIN");
      await restricted.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const visible = await restricted.query(`SELECT count(*)::int count FROM finnor_os.agent_profiles WHERE tenant_id=$1`, [foreignTenantId]);
      expect(visible.rows[0].count).toBe(0);
      await restricted.query("ROLLBACK");
    } finally { await restricted.end(); }
  });
});
