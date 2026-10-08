/** S1 end-to-end challenges, authored before the implementation.
 * Expectations use fixed predicates and direct SQL, never S1 reconstruction.
 * Run with a clean environment as documented in scope-evidence/README.md. */
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";
import { migrate } from "../../packages/db/migrate";
import { closePool, getPool, configureTenantVertical, withTenantTransaction } from "@finnor/db";
import { createEvidenceSource, appendEvidenceVersion } from "@finnor/memory";
import { createStrategy, createMetricSeries, recordMetricObservation, restateMetricObservation,
  attachCanonicalEvidenceToWorld, loadPrivateEquityWorldState, loadCompanyBrainProjection, listCompanyBrainRoots,
  executePrivateEquityOperationalQuery, loadEnterpriseBeliefView, validateBeliefViewPin,
  createDeal,
  createFund, createPortfolioHolding, createInvestmentCase, createThesis, createAssumption,
  type PeMutationContext } from "@finnor/private-equity";
import { createEpistemicState, createEvidenceRecord, appendEvidenceAndRecompute, stageDurableEpistemicGraph, baselineDurableEpistemicGraph, replayDurableEpistemicGraph, compareDurableShadowWithOracle, processDurableEpistemicChange,
  EPISTEMIC_HEURISTIC_VERSION, type EvidenceRecord } from "@finnor/epistemic-runtime";
import type { BeliefDecisionContext, BeliefView } from "@finnor/shared-types";
import { POST as companyBrainPost } from "../../apps/api/app/api/company-brain/[operation]/route";
import { assembleOperatingContext } from "../../packages/orchestration/src/operating-context";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const output = resolve(process.env.FINNOR_S1_EVIDENCE_DIR ?? join(repo, "scope-evidence", `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`));
type CaseResult = { id: string; input: unknown; expected: string; status: "PASS" | "FAIL"; observed: unknown; durationMs: number };
const results: CaseResult[] = [];
const startedAt = new Date().toISOString();
const codePaths = ["finnor-os/scripts/s1/run-s1-e2e.mts", "finnor-os/packages/private-equity/src/enterprise-beliefs.ts", "finnor-os/packages/private-equity/src/world-state.ts",
  "finnor-os/packages/private-equity/src/company-brain.ts", "finnor-os/packages/epistemic-runtime/src/belief-view.ts", "finnor-os/packages/epistemic-runtime/src/belief-update.ts",
  "finnor-os/packages/epistemic-runtime/src/durable.ts", "finnor-os/packages/memory/src/evidence.ts", "finnor-os/packages/shared-types/src/enterprise-beliefs.ts",
  "finnor-os/packages/orchestration/src/operating-context.ts", "finnor-os/apps/api/app/api/company-brain/[operation]/route.ts", "finnor-os/packages/authority/src/index.ts",
  "package-lock.json", "finnor-os/package-lock.json"];
const codeManifest = await Promise.all(codePaths.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(resolve(repo, path))).digest("hex") })));
let databaseVersion = "unavailable";
let migrationCount = 0;
const commitTracking = process.env.FINNOR_S1_COMMIT_TRACKING !== "off";
const workloads: unknown[] = [];

async function challenge(id: string, input: unknown, expected: string, fn: () => Promise<unknown>): Promise<void> {
  const start = performance.now();
  try { results.push({ id, input, expected, status: "PASS", observed: await fn(), durationMs: performance.now() - start }); }
  catch (error) { results.push({ id, input, expected, status: "FAIL", observed: error instanceof Error ? { message: error.message, stack: error.stack } : String(error), durationMs: performance.now() - start }); }
  await save();
}
async function save(): Promise<void> {
  await mkdir(output, { recursive: true });
  const versions: Record<string, string> = { node: process.version };
  for (const name of ["pg", "embedded-postgres", "tsx", "typescript", "next", "vitest"]) {
    try { versions[name] = JSON.parse(await readFile(resolve(repo, "finnor-os/node_modules", name, "package.json"), "utf8")).version; } catch { versions[name] = "unavailable"; }
  }
  await writeFile(join(output, "results.json"), JSON.stringify({ schema: "finnor.s1.e2e.v1", startedAt, generatedAt: new Date().toISOString(),
    status: results.some(r => r.status === "FAIL") ? "FAIL" : "PASS_LOCAL", versions, databaseVersion, migrationCount,
    boundary: "Disposable PostgreSQL; fixtures written by administrator; all application/reference reads use ordinary finnor_app. No live provider, JWT, protected ledger or economic certification.",
    oracle: "Direct immutable-history SQL and PostgreSQL numeric predicates; no production reconstruction in expected-answer generation.",
    commitTracking, codeManifest, results, workloads, rerun: "See scope-evidence/README.md; scripts/s1/run-s1-e2e.mts" }, null, 2) + "\n");
}
const directory = await mkdtemp(join(tmpdir(), "finnor-s1-e2e-"));
const port = await new Promise<number>((yes, no) => { const s = createServer(); s.once("error", no); s.listen(0, "127.0.0.1", () => { const a = s.address(); if (!a || typeof a === "string") return no(new Error("port unavailable")); s.close(() => yes(a.port)); }); });
const postgres = new EmbeddedPostgres({ databaseDir: directory, user: "finnor", password: "finnor", port, persistent: false, onLog: () => undefined });
let admin: pg.Client | undefined;
const tenant = randomUUID(); const otherTenant = randomUUID(); const actor = randomUUID(); const otherActor = randomUUID();
const company = randomUUID(); const otherCompany = randomUUID();
const ctx: PeMutationContext = { auth: { tenantId: tenant, userId: actor, employeeId: actor, role: "owner" }, provenance: { sourceSystem: "s1:e2e", createdBy: actor } };
const root = { entityType: "external_organization", entityId: company } as const;
const periodStart = "2026-01-01T00:00:00.000Z"; const periodEnd = "2026-01-31T00:00:00.000Z";
const validAt = "2026-02-01T00:00:00.000Z";
const decision: BeliefDecisionContext = { id: "external-threshold", version: "1", evidenceUniverse: "registered_canonical_records",
  requirements: [{ id: "tail", subject: root, metricKey: "revenue", unit: "currency", currencyCode: "USD", periodStart, periodEnd,
    operator: "gte", threshold: "9007199254740993.000000000001" }] };
// API instants are millisecond Dates. Leave a real 3 ms interval after prior
// commits so truncating PostgreSQL's microsecond clock cannot predate them.
const clock = async () => (await admin!.query<{ at: Date }>("SELECT clock_timestamp() at FROM pg_sleep(0.003)")).rows[0]!.at.toISOString();
const read = <T extends pg.QueryResultRow>(text: string, values: unknown[]) => withTenantTransaction(tenant, { userId: actor, readOnly: true, isolation: "repeatable read" }, (_db, client) => client.query<T>(text, values));

/** Independent full-resolution reference for this fixed metric decision. */
async function reference(knownAt: string): Promise<{ ids: string[]; matches: string[]; values: string[] }> {
  const r = await read<{ id: string; value: string; matches: boolean }>(`WITH latest AS (
      SELECT DISTINCT ON (entity_type,entity_id) entity_type,entity_id,snapshot
      FROM finnor_os.canonical_entity_versions WHERE tenant_id=$1 AND recorded_at<=$2 AND pg_xact_commit_timestamp(xmin)<=$2
      ORDER BY entity_type,entity_id,entity_version DESC
    ), series AS (SELECT entity_id,snapshot FROM latest WHERE entity_type='pe_metric_series'
      AND snapshot->>'subject_id'=$3 AND snapshot->>'metric_key'='revenue'
      AND snapshot->>'unit'='currency' AND snapshot->>'currency_code'='USD')
    SELECT o.entity_id::text id,o.snapshot->>'value_numeric' value,
      (o.snapshot->>'value_numeric')::numeric >= $6::numeric matches
    FROM latest o JOIN series s ON s.entity_id::text=o.snapshot->>'metric_series_id'
    WHERE o.entity_type='pe_metric_observation' AND o.snapshot->>'superseded_at' IS NULL
      AND (o.snapshot->>'period_start')::timestamptz=$4 AND (o.snapshot->>'period_end')::timestamptz=$5
    ORDER BY o.entity_id`, [tenant, knownAt, company, periodStart, periodEnd, decision.requirements[0]!.threshold]);
  return { ids: r.rows.map(x => x.id), matches: r.rows.filter(x => x.matches).map(x => x.id), values: r.rows.map(x => x.value) };
}

/** Exercise the existing durable runtime, not a reconstructed substitute graph. */
async function durableCommitChallenge(): Promise<unknown> {
  const source = await createEvidenceSource(otherTenant, { sourceKey: `s1:durable:${randomUUID()}`, sourceType: "manual", title: "S1 durable commit visibility" });
  const initial = await appendEvidenceVersion(otherTenant, source.id, { content: "before", snapshot: { rating: "before" }, asOf: new Date(periodStart) });
  const propositionId = `s1:durable:${source.id}`;
  const graph = await stageDurableEpistemicGraph({ tenantId: otherTenant, ruleVersion: "scope5-materiality-v1", heuristicVersion: EPISTEMIC_HEURISTIC_VERSION,
    propositions: [{ id: propositionId, subject: { kind: "entity", type: "evidence_source", id: source.id }, predicate: { name: "rating" } }], dependencies: [],
    bindings: [{ propositionId, sourceKind: "evidence_source", sourceType: "manual", sourceId: source.id, valuePath: "rating", evidenceKind: "DOCUMENT" }] });
  assert.equal((await baselineDurableEpistemicGraph(otherTenant, 1)).complete, true);
  const baselineCut = await clock();
  const at = (knownAt: string) => replayDurableEpistemicGraph({ tenantId: otherTenant, graphVersionId: graph.graphVersionId, validAt: periodEnd, knownAt });
  if (!commitTracking) {
    const unavailable = await at(baselineCut);
    await writeFile(join(output, "durable-commit-observations.json"), JSON.stringify({ graph, baselineCut, sourceId: source.id, initialVersion: initial.versionId,
      expected: "UNAVAILABLE_COMMIT_VISIBILITY", actual: unavailable, commitTracking, ordinaryRole: "finnor_app" }, null, 2));
    assert.equal(unavailable.status, "UNAVAILABLE_COMMIT_VISIBILITY");
    const currentComparison = await compareDurableShadowWithOracle(otherTenant, { recordShadowCheckpoint: false });
    assert.equal(currentComparison.equivalent, true); assert.equal(currentComparison.checked, 1);
    return { graph, baselineCut, unavailable, currentComparison, sourceId: source.id, initialVersion: initial.versionId };
  }
  const before = await at(baselineCut); assert.equal(before.status, "AVAILABLE");
  let release!: () => void; let inserted!: () => void; let failInsert!: (error: unknown) => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>((resolve, reject) => { inserted = resolve; failInsert = reject; });
  const lateVersion = randomUUID();
  const writer = withTenantTransaction(otherTenant, { userId: otherActor }, async (_db, client) => {
    await client.query("INSERT INTO finnor_os.evidence_source_versions(id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of) VALUES($1,$2,'tenant',$3,2,$4,'after',$5,$6)",
      [lateVersion, source.id, otherTenant, createHash("sha256").update("after").digest("hex"), { rating: "after" }, periodStart]);
    inserted(); await pending;
  });
  void writer.catch(failInsert);
  let during!: string; let whilePending;
  try { await ready; during = await clock(); whilePending = await at(during); await clock(); }
  finally { release(); await writer; }
  const independent = await withTenantTransaction(otherTenant, { userId: otherActor, readOnly: true }, (_db, client) => client.query<{ id: string; rating: string; committed_at: Date }>(
    "SELECT id,snapshot->>'rating' rating,pg_xact_commit_timestamp(xmin) committed_at FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND source_id=$2 AND pg_xact_commit_timestamp(xmin)<=$3 ORDER BY version_number", [otherTenant, source.id, during]));
  assert.deepEqual(independent.rows.map(row => row.id), [initial.versionId]);
  const replay = await at(during); const currentCut = await clock(); const current = await at(currentCut);
  const sourceVersions = await withTenantTransaction(otherTenant, { userId: otherActor, readOnly: true }, (_db, client) => client.query(
    "SELECT id,version_number,snapshot->>'rating' rating,created_at,retrieved_at,pg_xact_commit_timestamp(xmin) committed_at,pg_xact_commit_timestamp(xmin)<=$3 visible_at_cut FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND source_id=$2 ORDER BY version_number", [otherTenant, source.id, during]));
  await writeFile(join(output, "durable-commit-observations.json"), JSON.stringify({ graph, sourceId: source.id, initialVersion: initial.versionId, lateVersion,
    baselineCut, during, currentCut, before, whilePending, independent: independent.rows, sourceVersions: sourceVersions.rows, replay, current, expectedAtCut: "before", expectedCurrent: "after",
    commitTracking, ordinaryRole: "finnor_app", boundary: "Staged computational graph, no protected activation/effect/receipt" }, null, 2));
  assert.equal(replay.status, "AVAILABLE"); assert.equal(current.status, "AVAILABLE");
  if (replay.status === "AVAILABLE" && current.status === "AVAILABLE") {
    assert.deepEqual(replay.state.propositions.find(row => row.id === propositionId)?.value, { kind: "DETERMINISTIC", value: "before" });
    assert.deepEqual(current.state.propositions.find(row => row.id === propositionId)?.value, { kind: "DETERMINISTIC", value: "after" });
  }
  // Processing changes mutable queue-row xmin after currentCut. That must not
  // erase the immutable source knowledge already legitimately visible there.
  const changes = await withTenantTransaction(otherTenant, { userId: otherActor, readOnly: true }, (_db, client) => client.query<{ id: string }>(
    "SELECT id FROM finnor_os.epistemic_changes WHERE tenant_id=$1 AND status<>'processed' ORDER BY ingestion_order", [otherTenant]));
  assert.equal(changes.rows.length, 1);
  assert.equal((await processDurableEpistemicChange(otherTenant, changes.rows[0]!.id)).complete, true);
  const processed = await withTenantTransaction(otherTenant, { userId: otherActor, readOnly: true }, (_db, client) => client.query(
    "SELECT id,status,pg_xact_commit_timestamp(xmin) committed_at,pg_xact_commit_timestamp(xmin)>$3 updated_after_cut FROM finnor_os.epistemic_changes WHERE tenant_id=$1 AND id=$2", [otherTenant, changes.rows[0]!.id, currentCut]));
  const afterProcessing = await at(currentCut);
  await writeFile(join(output, "durable-worker-observations.json"), JSON.stringify({ currentCut, changes: processed.rows, afterProcessing,
    expected: "after", reference: sourceVersions.rows, ordinaryRole: "finnor_app" }, null, 2));
  assert.equal(processed.rows[0]?.updated_after_cut, true); assert.equal(afterProcessing.status, "AVAILABLE");
  if (afterProcessing.status === "AVAILABLE") assert.deepEqual(afterProcessing.state.propositions.find(row => row.id === propositionId)?.value, { kind: "DETERMINISTIC", value: "after" });
  const currentComparison = await compareDurableShadowWithOracle(otherTenant, { recordShadowCheckpoint: false });
  assert.equal(currentComparison.equivalent, true);
  return { graph, sourceId: source.id, initialVersion: initial.versionId, lateVersion, baselineCut, during, currentCut, before, whilePending, independent: independent.rows, replay, current,
    processed: processed.rows, afterProcessing, currentComparison,
    boundary: "Ordinary-role source/graph runtime and independent SQL. Graph staged for computation only; no activation, heartbeat, protected release, business effect or ExperienceLedger receipt fabricated." };
}

async function durableCanonicalCommitChallenge(): Promise<unknown> {
  const sourceId = String((await createStrategy(ctx, { name: "S1 canonical commit window" })).row.id);
  const propositionId = `s1:durable-canonical:${sourceId}`;
  const graph = await stageDurableEpistemicGraph({ tenantId: tenant, ruleVersion: "scope5-materiality-v1", heuristicVersion: EPISTEMIC_HEURISTIC_VERSION,
    propositions: [{ id: propositionId, subject: { kind: "entity", type: "pe_strategy", id: sourceId }, predicate: { name: "state" } }], dependencies: [],
    bindings: [{ propositionId, sourceKind: "canonical_entity", sourceType: "pe_strategy", sourceId, valuePath: "state", evidenceKind: "CANONICAL_DB" }] });
  assert.equal((await baselineDurableEpistemicGraph(tenant, 1)).complete, true);
  const at = (knownAt: string) => replayDurableEpistemicGraph({ tenantId: tenant, graphVersionId: graph.graphVersionId, validAt: knownAt, knownAt });
  let release!: () => void; let inserted!: () => void; let failInsert!: (error: unknown) => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>((resolve, reject) => { inserted = resolve; failInsert = reject; });
  const writer = withTenantTransaction(tenant, { userId: actor }, async (_db, client) => {
    await client.query("UPDATE finnor_os.pe_strategies SET state='active',activated_at=clock_timestamp(),version=version+1 WHERE tenant_id=$1 AND id=$2", [tenant, sourceId]);
    inserted(); await pending;
  });
  void writer.catch(failInsert);
  let during!: string; let whilePending;
  try { await ready; during = await clock(); whilePending = await at(during); await clock(); }
  finally { release(); await writer; }
  const sourceVersions = await read("SELECT id,entity_version,snapshot->>'state' state,recorded_at,pg_xact_commit_timestamp(xmin) committed_at,pg_xact_commit_timestamp(xmin)<=$3 visible_at_cut FROM finnor_os.canonical_entity_versions WHERE tenant_id=$1 AND entity_type='pe_strategy' AND entity_id=$2 ORDER BY entity_version", [tenant, sourceId, during]);
  const reference = await read("SELECT id,snapshot->>'state' state FROM finnor_os.canonical_entity_versions WHERE tenant_id=$1 AND entity_type='pe_strategy' AND entity_id=$2 AND recorded_at<=$3 AND pg_xact_commit_timestamp(xmin)<=$3 ORDER BY entity_version DESC LIMIT 1", [tenant, sourceId, during]);
  const replay = await at(during); const currentCut = await clock(); const current = await at(currentCut);
  await writeFile(join(output, "durable-canonical-commit-observations.json"), JSON.stringify({ sourceId, graph, during, currentCut, whilePending, sourceVersions: sourceVersions.rows, reference: reference.rows,
    replay, current, expectedAtCut: "draft", expectedCurrent: "active", ordinaryRole: "finnor_app", boundary: "Existing permitted strategy lifecycle transition/history and staged graph; no protected admission" }, null, 2));
  assert.deepEqual(reference.rows.map(row => row.state), ["draft"]);
  assert.equal(sourceVersions.rows.length, 2); assert.equal(sourceVersions.rows[1]?.visible_at_cut, false);
  assert.equal(replay.status, "AVAILABLE"); assert.equal(current.status, "AVAILABLE");
  if (replay.status === "AVAILABLE" && current.status === "AVAILABLE") {
    assert.deepEqual(replay.state.propositions.find(row => row.id === propositionId)?.value, { kind: "DETERMINISTIC", value: "draft" });
    assert.deepEqual(current.state.propositions.find(row => row.id === propositionId)?.value, { kind: "DETERMINISTIC", value: "active" });
  }
  return { graph, sourceId, during, currentCut, sourceVersions: sourceVersions.rows, reference: reference.rows, replay, current };
}

try {
  process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
  await postgres.initialise();
  await appendFile(join(directory, "postgresql.conf"), `\ntrack_commit_timestamp=${commitTracking ? "on" : "off"}\n`);
  await postgres.start(); await postgres.createDatabase("s1_e2e");
  const adminUrl = `postgres://finnor:finnor@127.0.0.1:${port}/s1_e2e`;
  migrationCount = (await migrate(adminUrl)).length;
  admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  databaseVersion = (await admin.query<{ version: string }>("SELECT version() version")).rows[0]!.version;
  await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
  await admin.query("SET app.test_vertical_mode='explicit'");
  await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'S1 A'),($3,$4,'S1 B')", [tenant, randomUUID(), otherTenant, randomUUID()]);
  await admin.query(`INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES
    ($1,$2,$3,'owner','active','S1 A'),($4,$5,$6,'owner','active','S1 B')`, [actor, tenant, `${actor}@test.invalid`, otherActor, otherTenant, `${otherActor}@test.invalid`]);
  process.env.DATABASE_URL = `postgres://finnor_app:finnor_app@127.0.0.1:${port}/s1_e2e`;
  await closePool();
  await configureTenantVertical({ tenantId: tenant, verticalKey: "private_equity", expectedVersion: 0, createdBy: actor, sourceSystem: "s1:e2e" });
  await configureTenantVertical({ tenantId: otherTenant, verticalKey: "private_equity", expectedVersion: 0, createdBy: otherActor, sourceSystem: "s1:e2e" });
  await admin.query(`INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES
    ($1,$2,'s1-company','S1 company','other'),($3,$4,'s1-foreign','FORBIDDEN-S1-FOREIGN','other')`, [company, tenant, otherCompany, otherTenant]);
  const source = await createEvidenceSource(tenant, { sourceKey: `s1:${randomUUID()}`, sourceType: "manual", title: "S1 permitted evidence" });
  const ev = await appendEvidenceVersion(tenant, source.id, { content: "registered statement", snapshot: {}, asOf: new Date(periodStart) });
  const evidence = { evidenceSourceId: source.id, evidenceVersionId: ev.versionId };
  const series = String((await createMetricSeries(ctx, { subjectType: "external_organization", subjectId: company, metricKey: "revenue", name: "Registered revenue", unit: "currency", currencyCode: "USD", frequency: "monthly" })).row.id);
  const observation = String((await recordMetricObservation(ctx, { metricSeriesId: series, periodStart: new Date(periodStart), periodEnd: new Date(periodEnd), value: { type: "number", value: "9007199254740993.000000000000" }, evidence })).row.id);
  const beforeCorrection = await clock();
  await challenge("ordinary-role-and-rls", { tenant, otherTenant }, "Non-superuser, no BYPASSRLS; foreign tenant rows invisible even with explicit foreign filter", async () => {
    const role = await read<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user", []);
    assert.equal(role.rows[0]?.rolname, "finnor_app"); assert.equal(role.rows[0]?.rolsuper, false); assert.equal(role.rows[0]?.rolbypassrls, false);
    assert.equal((await read("SELECT * FROM finnor_os.canonical_entity_versions WHERE tenant_id=$1", [otherTenant])).rows.length, 0);
    return role.rows[0];
  });
  if (!commitTracking) {
    await challenge("historical-visibility-unavailable", { beforeCorrection, commitTracking }, "Unavailable commit visibility forbids historical facts and predicate certificates rather than inventing knowledge", async () => {
      const past = await loadEnterpriseBeliefView(ctx, { root, validAt, knowledgeAt: beforeCorrection, decisionContext: decision });
      assert.equal(past.claims.length, 0); assert.equal(past.resolution.status, "INSUFFICIENT_RESOLUTION");
      assert(past.coverage.reasons.includes("HISTORICAL_COMMIT_VISIBILITY_UNAVAILABLE"));
      assert.equal(past.resolution.errorBound, null);
      const current = await loadEnterpriseBeliefView(ctx, { root, validAt, decisionContext: decision });
      assert(current.claims.length > 0);
      return { past, current };
    });
    await challenge("durable-replay-visibility-unavailable", { commitTracking }, "Existing durable replay cannot certify historical availability without retained commit visibility", durableCommitChallenge);
  } else {
  await challenge("exact-decimal-decision", decision, "Fixed PostgreSQL numeric oracle and BeliefView both retain below-threshold value without float rounding", async () => {
    const expected = await reference(beforeCorrection);
    const view = await loadEnterpriseBeliefView(ctx, { root, validAt, knowledgeAt: beforeCorrection, decisionContext: decision });
    assert.equal(view.resolution.status, "SUFFICIENT"); assert.equal(view.resolution.results[0]?.status, "DOES_NOT_MATCH");
    assert.equal(expected.matches.length, 0); assert.equal(view.claims.find(c => c.ownerRef.id === observation)?.ownerRef.revisionId !== undefined, true);
    return { expected, view };
  });
  await challenge("heldout-zero-fraction-and-negative-predicates", { values: ["0", "0.001", "-0.001", "1.2300", "-100.000"], thresholds: ["0", "0.00", "0.001", "-0.001", "1.23", "-100"] }, "Fixed held-out predicates exactly agree with independent PostgreSQL numeric comparisons, including zero at different decimal scales", async () => {
    const observed = [];
    for (const [i, value] of ["0", "0.001", "-0.001", "1.2300", "-100.000"].entries()) {
      const key = `heldout-numeric-${i}`;
      const s = String((await createMetricSeries(ctx, { subjectType: "external_organization", subjectId: company, metricKey: key, name: key, unit: "count", frequency: "monthly" })).row.id);
      await recordMetricObservation(ctx, { metricSeriesId: s, periodStart: new Date(periodStart), periodEnd: new Date(periodEnd), value: { type: "number", value }, evidence });
      const requirements = ["0", "0.00", "0.001", "-0.001", "1.23", "-100"].flatMap((threshold, t) => (["gte", "lte", "eq"] as const).map(operator => ({
        id: `${t}-${operator}`, subject: root, metricKey: key, unit: "count", currencyCode: null, periodStart, periodEnd, operator, threshold,
      })));
      const sql = await read<{ id: string; matches: boolean; value: string }>(`SELECT r.id,o.value_numeric::text value,
        CASE r.operator WHEN 'gte' THEN o.value_numeric>=r.threshold::numeric WHEN 'lte' THEN o.value_numeric<=r.threshold::numeric ELSE o.value_numeric=r.threshold::numeric END matches
        FROM finnor_os.pe_metric_observations o CROSS JOIN jsonb_to_recordset($2::jsonb) AS r(id text,operator text,threshold text)
        WHERE o.metric_series_id=$1 ORDER BY r.id`, [s, JSON.stringify(requirements)]);
      const view = await loadEnterpriseBeliefView(ctx, { root, validAt, decisionContext: { id: `heldout-${i}`, version: "fixed-1", evidenceUniverse: "registered_canonical_records", requirements } });
      assert.equal(view.resolution.status, "SUFFICIENT");
      for (const expected of sql.rows) assert.equal(view.resolution.results.find(x => x.requirementId === expected.id)?.status, expected.matches ? "MATCHES" : "DOES_NOT_MATCH", `${value} ${expected.id}`);
      observed.push({ value, sql: sql.rows, resolution: view.resolution });
    }
    return observed;
  });
  const corrected = String((await restateMetricObservation(ctx, { priorObservationId: observation, expectedVersion: 1,
    replacement: { value: { type: "number", value: "9007199254740993.000000000002" }, evidence } })).row.id);
  const afterCorrection = await clock();
  await challenge("as-of-restatement-and-provenance", { beforeCorrection, afterCorrection, validAt, observation, corrected }, "Past knowledge retains old value; present knowledge sees explicit correction; SQL oracle agrees and revision dependencies change", async () => {
    const past = await loadEnterpriseBeliefView(ctx, { root, validAt, knowledgeAt: beforeCorrection, decisionContext: decision });
    const present = await loadEnterpriseBeliefView(ctx, { root, validAt, knowledgeAt: afterCorrection, decisionContext: decision });
    assert.equal(past.resolution.results[0]?.status, "DOES_NOT_MATCH"); assert.equal(present.resolution.results[0]?.status, "MATCHES");
    assert.deepEqual((await reference(beforeCorrection)).ids, [observation]); assert.deepEqual((await reference(afterCorrection)).ids, [corrected]);
    assert.notEqual(past.dependencyDigest, present.dependencyDigest); assert(present.claims.some(c => c.ownerRef.id === corrected));
    return { past, present, oraclePast: await reference(beforeCorrection), oraclePresent: await reference(afterCorrection) };
  });
  await challenge("integrated-query-projection", { root, validAt, knowledgeAt: afterCorrection }, "World, operational query and Company Brain carry the same BeliefView dependency/clock semantics", async () => {
    const world = await loadPrivateEquityWorldState(ctx, root, { validAt, knowledgeAt: afterCorrection });
    const query = await executePrivateEquityOperationalQuery(tenant, { intent: "pe_world_state", root, validAt, knowledgeAt: afterCorrection }, { userId: actor, employeeId: actor });
    const projection = await loadCompanyBrainProjection(ctx, { root, validAt, knowledgeAt: afterCorrection });
    assert(world.beliefView); assert(query.beliefView); assert(projection.beliefView);
    assert.equal(world.beliefView.dependencyDigest, query.beliefView.dependencyDigest); assert.equal(world.beliefView.dependencyDigest, projection.beliefView.dependencyDigest);
    assert.equal(world.beliefView.knowledgeAt, afterCorrection);
    return { world: world.beliefView, query: query.beliefView, projection: projection.beliefView };
  });
  await challenge("actual-api-and-operating-context", { root, decision }, "Actual POST handler preserves qualifications, rejects spoofing and disables caching; authenticated OperatingContext carries an S1 view", async () => {
    process.env.AUTH_DEV_BYPASS = "1";
    const post = (body: unknown, userId = actor) => companyBrainPost(new Request("http://localhost/api/company-brain/belief-view", { method: "POST",
      headers: { "content-type": "application/json", "x-tenant-id": tenant, "x-user-id": userId }, body: JSON.stringify(body) }), { params: Promise.resolve({ operation: "belief-view" }) });
    try {
      const response = await post({ root, validAt, knowledgeAt: afterCorrection, decisionContext: decision });
      const body = await response.json() as BeliefView;
      assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(body.resolution.results[0]?.status, "MATCHES"); assert.equal(body.experience.receipt, null);
      const pinResponse = await companyBrainPost(new Request("http://localhost/api/company-brain/belief-pin", { method: "POST", headers: { "content-type": "application/json", "x-tenant-id": tenant, "x-user-id": actor }, body: JSON.stringify(body.pin) }), { params: Promise.resolve({ operation: "belief-pin" }) });
      assert.equal(pinResponse.status, 200); assert.equal((await pinResponse.json()).status, "CURRENT");
      const denied = await post({ root }, otherActor); const deniedBody = await denied.json();
      assert.equal(denied.status, 404); assert.equal(deniedBody.code, "PE_ENTITY_NOT_FOUND");
      const malformed = await post({ root, decisionContext: { ...decision, evidenceUniverse: "enterprise_truth" } });
      assert.equal(malformed.status, 400);
      const deal = await createDeal(ctx, { targetOrganizationId: company, name: "S1 context deal", dealLeadEmployeeId: actor,
        signedLoiAt: new Date(periodStart), targetClosingAt: new Date("2027-01-01") });
      const assembled = await assembleOperatingContext(ctx.auth, { instruction: String(deal.row.id), includeCanonicalBusinessState: true, includeMemory: false });
      assert.equal(assembled.context.beliefViews?.length, 1);
      assert.equal(assembled.context.beliefViews?.[0]?.root.entityId, deal.row.id);
      assert.equal(assembled.context.beliefViews?.[0]?.coverage.absenceClaimsPermitted, false);
      return { response: { status: response.status, cacheControl: response.headers.get("cache-control"), body }, denied: deniedBody,
        malformedStatus: malformed.status, context: assembled.context, authBoundary: "Existing nonproduction header seam; hosted JWT/provider behavior remains unverified" };
    } finally { delete process.env.AUTH_DEV_BYPASS; }
  });
  await challenge("api-request-byte-budget", { limitBytes: 65536, chunkBytes: 8192, contentLength: [null, "1"] }, "The actual POST handler rejects and cancels oversized streams even without an honest Content-Length; malformed JSON stays a generic client error", async () => {
    process.env.AUTH_DEV_BYPASS = "1";
    const observed = [];
    try {
      for (const declared of [null, "1"]) {
        let chunks = 0, cancelled = false;
        const stream = new ReadableStream<Uint8Array>({ pull(controller) {
          chunks++; controller.enqueue(new Uint8Array(8192).fill(32)); if (chunks === 12) controller.close();
        }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
        const headers: Record<string,string> = { "content-type": "application/json", "x-tenant-id": tenant, "x-user-id": actor };
        if (declared) headers["content-length"] = declared;
        const init: RequestInit & { duplex: "half" } = { method: "POST", headers, body: stream, duplex: "half" };
        const res = await companyBrainPost(new Request("http://localhost/api/company-brain/belief-view", init), { params: Promise.resolve({ operation: "belief-view" }) });
        const result = { declared, status: res.status, body: await res.json(), chunks, cancelled }; observed.push(result);
        await writeFile(join(output,"api-byte-budget-observations.json"), JSON.stringify(observed,null,2));
        assert.equal(res.status, 413); assert.equal(result.body.code,"PE_BRAIN_LIMIT"); assert.equal(cancelled,true); assert(chunks < 12);
      }
      const invalid = await companyBrainPost(new Request("http://localhost/api/company-brain/belief-view", { method: "POST",
        headers: { "content-type": "application/json", "x-tenant-id": tenant, "x-user-id": actor }, body: "{" }), { params: Promise.resolve({ operation: "belief-view" }) });
      assert.equal(invalid.status,400); assert.equal((await invalid.json()).code,"PE_BRAIN_INVALID");
      return { observed, malformedStatus: invalid.status, boundary: "Real Node Web Request stream/POST handler; no hosted network/proxy DoS certificate" };
    } finally { delete process.env.AUTH_DEV_BYPASS; }
  });
  await challenge("fund-portfolio-and-forecast-types", { decisionUniverse: "registered_canonical_records", horizons: ["H0", "H1"], holdingRequiresVerifiedClose: true }, "Unverified holdings remain rejected; fund views cannot certify an unavailable portfolio metric; assumptions/theses retain H1 types and same-name companies remain distinct", async () => {
    const deal = String((await createDeal(ctx, { targetOrganizationId: company, name: "S1 portfolio origin", dealLeadEmployeeId: actor, signedLoiAt: new Date(periodStart), targetClosingAt: new Date("2027-01-01") })).row.id);
    const fund = String((await createFund(ctx, { name: "S1 fund", baseCurrency: "USD", validFrom: new Date(periodStart) })).row.id);
    const holding = randomUUID();
    await assert.rejects(() => createPortfolioHolding(ctx, { id: holding, fundId: fund, companyId: company, originDealId: deal, entryDate: "2026-01-01", completeness: "partial", evidence }), /verified closed Deal/);
    const caseId = String((await createInvestmentCase(ctx, { dealId: deal, title: "S1 forecast case" })).row.id);
    const thesis = String((await createThesis(ctx, { dealId: deal, investmentCaseId: caseId, thesisType: "growth", title: "Conditional thesis", statement: "A typed hypothesis" })).row.id);
    const assumption = String((await createAssumption(ctx, { dealId: deal, investmentCaseId: caseId, assumptionKey: "growth", statement: "A forecast, not an outcome", valueType: "percent", value: 12, unit: "percent" })).row.id);
    const d: BeliefDecisionContext = { id: "portfolio-fixed", version: "1", evidenceUniverse: "registered_canonical_records", requirements: [{ id: "holding", subject: { entityType: "pe_portfolio_holding", entityId: holding }, metricKey: "investment", unit: "currency", currencyCode: "USD", periodStart, periodEnd, operator: "gte", threshold: "125" }] };
    const oracle = await read<{ id: string }>("SELECT id FROM finnor_os.pe_portfolio_holdings WHERE fund_id=$1", [fund]);
    const view = await loadEnterpriseBeliefView(ctx, { root: { entityType: "pe_fund", entityId: fund }, validAt, decisionContext: d });
    assert.equal(oracle.rows.length, 0); assert.equal(view.resolution.status, "INSUFFICIENT_RESOLUTION"); assert.equal(view.resolution.errorBound, null);
    assert.equal(view.coverage.absenceClaimsPermitted, false); assert(view.claims.some(c => c.ownerRef.id === fund));
    const dealView = await loadEnterpriseBeliefView(ctx, { root: { entityType: "pe_deal", entityId: deal } });
    assert.equal(dealView.claims.find(c => c.ownerRef.id === assumption)?.kind, "ASSUMPTION"); assert.equal(dealView.claims.find(c => c.ownerRef.id === assumption)?.horizon, "H1");
    assert.equal(dealView.claims.find(c => c.ownerRef.id === thesis)?.kind, "MODEL_CONDITIONAL");
    const duplicateName = randomUUID();
    await admin!.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'S1 company','other')", [duplicateName, tenant, duplicateName]);
    const separate = await loadEnterpriseBeliefView(ctx, { root: { entityType: "external_organization", entityId: duplicateName } });
    assert(!separate.claims.some(c => c.ownerRef.id === company || c.ownerRef.id === holding));
    return { oracle: oracle.rows, view, dealView, duplicateNameRoot: separate.root, duplicateNameClaimIds: separate.claims.map(c => c.ownerRef.id), portfolioFixtureBoundary: "Positive held-portfolio certification requires a legitimately verified closing receipt; no close effect or economic outcome was fabricated" };
  });
  await challenge("late-provider-timestamp", { providerAsOf: periodStart, retrievedAt: periodStart }, "Backdated source timestamps cannot alter earlier FINNOR knowledge", async () => {
    const strategy = String((await createStrategy(ctx, { name: "Backdating challenge" })).row.id);
    const strategyRoot = { entityType: "pe_strategy", entityId: strategy } as const;
    await attachCanonicalEvidenceToWorld(ctx, { worldRoot: strategyRoot, entity: { entityType: "pe_strategy", entityId: strategy }, evidenceSourceId: source.id, relationship: "supports" });
    const before = await clock();
    const late = await appendEvidenceVersion(tenant, source.id, { content: "late claim", snapshot: { worldRoot: strategyRoot, claims: [] }, asOf: new Date(periodStart), retrievedAt: new Date(periodStart) });
    const past = await loadPrivateEquityWorldState(ctx, strategyRoot, { knowledgeAt: before });
    assert(!past.evidence.some(e => e.versionId === late.versionId));
    return { before, lateVersion: late.versionId, permittedVersions: past.evidence.map(e => e.versionId) };
  });
  await challenge("copies-and-unsuperseded-conflict", { commonOrigin: "one-document", copies: 2 }, "Copies do not boost confidence; superseding one claim cannot erase an unrelated competing claim", async () => {
    const definition = { id: "copy", subject: { kind: "external" as const, type: "metric", id: "metric" }, predicate: { name: "reported" } };
    const state = createEpistemicState({ scope: { tenantId: tenant, principalId: actor, decisionId: "fixed-copy-test" }, asOf: afterCorrection, propositions: [definition] });
    const evidenceRecord = (id: string, value: number, supersedesEvidenceRefs?: string[]): EvidenceRecord => createEvidenceRecord({ id, propositionId: "copy", tenantId: tenant,
      source: { kind: "DOCUMENT", owner: "report-owner", ref: id, authority: "DURABLE_EVIDENCE", truthClass: "MEMORY", role: "answer_evidence" },
      observedAt: periodStart, validAt: periodStart, ingestedAt: beforeCorrection, value,
      confidence: { level: "MEDIUM", basis: "SOURCE_ASSERTION", heuristicVersion: EPISTEMIC_HEURISTIC_VERSION, reasonCodes: [] },
      freshness: { status: "FRESH", reason: "No freshness certification" }, sensitivity: "TENANT_INTERNAL",
      provenance: { sourceRef: id, parentEvidenceRefs: [], dependencyRefs: [] }, canonical: false, ...(supersedesEvidenceRefs ? { supersedesEvidenceRefs } : {}) });
    const copies = appendEvidenceAndRecompute(state, [evidenceRecord("copy-a", 1), evidenceRecord("copy-b", 1)], afterCorrection);
    assert.equal(copies.propositions[0]?.confidence.level, "MEDIUM"); assert.notEqual(copies.propositions[0]?.confidence.basis, "CORROBORATED");
    const conflict = appendEvidenceAndRecompute(state, [evidenceRecord("old", 0), evidenceRecord("independent-claim", 2), evidenceRecord("correction", 1, ["old"])], afterCorrection);
    assert.equal(conflict.propositions[0]?.status, "CONFLICTING");
    return { copies: copies.propositions, conflict: conflict.propositions };
  });
  await challenge("actual-source-conflicts-and-duplicate-identity", { commonOrigin: "one-upstream", proposition: "reported-state" }, "Actual immutable source copies retain uncertainty/conflicts; exact duplicates are idempotent and changed semantics under the same content identity are rejected", async () => {
    const id = String((await createStrategy(ctx, { name: "S1 conflict strategy" })).row.id);
    const r = { entityType: "pe_strategy", entityId: id } as const;
    const versions: string[] = [];
    for (const value of [1, 2]) {
      const src = await createEvidenceSource(tenant, { sourceKey: `conflict:${value}:${randomUUID()}`, sourceType: "pe_document_claim", title: "Common-origin report" });
      const snapshot = { worldRoot: r, origin: "one-upstream", claims: [{ propositionId: "reported-state", predicate: "reported", value }] };
      const content = `Common-origin statement ${value}`;
      const first = await appendEvidenceVersion(tenant, src.id, { content, snapshot, asOf: new Date(periodStart) });
      const [duplicate, concurrentDuplicate] = await Promise.all([1, 2].map(() => appendEvidenceVersion(tenant, src.id, { content, snapshot, asOf: new Date(periodStart) })));
      assert(duplicate); assert(concurrentDuplicate);
      assert.equal(first.versionId, duplicate.versionId);
      assert.equal(first.versionId, concurrentDuplicate.versionId);
      await assert.rejects(() => appendEvidenceVersion(tenant, src.id, { content, snapshot: { ...snapshot, claims: [{ propositionId: "reported-state", predicate: "reported", value: 999 }] } }), /semantic snapshot/);
      await attachCanonicalEvidenceToWorld(ctx, { worldRoot: r, entity: { entityType: "pe_strategy", entityId: id }, evidenceSourceId: src.id, evidenceVersionId: first.versionId, relationship: "supports" });
      versions.push(first.versionId);
    }
    const view = await loadEnterpriseBeliefView(ctx, { root: r });
    assert.equal(view.contradictions.find(x => x.reason === "COMPETING_SOURCE_ASSERTIONS")?.claimRefs.length, 2);
    assert(view.claims.filter(c => c.kind === "SOURCE_ASSERTION").every(c => !c.uncertainty.calibratedProbability && c.uncertainty.reasons.includes("SOURCE_INDEPENDENCE_UNESTABLISHED")));
    return { versions, view };
  });
  await challenge("embedding-wait-does-not-lock-source", { injectedProviderFailure: true }, "A controlled provider wait holds no database source lock; failure creates no evidence version", async () => {
    const src = await createEvidenceSource(tenant, { sourceKey: `embedding-fault:${randomUUID()}`, sourceType: "manual", title: "Embedding fault" });
    let release!: () => void; let reached!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { reached = resolve; });
    const provider = { name: `s1-fault-${randomUUID()}`, async embed(_text: string): Promise<number[]> { reached(); await wait; throw new Error("S1 injected provider failure"); } };
    const appending = appendEvidenceVersion(tenant, src.id, { content: `Embedding fault ${randomUUID()}`, embeddingProvider: provider });
    const rejected = assert.rejects(appending, /S1 injected provider failure/);
    await ready;
    try {
      await withTenantTransaction(tenant, { userId: actor }, (_db, client) => client.query("SELECT id FROM finnor_os.evidence_sources WHERE id=$1 FOR UPDATE NOWAIT", [src.id]));
    } finally { release(); await rejected; }
    assert.equal((await read("SELECT id FROM finnor_os.evidence_source_versions WHERE source_id=$1", [src.id])).rows.length, 0);
    return { sourceId: src.id, lockProbe: "FOR UPDATE NOWAIT succeeded while controlled provider was pending", versions: 0,
      boundary: "Injected local wait/failure validates lock placement and rollback only; no hosted provider claim" };
  });
  await challenge("nested-source-decimal-provenance", { exactValues: ["9007199254740993.000000000001", "9007199254740993.000000000002"] }, "Exact immutable source JSON remains retrievable and differing nested numeric assertions cannot collapse into agreement through binary floating point", async () => {
    const id = String((await createStrategy(ctx, { name: "S1 source precision" })).row.id);
    const r = { entityType: "pe_strategy", entityId: id } as const; const versions = [];
    for (const value of ["9007199254740993.000000000001", "9007199254740993.000000000002"]) {
      const src = await createEvidenceSource(tenant, { sourceKey: `exact-json:${randomUUID()}`, sourceType: "pe_document_claim", title: "Exact nested assertion" });
      const content = `Exact source value ${value}`;
      const raw = `{"worldRoot":${JSON.stringify(r)},"claims":[{"propositionId":"source-exact-number","predicate":"reported","value":${value}}]}`;
      const version = (await admin!.query<{ id: string }>(`INSERT INTO finnor_os.evidence_source_versions(source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of,retrieved_at,created_at)
        VALUES($1,'tenant',$2,1,$3,$4,$5::jsonb,$6,clock_timestamp(),clock_timestamp()) RETURNING id`, [src.id, tenant, createHash("sha256").update(content).digest("hex"), content, raw, periodStart])).rows[0]!.id;
      await attachCanonicalEvidenceToWorld(ctx, { worldRoot: r, entity: r, evidenceSourceId: src.id, evidenceVersionId: version, relationship: "supports" });
      versions.push({ version, value });
    }
    const oracle = await read<{ id: string; raw: string }>("SELECT id::text,snapshot::text raw FROM finnor_os.evidence_source_versions WHERE id=ANY($1::uuid[]) ORDER BY id", [versions.map(v => v.version)]);
    const view = await loadEnterpriseBeliefView(ctx, { root: r });
    for (const expected of oracle.rows) assert.equal(view.claims.find(c => c.ownerRef.revisionId === expected.id)?.exactSnapshotJson, expected.raw);
    assert.equal(view.contradictions.find(x => x.reason === "COMPETING_SOURCE_ASSERTIONS")?.claimRefs.length, 2);
    return { oracle: oracle.rows, view };
  });
  await challenge("current-resource-deny-and-search", { root }, "A resource deny cannot vanish in a heterogeneous grant list or leak forbidden existence through search/projection/coverage", async () => {
    const role = (await admin!.query<{ role_id: string }>("SELECT role_id FROM finnor_os.employee_role_assignments WHERE employee_id=$1 AND active LIMIT 1", [actor])).rows[0]!.role_id;
    const inserted = await admin!.query<{ id: string }>("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect) VALUES($1,$2,'query:pe_world_state','pe_metric_series','deny') RETURNING id", [tenant, role]);
    try {
      await assert.rejects(() => loadEnterpriseBeliefView(ctx, { root }), { code: "PE_ENTITY_NOT_FOUND" });
      await assert.rejects(() => loadCompanyBrainProjection(ctx, { root }), { code: "PE_ENTITY_NOT_FOUND" });
      await assert.rejects(() => listCompanyBrainRoots(ctx, { query: company }), { code: "PE_ENTITY_NOT_FOUND" });
      const deniedDeal = String((await admin!.query<{ id: string }>("SELECT id FROM finnor_os.pe_deals WHERE tenant_id=$1 ORDER BY created_at LIMIT 1", [tenant])).rows[0]!.id);
      const assembled = await assembleOperatingContext(ctx.auth, { instruction: deniedDeal, includeCanonicalBusinessState: true, includeMemory: false });
      assert.equal(assembled.context.beliefViews?.length ?? 0, 0);
      assert.equal(assembled.context.canonicalSummaries?.length ?? 0, 0);
      return { world: "UNAVAILABLE", projection: "UNAVAILABLE", rootSearch: "UNAVAILABLE", deniedOperatingContext: assembled.context, forbiddenCountsExposed: false };
    } finally { await admin!.query("DELETE FROM finnor_os.role_authority_grants WHERE id=$1", [inserted.rows[0]!.id]); }
  });
  await challenge("root-search-single-connection-concurrency", { poolMax: 1, parallelRequests: 3, query: company, limit: 1 }, "Root search releases its data transaction before authorization and succeeds with the hosted one-connection budget", async () => {
    await closePool(); getPool().options.max = 1;
    const start = performance.now();
    try {
      const searches = await Promise.allSettled(Array.from({ length: 3 }, () => listCompanyBrainRoots(ctx, { query: company, limit: 1 })));
      const observed = searches.map(result => result.status === "fulfilled" ? { status: result.status, roots: result.value } : { status: result.status, reason: String(result.reason) });
      assert(searches.every(result => result.status === "fulfilled" && result.value.length === 1 && result.value[0]?.ref.id === company), JSON.stringify(observed));
      const durationMs = performance.now() - start; assert(durationMs < 5000);
      return { poolMax: getPool().options.max, observed, durationMs, configurationBoundary: "Local ordinary-role pool reduced to the existing hosted maximum; no hosted load certification" };
    } finally { await closePool(); }
  });
  await challenge("root-search-full-budget", { poolMax: 1, roots: 100, latencyBudgetMs: 5000 }, "A fully permitted 100-root search preserves the independent SQL result inside the registered local latency budget", async () => {
    const prefix = `S1 roots ${randomUUID()}`;
    await admin!.query("INSERT INTO finnor_os.external_organizations(tenant_id,organization_key,name,kind) SELECT $1,'s1-root-'||gen_random_uuid(),$2||n,'other' FROM generate_series(1,100) n", [tenant, prefix]);
    const expected = (await read<{ id: string }>("SELECT id FROM finnor_os.external_organizations WHERE tenant_id=$1 AND name LIKE $2 ORDER BY id", [tenant, `${prefix}%`])).rows.map(r => r.id);
    await closePool(); getPool().options.max = 1;
    try {
      const start = performance.now(); const rows = await listCompanyBrainRoots(ctx, { query: prefix, limit: 100 }); const durationMs = performance.now() - start;
      assert.deepEqual(rows.map(r => r.ref.id).sort(), expected); assert(durationMs < 5000, `Full root search took ${durationMs} ms`);
      return { expected, rows, durationMs, poolMax: getPool().options.max, latencyBudgetMs: 5000 };
    } finally { await closePool(); }
  });
  await challenge("provider-permission-revocation", { currentRightsAlsoApplyToPast: true }, "Disabled or insufficient provider permissions block current/historical views and old pin use without exposing coverage or source identities", async () => {
    const id = String((await createStrategy(ctx, { name: "S1 provider revocation" })).row.id);
    const r = { entityType: "pe_strategy", entityId: id } as const;
    const integration = randomUUID(), scope = randomUUID();
    await admin!.query("INSERT INTO finnor_os.tenant_integrations(id,tenant_id,capability,binding,mode) VALUES($1,$2,'communications','microsoft_graph','sandbox')", [integration, tenant]);
    await admin!.query(`INSERT INTO finnor_os.integration_source_scopes(id,tenant_id,integration_id,provider,source_kind,provider_scope_type,provider_resource_id,scope_key,sync_strategy,recovery_strategy,required_permissions,effective_permissions,configured_by,root_binding_type,root_binding_id)
      VALUES($1,$2,$3,'microsoft_graph','outlook_mail_folder','mail_folder','test-mailbox','s1:revocation','delta','EXACT_DELTA',ARRAY['Mail.Read'],ARRAY['Mail.Read'],$4,'pe_strategy',$5)`, [scope, tenant, integration, actor, id]);
    await admin!.query("UPDATE finnor_os.integration_source_scopes SET last_successful_sync_at=clock_timestamp(),freshness_policy=$2 WHERE id=$1", [scope, { maxAgeSeconds: 86400 }]);
    const view = await loadEnterpriseBeliefView(ctx, { root: r });
    await clock();
    const unchanged = await validateBeliefViewPin(ctx, view.pin);
    await writeFile(join(output, "provider-pin-observations.json"), JSON.stringify({ scope, view, unchanged,
      expected: "CURRENT until source/rights/coverage/freshness state changes", boundary: "Local persisted provider descriptor; no live-provider claim" }, null, 2));
    assert.equal(unchanged.status, "CURRENT");
    await admin!.query("UPDATE finnor_os.integration_source_scopes SET freshness_policy=$2 WHERE id=$1", [scope, { maxAgeSeconds: 0 }]);
    const freshnessInvalidation = await validateBeliefViewPin(ctx, view.pin);
    assert.equal(freshnessInvalidation.status, "INVALIDATED");
    const expiredWorld = await loadPrivateEquityWorldState(ctx, r);
    assert.equal((expiredWorld.sourceCoverage[0]!.freshness as Record<string,unknown>).state,"expired");
    await writeFile(join(output,"provider-freshness-observations.json"), JSON.stringify({ unchanged, freshnessInvalidation, expiredCoverage: expiredWorld.sourceCoverage,
      expected: "Request age alone preserves pin; policy/semantic freshness state invalidates it", boundary: "Actual world/pin runtime; local metadata does not certify provider truth" },null,2));
    await admin!.query("UPDATE finnor_os.integration_source_scopes SET freshness_policy=$2 WHERE id=$1", [scope, { maxAgeSeconds: 86400 }]);
    await admin!.query("UPDATE finnor_os.integration_source_scopes SET enabled=false,disabled_at=clock_timestamp() WHERE id=$1", [scope]);
    await assert.rejects(() => loadEnterpriseBeliefView(ctx, { root: r, knowledgeAt: view.knowledgeAt }), { code: "PE_ENTITY_NOT_FOUND" });
    assert.equal((await validateBeliefViewPin(ctx, view.pin)).status, "UNAVAILABLE");
    await admin!.query("UPDATE finnor_os.integration_source_scopes SET enabled=true,disabled_at=NULL,effective_permissions='{}' WHERE id=$1", [scope]);
    try { await assert.rejects(() => loadEnterpriseBeliefView(ctx, { root: r }), { code: "PE_ENTITY_NOT_FOUND" }); }
    finally { await admin!.query("UPDATE finnor_os.integration_source_scopes SET effective_permissions=ARRAY['Mail.Read'] WHERE id=$1", [scope]); }
    return { configuredScope: scope, unchanged, freshnessInvalidation, disabledHistoricalRead: "UNAVAILABLE", stalePin: "UNAVAILABLE", permissionLostCurrentRead: "UNAVAILABLE", boundary: "Local permission metadata; live provider enforcement remains unverified" };
  });
  await challenge("pin-source-interpretation-and-rights-invalidation", { root }, "Source and interpretation changes invalidate current-use pins; historical replay remains separately reconstructable", async () => {
    const view = await loadEnterpriseBeliefView(ctx, { root, validAt });
    assert.equal((await validateBeliefViewPin(ctx, { ...view.pin, interpretationVersion: "retired-interpretation" })).status, "INVALIDATED");
    const added = await createMetricSeries(ctx, { subjectType: "external_organization", subjectId: company, metricKey: "pin-change", name: "S1 invalidating record", unit: "count", frequency: "instant" });
    const invalidated = await validateBeliefViewPin(ctx, view.pin); assert.equal(invalidated.status, "INVALIDATED");
    assert.equal(invalidated.experience?.event.type, "BELIEF_INVALIDATION");
    assert.equal(invalidated.experience?.event.invalidation?.priorDependencyDigest, view.pin.dependencyDigest);
    assert.equal(invalidated.experience?.receipt, null);
    const replay = await loadEnterpriseBeliefView(ctx, { root, validAt, knowledgeAt: view.knowledgeAt });
    assert(!replay.claims.some(c => c.ownerRef.id === added.row.id));
    return { priorPin: view.pin, invalidated, historicalDependencyDigest: replay.dependencyDigest };
  });
  await challenge("foreign-and-spoofed-principal", { otherCompany, tenant }, "Foreign root and spoofed principal fail with generic unavailable error without forbidden existence/provenance", async () => {
    for (const attack of [{ ctx, root: { entityType: "external_organization" as const, entityId: otherCompany } },
      { ctx: { auth: { ...ctx.auth, employeeId: otherActor, userId: otherActor } }, root }]) {
      await assert.rejects(() => loadEnterpriseBeliefView(attack.ctx, { root: attack.root }), e => {
        assert.equal((e as { code?: string }).code, "PE_ENTITY_NOT_FOUND"); assert(!JSON.stringify(e).includes("FORBIDDEN-S1")); return true;
      });
    }
    return { rejected: 2 };
  });
  await challenge("budget-missing-baseline-and-units", { root, maxClaims: 1 }, "Truncation, absent history and incompatible currency return insufficient resolution with no numeric error certificate", async () => {
    const truncated = await loadEnterpriseBeliefView(ctx, { root, validAt, decisionContext: decision, maxClaims: 1 });
    assert.equal(truncated.resolution.status, "INSUFFICIENT_RESOLUTION"); assert.equal(truncated.resolution.errorBound, null);
    const incompatible = await loadEnterpriseBeliefView(ctx, { root, validAt, decisionContext: { ...decision, requirements: decision.requirements.map(r => ({ ...r, currencyCode: "EUR" })) } });
    assert.equal(incompatible.resolution.status, "INSUFFICIENT_RESOLUTION");
    const prebaseline = await loadEnterpriseBeliefView(ctx, { root, knowledgeAt: "2020-01-01T00:00:00.000Z" });
    assert.equal(prebaseline.coverage.status, "UNAVAILABLE_BEFORE_BASELINE"); assert.equal(prebaseline.resolution.errorBound, null);
    return { truncated, incompatible, prebaseline };
  });
  await challenge("view-pin-restart-and-revocation", { root }, "Restart retains exact dependency witnesses; suspended caller cannot reuse historical view or pin", async () => {
    const view = await loadEnterpriseBeliefView(ctx, { root, validAt });
    await closePool();
    assert.equal((await validateBeliefViewPin(ctx, view.pin)).status, "CURRENT");
    await admin!.query("UPDATE finnor_os.users SET status='suspended' WHERE id=$1", [actor]);
    try {
      await assert.rejects(() => loadEnterpriseBeliefView(ctx, { root, validAt, knowledgeAt: beforeCorrection }), { code: "PE_ENTITY_NOT_FOUND" });
      assert.equal((await validateBeliefViewPin(ctx, view.pin)).status, "UNAVAILABLE");
    } finally { await admin!.query("UPDATE finnor_os.users SET status='active' WHERE id=$1", [actor]); }
    return { restart: "CURRENT", revoked: "UNAVAILABLE" };
  });
  await challenge("experience-boundary-honesty", { root }, "Typed S1 event preserves clocks/rights/dependencies/H0; absent protected broker remains explicit", async () => {
    const tenantTables = (await admin!.query<{ table_name: string }>("SELECT table_name FROM information_schema.columns WHERE table_schema='finnor_os' AND column_name='tenant_id' ORDER BY table_name")).rows.map(row => row.table_name);
    const fingerprint = async () => {
      const result: Record<string, { rows: string; digest: string }> = {};
      for (const table of tenantTables) {
        assert(/^[a-z_][a-z_0-9]*$/.test(table));
        result[table] = (await admin!.query<{ rows: string; digest: string }>(`SELECT count(*)::text rows,md5(coalesce(string_agg(to_jsonb(t)::text,'\n' ORDER BY to_jsonb(t)::text),'')) digest FROM finnor_os."${table}" t WHERE tenant_id=$1`, [tenant])).rows[0]!;
      }
      return result;
    };
    const before = await fingerprint();
    const view = await loadEnterpriseBeliefView(ctx, { root, validAt });
    const pin = await validateBeliefViewPin(ctx, view.pin);
    const invalidated = await validateBeliefViewPin(ctx, { ...view.pin, interpretationVersion: "unreviewed-interpretation" });
    await clock();
    const repeatedInvalidation = await validateBeliefViewPin(ctx, { ...view.pin, interpretationVersion: "unreviewed-interpretation" });
    const unavailable = await validateBeliefViewPin(ctx, { ...view.pin, principalId: otherActor });
    for (const result of [pin, invalidated, unavailable]) assert.equal(result.executionAuthorityGranted, false);
    assert.equal(view.experience.appendAuthorityGranted, false); assert.equal(view.experience.executionAuthorityGranted, false);
    process.env.AUTH_DEV_BYPASS = "1";
    let unsupportedAppend;
    try {
      const response = await companyBrainPost(new Request("http://localhost/api/company-brain/experience-append", { method: "POST",
        headers: { "content-type": "application/json", "x-tenant-id": tenant, "x-user-id": actor }, body: JSON.stringify(view.experience.event) }),
        { params: Promise.resolve({ operation: "experience-append" }) });
      unsupportedAppend = { status: response.status, body: await response.json() };
      assert.equal(unsupportedAppend.status, 404); assert.equal(unsupportedAppend.body.receipt, undefined);
    } finally { delete process.env.AUTH_DEV_BYPASS; }
    const after = await fingerprint(); assert.deepEqual(after, before);
    // Independently encode the typed JSON envelope; the expected identifier does
    // not call the production event builder or hashing helper.
    const ordered = (value: unknown): string => {
      if (value === null || typeof value !== "object") return JSON.stringify(value);
      if (Array.isArray(value)) return `[${value.map(ordered).join(",")}]`;
      return `{${Object.keys(value).sort((a, b) => a.localeCompare(b)).map(key => `${JSON.stringify(key)}:${ordered((value as Record<string, unknown>)[key])}`).join(",")}}`;
    };
    for (const event of [view.experience.event, invalidated.experience!.event, repeatedInvalidation.experience!.event]) {
      const { eventId, ...body } = JSON.parse(JSON.stringify(event));
      assert.equal(eventId, `s1-event:${createHash("sha256").update(ordered(body)).digest("hex")}`);
    }
    assert.notEqual(invalidated.experience!.event.eventId, repeatedInvalidation.experience!.event.eventId);
    assert.equal(view.experience.status, "BLOCKED_EXTERNAL"); assert.equal(view.experience.event.semanticOwner, "S1");
    assert.equal(view.experience.event.knowledgeAt, view.knowledgeAt); assert.equal(view.experience.event.horizon, "H0");
    assert.equal(view.experience.event.contentDigest, view.contentDigest); assert.equal(view.experience.receipt, null);
    return { experience: view.experience, pin, invalidated, repeatedInvalidation, unavailable, unsupportedAppend, before, after,
      writeBoundary: "Independent fingerprints of every tenant-bearing table before/after real S1 view/current/invalidated/unavailable pin paths; no tenant record, effect, receipt or local substitute ledger was written. Setup fingerprints use the disposable administrator; S1 calls use the tested ordinary role." };
  });
  await challenge("transaction-commit-window", { root }, "A row inserted before the knowledge cut but committed after it never appears when that historical cut is replayed", async () => {
    let release!: () => void; let inserted!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { inserted = resolve; });
    const id = randomUUID();
    const writer = withTenantTransaction(tenant, { userId: actor }, async (_db, client) => {
      await client.query(`INSERT INTO finnor_os.pe_metric_series(id,tenant_id,subject_type,subject_id,metric_key,name,unit,frequency,source_system,created_by)
        VALUES($1,$2,'external_organization',$3,'commit-window','Pending record','count','instant','s1:e2e',$4)`, [id, tenant, company, actor]);
      inserted(); await pending;
    });
    await ready;
    const during = await clock();
    let whilePending: BeliefView;
    try { whilePending = await loadEnterpriseBeliefView(ctx, { root, knowledgeAt: during }); assert(!whilePending.claims.some(c => c.ownerRef.id === id)); }
    finally { release(); await writer; }
    const replay = await loadEnterpriseBeliefView(ctx, { root, knowledgeAt: during });
    const current = await loadEnterpriseBeliefView(ctx, { root });
    const sql = await read<{ recorded_at: Date; committed_at: Date }>(`SELECT recorded_at,pg_xact_commit_timestamp(xmin) committed_at FROM finnor_os.canonical_entity_versions WHERE entity_id=$1`, [id]);
    assert(sql.rows[0]!.recorded_at.getTime() <= Date.parse(during)); assert(sql.rows[0]!.committed_at.getTime() > Date.parse(during));
    assert(!replay.claims.some(c => c.ownerRef.id === id)); assert(current.claims.some(c => c.ownerRef.id === id));
    return { id, during, timestamps: sql.rows, pendingIds: whilePending!.claims.map(c => c.ownerRef.id), replayIds: replay.claims.map(c => c.ownerRef.id), currentIds: current.claims.map(c => c.ownerRef.id) };
  });
  await challenge("durable-replay-transaction-commit-window", { sourceKind: "evidence_source", commitTracking }, "Existing durable replay agrees with independent committed-source SQL at a cut before the next source version commits", durableCommitChallenge);
  await challenge("durable-canonical-transaction-commit-window", { sourceKind: "canonical_entity", commitTracking }, "Canonical owner replay excludes a revision committed after the cut, independently of mutable worker state", durableCanonicalCommitChallenge);
  await challenge("high-fanout-decisive-tail-and-incompatible-context", { count: 200, maxClaims: 100, fixedThreshold: "500", unit: "count" }, "The full permitted SQL reference preserves the decisive tail; bounded or stale/incompatible views cannot certify its predicate", async () => {
    const target = randomUUID();
    await admin!.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'S1 tail','other')", [target, tenant, target]);
    await admin!.query(`INSERT INTO finnor_os.pe_metric_series(tenant_id,subject_type,subject_id,metric_key,name,unit,frequency,source_system,created_by)
      SELECT $1,'external_organization',$2,'outlier-'||n,'Outlier '||n,'count','monthly','s1:e2e',$3 FROM generate_series(1,200) n`, [tenant, target, actor]);
    await admin!.query(`INSERT INTO finnor_os.pe_metric_observations(tenant_id,metric_series_id,period_start,period_end,value_type,value_numeric,evidence_source_id,evidence_version_id,source_system,created_by)
      SELECT $1,id,$2,$3,'number',CASE WHEN metric_key='outlier-200' THEN 1000 ELSE 0 END,$4,$5,'s1:e2e',$6 FROM finnor_os.pe_metric_series WHERE subject_id=$7`, [tenant, periodStart, periodEnd, source.id, ev.versionId, actor, target]);
    const targetRoot = { entityType: "external_organization", entityId: target } as const;
    const d: BeliefDecisionContext = { id: "heldout-tail", version: "fixed-1", evidenceUniverse: "registered_canonical_records", requirements: [{ id: "tail", subject: targetRoot,
      metricKey: "outlier-200", unit: "count", currencyCode: null, periodStart, periodEnd, operator: "gte", threshold: "500" }] };
    const sql = await read<{ matches: boolean; value: string }>(`SELECT value_numeric::text value,value_numeric>=500 matches FROM finnor_os.pe_metric_observations o JOIN finnor_os.pe_metric_series s ON s.id=o.metric_series_id WHERE s.subject_id=$1 AND s.metric_key='outlier-200'`, [target]);
    const full = await loadEnterpriseBeliefView(ctx, { root: targetRoot, validAt, decisionContext: d });
    const bounded = await loadEnterpriseBeliefView(ctx, { root: targetRoot, validAt, decisionContext: d, maxClaims: 100 });
    assert.equal(sql.rows[0]?.matches, true); assert.equal(full.resolution.results[0]?.status, "MATCHES");
    assert.equal(bounded.resolution.status, "INSUFFICIENT_RESOLUTION"); assert.equal(bounded.resolution.errorBound, null);
    const stale = await loadEnterpriseBeliefView(ctx, { root: targetRoot, validAt, decisionContext: { ...d, requirements: d.requirements.map(x => ({ ...x, maximumAgeMs: 1 })) } });
    assert.equal(stale.resolution.status, "INSUFFICIENT_RESOLUTION");
    const incompatible = await loadEnterpriseBeliefView(ctx, { root: targetRoot, validAt, decisionContext: { ...d, requirements: d.requirements.map(x => ({ ...x, unit: "percentage" })) } });
    assert.equal(incompatible.resolution.status, "INSUFFICIENT_RESOLUTION");
    return { sql: sql.rows, full, bounded, stale, incompatible };
  });
  await challenge("operating-envelope", { sizes: [1, 100, 1000, 5001], maxLatencyMs: 5000, maxWorkingMemoryBytes: 268435456 }, "Cold/warm/adverse workloads meet declared budget or return explicit incomplete resolution; no extrapolated scale", async () => {
    for (const size of [1, 100, 1000, 5001]) {
      const loadCompany = randomUUID();
      await admin!.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'S1 load','other')", [loadCompany, tenant, loadCompany]);
      await admin!.query(`INSERT INTO finnor_os.pe_metric_series(tenant_id,subject_type,subject_id,metric_key,name,unit,frequency,source_system,created_by)
        SELECT $1,'external_organization',$2,'load-'||n,'Load '||n,'count','instant','s1:e2e',$3 FROM generate_series(1,$4::integer) n`, [tenant, loadCompany, actor, size]);
      const timings: number[] = []; let last: BeliefView | undefined;
      await closePool(); const before = process.memoryUsage().rss;
      let sampledPeakRssBytes = before;
      const sampler = setInterval(() => { sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss); }, 5);
      try {
      for (let repeat = 0; repeat < 6; repeat++) {
        const t = performance.now(); last = await loadEnterpriseBeliefView(ctx, { root: { entityType: "external_organization", entityId: loadCompany } }); timings.push(performance.now() - t);
        sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss);
      }
      } finally { clearInterval(sampler); }
      const p95 = [...timings].sort((a, b) => a - b)[Math.ceil(timings.length * .95) - 1]!;
      const measurement = { size, timings, p95, coldMs: timings[0], sampledPeakRssBytes, samplingIntervalMs: 5, processLifetimePeakRssBytes: process.resourceUsage().maxRSS * 1024,
        rssDeltaBytes: Math.max(0, sampledPeakRssBytes - before), coverage: last!.coverage, claimCount: last!.claims.length, cost: "LOCAL_UNMETERED_NO_PROVIDER_OR_MODEL_CALLS" };
      workloads.push(measurement); assert(p95 <= 5000, `p95 exceeds budget at ${size}`); assert(measurement.rssDeltaBytes <= 268435456, `memory exceeds budget at ${size}`);
      if (size >= 1000) { assert.notEqual(last!.coverage.status, "COMPLETE"); assert.equal(last!.resolution.errorBound, null); }
    }
    return workloads;
  });
  await challenge("large-payload-budget", { records: 400, metadataBytesPerRecord: 30000, candidateBytes: 8388608 }, "Large permitted payloads are bounded before transfer and return explicit incomplete coverage without an error certificate", async () => {
    const target = randomUUID();
    const payloadContext: PeMutationContext = { auth: { tenantId: otherTenant, userId: otherActor, employeeId: otherActor, role: "owner" } };
    await admin!.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'S1 payload','other')", [target, otherTenant, target]);
    await admin!.query(`INSERT INTO finnor_os.pe_metric_series(tenant_id,subject_type,subject_id,metric_key,name,unit,frequency,source_system,created_by)
      SELECT $1,'external_organization',$2,'payload-'||n,'Payload '||n,'count','instant',repeat('x',30000),$3 FROM generate_series(1,400) n`, [otherTenant, target, otherActor]);
    const before = process.memoryUsage().rss; const t = performance.now();
    const view = await loadEnterpriseBeliefView(payloadContext, { root: { entityType: "external_organization", entityId: target } });
    assert.equal(view.claims.length, 0); assert.equal(view.coverage.canonicalStatus, "PARTIAL"); assert(view.coverage.reasons.includes("PERMITTED_CANDIDATE_BYTE_BUDGET_EXCEEDED"));
    assert.equal(view.resolution.errorBound, null);
    return { view, durationMs: performance.now() - t, endRssDeltaBytes: Math.max(0, process.memoryUsage().rss - before) };
  });
  }
} catch (error) {
  results.push({ id: "setup-or-unhandled", input: {}, expected: "Disposable setup and all challenge cases execute; no skips", status: "FAIL", observed: error instanceof Error ? { message: error.message, stack: error.stack } : String(error), durationMs: 0 });
} finally {
  await save(); await closePool().catch(() => undefined); await admin?.end().catch(() => undefined);
  await postgres.stop().catch(() => undefined); await rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ output, passed: results.filter(r => r.status === "PASS").length, failed: results.filter(r => r.status === "FAIL").length }));
if (results.some(r => r.status === "FAIL")) process.exitCode = 1;
