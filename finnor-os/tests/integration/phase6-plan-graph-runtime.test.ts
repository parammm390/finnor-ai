import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  closePool,
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
  private readonly compiler: LLMPlanner;

  constructor() {
    this.compiler = new LLMPlanner(createDefaultPluginRegistry());
  }

  async plan(_instruction: string, tenantContext: TenantContext, _memory: MemorySnapshot, opts?: PlannerOptions): Promise<PlanningResult> {
    this.calls += 1;
    if (!opts?.goalSpec || !opts.constraints || !opts.planningSnapshot || !opts.workId) {
      throw new Error("Multi-node runtime fixture requires canonical P6 planning inputs");
    }
    const criterionIds = opts.goalSpec.criteria.map((criterion) => criterion.id);
    return this.compiler.compileCandidatePlans({
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
            observation: criterion.criterion,
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
});
