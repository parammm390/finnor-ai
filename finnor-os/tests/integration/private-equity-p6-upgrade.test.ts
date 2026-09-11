import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../packages/db/migrate";
import { MIGRATIONS } from "../../packages/db/migrations-bundle";

const SOURCE_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const P6_MIGRATION = "0128_phase6_planning_causal_attention.sql";
const P6_MIGRATIONS = MIGRATIONS.filter(({ name }) => name <= P6_MIGRATION);

async function canConnect(): Promise<boolean> {
  const client = new pg.Client({ connectionString: SOURCE_URL, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function databaseUrl(database: string): string {
  const url = new URL(SOURCE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

const available = await canConnect();

describe.skipIf(!available)("P6 fresh migration and populated P1-P5 upgrade", () => {
  const upgradeDatabase = `finnor_p6_upgrade_${randomUUID().replaceAll("-", "_")}`;
  const freshDatabase = `finnor_p6_fresh_${randomUUID().replaceAll("-", "_")}`;
  const upgradeUrl = databaseUrl(upgradeDatabase);
  const freshUrl = databaseUrl(freshDatabase);
  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const workId = randomUUID();
  const inputId = randomUUID();
  const instructionId = randomUUID();
  const attemptId = randomUUID();
  const actionId = randomUUID();
  const legacyPlanId = randomUUID();
  let upgradeClient: pg.Client;
  let freshClient: pg.Client;
  let beforeFingerprint = "";
  let afterFingerprint = "";
  let appliedUpgrade: string[] = [];
  let appliedFresh: string[] = [];

  beforeAll(async () => {
    const source = new pg.Client({ connectionString: SOURCE_URL });
    await source.connect();
    try {
      await source.query(`CREATE DATABASE ${upgradeDatabase}`);
      await source.query(`CREATE DATABASE ${freshDatabase}`);
    } finally {
      await source.end();
    }

    const preP6 = P6_MIGRATIONS.filter(({ name }) => name < P6_MIGRATION);
    expect(preP6.at(-1)?.name).toBe("0127_pe_actions_ic_runtime.sql");
    expect(await migrate(upgradeUrl, preP6)).toEqual(preP6.map(({ name }) => name));

    upgradeClient = new pg.Client({ connectionString: upgradeUrl });
    await upgradeClient.connect();
    await upgradeClient.query("SET app.test_vertical_mode = 'explicit'");
    await upgradeClient.query(
      "INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'P6 populated upgrade project')",
      [tenantId, `p6-upgrade-${tenantId}`],
    );
    await upgradeClient.query(
      "INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','P6 Upgrade Owner')",
      [ownerId, tenantId, `p6-upgrade-${ownerId}@test.invalid`],
    );
    await upgradeClient.query(
      `INSERT INTO finnor_os.works(id,tenant_id,status,initial_channel,initial_instruction,created_by,idempotency_key)
       VALUES($1,$2,'planning','console','Preserve this exact legacy action plan during P6',$3,$4)`,
      [workId, tenantId, ownerId, `p6-upgrade-work-${workId}`],
    );
    await upgradeClient.query(
      `INSERT INTO finnor_os.work_inputs(id,tenant_id,work_id,instruction_id,channel,instruction_text,created_by,idempotency_key)
       VALUES($1,$2,$3,$4,'console','Preserve this exact legacy action plan during P6',$5,$6)`,
      [inputId, tenantId, workId, instructionId, ownerId, `p6-upgrade-input-${inputId}`],
    );
    await upgradeClient.query(
      `INSERT INTO finnor_os.work_planner_attempts(
         id,tenant_id,work_id,work_input_id,attempt,attempt_key,status,planner_result,decision_context_snapshot,decision_context_hash,decision_context_captured_at,completed_at
       ) VALUES($1,$2,$3,$4,1,'legacy-attempt','succeeded',$5::jsonb,$6::jsonb,$7,'2026-09-10T00:00:00.000Z',clock_timestamp())`,
      [
        attemptId,
        tenantId,
        workId,
        inputId,
        JSON.stringify({ actions: [{ action_type: "create_task", payload: { title: "Legacy task" } }] }),
        JSON.stringify({ version: 1, capturedAt: "2026-09-10T00:00:00.000Z", entities: [] }),
        "1".repeat(64),
      ],
    );
    await upgradeClient.query(
      `INSERT INTO finnor_os.domain_actions(
         id,tenant_id,action_type,payload,status,plan_id,work_id,planner_attempt_id,initiated_by
       ) VALUES($1,$2,'create_task',$3::jsonb,'draft',$4,$5,$6,$7)`,
      [actionId, tenantId, JSON.stringify({ title: "Legacy task" }), legacyPlanId, workId, attemptId, ownerId],
    );

    const fingerprint = async () => (await upgradeClient.query<{ hash: string }>(
      `SELECT encode(public.digest(convert_to(jsonb_build_object(
        'work',(SELECT to_jsonb(w) - ARRAY['updated_at'] FROM finnor_os.works w WHERE id=$1),
        'input',(SELECT to_jsonb(i) FROM finnor_os.work_inputs i WHERE id=$2),
        'attempt',(SELECT to_jsonb(a) - ARRAY['goal_spec','constraint_set','planning_snapshot','candidate_plans','compilation_result','selected_plan_revision_id'] FROM finnor_os.work_planner_attempts a WHERE id=$3),
        'action',(SELECT to_jsonb(d) - ARRAY['plan_revision_id','plan_node_id'] FROM finnor_os.domain_actions d WHERE id=$4)
      )::text,'UTF8'),'sha256'),'hex') hash`,
      [workId, inputId, attemptId, actionId],
    )).rows[0]!.hash;

    beforeFingerprint = await fingerprint();
    appliedUpgrade = await migrate(upgradeUrl, P6_MIGRATIONS);
    afterFingerprint = await fingerprint();

    appliedFresh = await migrate(freshUrl, P6_MIGRATIONS);
    freshClient = new pg.Client({ connectionString: freshUrl });
    await freshClient.connect();
  }, 180_000);

  afterAll(async () => {
    await upgradeClient?.end().catch(() => undefined);
    await freshClient?.end().catch(() => undefined);
    const source = new pg.Client({ connectionString: SOURCE_URL });
    await source.connect();
    try {
      await source.query(`DROP DATABASE IF EXISTS ${upgradeDatabase} WITH (FORCE)`);
      await source.query(`DROP DATABASE IF EXISTS ${freshDatabase} WITH (FORCE)`);
    } finally {
      await source.end();
    }
  }, 30_000);

  it("applies only P6 and preserves exact populated legacy Work, input, attempt, and DomainAction truth", () => {
    expect(appliedUpgrade).toEqual([P6_MIGRATION]);
    expect(afterFingerprint).toBe(beforeFingerprint);
  });

  it("does not fabricate historical GoalSpecs, CandidatePlans, PlanGraphs, or plan-node links", async () => {
    const result = await upgradeClient.query<{
      revisions: number;
      goal_spec: unknown;
      constraint_set: unknown;
      planning_snapshot: unknown;
      candidate_plans: unknown;
      compilation_result: unknown;
      selected_plan_revision_id: string | null;
      plan_revision_id: string | null;
      plan_node_id: string | null;
    }>(
      `SELECT
        (SELECT count(*)::int FROM finnor_os.work_plan_revisions WHERE tenant_id=$1) revisions,
        a.goal_spec,a.constraint_set,a.planning_snapshot,a.candidate_plans,a.compilation_result,a.selected_plan_revision_id,
        d.plan_revision_id,d.plan_node_id
       FROM finnor_os.work_planner_attempts a
       JOIN finnor_os.domain_actions d ON d.planner_attempt_id=a.id
       WHERE a.id=$2 AND d.id=$3`,
      [tenantId, attemptId, actionId],
    );
    expect(result.rows[0]).toEqual({
      revisions: 0,
      goal_spec: null,
      constraint_set: null,
      planning_snapshot: null,
      candidate_plans: null,
      compilation_result: null,
      selected_plan_revision_id: null,
      plan_revision_id: null,
      plan_node_id: null,
    });
  });

  it("installs the P6 table, hard RLS, immutable trigger, link guards, and attention intent", async () => {
    const relations = await upgradeClient.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='finnor_os' AND c.relname='work_plan_revisions'`,
    );
    expect(relations.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const triggers = await upgradeClient.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='finnor_os' AND NOT t.tgisinternal
         AND ((c.relname='work_plan_revisions' AND tgname IN ('work_plan_revisions_scope','work_plan_revisions_immutable'))
           OR (c.relname='domain_actions' AND tgname='domain_actions_plan_link')) ORDER BY tgname`,
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      "domain_actions_plan_link",
      "work_plan_revisions_immutable",
      "work_plan_revisions_scope",
    ]);
    const queryConstraint = await upgradeClient.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) definition FROM pg_constraint
       WHERE connamespace='finnor_os'::regnamespace AND conname='work_query_executions_intent_check'`,
    );
    expect(queryConstraint.rows[0]!.definition).toContain("attention_queue");
  });

  it("applies the complete migration lineage to a fresh database and is idempotent", async () => {
    expect(appliedFresh).toEqual(P6_MIGRATIONS.map(({ name }) => name));
    expect(await migrate(freshUrl, P6_MIGRATIONS)).toEqual([]);
    const head = await freshClient.query<{ name: string }>(
      "SELECT name FROM finnor_os._migrations ORDER BY name DESC LIMIT 1",
    );
    expect(head.rows[0]?.name).toBe(P6_MIGRATION);
    const table = await freshClient.query<{ exists: boolean }>(
      "SELECT to_regclass('finnor_os.work_plan_revisions') IS NOT NULL exists",
    );
    expect(table.rows[0]?.exists).toBe(true);
  });
});
