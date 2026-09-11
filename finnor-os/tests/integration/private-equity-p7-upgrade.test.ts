import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../packages/db/migrate";
import { MIGRATIONS } from "../../packages/db/migrations-bundle";

const SOURCE_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@127.0.0.1:5432/finnor";
const P7_MIGRATION = "0129_phase7_governed_workforce_learning.sql";

async function canConnect(): Promise<boolean> {
  const client = new pg.Client({ connectionString: SOURCE_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => undefined); }
}

function databaseUrl(database: string): string {
  const url = new URL(SOURCE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

function hash(label: string): string {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

const available = await canConnect();

describe.skipIf(!available)("P7 fresh migration and populated P1-P6 upgrade", () => {
  const upgradeDatabase = `finnor_p7_upgrade_${randomUUID().replaceAll("-", "_")}`;
  const freshDatabase = `finnor_p7_fresh_${randomUUID().replaceAll("-", "_")}`;
  const upgradeUrl = databaseUrl(upgradeDatabase);
  const freshUrl = databaseUrl(freshDatabase);
  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const roleId = randomUUID();
  const workId = randomUUID();
  const inputId = randomUUID();
  const loopId = randomUUID();
  const stepId = randomUUID();
  const planId = randomUUID();
  const nodeId = `node-${randomUUID()}`;
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
    } finally { await source.end(); }

    const preP7 = MIGRATIONS.filter(({ name }) => name < P7_MIGRATION);
    expect(preP7.at(-1)?.name).toBe("0128_phase6_planning_causal_attention.sql");
    expect(await migrate(upgradeUrl, preP7)).toEqual(preP7.map(({ name }) => name));
    upgradeClient = new pg.Client({ connectionString: upgradeUrl });
    await upgradeClient.connect();
    await upgradeClient.query("SET app.test_vertical_mode = 'explicit'");
    await upgradeClient.query(`INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'P7 populated upgrade')`, [tenantId, `p7-upgrade-${tenantId}`]);
    await upgradeClient.query(
      `INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','P7 Upgrade Owner')`,
      [ownerId, tenantId, `p7-upgrade-${ownerId}@test.invalid`],
    );
    await upgradeClient.query(
      `INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name,legacy_role) VALUES($1,$2,'owner-before-p7','Owner before P7','owner')`,
      [roleId, tenantId],
    );
    await upgradeClient.query(
      `INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,'{"kind":"tenant"}'::jsonb)`,
      [tenantId, ownerId, roleId],
    );
    await upgradeClient.query(
      `INSERT INTO finnor_os.works(id,tenant_id,status,initial_channel,initial_instruction,execution_model,created_by,idempotency_key)
       VALUES($1,$2,'executing','console','Preserve exact P6 plan during P7','objective',$3,$4)`,
      [workId, tenantId, ownerId, `p7-upgrade-work-${workId}`],
    );
    await upgradeClient.query(
      `INSERT INTO finnor_os.work_inputs(id,tenant_id,work_id,instruction_id,channel,instruction_text,created_by,idempotency_key)
       VALUES($1,$2,$3,$4,'console','Preserve exact P6 plan during P7',$5,$6)`,
      [inputId, tenantId, workId, randomUUID(), ownerId, `p7-upgrade-input-${inputId}`],
    );
    await upgradeClient.query(
      `INSERT INTO finnor_os.work_objective_loops(
         id,tenant_id,work_id,objective,state,revision,step_count,deadline_at,created_by,initial_channel,success_condition
       ) VALUES($1,$2,$3,'Preserve P6 truth','continue',1,1,now()+interval '1 day',$4,'console',$5::jsonb)`,
      [loopId, tenantId, workId, ownerId, JSON.stringify({ version: 1, statement: "P6 truth remains exact", mode: "all", source: "explicit", criteria: [] })],
    );
    const goalHash = hash(`goal:${workId}`);
    const constraintHash = hash(`constraints:${workId}`);
    const snapshotHash = hash(`snapshot:${workId}`);
    const graphHash = hash(`graph:${workId}`);
    await upgradeClient.query(
      `INSERT INTO finnor_os.work_plan_revisions(
         id,tenant_id,work_id,work_input_id,objective_loop_id,revision,reason,status,goal_spec,constraint_set,planning_snapshot,candidate_summary,validation,plan_graph,score,goal_hash,constraint_hash,world_snapshot_hash,graph_hash,semantic_hash
       ) VALUES($1,$2,$3,$4,$5,1,'initial','active',$6::jsonb,$7::jsonb,$8::jsonb,'{}'::jsonb,'{"version":1}'::jsonb,$9::jsonb,'{}'::jsonb,$10,$11,$12,$13,$13)`,
      [
        planId, tenantId, workId, inputId, loopId,
        JSON.stringify({ version: 1, semanticHash: goalHash }),
        JSON.stringify({ version: 1, semanticHash: constraintHash }),
        JSON.stringify({ version: 1, semanticHash: snapshotHash, verticalKey: "none" }),
        JSON.stringify({ version: 1, semanticHash: graphHash, nodes: [{ id: nodeId, kind: "query", request: { intent: "work_list", recordId: workId } }] }),
        goalHash, constraintHash, snapshotHash, graphHash,
      ],
    );
    await upgradeClient.query(
      `INSERT INTO finnor_os.work_objective_steps(id,tenant_id,objective_loop_id,work_id,step_number,idempotency_key,phase,plan_revision_id,plan_node_id)
       VALUES($1,$2,$3,$4,1,'p7-upgrade-step','deciding',$5,$6)`,
      [stepId, tenantId, loopId, workId, planId, nodeId],
    );
    const fingerprint = async () => (await upgradeClient.query<{ hash: string }>(
      `SELECT encode(public.digest(convert_to(jsonb_build_object(
        'work',(SELECT to_jsonb(work_row)-ARRAY['updated_at'] FROM finnor_os.works work_row WHERE id=$1),
        'loop',(SELECT to_jsonb(loop_row)-ARRAY['updated_at'] FROM finnor_os.work_objective_loops loop_row WHERE id=$2),
        'plan',(SELECT to_jsonb(plan_row) FROM finnor_os.work_plan_revisions plan_row WHERE id=$3),
        'step',(SELECT to_jsonb(step_row) FROM finnor_os.work_objective_steps step_row WHERE id=$4)
      )::text,'UTF8'),'sha256'),'hex') hash`,
      [workId, loopId, planId, stepId],
    )).rows[0]!.hash;
    beforeFingerprint = await fingerprint();
    appliedUpgrade = await migrate(upgradeUrl, MIGRATIONS);
    afterFingerprint = await fingerprint();

    appliedFresh = await migrate(freshUrl, MIGRATIONS);
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
    } finally { await source.end(); }
  }, 30_000);

  it("applies only P7 and preserves populated P1-P6 Work, ObjectiveLoop, PlanRevision, and ObjectiveStep truth", () => {
    expect(appliedUpgrade).toEqual([P7_MIGRATION]);
    expect(afterFingerprint).toBe(beforeFingerprint);
  });

  it("does not invent worker, assignment, observation, proposal, or learning history", async () => {
    const counts = await upgradeClient.query(
      `SELECT
        (SELECT count(*)::int FROM finnor_os.agent_profiles) profiles,
        (SELECT count(*)::int FROM finnor_os.agent_profile_revisions) profile_revisions,
        (SELECT count(*)::int FROM finnor_os.workforce_assignments) assignments,
        (SELECT count(*)::int FROM finnor_os.learning_observations) observations,
        (SELECT count(*)::int FROM finnor_os.learning_proposals) proposals,
        (SELECT count(*)::int FROM finnor_os.learning_revisions) learning_revisions`,
    );
    expect(counts.rows[0]).toEqual({ profiles: 0, profile_revisions: 0, assignments: 0, observations: 0, proposals: 0, learning_revisions: 0 });
  });

  it("installs hard RLS, immutable/scope triggers, indexes, workforce query intent, and all three owner governance grants", async () => {
    const rls = await upgradeClient.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
       WHERE namespace.nspname='finnor_os' AND relname IN ('agent_profiles','agent_profile_revisions','workforce_assignments','learning_observations','learning_proposals','learning_revisions') ORDER BY relname`,
    );
    expect(rls.rows).toHaveLength(6);
    expect(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    const triggers = await upgradeClient.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger trigger_row JOIN pg_class relation ON relation.oid=trigger_row.tgrelid JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
       WHERE namespace.nspname='finnor_os' AND NOT trigger_row.tgisinternal AND tgname IN (
         'agent_profile_nonhuman','agent_profile_revisions_immutable','workforce_assignments_scope','workforce_assignments_history',
         'learning_observations_scope','learning_observations_immutable','learning_proposals_valid','learning_proposals_history','learning_revisions_valid','learning_revisions_immutable'
       ) ORDER BY tgname`,
    );
    expect(triggers.rows).toHaveLength(10);
    const intent = await upgradeClient.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE connamespace='finnor_os'::regnamespace AND conname='work_query_executions_intent_check'`,
    );
    expect(intent.rows[0]!.definition).toContain("workforce_status");
    const grants = await upgradeClient.query<{ capability: string }>(
      `SELECT capability FROM finnor_os.role_authority_grants WHERE role_id=$1 AND capability LIKE 'workforce:%' ORDER BY capability`, [roleId],
    );
    expect(grants.rows.map((row) => row.capability)).toEqual(["workforce:configure_agent", "workforce:promote_learning", "workforce:reassign_agent"]);
  });

  it("applies the complete lineage to a fresh database and remains idempotent", async () => {
    expect(appliedFresh).toEqual(MIGRATIONS.map(({ name }) => name));
    expect(await migrate(freshUrl, MIGRATIONS)).toEqual([]);
    const head = await freshClient.query<{ name: string }>("SELECT name FROM finnor_os._migrations ORDER BY name DESC LIMIT 1");
    expect(head.rows[0]?.name).toBe(P7_MIGRATION);
  });
});
