import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  closePool,
  beginWorkPlannerAttempt,
  persistSelectedWorkPlan,
  withTenant,
  workObjectiveSteps,
  workPlanRevisions,
} from "@finnor/db";
import {
  createDefaultPluginRegistry,
  FinnorOrchestrator,
  LLMPlanner,
  type Planner,
  type PlannerOptions,
  type PlanningResult,
} from "@finnor/orchestration";
import type { MemorySnapshot, ObjectiveSuccessCondition, TenantContext } from "@finnor/shared-types";
import { migrate } from "../../packages/db/migrate";
import { assertDisposableDatabaseTarget } from "../../packages/db/production-target-guard";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

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

class MultiNodeQueryPlanner implements Planner {
  calls = 0;
  lastPlanning: PlanningResult | null = null;
  private readonly compiler: LLMPlanner;

  constructor(private readonly checkLabel?: string) {
    this.compiler = new LLMPlanner(createDefaultPluginRegistry());
  }

  async plan(_instruction: string, tenantContext: TenantContext, _memory: MemorySnapshot, opts?: PlannerOptions): Promise<PlanningResult> {
    this.calls += 1;
    if (!opts?.goalSpec || !opts.constraints || !opts.planningSnapshot || !opts.workId) {
      throw new Error("Multi-node runtime fixture requires canonical P6 planning inputs");
    }
    const criterionIds = opts.goalSpec.criteria.map((criterion) => criterion.id);
    const planning = await this.compiler.compileCandidatePlans({
      candidates: [{
        version: 1,
        candidateKey: "two-causal-reads",
        nodes: [
          {
            key: "read_exact_work",
            kind: "query",
            request: { intent: "work_list", recordId: opts.workId },
            supports: criterionIds,
          },
          {
            key: "read_runnable_work",
            kind: "query",
            request: { intent: "work_list", openOnly: true, statuses: ["executing"] },
            dependsOn: ["read_exact_work"],
            supports: criterionIds,
          },
          ...opts.goalSpec.criteria.map((criterion, index) => ({
            key: `verify_${index + 1}`,
            kind: "check" as const,
            criterionId: criterion.id,
            dependsOn: ["read_runnable_work"],
            observation: this.checkLabel ? { ...criterion.criterion, reviewNote: this.checkLabel } : criterion.criterion,
          })),
        ],
      }],
      tenantContext,
      verticalKey: opts.planningSnapshot.verticalKey,
      goal: opts.goalSpec,
      constraints: opts.constraints,
      snapshot: opts.planningSnapshot,
      // Query execution itself is still authorized by the Objective runtime. This
      // fixture uses its explicit system principal and avoids manufacturing a human
      // authority graph solely to test PlanGraph continuation.
      useDatabase: false,
    });
    this.lastPlanning = planning;
    return planning;
  }
}

describe.skipIf(!available)("Phase 6 PlanGraph + ObjectiveLoop runtime", () => {
  const tenantId = randomUUID();
  const configuredBy = randomUUID();
  const agentProfileId = randomUUID();
  let admin: pg.Client;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.SECRETS_PROVIDER = "env";
    await migrate(DB_URL);
    admin = new pg.Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("SET app.test_vertical_mode = 'explicit'");
    await admin.query(
      "INSERT INTO finnor_os.tenants(id,client_key,name) VALUES ($1,$2,'P6 multi-node runtime')",
      [tenantId, `p6-plan-graph-${randomUUID()}`],
    );
    await admin.query(
      "INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','P6 Runtime Fixture Owner')",
      [configuredBy, tenantId, `p6-runtime-${configuredBy}@test.invalid`],
    );
    await admin.query(
      `INSERT INTO finnor_os.tenant_vertical_assignments
        (tenant_id,vertical_key,version,source_system,created_by)
       VALUES ($1,'none',1,'certification:p6-plan-graph',$2)`,
      [tenantId, configuredBy],
    );
    await admin.query(
      "INSERT INTO finnor_os.agent_profiles(id,tenant_id,key,name) VALUES($1,$2,'p6-runtime-worker','P6 Runtime Worker')",
      [agentProfileId, tenantId],
    );
    await admin.query(
      `INSERT INTO finnor_os.agent_profile_revisions(
         id,tenant_id,agent_profile_id,revision,model_route,capability_grants,max_concurrent_assignments,autonomy_limits,planning_hints,status,config_hash,created_by
       ) VALUES($1,$2,$3,1,$4::jsonb,$5::jsonb,1,$6::jsonb,'{}'::jsonb,'active',$7,$8)`,
      [
        randomUUID(),
        tenantId,
        agentProfileId,
        JSON.stringify({ provider: "orchestration_runtime", model: null, purpose: "objective_execution" }),
        JSON.stringify([{ capability: "query:work_list", kind: "query" }, { capability: "check:objective_success", kind: "check" }]),
        JSON.stringify({ maxActions: 1, maxQueries: 5, maxReplans: 5, maxPlannerCalls: 5, maxWallClockMs: 86_400_000, maxKnownCostUsd: null, maxKnownTokens: null }),
        `sha256:${createHash("sha256").update(`p6-runtime-worker:${agentProfileId}`).digest("hex")}`,
        configuredBy,
      ],
    );
  });

  afterAll(async () => {
    await closePool();
    await admin?.end();
  });

  it("continues one immutable multi-node graph and completes only through the selected check", async () => {
    const planner = new MultiNodeQueryPlanner();
    const runtime = new FinnorOrchestrator({ planner });
    const ctx: TenantContext = { tenantId, userId: "system:p6-runtime-certification", role: "owner" };
    const successCondition: ObjectiveSuccessCondition = {
      version: 1,
      statement: "The accepted Work remains visible in canonical Work truth.",
      mode: "all",
      source: "explicit",
      criteria: [{
        kind: "canonical_query",
        request: { intent: "work_list", openOnly: true },
        assertion: { path: ["works"], operator: "exists" },
      }],
    };
    const objective = await runtime.startObjective("Verify this Work through two causally ordered reads.", ctx, {
      idempotencyKey: `p6-plan-graph:${randomUUID()}`,
      successCondition,
      maxSteps: 5,
      maxQueries: 5,
      maxActions: 0,
    });

    expect(await runtime.runObjectiveIteration({ tenantId, workId: objective.workId, objectiveLoopId: objective.objectiveLoopId })).toBe("continue");
    expect(await runtime.runObjectiveIteration({ tenantId, workId: objective.workId, objectiveLoopId: objective.objectiveLoopId })).toBe("continue");
    expect(await runtime.runObjectiveIteration({ tenantId, workId: objective.workId, objectiveLoopId: objective.objectiveLoopId })).toBe("completed");
    expect(planner.calls).toBe(1);

    const [plans, steps] = await Promise.all([
      withTenant(tenantId, (db) => db.select().from(workPlanRevisions).where(eq(workPlanRevisions.workId, objective.workId)).orderBy(asc(workPlanRevisions.revision))),
      withTenant(tenantId, (db) => db.select().from(workObjectiveSteps).where(eq(workObjectiveSteps.objectiveLoopId, objective.objectiveLoopId)).orderBy(asc(workObjectiveSteps.stepNumber))),
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ revision: 1, parentRevisionId: null, status: "completed", completionProof: { verified: true } });
    expect(new Set(steps.map((step) => step.planRevisionId))).toEqual(new Set([plans[0]!.id]));
    expect(steps.map((step) => step.decisionKind)).toEqual(["query", "query", "complete"]);
    expect(steps.map((step) => step.planNodeId)).toEqual([
      expect.stringMatching(/^node_/),
      expect.stringMatching(/^node_/),
      expect.stringMatching(/^node_/),
    ]);
    expect(new Set(steps.map((step) => step.planNodeId)).size).toBe(3);
  }, 30_000);

  it("rolls back Objective finalization when its Work completion cannot commit and recovers the checked proof", async () => {
    assertDisposableDatabaseTarget(DB_URL, "Objective completion commit fault");
    const directory = process.env.FINNOR_OBJECTIVE_COMMIT_EVIDENCE_DIR ?? join(tmpdir(), "finnor-objective-commit", randomUUID());
    await mkdir(directory, { recursive: true });
    const patch = execFileSync("git", ["diff", "--binary", "HEAD"], { encoding: "utf8" });
    await writeFile(join(directory, "source.patch"), patch);
    const source = { revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), patchSha256: createHash("sha256").update(patch).digest("hex"), node: process.version };
    const planner = new MultiNodeQueryPlanner(), runtime = new FinnorOrchestrator({ planner });
    const objective = await runtime.startObjective("Verify the original Work through two reads despite a failed final commit.", { tenantId, userId: "system:p6-runtime-certification", role: "owner" }, {
      idempotencyKey: randomUUID(), maxSteps: 5, maxQueries: 5, maxActions: 0,
      successCondition: { version: 1, statement: "The accepted Work is visible in canonical Work truth.", mode: "all", source: "explicit", criteria: [{ kind: "canonical_query", request: { intent: "work_list", openOnly: true }, assertion: { path: ["works"], operator: "exists" } }] },
    });
    const invocation = { tenantId, workId: objective.workId, objectiveLoopId: objective.objectiveLoopId, workforceLeaseOwner: randomUUID() };
    const observations: unknown[] = [];
    async function observe(step: string) {
      const work = (await admin.query("SELECT status,final_outcome,failure FROM finnor_os.works WHERE tenant_id=$1 AND id=$2", [tenantId, objective.workId])).rows[0];
      const loop = (await admin.query("SELECT state,deadline_at,max_steps,max_queries,max_actions FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND id=$2", [tenantId, objective.objectiveLoopId])).rows[0];
      const steps = (await admin.query("SELECT id,step_number,completed_at,iteration_outcome FROM finnor_os.work_objective_steps WHERE tenant_id=$1 AND objective_loop_id=$2 ORDER BY step_number", [tenantId, objective.objectiveLoopId])).rows;
      const plans = (await admin.query("SELECT id,status,completion_proof FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND work_id=$2 ORDER BY revision", [tenantId, objective.workId])).rows;
      const state = { work, loop, steps, plans }; observations.push({ step, state }); return state;
    }
    const trigger = `completion_fault_${randomUUID().replaceAll("-", "")}`;
    try {
      expect(await runtime.runObjectiveIteration(invocation)).toBe("continue");
      expect(await runtime.runObjectiveIteration(invocation)).toBe("continue");
      const before = await observe("two canonical queries completed");
      await admin.query(`CREATE FUNCTION finnor_os.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${objective.workId}'::uuid AND NEW.status='completed' THEN RAISE EXCEPTION 'OBJECTIVE_PARENT_COMMIT_FAULT'; END IF; RETURN NEW; END $$`);
      await admin.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON finnor_os.works FOR EACH ROW EXECUTE FUNCTION finnor_os.${trigger}()`);
      let failure: unknown;
      try { await runtime.runObjectiveIteration(invocation); } catch (error) { failure = error; }
      const errors: string[] = [];
      for (let cause = failure; cause instanceof Error; cause = cause.cause) errors.push(cause.message);
      observations.push({ step: "real Work UPDATE rejected", errors });
      expect(errors.join("\n")).toContain("OBJECTIVE_PARENT_COMMIT_FAULT");
      const interrupted = await observe("after rejected parent commit");
      expect(interrupted.plans).toMatchObject([{ status: "completed", completion_proof: { verified: true } }]);
      expect(interrupted.work.status).toBe("executing");
      expect(interrupted.loop.state).toBe("continue");
      expect(interrupted.steps.at(-1)?.completed_at).toBeNull();
      await admin.query(`DROP TRIGGER ${trigger} ON finnor_os.works`);
      expect(await runtime.runObjectiveIteration(invocation)).toBe("completed");
      const recovered = await observe("ordinary runtime recovered original proof");
      expect(recovered.work).toMatchObject({ status: "completed", final_outcome: { kind: "objective", objectiveLoopId: objective.objectiveLoopId, successVerification: { state: "verified" }, observation: { recoveredCompletionProof: { verified: true } } } });
      expect(recovered.loop).toEqual({ ...before.loop, state: "completed" });
      expect(recovered.steps.map(row => row.id)).toEqual(interrupted.steps.map(row => row.id));
      expect(recovered.plans).toEqual(interrupted.plans);
      expect(planner.calls).toBe(1);
    } finally {
      await admin.query(`DROP TRIGGER IF EXISTS ${trigger} ON finnor_os.works`);
      await admin.query(`DROP FUNCTION IF EXISTS finnor_os.${trigger}()`);
      await writeFile(join(directory, "execution.json"), JSON.stringify({ source, inputs: invocation, observations, contract: "Checked Plan proof survives a rejected parent write; Objective, step and Work finalization commit together and retry preserves the original deadline and budgets.", existingCoverageGap: "The ordinary successful PlanGraph journey cannot observe a failure between Objective and Work commits.", qualification: "Real PostgreSQL fault and canonical runtime; no mounted browser or live provider proof.", rerun: "Set DATABASE_URL to a migrated disposable database and FINNOR_OBJECTIVE_COMMIT_EVIDENCE_DIR to a private directory; from finnor-os run npx vitest run tests/integration/phase6-plan-graph-runtime.test.ts -t 'rolls back Objective finalization'" }, null, 2) + "\n");
    }
  }, 30_000);

  it("finishes a query and replaces its Plan concurrently without a Work and step lock cycle", async () => {
    assertDisposableDatabaseTarget(DB_URL, "Objective finalization and replan race");
    const directory = process.env.FINNOR_OBJECTIVE_RACE_EVIDENCE_DIR ?? join(tmpdir(), "finnor-objective-race", randomUUID());
    await mkdir(directory, { recursive: true });
    const patch = execFileSync("git", ["diff", "--binary", "HEAD"], { encoding: "utf8" });
    await writeFile(join(directory, "source.patch"), patch);
    const source = { revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), patchSha256: createHash("sha256").update(patch).digest("hex"), node: process.version };
    const planner = new MultiNodeQueryPlanner(), runtime = new FinnorOrchestrator({ planner });
    const ctx: TenantContext = { tenantId, userId: "system:p6-runtime-certification", role: "owner" };
    const objective = await runtime.startObjective("Keep original checked reads while replacing the remaining Plan.", ctx, {
      idempotencyKey: randomUUID(), maxSteps: 5, maxQueries: 5, maxActions: 0,
      successCondition: { version: 1, statement: "The accepted Work is visible.", mode: "all", source: "explicit", criteria: [{ kind: "canonical_query", request: { intent: "work_list", openOnly: true }, assertion: { path: ["works"], operator: "exists" } }] },
    });
    const invocation = { tenantId, workId: objective.workId, objectiveLoopId: objective.objectiveLoopId };
    expect(await runtime.runObjectiveIteration(invocation)).toBe("continue");
    const parent = (await admin.query("SELECT id,work_input_id FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND work_id=$2 AND status='active'", [tenantId, objective.workId])).rows[0];
    const nextAttempt = await beginWorkPlannerAttempt({ tenantId, workId: objective.workId, workInputId: parent.work_input_id, attemptKey: randomUUID() });
    const base = planner.lastPlanning!;
    const child = await new MultiNodeQueryPlanner("Independently verify the replacement Plan.").plan("Prepare the replacement graph.", ctx, {} as MemorySnapshot, { workId: objective.workId, goalSpec: base.goal, constraints: base.constraints, planningSnapshot: base.snapshot });
    const selected = child.compilation.selected!;
    expect(selected, JSON.stringify(child.compilation)).toBeTruthy();
    const trigger = `finalization_gate_${randomUUID().replaceAll("-", "")}`;
    const gate = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 8), 16);
    const gatePid = Number((await admin.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const observations: unknown[] = [];
    let finishing: Promise<unknown> | null = null, replacing: Promise<unknown> | null = null;
    const settle = async (promise: Promise<unknown>) => {
      try { return { status: "fulfilled", value: await promise }; }
      catch (error) { const errors: string[] = []; for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) errors.push(cause.message); return { status: "rejected", errors }; }
    };
    async function blockedBy(pid: number) {
      const until = Date.now() + 5_000;
      while (Date.now() < until) {
        const rows = (await admin.query("SELECT pid,wait_event,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))", [pid])).rows;
        if (rows.length) { observations.push({ step: "physical database wait", blocker: pid, rows }); return Number(rows[0].pid); }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw Error("Expected physical database interleaving was not reached");
    }
    try {
      await admin.query(`CREATE FUNCTION finnor_os.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.work_id='${objective.workId}'::uuid AND NEW.step_number=2 AND NEW.phase='finished' AND NEW.execution_state<>'superseded' THEN PERFORM pg_advisory_xact_lock(${gate}::bigint); END IF; RETURN NEW; END $$`);
      await admin.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON finnor_os.work_objective_steps FOR EACH ROW EXECUTE FUNCTION finnor_os.${trigger}()`);
      await admin.query("SELECT pg_advisory_lock($1::bigint)", [gate]);
      finishing = settle(runtime.runObjectiveIteration(invocation));
      const finishingPid = await blockedBy(gatePid);
      replacing = settle(persistSelectedWorkPlan({ tenantId, workId: objective.workId, workInputId: parent.work_input_id, plannerAttemptId: nextAttempt.id, objectiveLoopId: objective.objectiveLoopId, parentRevisionId: parent.id, reason: "observation", goalSpec: child.goal, constraintSet: child.constraints, planningSnapshot: child.snapshot, candidatePlans: child.candidates, compilationResult: child.compilation, planGraph: selected.graph!, score: selected.score, semanticHash: selected.graph!.semanticHash }));
      await blockedBy(finishingPid);
      await admin.query("SELECT pg_advisory_unlock($1::bigint)", [gate]);
      const results = await Promise.all([finishing, replacing]);
      const plans = (await admin.query("SELECT id,status,parent_revision_id FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND work_id=$2 ORDER BY revision", [tenantId, objective.workId])).rows;
      const steps = (await admin.query("SELECT step_number,execution_state,completed_at FROM finnor_os.work_objective_steps WHERE tenant_id=$1 AND objective_loop_id=$2 ORDER BY step_number", [tenantId, objective.objectiveLoopId])).rows;
      observations.push({ step: "both owners settled", results, plans, steps });
      expect(results).toMatchObject([{ status: "fulfilled", value: "continue" }, { status: "fulfilled" }]);
      expect(plans).toMatchObject([{ id: parent.id, status: "superseded" }, { status: "active", parent_revision_id: parent.id }]);
      expect(steps).toMatchObject([{ step_number: 1, execution_state: "completed" }, { step_number: 2, execution_state: "completed" }]);
    } finally {
      await admin.query("SELECT pg_advisory_unlock($1::bigint)", [gate]);
      await Promise.all([finishing, replacing]);
      await admin.query(`DROP TRIGGER IF EXISTS ${trigger} ON finnor_os.work_objective_steps`);
      await admin.query(`DROP FUNCTION IF EXISTS finnor_os.${trigger}()`);
      await writeFile(join(directory, "execution.json"), JSON.stringify({ source, inputs: invocation, observations, contract: "A query finalizer and canonical Plan replacement settle without deadlock and retain already completed query steps.", credibleDefect: "Step-to-Work and Work-to-step lock inversion introduced by atomic finalization.", existingCoverageGap: "Sequential commit fault and competing replanner tests do not run finalization against replan ownership.", qualification: "Real PostgreSQL blocking and canonical runtime/Plan owners; no mounted browser proof.", rerun: "Set DATABASE_URL to a migrated disposable database and FINNOR_OBJECTIVE_RACE_EVIDENCE_DIR to a private directory; from finnor-os run npx vitest run tests/integration/phase6-plan-graph-runtime.test.ts -t 'replaces its Plan concurrently'" }, null, 2) + "\n");
    }
  }, 30_000);
});
