import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { closePool } from "@finnor/db";
import {
  closedWorldClaimPermitted,
  listCompanyBrainRoots,
  loadCompanyBrainProjection,
  traverseCompanyBrain,
  type PeMutationContext,
} from "@finnor/private-equity";
import { migrate, type MigrationFile } from "../../packages/db/migrate";
import { CURRENT_MIGRATION_HEAD } from "../../packages/db/migration-head";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const WORKSPACE = resolve(REPO, "..");
const MIGRATIONS = resolve(REPO, "packages/db/migrations");
const REPORT_JSON = resolve(REPO, "docs/release/phase4-company-brain-certification.json");
const REPORT_MD = resolve(REPO, "docs/release/phase4-company-brain-certification.md");
const SCOPE4_TABLES = [
  "pe_funds", "pe_vehicles", "pe_fund_vehicle_links", "pe_strategy_mandates", "pe_portfolio_holdings",
  "pe_company_hierarchy_relationships", "pe_company_party_roles", "pe_securities", "pe_debt_facilities",
  "pe_debt_facility_lenders", "pe_ownership_interests", "pe_benchmarks", "pe_metric_series",
  "pe_metric_observations", "pe_benchmark_observations", "pe_outcomes", "pe_exits", "pe_fact_coverage",
] as const;

type Gate = { id: string; status: "PASS_LOCAL" | "PASS_INTEGRATION" | "PASS_LIVE" | "BLOCKED_EXTERNAL"; evidence: string };
type Metric = { operation: string; samples: number; p50Ms: number; p95Ms: number; maxMs: number; thresholdMs: number };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not reserve a PostgreSQL port"));
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function migrationFiles(): Promise<MigrationFile[]> {
  return Promise.all((await readdir(MIGRATIONS)).filter((name) => name.endsWith(".sql")).sort().map(async (name) => ({
    name, sql: await readFile(join(MIGRATIONS, name), "utf8"),
  })));
}

async function command(id: string, executable: string, args: string[], cwd = REPO, env: Record<string, string | undefined> = {}, timeoutMs = 1_200_000): Promise<string> {
  process.stdout.write(`\n[scope4] ${id}\n`);
  return new Promise((resolveOutput, reject) => {
    const child = spawn(executable, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => { const value = chunk.toString(); output += value; process.stdout.write(value); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${id} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveOutput(output);
      else reject(new Error(`${id} exited ${code}\n${output.slice(-8_000)}`));
    });
  });
}

async function inspectFresh(url: string): Promise<Record<string, unknown>> {
  const client = new pg.Client({ connectionString: url }); await client.connect();
  try {
    const head = await client.query<{ name: string }>("SELECT name FROM finnor_os._migrations ORDER BY name DESC LIMIT 1");
    assert(head.rows[0]?.name === CURRENT_MIGRATION_HEAD, `fresh migration head was ${head.rows[0]?.name}`);
    const tables = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number; history: number }>(
      `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
        (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname='finnor_os' AND p.tablename=c.relname AND p.policyname='tenant_isolation') policies,
        (SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal AND t.tgname='canonical_history') history
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='finnor_os' AND c.relname=ANY($1::text[])`, [SCOPE4_TABLES],
    );
    assert(tables.rows.length === SCOPE4_TABLES.length, "fresh database is missing Scope 4 tables");
    assert(tables.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity && row.policies === 1 && row.history === 1), "fresh database Scope 4 RLS/history controls are incomplete");
    const registry = await client.query<{ count: number }>("SELECT count(*)::int count FROM finnor_os.canonical_truth_registry WHERE source_table=ANY($1::text[]) AND writable_owner='@finnor/private-equity'", [SCOPE4_TABLES]);
    assert(registry.rows[0]?.count === SCOPE4_TABLES.length, "fresh database canonical registry is incomplete");
    return { head: head.rows[0]!.name, tables: tables.rows.length, forcedRls: true, historyTriggers: true, canonicalOwners: registry.rows[0]!.count };
  } finally { await client.end(); }
}

async function populatedUpgrade(url: string, files: MigrationFile[]): Promise<Record<string, unknown>> {
  const preScope4 = files.filter((file) => file.name < "0139_scope4_pe_digital_twin.sql");
  await migrate(url, preScope4);
  const client = new pg.Client({ connectionString: url }); await client.connect();
  const tenantId = "50000000-0000-4000-8000-000000000001";
  const userId = "50000000-0000-4000-8000-000000000002";
  const companyId = "50000000-0000-4000-8000-000000000003";
  const personId = "50000000-0000-4000-8000-000000000004";
  const strategyId = "50000000-0000-4000-8000-000000000005";
  try {
    await client.query("SET app.test_vertical_mode='explicit'");
    await client.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,'scope4-upgrade','Scope 4 populated upgrade')", [tenantId]);
    await client.query("SELECT set_config('app.tenant_id',$1,false),set_config('app.user_id',$2,false)", [tenantId, userId]);
    await client.query("SELECT * FROM finnor_os.configure_tenant_vertical($1,'private_equity',0,$2,'certification:scope4',NULL)", [tenantId, userId]);
    await client.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,'scope4-upgrade@test.invalid','owner','active','Upgrade owner')", [userId, tenantId]);
    await client.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'upgrade-company','Upgrade Company','other')", [companyId, tenantId]);
    await client.query("INSERT INTO finnor_os.external_contacts(id,tenant_id,contact_key,external_organization_id,name,title) VALUES($1,$2,'upgrade-person',$3,'Upgrade Person','CFO')", [personId, tenantId, companyId]);
    await client.query("INSERT INTO finnor_os.pe_strategies(id,tenant_id,name,state,source_system,created_by) VALUES($1,$2,'Existing Strategy','draft','certification:scope4',$3)", [strategyId, tenantId, userId]);
    const before = await client.query("SELECT row_to_json(o) organization,(SELECT row_to_json(c) FROM finnor_os.external_contacts c WHERE c.id=$2) contact,(SELECT row_to_json(s) FROM finnor_os.pe_strategies s WHERE s.id=$3) strategy FROM finnor_os.external_organizations o WHERE o.id=$1", [companyId, personId, strategyId]);
    const preMigrationAt = new Date();
    await client.end();
    const applied = await migrate(url, files);
    assert(applied[0] === "0139_scope4_pe_digital_twin.sql" && applied.at(-1) === CURRENT_MIGRATION_HEAD,
      `populated upgrade applied unexpected migrations: ${applied.join(",")}`);
    const verify = new pg.Client({ connectionString: url }); await verify.connect();
    try {
      const after = await verify.query("SELECT row_to_json(o) organization,(SELECT row_to_json(c) FROM finnor_os.external_contacts c WHERE c.id=$2) contact,(SELECT row_to_json(s) FROM finnor_os.pe_strategies s WHERE s.id=$3) strategy FROM finnor_os.external_organizations o WHERE o.id=$1", [companyId, personId, strategyId]);
      assert(JSON.stringify(before.rows[0]) === JSON.stringify(after.rows[0]), "populated upgrade changed existing canonical identity or truth");
      const fabricated = await verify.query<{ total: string }>(`SELECT (${SCOPE4_TABLES.map((table) => `(SELECT count(*) FROM finnor_os.${table})`).join("+")})::text total`);
      assert(fabricated.rows[0]?.total === "0", `populated upgrade fabricated ${fabricated.rows[0]?.total} Scope 4 rows`);
      const baselines = await verify.query<{ entity_type: string; count: number; origin: string; recorded_at: Date }>(
        `SELECT entity_type,count(*)::int count,min(origin) origin,min(recorded_at) recorded_at
           FROM finnor_os.canonical_entity_versions
          WHERE tenant_id=$1 AND entity_type IN ('external_organization','external_contact') GROUP BY entity_type ORDER BY entity_type`, [tenantId],
      );
      assert(baselines.rows.length === 2 && baselines.rows.every((row) => row.count === 1 && row.origin === "baseline" && row.recorded_at >= preMigrationAt), "Core identity migration baseline is not truthful or unique");
      const coverage = await verify.query<{ entity_type: string; coverage_started_at: Date }>(
        "SELECT entity_type,coverage_started_at FROM finnor_os.canonical_history_coverage WHERE entity_type IN ('external_organization','external_contact') ORDER BY entity_type",
      );
      assert(coverage.rows.length === 2, "Core identity history coverage was not recorded");
      const invented = await verify.query<{ count: number }>(
        `SELECT count(*)::int count FROM finnor_os.canonical_entity_versions v
          JOIN finnor_os.canonical_history_coverage c ON c.entity_type=v.entity_type
         WHERE v.tenant_id=$1 AND v.entity_type IN ('external_organization','external_contact') AND v.recorded_at<c.coverage_started_at`, [tenantId],
      );
      assert(invented.rows[0]?.count === 0, "populated upgrade invented pre-baseline identity history");
      return { applied, identitiesPreserved: 3, fabricatedScope4Rows: 0, coreIdentityBaselines: 2, preBaselineRows: 0 };
    } finally { await verify.end(); }
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}

function percentile(values: number[], p: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * p) - 1)] ?? 0;
}

async function measured(operation: string, thresholdMs: number, callback: () => Promise<unknown>): Promise<Metric> {
  for (let index = 0; index < 2; index += 1) await callback();
  const values: number[] = [];
  for (let index = 0; index < 12; index += 1) {
    const start = performance.now(); await callback(); values.push(performance.now() - start);
  }
  const metric = { operation, samples: values.length, p50Ms: Number(percentile(values, 0.5).toFixed(2)), p95Ms: Number(percentile(values, 0.95).toFixed(2)), maxMs: Number(Math.max(...values).toFixed(2)), thresholdMs };
  assert(metric.p95Ms < thresholdMs, `${operation} p95 ${metric.p95Ms}ms exceeded ${thresholdMs}ms`);
  return metric;
}

async function benchmark(url: string): Promise<{ corpus: Record<string, number>; metrics: Metric[]; plans: Record<string, unknown> }> {
  const admin = new pg.Client({ connectionString: url }); await admin.connect();
  const tenantId = "60000000-0000-4000-8000-000000000001";
  const userId = "60000000-0000-4000-8000-000000000002";
  const evidenceSource = "60000000-0000-4000-8000-000000000003";
  const evidenceVersion = "60000000-0000-4000-8000-000000000004";
  try {
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    await admin.query("SET app.test_vertical_mode='explicit'");
    await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,'scope4-benchmark','Scope 4 benchmark') ON CONFLICT DO NOTHING", [tenantId]);
    await admin.query("SELECT set_config('app.tenant_id',$1,false),set_config('app.user_id',$2,false)", [tenantId, userId]);
    await admin.query("SELECT * FROM finnor_os.configure_tenant_vertical($1,'private_equity',0,$2,'certification:scope4',NULL)", [tenantId, userId]);
    await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,'scope4-benchmark@test.invalid','owner','active','Benchmark owner') ON CONFLICT DO NOTHING", [userId, tenantId]);
    await admin.query(`INSERT INTO finnor_os.evidence_sources(id,scope,tenant_id,source_key,source_type,title)
      VALUES($1,'tenant',$2,'scope4-benchmark-evidence','document','Scope 4 benchmark evidence') ON CONFLICT DO NOTHING`, [evidenceSource, tenantId]);
    await admin.query(`INSERT INTO finnor_os.evidence_source_versions(id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of,retrieved_at)
      VALUES($1,$2,'tenant',$3,1,$4,'Synthetic benchmark facts','{}','2024-01-01','2024-01-01') ON CONFLICT DO NOTHING`, [evidenceVersion, evidenceSource, tenantId, "c".repeat(64)]);
    await admin.query(`INSERT INTO finnor_os.external_organizations(tenant_id,organization_key,name,kind)
      SELECT $1,'bench-company-'||lpad(g::text,4,'0'),'Benchmark Company '||lpad(g::text,4,'0'),'other' FROM generate_series(1,200) g` , [tenantId]);
    await admin.query(`INSERT INTO finnor_os.pe_funds(tenant_id,name,vintage_year,base_currency,status,source_system,external_id,created_by)
      SELECT $1,'Benchmark Fund '||g,2020+(g%6),'USD','active','certification:scope4','fund-'||g,$2 FROM generate_series(1,10) g`, [tenantId, userId]);
    await admin.query(`INSERT INTO finnor_os.pe_vehicles(tenant_id,name,vehicle_type,jurisdiction,status,source_system,external_id,created_by)
      SELECT $1,'Benchmark Vehicle '||g,CASE WHEN g%2=0 THEN 'parallel' ELSE 'main' END,'US','active','certification:scope4','vehicle-'||g,$2 FROM generate_series(1,20) g`, [tenantId, userId]);
    await admin.query(`INSERT INTO finnor_os.pe_fund_vehicle_links(tenant_id,fund_id,vehicle_id,relationship_kind,valid_from,completeness,evidence_source_id,evidence_version_id,source_system,external_id,created_by)
      SELECT $1,f.id,v.id,CASE WHEN row_number() OVER(ORDER BY v.id)%2=0 THEN 'parallel' ELSE 'master' END,'2024-01-01','complete',$2,$3,'certification:scope4','fv-'||v.id,$4
        FROM (SELECT id,row_number() OVER(ORDER BY id) n FROM finnor_os.pe_vehicles WHERE tenant_id=$1) v
        JOIN (SELECT id,row_number() OVER(ORDER BY id) n FROM finnor_os.pe_funds WHERE tenant_id=$1) f ON f.n=((v.n-1)%10)+1`, [tenantId, evidenceSource, evidenceVersion, userId]);
    await admin.query(`INSERT INTO finnor_os.pe_deals(tenant_id,target_organization_id,name,code_name,deal_lead_employee_id,signed_loi_at,target_closing_at,source_system,external_id,created_by)
      SELECT $1,o.id,'Acquisition of '||o.name,'B'||lpad(row_number() OVER(ORDER BY o.id)::text,4,'0'),$2::uuid,'2024-10-01','2025-01-15','certification:scope4','deal-'||o.id,$2::text
        FROM finnor_os.external_organizations o WHERE o.tenant_id=$1 AND o.organization_key LIKE 'bench-company-%'`, [tenantId, userId]);
    await admin.query(`INSERT INTO finnor_os.authority_decisions
        (tenant_id,employee_id,authority_revision,operation,capability,resource_type,resource_id,risk,outcome,reason_code,evidence)
      SELECT $1,$2,coalesce((SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1),1),
        'action','private_equity:close_deal','pe_deal',d.id,'high','allowed','scope4_benchmark','{}'::jsonb
        FROM finnor_os.pe_deals d WHERE d.tenant_id=$1 AND d.external_id LIKE 'deal-%'`, [tenantId, userId]);
    await admin.query(`SELECT finnor_os.pe_declare_deal_closed(
        $1,d.id,d.version,d.graph_version,a.id,NULL,'certification:scope4',$2::text)
      FROM finnor_os.pe_deals d
      JOIN finnor_os.authority_decisions a ON a.tenant_id=d.tenant_id AND a.resource_type='pe_deal'
        AND a.resource_id=d.id AND a.capability='private_equity:close_deal'
      WHERE d.tenant_id=$1 AND d.external_id LIKE 'deal-%'`, [tenantId, userId]);
    await admin.query(`INSERT INTO finnor_os.pe_portfolio_holdings(tenant_id,fund_id,company_id,origin_deal_id,entry_date,completeness,evidence_source_id,evidence_version_id,source_system,external_id,created_by)
      SELECT $1,f.id,o.id,d.id,d.actual_close_at::date,'complete',$2,$3,'certification:scope4','holding-'||o.id,$4
        FROM (SELECT id,row_number() OVER(ORDER BY id) n FROM finnor_os.external_organizations WHERE tenant_id=$1 AND organization_key LIKE 'bench-company-%') o
        JOIN finnor_os.pe_deals d ON d.tenant_id=$1 AND d.target_organization_id=o.id
        JOIN (SELECT id,row_number() OVER(ORDER BY id) n FROM finnor_os.pe_funds WHERE tenant_id=$1) f ON f.n=((o.n-1)%10)+1`, [tenantId, evidenceSource, evidenceVersion, userId]);
    await admin.query(`INSERT INTO finnor_os.pe_securities(tenant_id,issuer_company_id,security_key,security_type,name,currency_code,valid_from,completeness,evidence_source_id,evidence_version_id,source_system,external_id,created_by)
      SELECT $1,o.id,'COMMON','common_equity','Common Equity','USD','2025-01-15','complete',$2,$3,'certification:scope4','security-'||o.id,$4 FROM finnor_os.external_organizations o WHERE o.tenant_id=$1 AND o.organization_key LIKE 'bench-company-%'`, [tenantId, evidenceSource, evidenceVersion, userId]);
    await admin.query(`INSERT INTO finnor_os.pe_debt_facilities(tenant_id,borrower_company_id,facility_key,name,facility_type,committed_amount,currency_code,status,valid_from,completeness,evidence_source_id,evidence_version_id,source_system,external_id,created_by)
      SELECT $1,o.id,'TLA','Term Loan A','term_loan',50000000,'USD','active','2025-01-15','complete',$2,$3,'certification:scope4','facility-'||o.id,$4 FROM finnor_os.external_organizations o WHERE o.tenant_id=$1 AND o.organization_key LIKE 'bench-company-%'`, [tenantId, evidenceSource, evidenceVersion, userId]);
    await admin.query(`INSERT INTO finnor_os.pe_ownership_interests(tenant_id,owner_type,owner_id,subject_type,subject_id,economic_percentage,ownership_class,valid_from,completeness,evidence_source_id,evidence_version_id,source_system,external_id,created_by)
      SELECT $1,'pe_fund',f.id,'external_organization',o.id,0.6,'common','2025-01-15','complete',$2,$3,'certification:scope4','ownership-'||o.id,$4
        FROM (SELECT id,row_number() OVER(ORDER BY id) n FROM finnor_os.external_organizations WHERE tenant_id=$1 AND organization_key LIKE 'bench-company-%') o
        JOIN (SELECT id,row_number() OVER(ORDER BY id) n FROM finnor_os.pe_funds WHERE tenant_id=$1) f ON f.n=((o.n-1)%10)+1`, [tenantId, evidenceSource, evidenceVersion, userId]);
    await admin.query(`INSERT INTO finnor_os.pe_fact_coverage(tenant_id,subject_type,subject_id,proposition,coverage_status,valid_from,evidence_source_id,evidence_version_id,source_system,external_id,created_by)
      SELECT $1,'external_organization',o.id,p.proposition,'complete','2025-01-15',$2,$3,'certification:scope4',p.proposition||'-'||o.id,$4
        FROM finnor_os.external_organizations o CROSS JOIN (VALUES('ownership_total'),('company_debt')) p(proposition)
       WHERE o.tenant_id=$1 AND o.organization_key LIKE 'bench-company-%'`, [tenantId, evidenceSource, evidenceVersion, userId]);
    await admin.query(`INSERT INTO finnor_os.pe_metric_series(tenant_id,subject_type,subject_id,metric_key,name,unit,currency_code,frequency,source_system,external_id,created_by)
      SELECT $1,'external_organization',o.id,'revenue','Revenue','currency','USD','quarterly','certification:scope4','metric-'||o.id,$2 FROM finnor_os.external_organizations o WHERE o.tenant_id=$1 AND o.organization_key LIKE 'bench-company-%'`, [tenantId, userId]);
    await admin.query(`INSERT INTO finnor_os.pe_metric_observations(tenant_id,metric_series_id,period_start,period_end,value_type,value_numeric,evidence_source_id,evidence_version_id,source_system,external_id,created_by)
      SELECT $1,s.id,make_date(2024+((g-1)/4),1+(((g-1)%4)*3),1),make_date(2024+((g-1)/4),1+(((g-1)%4)*3),1)+interval '3 months - 1 day','number',10000000+(g*100000),$2,$3,'certification:scope4','observation-'||s.id||'-'||g,$4
        FROM finnor_os.pe_metric_series s CROSS JOIN generate_series(1,5) g WHERE s.tenant_id=$1`, [tenantId, evidenceSource, evidenceVersion, userId]);

    const root = (await admin.query<{ id: string }>("SELECT id::text FROM finnor_os.external_organizations WHERE tenant_id=$1 AND organization_key='bench-company-0199'", [tenantId])).rows[0]!.id;
    const fund = (await admin.query<{ id: string }>("SELECT id::text FROM finnor_os.pe_funds WHERE tenant_id=$1 ORDER BY name LIMIT 1", [tenantId])).rows[0]!.id;
    await admin.query("ANALYZE finnor_os.canonical_entity_versions; ANALYZE finnor_os.pe_metric_observations; ANALYZE finnor_os.external_organizations");
    const planResult = await admin.query<{ plan: unknown }>(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
      SELECT DISTINCT ON(entity_type,entity_id) entity_type,entity_id,snapshot FROM finnor_os.canonical_entity_versions
       WHERE tenant_id=$1 AND recorded_at<=now() AND entity_type=ANY($2::text[])
       ORDER BY entity_type,entity_id,recorded_at DESC,entity_version DESC`, [tenantId, ["external_organization", "pe_portfolio_holding", "pe_ownership_interest", "pe_metric_series", "pe_metric_observation"]]);

    process.env.DATABASE_URL = url.replace(/\/\/[^@]+@/, "//finnor_app:finnor_app@");
    await closePool();
    const ctx: PeMutationContext = { auth: { tenantId, userId, employeeId: userId, role: "owner" } };
    const currentValidAt = new Date().toISOString();
    let companyProjection = await loadCompanyBrainProjection(ctx, { root: { entityType: "external_organization", entityId: root }, validAt: currentValidAt });
    const metrics: Metric[] = [];
    metrics.push(await measured("company lookup/search", 1_000, () => listCompanyBrainRoots(ctx, { query: "Benchmark Company 0199", limit: 20 })));
    metrics.push(await measured("Company projection", 3_500, async () => { companyProjection = await loadCompanyBrainProjection(ctx, { root: { entityType: "external_organization", entityId: root }, validAt: currentValidAt }); }));
    metrics.push(await measured("Fund/portfolio projection", 4_000, () => loadCompanyBrainProjection(ctx, { root: { entityType: "pe_fund", entityId: fund }, validAt: currentValidAt })));
    metrics.push(await measured("bounded traversal", 100, async () => { traverseCompanyBrain(companyProjection, { namespace: "core", owner: "@finnor/db", type: "external_organization", id: root }, { depth: 3, limit: 100 }); }));
    metrics.push(await measured("historical/as-of projection", 4_000, () => loadCompanyBrainProjection(ctx, { root: { entityType: "external_organization", entityId: root }, validAt: "2025-03-31T23:59:59.000Z", knowledgeAt: new Date().toISOString() })));
    metrics.push(await measured("ownership closed-world as-of", 1_000, () => closedWorldClaimPermitted(ctx, { subjectType: "external_organization", subjectId: root, proposition: "ownership_total", validAt: new Date(currentValidAt) })));
    assert(companyProjection.capitalStructures.some((row) => row.companyId === root && row.observedEconomicPercentageTotal === "0.6"), "benchmark Company projection did not include complete observed capital structure");
    assert(companyProjection.nodes.some((node) => node.type === "pe_metric_observation"), "benchmark Company projection did not include metric history");
    const plan = (planResult.rows[0] as unknown as Record<string, unknown>)?.["QUERY PLAN"] ?? planResult.rows[0];
    return { corpus: { companies: 200, funds: 10, vehicles: 20, closedDeals: 200, holdings: 200, securities: 200, debtFacilities: 200, ownershipInterests: 200, coverageFacts: 400, metricSeries: 200, metricObservations: 1_000 }, metrics, plans: { canonicalHistory: plan } };
  } finally {
    await closePool();
    await admin.end();
  }
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const directory = await mkdtemp(join(tmpdir(), "finnor-scope4-certification-"));
  const port = await freePort();
  const postgres = new EmbeddedPostgres({ databaseDir: directory, user: "finnor", password: "finnor", port, persistent: false, onLog: () => undefined });
  const databaseNames = { fresh: "scope4_fresh", upgrade: "scope4_upgrade" };
  const url = (name: string) => `postgres://finnor:finnor@127.0.0.1:${port}/${name}`;
  const gates: Gate[] = [];
  let report: Record<string, unknown> | null = null;
  process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
  try {
    await postgres.initialise(); await postgres.start();
    await postgres.createDatabase(databaseNames.fresh); await postgres.createDatabase(databaseNames.upgrade);
    const files = await migrationFiles();
    const freshApplied = await migrate(url(databaseNames.fresh), files);
    const fresh = await inspectFresh(url(databaseNames.fresh));
    gates.push({ id: "fresh-database", status: "PASS_INTEGRATION", evidence: `${freshApplied.length} forward migrations; head 0139; 18 forced-RLS history owners` });
    const upgrade = await populatedUpgrade(url(databaseNames.upgrade), files);
    gates.push({ id: "populated-upgrade", status: "PASS_INTEGRATION", evidence: "0138 populated Core identities and PE Strategy preserved byte-for-byte; zero fabricated Scope 4 rows; honest baselines" });

    await command("typecheck", "npm", ["run", "typecheck", "--", "--pretty", "false"]);
    gates.push({ id: "typecheck", status: "PASS_LOCAL", evidence: "repository TypeScript project" });
    await command("relationship-matrix", "npx", ["tsx", "scripts/release/generate-scope4-relationship-contracts.ts", "--check"]);
    gates.push({ id: "relationship-contracts", status: "PASS_LOCAL", evidence: "66 runtime relationship contracts exactly match checked-in certification matrix" });
    await command("domain-boundary", "npm", ["run", "PE-DOMAIN-BOUNDARY"]);
    gates.push({ id: "pe-domain-boundary", status: "PASS_LOCAL", evidence: "canonical PE ownership boundary verifier" });

    const testEnv = { DATABASE_URL: url(databaseNames.fresh), FINNOR_TEST_MANAGED_EXTENSIONS: "omit" };
    await command("scope4-and-unit-regressions", "npx", ["vitest", "run",
      "packages/private-equity/src/company-brain.test.ts", "packages/private-equity/src/semantic-activity.test.ts",
      "tests/unit/private-equity-state-machines.test.ts", "tests/unit/private-equity-p1-world.test.ts",
      "tests/unit/private-equity-epistemic.test.ts", "tests/unit/private-equity-phase4-contract.test.ts",
      "tests/unit/private-equity-p5-contract.test.ts", "tests/unit/source-truth-contract.test.ts",
      "tests/unit/scope1-orchestration-kernel.test.ts", "tests/unit/scope3-compute-contract.test.ts",
      "--no-file-parallelism", "--maxWorkers=1"], REPO, testEnv);
    gates.push({ id: "unit-regressions", status: "PASS_LOCAL", evidence: "Company Brain, PE state/epistemic/underwriting/IC, Source Truth, Scope 1 and Scope 3 contract suites" });

    const databaseRegressionFiles = [
      "tests/integration/private-equity-scope4-digital-twin.test.ts",
      "tests/integration/private-equity-phase2.test.ts",
      "tests/integration/private-equity-p1-world-truth.test.ts",
      "tests/integration/private-equity-p4-underwriting.test.ts",
      "tests/integration/private-equity-p5-ic-runtime.test.ts",
      "tests/integration/source-truth-loop.test.ts",
      "tests/integration/work-kernel.test.ts",
      "tests/integration/phase6-plan-graph-runtime.test.ts",
      "tests/integration/scope1-orchestration-concurrency.test.ts",
      "tests/integration/scope2-effect-protocol.test.ts",
      "tests/integration/scope2-operator-controls.test.ts",
    ];
    // Each integration file gets a fresh Node process. Several legacy suites
    // deliberately swap DATABASE_URL between the migration and RLS roles; worker
    // reuse would let one file's process.env and pool state contaminate the next.
    for (const testFile of databaseRegressionFiles) {
      await command(`database:${testFile.split("/").at(-1)}`, "npx", ["vitest", "run", testFile, "--no-file-parallelism", "--maxWorkers=1"], REPO, testEnv, 600_000);
    }
    await command("scope3-focused-disposable", "npm", ["run", "release:scope3:focused"], REPO, {}, 900_000);
    gates.push({ id: "database-regressions", status: "PASS_INTEGRATION", evidence: "Scope 4 adversarial; existing PE close/world/Underwriting/IC; Source Truth, Work/Planning, and Scope 1-2 database suites; focused 44-test Scope 3 disposable suite" });

    await command("phase15a-release-policy", "npm", ["run", "test:release"], WORKSPACE, {}, 900_000);
    gates.push({ id: "phase15a", status: "PASS_LOCAL", evidence: "production target, protected environment, PR verdict, mutation inventory, and release policy suite" });

    const performanceEvidence = await benchmark(url(databaseNames.fresh));
    gates.push({ id: "postgres-graph-benchmark", status: "PASS_INTEGRATION", evidence: `${performanceEvidence.metrics.length} measured operations on representative 200-company / 1,000-observation corpus; all p95 guardrails passed` });
    gates.push({ id: "live-provider-validation", status: "BLOCKED_EXTERNAL", evidence: "No SEC, GLEIF, PitchBook, Preqin, CapIQ, Grata, SourceScrub, or equivalent credential/data source was supplied; no live-provider claim made" });

    report = {
      phase: "Phase 4 — Company Brain / PE Digital Twin",
      status: "PASS_INTEGRATION",
      startedAt,
      completedAt: new Date().toISOString(),
      migrationHead: CURRENT_MIGRATION_HEAD,
      evidenceLevels: { local: "PASS_LOCAL", database: "PASS_INTEGRATION", liveProviders: "BLOCKED_EXTERNAL" },
      freshDatabase: fresh,
      populatedUpgrade: upgrade,
      benchmark: performanceEvidence,
      gates,
      graphStoreConclusion: "PostgreSQL met every measured p95 guardrail on the representative bounded corpus. No graph-store bakeoff or dual-write is justified by evidence.",
      blockedExternal: ["Live third-party company, person, ownership, debt, metric, and benchmark provider certification"],
    };
    await mkdir(dirname(REPORT_JSON), { recursive: true });
    await writeFile(REPORT_JSON, `${JSON.stringify(report, null, 2)}\n`);
    const metricRows = performanceEvidence.metrics.map((metric) => `| ${metric.operation} | ${metric.samples} | ${metric.p50Ms} | ${metric.p95Ms} | ${metric.maxMs} | ${metric.thresholdMs} |`).join("\n");
    const gateRows = gates.map((gate) => `| ${gate.id} | ${gate.status} | ${gate.evidence.replaceAll("|", "\\|")} |`).join("\n");
    await writeFile(REPORT_MD, `# Phase 4 Company Brain certification\n\nStatus: **PASS_INTEGRATION**\n\nLive provider evidence: **BLOCKED_EXTERNAL**\n\n## Gates\n\n| Gate | Status | Evidence |\n| --- | --- | --- |\n${gateRows}\n\n## Benchmark corpus\n\n\`\`\`json\n${JSON.stringify(performanceEvidence.corpus, null, 2)}\n\`\`\`\n\n## Measured Postgres operations\n\n| Operation | Samples | p50 ms | p95 ms | max ms | p95 guardrail ms |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${metricRows}\n\nPostgreSQL met all measured guardrails. The evidence does not justify a graph database, bakeoff, or dual-write.\n\n## Migration\n\nFresh database: **PASS_INTEGRATION**. Populated 0138 to 0139 upgrade: **PASS_INTEGRATION**. Existing Company, Person, and Strategy identities were preserved; no Phase 4 business row or pre-baseline history was fabricated.\n`);
    console.log(`\nSCOPE4_CERTIFICATION ${JSON.stringify({ status: report.status, gates: gates.length, report: REPORT_JSON })}`);
  } finally {
    await closePool().catch(() => undefined);
    await postgres.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
