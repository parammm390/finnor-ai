import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  beginWorkPlannerAttempt,
  closePool,
  domainActions,
  persistSelectedWorkPlan,
  receiveWork,
  workPlanRevisions,
  workPlannerAttempts,
  withTenant,
} from "@finnor/db";
import {
  FinnorOrchestrator,
  deterministicPlanActionId,
  selectAndMaterializePlan,
  selectPlanRevision,
  type PlanningResult,
} from "@finnor/orchestration";
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
} from "@finnor/planning";
import { migrate } from "../../packages/db/migrate";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@127.0.0.1:5432/finnor";

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

function nodeFacts(node: CandidatePlanNode): NodeCompilationFacts {
  const action = node.kind === "action";
  return {
    registered: true,
    schemaValid: true,
    schemaErrors: [],
    grounded: true,
    crossTenant: false,
    stale: false,
    authority: "allowed",
    health: "available",
    risk: action ? "high" : "low",
    irreversible: action,
    wrongVerticalRoot: false,
    policyAllowed: true,
    preconditionsSatisfied: true,
    deadlineFeasible: true,
    uncertainPrerequisiteNodeKeys: [],
    supportedRecoveryModes: ["retry", "replan", "recover", "escalate"],
    ...(action ? { groundedPayload: node.kind === "action" ? node.payload : {}, predictedReceipt: { kind: "certification_prediction" } } : {}),
  };
}

function planningFixture(params: {
  tenantId: string;
  workId: string;
  workInputId: string;
  plannerAttemptId: string;
  variant: string;
  kind?: "query" | "action";
}): PlanningResult {
  const goal = buildGoalSpec({
    objective: "Verify the exact accepted Work state.",
    workId: params.workId,
    workInputId: params.workInputId,
    successCondition: {
      version: 1,
      statement: "The accepted Work is visible in canonical Work truth.",
      mode: "all",
      source: "explicit",
      criteria: [{ kind: "canonical_query", request: { intent: "work_list", recordId: params.workId }, assertion: { path: ["works"], operator: "exists" } }],
    },
  });
  const criterionId = goal.criteria[0]!.id;
  const action = params.kind === "action";
  const candidate: CandidatePlan = {
    version: 1,
    candidateKey: `candidate-${params.variant}`,
    nodes: action
      ? [
          {
            key: `send-${params.variant}`,
            kind: "action",
            actionType: "send_message",
            payload: { recipient: "ops@example.test", body: `Status ${params.variant}` },
            supports: [criterionId],
          },
          { key: `check-${params.variant}`, kind: "check", criterionId, dependsOn: [`send-${params.variant}`] },
        ]
      : [
          {
            key: `read-${params.variant}`,
            kind: "query",
            request: { intent: "work_list", recordId: params.workId, variant: params.variant },
            supports: [criterionId],
          },
          { key: `check-${params.variant}`, kind: "check", criterionId, dependsOn: [`read-${params.variant}`] },
        ],
  };
  const constraints = buildConstraintSet({
    tenantId: params.tenantId,
    verticalKey: "none",
    allowedCapabilities: [action ? "send_message" : "query:work_list", "check:objective_success"],
    humanOnlyCapabilities: [],
    prohibitedCapabilities: [],
    authorityRevision: null,
    budgets: DEFAULT_PLAN_BUDGETS,
    constraints: [],
    deadlineAt: null,
    softPreferences: [],
  });
  const snapshot = buildPlanningWorldSnapshot({
    workId: params.workId,
    workInputId: params.workInputId,
    plannerAttemptId: params.plannerAttemptId,
    tenantId: params.tenantId,
    verticalKey: "none",
    capturedAt: "2030-01-01T00:00:00.000Z",
    decisionContextHash: sha256({ workId: params.workId, workInputId: params.workInputId }),
    canonicalStateHash: sha256({ workId: params.workId, status: "received" }),
    work: { id: params.workId, status: "received", inputId: params.workInputId },
    authority: { employeeId: null, revision: null, roles: ["system"] },
    capabilities: [
      {
        capability: action ? "send_message" : "query:work_list",
        kind: action ? "action" : "query",
        modelProposable: true,
        available: true,
        health: "available",
        risk: action ? "high" : "low",
        irreversible: action,
        requiredReferences: [],
        effectClass: action ? "external_side_effect" : null,
        observationStrategy: action ? "business_effect" : "operational_query",
        reversibility: action ? "irreversible" : "read_only",
        supportedRecoveryModes: ["retry", "replan", "recover", "escalate"],
        externalSideEffect: action,
        authorityRequirement: action ? "policy" : "query",
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
  const facts: CandidateCompilationFacts = {
    candidateKey: candidate.candidateKey,
    nodes: Object.fromEntries(candidate.nodes.map((node) => [node.key, nodeFacts(node)])),
  };
  const compilation = compileAndSelectPlans({ candidates: [candidate], facts: [facts], goal, constraints, snapshot });
  if (!compilation.selected?.graph) throw new Error(`Invalid concurrency fixture: ${JSON.stringify(compilation.candidates[0]?.violations)}`);
  return { version: 1, goal, constraints, snapshot, candidates: [candidate], compilation };
}

function persistenceParams(planning: PlanningResult, plannerAttemptId: string, parentRevisionId: string | null = null) {
  const selected = planning.compilation.selected!;
  return {
    tenantId: planning.snapshot.tenantId,
    workId: planning.snapshot.workId,
    workInputId: planning.snapshot.workInputId,
    plannerAttemptId,
    parentRevisionId,
    reason: parentRevisionId ? "observation" as const : "initial" as const,
    goalSpec: planning.goal,
    constraintSet: planning.constraints,
    planningSnapshot: planning.snapshot,
    candidatePlans: planning.candidates,
    compilationResult: planning.compilation,
    planGraph: selected.graph!,
    score: selected.score,
    semanticHash: selected.graph!.semanticHash,
  };
}

describe.skipIf(!available)("Phase 6 PlanRevision concurrency and crash safety", () => {
  const tenantId = randomUUID();
  const foreignTenantId = randomUUID();
  const configuredBy = randomUUID();
  let admin: pg.Client;

  async function createWork(label: string) {
    return receiveWork({
      tenantId,
      instruction: `P6 concurrency certification ${label}`,
      channel: "console",
      userId: "system:p6-concurrency",
      idempotencyKey: `p6-concurrency:${label}:${randomUUID()}`,
    });
  }

  async function attempt(work: Awaited<ReturnType<typeof createWork>>, key = randomUUID()) {
    return beginWorkPlannerAttempt({ tenantId, workId: work.workId, workInputId: work.workInputId, attemptKey: `p6:${key}` });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.SECRETS_PROVIDER = "env";
    await migrate(DB_URL);
    admin = new pg.Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("SET app.test_vertical_mode = 'explicit'");
    await admin.query(
      "INSERT INTO finnor_os.tenants(id,client_key,name) VALUES ($1,$3,'P6 concurrency'),($2,$4,'P6 foreign concurrency')",
      [tenantId, foreignTenantId, `p6-concurrency-${tenantId}`, `p6-concurrency-${foreignTenantId}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.tenant_vertical_assignments(tenant_id,vertical_key,version,source_system,created_by)
       VALUES ($1,'none',1,'certification:p6-concurrency',$3),($2,'none',1,'certification:p6-concurrency',$3)`,
      [tenantId, foreignTenantId, configuredBy],
    );
  });

  afterAll(async () => {
    await closePool();
    await admin?.end();
  });

  it("converges two planner retries on one durable attempt claim", async () => {
    const work = await createWork("attempt-retry");
    const key = randomUUID();
    const results = await Promise.all([attempt(work, key), attempt(work, key)]);
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.map((result) => result.claimed).sort()).toEqual([false, true]);
    const rows = await withTenant(tenantId, (db) => db.select().from(workPlannerAttempts).where(eq(workPlannerAttempts.workId, work.workId)));
    expect(rows).toHaveLength(1);
  });

  it("converges identical selection retries but admits only one competing initial winner", async () => {
    const replayWork = await createWork("selection-replay");
    const [attemptA, attemptB] = await Promise.all([attempt(replayWork), attempt(replayWork)]);
    const planningA = planningFixture({ tenantId, workId: replayWork.workId, workInputId: replayWork.workInputId, plannerAttemptId: attemptA.id, variant: "same" });
    const planningB = planningFixture({ tenantId, workId: replayWork.workId, workInputId: replayWork.workInputId, plannerAttemptId: attemptB.id, variant: "same" });
    expect(planningA.snapshot.semanticHash).toBe(planningB.snapshot.semanticHash);
    const replayed = await Promise.all([
      persistSelectedWorkPlan(persistenceParams(planningA, attemptA.id)),
      persistSelectedWorkPlan(persistenceParams(planningB, attemptB.id)),
    ]);
    expect(new Set(replayed.map((revision) => revision.id)).size).toBe(1);
    expect(await withTenant(tenantId, (db) => db.select().from(workPlanRevisions).where(eq(workPlanRevisions.workId, replayWork.workId)))).toHaveLength(1);

    const raceWork = await createWork("selection-race");
    const [raceA, raceB] = await Promise.all([attempt(raceWork), attempt(raceWork)]);
    const left = planningFixture({ tenantId, workId: raceWork.workId, workInputId: raceWork.workInputId, plannerAttemptId: raceA.id, variant: "left" });
    const right = planningFixture({ tenantId, workId: raceWork.workId, workInputId: raceWork.workInputId, plannerAttemptId: raceB.id, variant: "right" });
    const raced = await Promise.allSettled([
      persistSelectedWorkPlan(persistenceParams(left, raceA.id)),
      persistSelectedWorkPlan(persistenceParams(right, raceB.id)),
    ]);
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter((result) => result.status === "rejected")).toHaveLength(1);
    const raceRows = await withTenant(tenantId, (db) => db.select().from(workPlanRevisions).where(eq(workPlanRevisions.workId, raceWork.workId)));
    expect(raceRows).toHaveLength(1);
    expect(raceRows[0]).toMatchObject({ revision: 1, status: "active", parentRevisionId: null });
  });

  it("serializes competing child replans and preserves the immutable parent", async () => {
    const work = await createWork("replan-race");
    const initialAttempt = await attempt(work);
    const initialPlanning = planningFixture({ tenantId, workId: work.workId, workInputId: work.workInputId, plannerAttemptId: initialAttempt.id, variant: "initial" });
    const parent = await persistSelectedWorkPlan(persistenceParams(initialPlanning, initialAttempt.id));
    const [attemptA, attemptB] = await Promise.all([attempt(work), attempt(work)]);
    const left = planningFixture({ tenantId, workId: work.workId, workInputId: work.workInputId, plannerAttemptId: attemptA.id, variant: "replan-left" });
    const right = planningFixture({ tenantId, workId: work.workId, workInputId: work.workInputId, plannerAttemptId: attemptB.id, variant: "replan-right" });
    const results = await Promise.allSettled([
      persistSelectedWorkPlan(persistenceParams(left, attemptA.id, parent.id)),
      persistSelectedWorkPlan(persistenceParams(right, attemptB.id, parent.id)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rows = await withTenant(tenantId, (db) => db.select().from(workPlanRevisions).where(eq(workPlanRevisions.workId, work.workId)).orderBy(asc(workPlanRevisions.revision)));
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => ({ revision: row.revision, status: row.status, parent: row.parentRevisionId }))).toEqual([
      { revision: 1, status: "superseded", parent: null },
      { revision: 2, status: "active", parent: parent.id },
    ]);
    await expect(admin.query("UPDATE finnor_os.work_plan_revisions SET score=$1::jsonb WHERE id=$2", [JSON.stringify({ forged: true }), parent.id])).rejects.toThrow(/immutable/i);
    await expect(admin.query("DELETE FROM finnor_os.work_plan_revisions WHERE id=$1", [parent.id])).rejects.toThrow(/immutable/i);
  });

  it("recovers a crash between revision selection and action materialization without duplication", async () => {
    const work = await createWork("materialization-crash");
    const plannerAttempt = await attempt(work);
    const planning = planningFixture({ tenantId, workId: work.workId, workInputId: work.workInputId, plannerAttemptId: plannerAttempt.id, variant: "crash", kind: "action" });
    const selected = await selectPlanRevision({
      planning,
      tenantContext: { tenantId, userId: "system:p6-concurrency", role: "owner" },
      workId: work.workId,
      workInputId: work.workInputId,
      plannerAttemptId: plannerAttempt.id,
    });
    const recovered = await Promise.all([
      selectAndMaterializePlan({ planning, tenantContext: { tenantId, userId: "system:p6-concurrency", role: "owner" }, workId: work.workId, workInputId: work.workInputId, plannerAttemptId: plannerAttempt.id }),
      selectAndMaterializePlan({ planning, tenantContext: { tenantId, userId: "system:p6-concurrency", role: "owner" }, workId: work.workId, workInputId: work.workInputId, plannerAttemptId: plannerAttempt.id }),
    ]);
    expect(new Set(recovered.map((result) => result.planRevisionId))).toEqual(new Set([selected.planRevisionId]));
    expect(new Set(recovered.flatMap((result) => result.actions.map((action) => action.id))).size).toBe(1);
    const rows = await withTenant(tenantId, (db) => db.select().from(domainActions).where(eq(domainActions.planRevisionId, selected.planRevisionId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(deterministicPlanActionId(selected.planRevisionId, rows[0]!.planNodeId!));
  });

  it("refuses old-revision execution after supersession and rejects cross-tenant revision scope", async () => {
    const work = await createWork("stale-execution");
    const actionAttempt = await attempt(work);
    const actionPlanning = planningFixture({ tenantId, workId: work.workId, workInputId: work.workInputId, plannerAttemptId: actionAttempt.id, variant: "old-action", kind: "action" });
    const materialized = await selectAndMaterializePlan({
      planning: actionPlanning,
      tenantContext: { tenantId, userId: "system:p6-concurrency", role: "owner" },
      workId: work.workId,
      workInputId: work.workInputId,
      plannerAttemptId: actionAttempt.id,
    });
    const childAttempt = await attempt(work);
    const childPlanning = planningFixture({ tenantId, workId: work.workId, workInputId: work.workInputId, plannerAttemptId: childAttempt.id, variant: "replacement" });
    await persistSelectedWorkPlan(persistenceParams(childPlanning, childAttempt.id, materialized.planRevisionId));

    const runtime = new FinnorOrchestrator();
    const stale = await runtime.runAction(materialized.actions[0]!.id, tenantId);
    expect(stale).toMatchObject({ status: "failure", output: { code: "PLAN_REVISION_NOT_ACTIVE", planRevisionId: materialized.planRevisionId } });
    await expect(admin.query("UPDATE finnor_os.domain_actions SET status='pending' WHERE tenant_id=$1 AND id=$2", [
      tenantId,
      materialized.actions[0]!.id,
    ])).rejects.toThrow(/non-active PlanRevision/i);

    const foreignWork = await receiveWork({
      tenantId: foreignTenantId,
      instruction: "Foreign tenant work",
      channel: "console",
      userId: "system:p6-concurrency",
      idempotencyKey: `p6-foreign:${randomUUID()}`,
    });
    const foreignAttempt = await beginWorkPlannerAttempt({
      tenantId: foreignTenantId,
      workId: foreignWork.workId,
      workInputId: foreignWork.workInputId,
      attemptKey: `p6:${randomUUID()}`,
    });
    const foreignPlanning = planningFixture({ tenantId: foreignTenantId, workId: foreignWork.workId, workInputId: foreignWork.workInputId, plannerAttemptId: foreignAttempt.id, variant: "foreign" });
    const selected = foreignPlanning.compilation.selected!;
    await expect(admin.query(
      `INSERT INTO finnor_os.work_plan_revisions(
         tenant_id,work_id,work_input_id,revision,reason,status,goal_spec,constraint_set,planning_snapshot,
         candidate_summary,validation,plan_graph,score,goal_hash,constraint_hash,world_snapshot_hash,graph_hash,semantic_hash
       ) VALUES ($1,$2,$3,1,'initial','active',$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$14)`,
      [
        tenantId,
        foreignWork.workId,
        foreignWork.workInputId,
        JSON.stringify(foreignPlanning.goal),
        JSON.stringify(foreignPlanning.constraints),
        JSON.stringify(foreignPlanning.snapshot),
        JSON.stringify({ candidates: [], selected: selected.candidateKey }),
        JSON.stringify(foreignPlanning.compilation),
        JSON.stringify(selected.graph),
        JSON.stringify(selected.score),
        foreignPlanning.goal.semanticHash,
        foreignPlanning.constraints.semanticHash,
        foreignPlanning.snapshot.semanticHash,
        selected.graph!.semanticHash,
      ],
    )).rejects.toThrow(/does not belong to tenant|scope mismatch/i);
  }, 30_000);
});
