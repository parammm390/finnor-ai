/** Preregistered owning E2E extension. Proposals are scripted; financial outcomes,
 * authority, native plan admission, SQL, private custody and queue delivery are real. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import { closePool, getPool, receiveWork, withTenantTransaction } from "@finnor/db";
import { ObjectiveLoopRuntime, startWorkObjective, controlWorkObjective } from "../../packages/orchestration/src/objective-loop";
import { LLMPlanner, type Planner } from "../../packages/orchestration/src/planner";
import { createDefaultPluginRegistry } from "../../packages/orchestration/src/plugin-registry";
import { executeTenantOperationalQuery } from "../../packages/orchestration/src/operational-query-runtime";
import { reserveReadyPlanFrontier } from "../../packages/orchestration/src/orchestration-kernel";
import type { EconomicReadRequest, ObjectiveSuccessCondition } from "@finnor/shared-types";
import type { economicReadHttpFixture } from "./read-http-fixture.mts";

type Http = Awaited<ReturnType<typeof economicReadHttpFixture>>;
type Identity = Parameters<Http["context"]>[0];
type Check = (id: string, predicate: string, run: () => Promise<unknown>, transport?: boolean) => Promise<void>;
type Fixture = {
  admin: pg.Client; observer: pg.Client; http: Http; check: Check; evidence: string;
  tenant: string; actor: string; peerActor: string; scopedActor: string; company: string;
  foreignTenant: string; foreignActor: string; cashCompany: string;
  scope: string; quote: any; quoteSource: { id: string };
  revenueSource: { id: string }; revenueVersion: { versionId: string };
  revenueObservationId: string; cashSource: { id: string }; cashVersion: { versionId: string };
  appendQuote: (body: any) => Promise<void>;
};
const revenue = { intent: "company_revenue", company: { kind: "TENANT_DEFAULT" }, period: "LAST_COMPLETED_MONTH" } satisfies EconomicReadRequest;
const stock: EconomicReadRequest = { intent: "stock_quote", instrument: { kind: "SYMBOL", symbol: "AAPL", exchange: "XNAS" } };
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
async function artifactWrite(run: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(run), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Error("FINITE_NATIVE_ARTIFACT_WRITE_TIMEOUT")), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}
const canonical = (value: any): string => value === undefined ? "null" : value === null || typeof value !== "object"
  ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
function noFacts(value: unknown) {
  const wire = JSON.stringify(value) ?? "";
  for (const forbidden of ["950.25", "100.125", "41.75", "200.875", "999999", "finnor.recorded-revenue-statement", "finnor.recorded-market-quote"])
    assert.ok(!wire.includes(forbidden), `Shared/error/model projection disclosed ${forbidden}`);
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    for (const [key, nested] of Object.entries(node)) {
      assert.ok(!["economicRead", "economicRevenue", "economicQuote", "price", "amount"].includes(key), `Private fact key escaped: ${key}`);
      visit(nested);
    }
  };
  visit(value);
}
function denied(response: { status: number; body: unknown }) {
  assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(response)); noFacts(response.body);
}
function readCondition(requests: EconomicReadRequest[]): ObjectiveSuccessCondition {
  return { version: 1, source: "explicit", mode: "all", statement: "The original private read receipts, not their financial facts, must be currently usable.",
    criteria: requests.map(request => ({ kind: "canonical_query", request, assertion: { path: ["status"], operator: "eq", expected: "ok" } })) };
}

export async function runReadObjectiveV1Cases(f: Fixture) {
  const { admin, observer, http, check, tenant, scopedActor, company } = f;
  const journal = async (step: string, observation: unknown) => artifactWrite(() => appendFile(join(f.evidence, "objective-v1-steps.ndjson"),
    JSON.stringify({ at: new Date().toISOString(), step, observation }) + "\n"));
  const get = async (path: Parameters<Http["get"]>[0], identity: Identity = "scoped") => {
    const response = await http.get(path, identity); await journal("AUTHENTICATED_GET", { path, identity, response }); return response;
  };
  async function sources() {
    const versions = (await admin.query(`SELECT id,tenant_id,source_id,version_number,content_hash,as_of,snapshot,
      snapshot::text snapshot_text,to_jsonb(v)::text row_text FROM finnor_os.evidence_source_versions v
      WHERE source_id=ANY($1::uuid[]) ORDER BY source_id,version_number`, [[f.revenueSource.id, f.quoteSource.id, f.cashSource.id]])).rows;
    const observations = (await admin.query(`SELECT to_jsonb(o) value,to_jsonb(o)::text row_text FROM finnor_os.pe_metric_observations o
      WHERE id=$1 OR evidence_version_id=$2 ORDER BY id`, [f.revenueObservationId, f.cashVersion.versionId])).rows;
    const mappings = (await admin.query(`SELECT to_jsonb(o) value,to_jsonb(o)::text row_text FROM finnor_os.external_ref_observations o
      WHERE tenant_id=$1 AND evidence_source_id=$2 ORDER BY received_at,id`, [tenant, f.quoteSource.id])).rows;
    const sourceLinks = (await admin.query(`SELECT to_jsonb(r) value,to_jsonb(r)::text row_text FROM finnor_os.external_refs r
      WHERE tenant_id=$1 AND id IN(SELECT source_link_id FROM finnor_os.external_ref_observations
        WHERE tenant_id=$1 AND evidence_source_id=$2) ORDER BY id`, [tenant, f.quoteSource.id])).rows;
    const rows = { versions: versions.map(row => ({ ...row, row_sha256: digest(row.row_text), snapshot_sha256: digest(row.snapshot_text) })),
      observations: observations.map(row => ({ ...row, row_sha256: digest(row.row_text) })),
      mappings: mappings.map(row => ({ ...row, row_sha256: digest(row.row_text) })),
      sourceLinks: sourceLinks.map(row => ({ ...row, row_sha256: digest(row.row_text) })) };
    return rows;
  }
  const originalSources = await sources();
  assert.equal(originalSources.versions.find(row => row.id === f.revenueVersion.versionId)?.snapshot.economicRevenue.amount, "950.25");
  assert.equal(originalSources.versions.find(row => row.id === f.cashVersion.versionId)?.snapshot.economicRevenue.amount, "41.75");
  assert.equal(originalSources.versions.filter(row => row.source_id === f.quoteSource.id).at(-1)?.snapshot.economicQuote.price, "100.125");
  await artifactWrite(() => writeFile(join(f.evidence, "objective-original-source-rows.json"), JSON.stringify(originalSources, null, 2) + "\n"));

  const role = randomUUID(), assignment = randomUUID(), denyRole = randomUUID(), denyAssignment = randomUUID();
  const resourceScope = { kind: "resources", resourceType: "external_organization", resourceIds: [company] };
  // This actor has configured exact financial grants, not a legacy owner fallback.
  const priorAssignments = (await admin.query(`SELECT a.*,r.legacy_role FROM finnor_os.employee_role_assignments a
    JOIN finnor_os.employee_roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id
    WHERE a.tenant_id=$1 AND a.employee_id=$2 AND a.active ORDER BY a.id`, [tenant, scopedActor])).rows;
  assert.ok(priorAssignments.every(row => row.legacy_role && row.resource_scope?.kind === "tenant"),
    "Only the disposable user's automatic legacy assignments may precede the narrow fixture");
  await journal("DISPOSABLE_LEGACY_ASSIGNMENTS_BEFORE_NARROW_FIXTURE", priorAssignments);
  await admin.query("UPDATE finnor_os.employee_role_assignments SET active=false WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
    [tenant, priorAssignments.map(row => row.id)]);
  assert.equal((await admin.query("SELECT count(*)::int n FROM finnor_os.employee_role_assignments WHERE tenant_id=$1 AND employee_id=$2 AND active",
    [tenant, scopedActor])).rows[0].n, 0);
  await admin.query(`INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name,active) VALUES
    ($1,$2,$3,'Native exact financial read fixture',true),($4,$2,$5,'Native matching deny fixture',true)`,
    [role, tenant, `native-read-${role}`, denyRole, `native-deny-${denyRole}`]);
  await admin.query(`INSERT INTO finnor_os.employee_role_assignments(id,tenant_id,employee_id,role_id,resource_scope,effective_from)
    VALUES($1,$2,$3,$4,$5::jsonb,clock_timestamp()-interval '1 day')`, [assignment, tenant, scopedActor, role, JSON.stringify(resourceScope)]);
  await admin.query(`INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect) VALUES
    ($1,$2,'query:company_revenue','external_organization','allow'),($1,$2,'query:stock_quote','external_organization','allow'),
    ($1,$2,'query:team_roster','*','deny')`, [tenant, role]);
  const grantSnapshot = async () => ({
    assignments: (await admin.query("SELECT id,employee_id,role_id,resource_scope,active FROM finnor_os.employee_role_assignments WHERE tenant_id=$1 AND employee_id=$2 AND active ORDER BY id", [tenant, scopedActor])).rows,
    grants: (await admin.query("SELECT role_id,capability,resource_type,effect FROM finnor_os.role_authority_grants WHERE tenant_id=$1 AND role_id=ANY($2::uuid[]) ORDER BY capability,role_id", [tenant, [role, denyRole]])).rows,
  });
  const grants = await grantSnapshot(); await journal("EXACT_GRANTS_WITHOUT_GENERIC_WORK_OR_WORLD_AUTHORITY", grants);
  const registry = createDefaultPluginRegistry(), compiler = new LLMPlanner(registry);
  const actionOwner = (await import("../../apps/api/lib/orchestrator")).getOrchestrator();
  type Root = { label: string; accepted: Awaited<ReturnType<typeof startWorkObjective>>; captures: any[]; runtime: ObjectiveLoopRuntime; prepared: any; requests: EconomicReadRequest[] };
  async function custody(root: Pick<Root, "accepted">) {
    const { workId, workInputId, objectiveLoopId } = root.accepted;
    const work = (await admin.query("SELECT * FROM finnor_os.works WHERE tenant_id=$1 AND id=$2", [tenant, workId])).rows[0];
    const inputs = (await admin.query(`SELECT *,to_jsonb(i)::text row_text FROM finnor_os.work_inputs i
      WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at,id`, [tenant, workId])).rows;
    const principals = (await admin.query("SELECT id,tenant_id,role,status FROM finnor_os.users WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id",
      [tenant, [...new Set([...inputs.map(row => row.created_by), work.current_owner_id].filter(Boolean))]])).rows;
    const loop = (await admin.query(`SELECT *,success_condition::text acceptance_text FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND id=$2`, [tenant, objectiveLoopId])).rows[0];
    const plans = (await admin.query("SELECT * FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND work_id=$2 ORDER BY revision", [tenant, workId])).rows;
    const steps = (await admin.query("SELECT * FROM finnor_os.work_objective_steps WHERE tenant_id=$1 AND objective_loop_id=$2 ORDER BY step_number,id", [tenant, objectiveLoopId])).rows;
    const receipts = (await admin.query("SELECT * FROM finnor_os.work_query_executions WHERE tenant_id=$1 AND work_id=$2 AND objective_step_id IS NOT NULL ORDER BY objective_step_id", [tenant, workId])).rows;
    const privateRows = (await admin.query(`SELECT reply_key,response,response::text response_text FROM finnor_os.work_input_responses
      WHERE tenant_id=$1 AND work_input_id=$2 ORDER BY reply_key`, [tenant, workInputId])).rows.map(row => ({ ...row, response_sha256: digest(row.response_text) }));
    const events = (await admin.query("SELECT event_type,payload FROM finnor_os.work_events WHERE tenant_id=$1 AND work_id=$2 ORDER BY seq", [tenant, workId])).rows;
    const traces = (await admin.query("SELECT phase,payload FROM finnor_os.instruction_events WHERE tenant_id=$1 AND instruction_id=$2 ORDER BY seq", [tenant, root.accepted.instructionId])).rows;
    return { work, principals, inputs: inputs.map(row => ({ ...row, row_sha256: digest(row.row_text) })), loop, plans, steps, receipts, privateRows, events, traces };
  }
  const native = (root: Root, override: { expectedRevision?: number; expectedStepNumber?: number; workforceLeaseOwner?: string } = {}) => root.runtime.runIteration({
    tenantId: tenant, workId: root.accepted.workId, objectiveLoopId: root.accepted.objectiveLoopId,
    expectedRevision: 1, expectedStepNumber: 1, deferToWorkforceJob: true, signal: AbortSignal.timeout(30_000), ...override,
  });
  async function fault(table: "work_objective_steps" | "work_input_responses", root: Pick<Root, "accepted"> | { instructionId: string }, condition: string, update: boolean) {
    const name = `w1_native_${randomUUID().replaceAll("-", "")}`;
    const scope = "instructionId" in root
      ? `EXISTS(SELECT 1 FROM finnor_os.work_inputs i WHERE i.tenant_id=NEW.tenant_id
          AND i.id=NEW.work_input_id AND i.instruction_id='${root.instructionId}'::uuid)`
      : table === "work_objective_steps"
      ? `NEW.objective_loop_id='${root.accepted.objectiveLoopId}'::uuid`
      : `NEW.work_input_id='${root.accepted.workInputId}'::uuid`;
    await admin.query(`CREATE FUNCTION finnor_os.${name}() RETURNS trigger LANGUAGE plpgsql AS $owned$
      BEGIN IF NEW.tenant_id='${tenant}'::uuid AND ${scope} AND (${condition})
      THEN RAISE EXCEPTION 'W1_NATIVE_OWNED_BOUNDARY_FAULT'; END IF; RETURN NEW; END $owned$`);
    try { await admin.query(`CREATE TRIGGER ${name} BEFORE ${update ? "UPDATE" : "INSERT"} ON finnor_os.${table}
      FOR EACH ROW EXECUTE FUNCTION finnor_os.${name}()`); }
    catch (error) { await admin.query(`DROP FUNCTION finnor_os.${name}()`); throw error; }
    await journal("REAL_SQL_FAULT_INSTALLED", { table, root: "accepted" in root ? root.accepted : root, condition, update });
    return async () => { await admin.query(`DROP TRIGGER ${name} ON finnor_os.${table}`); await admin.query(`DROP FUNCTION finnor_os.${name}()`); };
  }
  async function initialMaterialFence(root: Root) {
    const before = await custody(root);
    assert.equal(before.steps.length, 0); assert.equal(before.loop.step_count, 0);
    let running: Promise<{ outcome?: Awaited<ReturnType<typeof native>>; error?: string }> | undefined;
    let result: Awaited<NonNullable<typeof running>> | undefined;
    let blocker: any, waiting: any, locks: any[], loopRows: any[], cursorRows: any[];
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL lock_timeout='5s'");
      await admin.query("SELECT pg_advisory_xact_lock(hashtextextended('v3-material-cut:' || $1::uuid::text,0))", [tenant]);
      blocker = (await admin.query("SELECT pg_backend_pid() pid,pg_current_xact_id()::text xid")).rows[0];
      running = native(root).then(outcome => ({ outcome }), failure => ({ error: String(failure) }));
      const end = Date.now() + 5_000;
      for (let attempt = 0; attempt < 200 && Date.now() < end; attempt++) {
        waiting = (await observer.query(`SELECT pid,usename,xact_start,wait_event_type,wait_event,query,pg_blocking_pids(pid) blockers,pg_backend_pid() observer_pid
          FROM pg_stat_activity WHERE datname=current_database() AND usename='finnor_app'
          AND wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid)) ORDER BY pid LIMIT 1`, [blocker.pid])).rows[0];
        if (waiting) break;
        await new Promise<void>(resolve => setTimeout(resolve, 25));
      }
      assert.ok(waiting, "The actual first controller did not reach its material-fence pause");
      await observer.query("BEGIN");
      try {
        loopRows = (await observer.query("SELECT id,step_count,query_count FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND id=$2 FOR NO KEY UPDATE NOWAIT",
          [tenant, root.accepted.objectiveLoopId])).rows;
        cursorRows = (await observer.query("SELECT tenant_id,last_seq FROM finnor_os.tenant_operational_delta_cursors WHERE tenant_id=$1 FOR UPDATE NOWAIT", [tenant])).rows;
        assert.equal(loopRows.length, 1); assert.equal(cursorRows.length, 1);
      } finally { await observer.query("ROLLBACK"); }
      locks = (await admin.query(`SELECT pid,locktype,mode,granted,virtualtransaction,transactionid::text,classid,objid,objsubid,
        relation::regclass::text relation FROM pg_locks WHERE pid=ANY($1::int[]) ORDER BY pid,locktype,granted`,
        [[blocker.pid, waiting.pid]])).rows;
      await journal("ACTUAL_INITIAL_CONTROLLER_MATERIAL_WAIT", { accepted: root.accepted, blocker, waiting, locks, loopRows, cursorRows });
    } finally {
      await admin.query("ROLLBACK");
      if (running) result = await running;
    }
    return { before, blocker, waiting, locks: locks!, loopRows: loopRows!, cursorRows: cursorRows!, result };
  }
  async function prepare(label: string, requests: EconomicReadRequest[] = [revenue], options: {
    queue?: boolean; workId?: string; maxQueries?: number; maxSteps?: number; deadlineAt?: Date;
    shape?: "chain" | "check_barrier"; condition?: ObjectiveSuccessCondition;
  } = {}): Promise<Root> {
    const captures: any[] = [];
    const proposer: Planner = { async plan(instruction, tenantContext, memory, opts) {
      if (!opts?.goalSpec || !opts.constraints || !opts.planningSnapshot) throw Error("ACTUAL_NATIVE_PLANNING_INPUTS_REQUIRED");
      captures.push(copy({ instruction, tenantContext, memory, opts: { ...opts, signal: undefined } }));
      noFacts(captures.at(-1));
      const goal = opts.goalSpec, keys = requests.map((_, index) => `read_${index + 1}`);
      assert.equal(goal.criteria.length, requests.length);
      const candidates = [{ version: 1, candidateKey: `native_${label}`, nodes: [
        ...requests.map((request, index) => ({ key: keys[index], kind: "query", request,
          dependsOn: options.shape && index > 0 ? [options.shape === "check_barrier" ? `check_${index}` : keys[index - 1]!] : [],
          supports: [goal.criteria[index]!.id] })),
        ...goal.criteria.map((criterion, index) => ({ key: `check_${index + 1}`, kind: "check", criterionId: criterion.id,
          dependsOn: options.shape ? [keys[index]!] : keys, supports: [criterion.id] })),
      ] }];
      return compiler.compileCandidatePlans({ candidates, tenantContext, goal, constraints: opts.constraints,
        snapshot: opts.planningSnapshot, verticalKey: "private_equity", planningContext: opts.planningContext, useDatabase: true });
    } };
    const accepted = await startWorkObjective(requests.length > 1
      ? "Read our recorded last-month revenue and the AAPL stock quote without creating business effects."
      : requests[0]!.intent === "stock_quote" ? "Read the AAPL stock quote without creating business effects."
        : "Read our recorded last-month revenue without creating business effects.",
    await http.context("scoped"), { workId: options.workId, channel: "console", instructionId: randomUUID(), idempotencyKey: randomUUID(),
      successCondition: options.condition ?? readCondition(requests), maxSteps: options.maxSteps ?? 16, maxActions: 0, maxQueries: options.maxQueries ?? 8,
      deadlineAt: options.deadlineAt ?? new Date(Date.now() + 600_000), deferInitialIteration: !options.queue });
    const runtime = new ObjectiveLoopRuntime(registry, actionOwner, undefined, proposer), root: Root = { label, accepted, runtime, captures, requests, prepared: null };
    // Stop the actual native owner AFTER canonical plan admission but BEFORE any
    // query reservation/dispatch. This is not a manufactured PlanGraph/receipt.
    const remove = await fault("work_objective_steps", root, "NEW.budget_reserved_at IS NOT NULL AND OLD.budget_reserved_at IS NULL", true);
    let stopped: unknown, materialFenceProbe: Awaited<ReturnType<typeof initialMaterialFence>> | undefined;
    try {
      if (label === "primary") { materialFenceProbe = await initialMaterialFence(root); stopped = materialFenceProbe.result?.error; }
      else await native(root);
    } catch (error) {
      if (label === "primary") throw error;
      stopped = String(error); noFacts(stopped);
    }
    finally { await remove(); }
    const prepared = await custody(root); root.prepared = prepared;
    assert.ok(stopped, "The actual pre-dispatch stop must have been reached");
    assert.equal(captures.length, 1); assert.equal(prepared.plans.length, 1); assert.equal(prepared.plans[0].status, "active");
    assert.equal(prepared.receipts.length, 0); assert.equal(prepared.privateRows.filter(row => row.reply_key !== "input").length, 0);
    assert.equal(prepared.loop.query_count, 0); assert.equal(prepared.steps.filter(row => row.budget_reserved_at).length, 0);
    assert.equal((await admin.query("SELECT count(*)::int n FROM finnor_os.workforce_assignments WHERE tenant_id=$1 AND work_id=$2", [tenant, accepted.workId])).rows[0].n, 0);
    const jobs = (await admin.query("SELECT * FROM finnor_os.jobs WHERE tenant_id=$1 AND payload->>'objectiveLoopId'=$2", [tenant, accepted.objectiveLoopId])).rows;
    assert.equal(jobs.length, options.queue ? 1 : 0);
    const attempts = (await admin.query("SELECT * FROM finnor_os.work_planner_attempts WHERE tenant_id=$1 AND work_id=$2", [tenant, accepted.workId])).rows;
    assert.equal(attempts.length, 1, "Only the ordinary parent admission attempt may be setup");
    if (label === "primary") assert.ok(materialFenceProbe, "The actual initial-claim material-fence probe must complete");
    const observation = { label, accepted, stopped, prepared, captures, jobs, attempts, materialFenceProbe, grants: await grantSnapshot() };
    await artifactWrite(() => appendFile(join(f.evidence, "objective-v1-setups.ndjson"), JSON.stringify(observation) + "\n"));
    return root;
  }
  function committed(snapshot: Awaited<ReturnType<typeof custody>>, requests: EconomicReadRequest[]) {
    assert.equal(snapshot.receipts.length, requests.length);
    assert.equal(snapshot.privateRows.filter(row => row.reply_key.startsWith("objective:")).length, requests.length);
    for (const receipt of snapshot.receipts) {
      assert.equal(receipt.status, "succeeded");
      const row = snapshot.privateRows.find(item => item.reply_key === `objective:${receipt.objective_step_id}`); assert.ok(row);
      const reply = row.response, origin = reply.objective, step = snapshot.steps.find(item => item.id === receipt.objective_step_id);
      const plan = snapshot.plans.find(item => item.id === origin.planRevisionId); assert.ok(plan && step);
      const input = snapshot.inputs.find(item => item.id === reply.workInputId); assert.ok(input);
      assert.equal(origin.originalPrincipalId, scopedActor); assert.equal(origin.originalWorkInputId, input.id);
      assert.equal(origin.originalInstructionId, input.instruction_id); assert.equal(origin.originalInputSha256, digest(input.instruction_text));
      assert.equal(origin.objectiveLoopId, snapshot.loop.id); assert.equal(origin.objectiveRevision, snapshot.loop.revision);
      assert.equal(origin.planRevisionId, step.plan_revision_id); assert.equal(origin.planNodeId, step.plan_node_id);
      assert.equal(origin.objectiveStepId, step.id); assert.equal(origin.attemptNumber, step.attempt_number);
      assert.equal(origin.planSemanticHash, plan.semantic_hash); assert.equal(origin.goalSemanticHash, plan.goal_hash);
      assert.equal(origin.nodeSemanticHash, plan.plan_graph.nodes.find((node: any) => node.id === step.plan_node_id).semanticHash);
      assert.equal(origin.acceptanceHash, `sha256:${digest(canonical(snapshot.loop.success_condition))}`);
      assert.deepEqual(plan.goal_spec.successCondition, snapshot.loop.success_condition);
      assert.equal(input.created_by, scopedActor); assert.equal(reply.instructionId, input.instruction_id);
      assert.equal(reply.workId, snapshot.work.id); assert.equal(receipt.work_input_id, input.id);
      assert.equal(reply.query.result.execution.id, receipt.id); assert.equal(reply.query.metadata.queryId, receipt.id);
      assert.equal(receipt.execution_key, `objective-economic:${step.id}`); assert.deepEqual(reply.query.request, receipt.request);
      assert.ok(requests.some(request => canonical(request) === canonical(receipt.request)));
      assert.deepEqual(plan.plan_graph.nodes.find((node: any) => node.id === step.plan_node_id).request, receipt.request);
      const economic = reply.query.result.economicRead;
      if (receipt.intent === "company_revenue") {
        assert.equal(economic.statement.amount, "950.25"); assert.equal(economic.statement.companyId, company);
        assert.equal(economic.statement.basis, "ACCRUAL"); assert.equal(economic.statement.currency, "USD");
        assert.equal(economic.witnesses[0].versionId, f.revenueVersion.versionId);
        assert.equal(economic.witnesses[0].observationId, f.revenueObservationId);
      } else {
        assert.equal(economic.quote.price, "100.125"); assert.equal(economic.quote.providerTimestamp, f.quote.providerTimestamp);
        assert.equal(economic.quote.instrument.symbol, "AAPL"); assert.equal(economic.quote.instrument.exchange, "XNAS");
        assert.equal(economic.quote.instrument.issuerCompanyId, company); assert.equal(economic.quote.license.displayAllowed, true);
      }
    }
    return snapshot;
  }
  const privateGet = (root: Root, stepId: string, identity: Identity = "scoped", inputId = root.accepted.workInputId, workId = root.accepted.workId) =>
    get(`/api/queries?workId=${workId}&workInputId=${inputId}&objectiveStepId=${stepId}`, identity);
  async function faultedCommit(root: Root, afterProof = false) {
    const remove = await fault("work_objective_steps", root, afterProof
      ? "NEW.completed_at IS NOT NULL AND NEW.decision_kind='complete'"
      : "NEW.completed_at IS NOT NULL AND NEW.query_execution_id IS NOT NULL", true);
    let error: unknown;
    try { await native(root); } catch (failure) { error = String(failure); noFacts(error); }
    finally { await remove(); }
    assert.ok(error, "Actual post-private-commit finalization fault was not reached");
    const snapshot = committed(await custody(root), root.requests);
    assert.equal(snapshot.loop.state, "continue");
    assert.ok(snapshot.steps.some(row => !row.completed_at));
    await journal("FAULTED_PRIVATE_COMMIT", { root: root.accepted, afterProof, error, snapshot });
    return { error, snapshot };
  }
  const privateBytes = (snapshot: Awaited<ReturnType<typeof custody>>) => snapshot.privateRows.map(row => ({
    reply_key: row.reply_key, response_text: row.response_text, response_sha256: row.response_sha256,
  }));
  async function refusedNative(root: Root) {
    let error: unknown; try { await native(root); } catch (failure) { error = String(failure); }
    assert.ok(error, "Current native continuation returned without rechecking private custody");
    noFacts(error); return error;
  }
  async function completionFence(root: Root, mode: "input" | "deadline" | "deadline_seal") {
    const before = await faultedCommit(root, true);
    assert.equal(before.snapshot.plans[0].status, "active", "Plan sealing must roll back with the failed final step");
    let running: Promise<{ outcome?: Awaited<ReturnType<typeof native>>; error?: string }> | undefined;
    let result: Awaited<NonNullable<typeof running>> | undefined;
    let blockedRead: any, claimed: Awaited<ReturnType<typeof custody>> | undefined, newInput: Awaited<ReturnType<typeof receiveWork>> | undefined;
    let mutationAt: string | undefined, claimUntil: string | undefined;
    let intake: Promise<{ received?: Awaited<ReturnType<typeof receiveWork>>; error?: string }> | undefined;
    let intakeResult: Awaited<NonNullable<typeof intake>> | undefined;
    let intakeWait: any, intakeCursorRows: any[] | undefined, intakeLocks: any[] | undefined;
    let pauseOwnerPid: number | undefined, scheduleFailure: string | undefined;
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL lock_timeout='5s'");
      pauseOwnerPid = (await admin.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      if (mode === "deadline_seal") await admin.query("SELECT id FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND id=$2 FOR NO KEY UPDATE",
        [tenant, before.snapshot.plans[0].id]);
      else await admin.query("LOCK TABLE finnor_os.evidence_source_versions IN ACCESS EXCLUSIVE MODE");
      running = native(root).then(outcome => ({ outcome }), failure => ({ error: String(failure) }));
      const awaitedTable = mode === "deadline_seal" ? "work_plan_revisions" : "evidence_source_versions";
      const observationDeadline = Date.now() + 5_000;
      for (let attempt = 0; attempt < 200 && Date.now() < observationDeadline; attempt++) {
        blockedRead = (await observer.query(`SELECT pid,usename,wait_event_type,wait_event,query_start,query,pg_backend_pid() observer_pid,pg_blocking_pids(pid) blockers
          FROM pg_stat_activity WHERE datname=current_database() AND usename='finnor_app'
          AND wait_event_type='Lock' AND position($1::text in query)>0
          AND pid<>pg_backend_pid() ORDER BY pid LIMIT 1`, [awaitedTable])).rows[0];
        if (blockedRead) break;
        await new Promise<void>(resolve => setTimeout(resolve, 25));
      }
      assert.ok(blockedRead && /^\s*select\b/i.test(blockedRead.query), "The real native SELECT did not reach the registered pause");
      if (mode === "deadline_seal") assert.match(blockedRead.query, /^\s*SELECT id FROM .*work_plan_revisions.*FOR NO KEY UPDATE\s*$/i);
      noFacts(blockedRead);
      claimed = await custody(root);
      const checkStep = claimed.steps.find(row => !row.completed_at && row.claim_owner === claimed!.loop.lease_owner);
      assert.ok(checkStep?.claim_owner && checkStep.claim_until);
      assert.equal(claimed.plans[0].plan_graph.nodes.find((row: any) => row.id === checkStep.plan_node_id)?.kind, "check");
      claimUntil = new Date(checkStep.claim_until).toISOString();
      if (mode === "deadline_seal") {
        intake = receiveWork({ tenantId: tenant, userId: scopedActor, channel: "console",
          instruction: "An independent original-human intake waits for canonical material publication.",
          instructionId: randomUUID(), idempotencyKey: randomUUID() })
          .then(received => ({ received }), failure => ({ error: String(failure) }));
        const end = Date.now() + 5_000;
        for (let attempt = 0; attempt < 200 && Date.now() < end; attempt++) {
          intakeWait = (await observer.query(`SELECT pid,usename,xact_start,wait_event_type,wait_event,query,pg_blocking_pids(pid) blockers,pg_backend_pid() observer_pid
            FROM pg_stat_activity WHERE datname=current_database() AND usename='finnor_app'
            AND wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid)) ORDER BY pid LIMIT 1`, [blockedRead.pid])).rows[0];
          if (intakeWait) break;
          await new Promise<void>(resolve => setTimeout(resolve, 25));
        }
        assert.ok(intakeWait, "The distinct original intake did not wait on the actual finalizer");
        await observer.query("BEGIN");
        try {
          intakeCursorRows = (await observer.query("SELECT tenant_id,last_seq FROM finnor_os.tenant_operational_delta_cursors WHERE tenant_id=$1 FOR UPDATE NOWAIT", [tenant])).rows;
          assert.equal(intakeCursorRows.length, 1);
        } finally { await observer.query("ROLLBACK"); }
        intakeLocks = (await admin.query(`SELECT pid,locktype,mode,granted,virtualtransaction,transactionid::text,classid,objid,objsubid,
          relation::regclass::text relation FROM pg_locks WHERE pid=ANY($1::int[]) ORDER BY pid,locktype,granted`,
          [[blockedRead.pid, intakeWait.pid]])).rows;
      }
      if (mode === "input") {
        newInput = await receiveWork({ tenantId: tenant, workId: root.accepted.workId, userId: scopedActor,
          instruction: "A new original-human instruction supersedes the earlier accepted private read proof.",
          channel: "console", instructionId: randomUUID(), idempotencyKey: randomUUID() });
        assert.equal(newInput.created, false); assert.equal(newInput.duplicate, false);
        assert.equal(newInput.workId, root.accepted.workId); assert.notEqual(newInput.workInputId, root.accepted.workInputId);
      } else {
        const delay = Math.max(0, new Date(claimed.loop.deadline_at).getTime() - Date.now() + 30);
        assert.ok(delay <= 7_000, "The accepted completion deadline must fit within its unchanged ten-second SQL timeout");
        await new Promise<void>(resolve => setTimeout(resolve, delay));
      }
      mutationAt = (await admin.query("SELECT clock_timestamp() now")).rows[0].now.toISOString();
      assert.ok(typeof mutationAt === "string" && typeof claimUntil === "string");
      assert.ok(Date.parse(claimUntil) > Date.parse(mutationAt), "An expired claim would mask the completion fence");
      if (mode !== "input") assert.ok(Date.parse(mutationAt) >= new Date(claimed.loop.deadline_at).getTime());
      await journal("ACTUAL_NATIVE_COMPLETION_FENCE_WAIT", { mode, blockedRead, claimed, newInput, mutationAt, claimUntil,
        pauseOwnerPid, intakeWait, intakeCursorRows, intakeLocks });
    } catch (failure) {
      scheduleFailure = String(failure);
      const activities = (await observer.query(`SELECT pid,usename,state,wait_event_type,wait_event,query,pg_backend_pid() observer_pid,pg_blocking_pids(pid) blockers
        FROM pg_stat_activity WHERE datname=current_database() AND usename='finnor_app' AND state<>'idle' ORDER BY pid`)).rows;
      await journal("FAILED_NATIVE_COMPLETION_FENCE_WAIT", { mode, accepted: root.accepted, error: scheduleFailure,
        pauseOwnerPid, activities, snapshot: await custody(root) });
      throw failure;
    } finally {
      await admin.query("ROLLBACK");
      if (running) result = await running;
      if (intake) intakeResult = await intake;
      if (scheduleFailure) await journal("FAILED_NATIVE_COMPLETION_FENCE_RELEASED", {
        mode, error: scheduleFailure, result, intakeResult, after: await custody(root) });
    }
    const after = await custody(root);
    await journal("ACTUAL_NATIVE_COMPLETION_FENCE_RELEASED", { mode, result, intakeResult, after });
    assert.equal(result?.error, undefined); assert.equal(result?.outcome, "continue");
    assert.notEqual(after.work.status, "completed"); assert.equal(after.loop.state, "continue");
    assert.equal(after.plans[0].status, "active"); assert.equal(after.plans[0].completion_proof, null);
    assert.equal(after.loop.acceptance_text, before.snapshot.loop.acceptance_text);
    assert.equal(after.loop.deadline_at.toISOString(), before.snapshot.loop.deadline_at.toISOString());
    assert.equal(after.loop.query_count, before.snapshot.loop.query_count);
    assert.equal(after.loop.node_attempt_count, before.snapshot.loop.node_attempt_count);
    assert.deepEqual(privateBytes(after), privateBytes(before.snapshot)); assert.deepEqual(after.receipts, before.snapshot.receipts);
    if (newInput) assert.equal(after.inputs.at(-1)?.id, newInput.workInputId);
    let independentIntakeRows: any[] | undefined;
    if (mode === "deadline_seal") {
      assert.equal(intakeResult?.error, undefined); assert.ok(intakeResult?.received?.created);
      assert.equal(intakeResult.received.duplicate, false); assert.notEqual(intakeResult.received.workId, root.accepted.workId);
      independentIntakeRows = (await admin.query(`SELECT w.id,w.created_by,to_jsonb(w)::text work_row_text,i.id input_id,i.created_by input_created_by,
        i.instruction_id,i.instruction_text,to_jsonb(i)::text input_row_text,
        (SELECT count(*)::int FROM finnor_os.work_objective_loops l WHERE l.tenant_id=w.tenant_id AND l.work_id=w.id) objective_count,
        (SELECT count(*)::int FROM finnor_os.work_query_executions q WHERE q.tenant_id=w.tenant_id AND q.work_id=w.id) query_count,
        (SELECT count(*)::int FROM finnor_os.work_planner_attempts p WHERE p.tenant_id=w.tenant_id AND p.work_id=w.id) planner_attempt_count
        FROM finnor_os.works w
        JOIN finnor_os.work_inputs i ON i.tenant_id=w.tenant_id AND i.work_id=w.id
        WHERE w.tenant_id=$1 AND w.id=$2 AND i.id=$3`,
        [tenant, intakeResult.received.workId, intakeResult.received.workInputId])).rows;
      assert.equal(independentIntakeRows.length, 1);
    }
    return { mode, before, blockedRead, claimed, newInput, mutationAt, claimUntil, result, after,
      pauseOwnerPid, intakeWait, intakeCursorRows, intakeLocks, intakeResult, independentIntakeRows };
  }

  try {
    const primary = await prepare("primary", [revenue, stock], { queue: true });
    const chainRoot = await prepare("three_query_chain", [revenue, stock, { ...revenue, basis: "ACCRUAL", currency: "USD" }], { shape: "chain" });
    const barrierRoot = await prepare("query_check_barriers", [revenue, stock, { ...revenue, basis: "ACCRUAL", currency: "USD" }], { shape: "check_barrier" });
    const repeatedCondition = readCondition([revenue, revenue]);
    assert.equal(repeatedCondition.criteria[1]!.kind, "canonical_query");
    if (repeatedCondition.criteria[1]!.kind === "canonical_query")
      repeatedCondition.criteria[1]!.assertion = { path: ["execution", "status"], operator: "eq", expected: "succeeded" };
    const repeatedRoot = await prepare("repeated_request_criteria", [revenue, revenue], { condition: repeatedCondition });
    // A changed current owner is not the original input principal.
    await admin.query("UPDATE finnor_os.works SET current_owner_id=$3 WHERE tenant_id=$1 AND id=$2", [tenant, primary.accepted.workId, f.peerActor]);
    let primarySnapshot: Awaited<ReturnType<typeof custody>> | undefined;
    await check("OBJ_QUEUE_INLINE_NO_ACTIVATION", "The pre-existing root queue job runs native financial nodes inline, as the original human, without any new activation", async () => {
      const priorUrl = process.env.DATABASE_URL, workerUrl = new URL(priorUrl!);
      workerUrl.username = "finnor_worker"; workerUrl.password = "w1_disposable_native_worker";
      await admin.query("ALTER ROLE finnor_worker LOGIN PASSWORD 'w1_disposable_native_worker'");
      let principal, job;
      try {
        process.env.DATABASE_URL = workerUrl.href; await closePool();
        const { JobQueue } = await import("../../apps/worker/src/queue");
        const { runObjectiveIteration } = await import("../../apps/worker/src/handlers/run-objective-iteration");
        const cutover = (await admin.query("SELECT * FROM finnor_os.compute_plane_cutover WHERE singleton=true")).rows[0];
        const queue = new JobQueue(`native-objective-${randomUUID()}`, 300, cutover.state === "authoritative" ? "INTERACTIVE" : null);
        queue.register("run_objective_iteration", runObjectiveIteration,
          { protocolVersions: [1], retrySafety: "locally_idempotent", allowedClasses: ["INTERACTIVE"] });
        principal = (await getPool().query("SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
        assert.equal(principal.current_user, "finnor_worker"); assert.equal(principal.rolsuper, false); assert.equal(principal.rolbypassrls, false);
        assert.equal(await queue.tick(AbortSignal.timeout(30_000)), true);
        primarySnapshot = committed(await custody(primary), [revenue, stock]);
        assert.equal(primarySnapshot.loop.state, "completed"); assert.equal(primarySnapshot.work.status, "completed");
        job = (await admin.query("SELECT * FROM finnor_os.jobs WHERE tenant_id=$1 AND payload->>'objectiveLoopId'=$2", [tenant, primary.accepted.objectiveLoopId])).rows;
        assert.equal(job.length, 1); assert.equal(job[0].status, "completed"); assert.equal(job[0].attempts, 1);
        return { setup: primary.prepared, principal, cutover, job, snapshot: primarySnapshot };
      } finally { process.env.DATABASE_URL = priorUrl; await closePool(); }
    }, true);
    await check("OBJ_PLAN_SCOPED_RESOLUTION", "Actual native compiler/admission and private dispatch require only the resolved subject's exact financial grants", async () => {
      const snapshot = committed(await custody(primary), [revenue, stock]);
      const receipt = snapshot.receipts.find(row => row.intent === "company_revenue")!;
      const response = await privateGet(primary, receipt.objective_step_id); assert.equal(response.status, 200); assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.body.query.result.economicRead.statement.amount, "950.25");
      const principal = (await getPool().query("SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
      assert.equal(principal.current_user, "finnor_app"); assert.equal(principal.rolsuper, false); assert.equal(principal.rolbypassrls, false);
      return { setup: primary.prepared, captures: primary.captures, grants: await grantSnapshot(), principal, response, snapshot };
    }, true);
    await check("OBJ_MULTI_QUERY_PRIVATE_CUSTODY", "One actual human input owns separate immutable revenue and quote native-step slots and exact original accepted provenance", async () => {
      const snapshot = committed(await custody(primary), [revenue, stock]);
      assert.equal(snapshot.inputs.length, 1); assert.equal(snapshot.privateRows.length, 2);
      assert.ok(snapshot.privateRows.every(row => row.reply_key.startsWith("objective:")));
      assert.equal(new Set(snapshot.receipts.map(row => row.objective_step_id)).size, 2);
      const input = snapshot.inputs[0];
      const ordinaryDuplicate = await receiveWork({ tenantId: tenant, workId: snapshot.work.id,
        instructionId: input.instruction_id, instruction: input.instruction_text, channel: "console", userId: scopedActor,
        idempotencyKey: input.idempotency_key });
      assert.equal(ordinaryDuplicate.duplicate, true); assert.ok(!Object.hasOwn(ordinaryDuplicate, "response"));
      noFacts(ordinaryDuplicate);
      const responses = await Promise.all(snapshot.receipts.map(row => privateGet(primary, row.objective_step_id)));
      responses.forEach(response => assert.equal(response.status, 200));
      const chainOutcome = await native(chainRoot), chainSnapshot = committed(await custody(chainRoot), chainRoot.requests);
      assert.equal(chainOutcome, "completed"); assert.equal(chainSnapshot.receipts.length, 3);
      const repeatedOutcome = await native(repeatedRoot), repeatedSnapshot = committed(await custody(repeatedRoot), repeatedRoot.requests);
      assert.equal(repeatedOutcome, "completed"); assert.equal(repeatedSnapshot.receipts.length, 2);
      assert.equal(new Set(repeatedSnapshot.receipts.map(row => row.objective_step_id)).size, 2);
      const barrierOutcome = await native(barrierRoot), barrierSnapshot = committed(await custody(barrierRoot), barrierRoot.requests);
      assert.equal(barrierOutcome, "completed"); assert.equal(barrierSnapshot.receipts.length, 3);
      return { snapshot, ordinaryDuplicate, responses,
        chain: { setup: chainRoot.prepared, outcome: chainOutcome, snapshot: chainSnapshot },
        repeated: { setup: repeatedRoot.prepared, outcome: repeatedOutcome, snapshot: repeatedSnapshot },
        barrier: { setup: barrierRoot.prepared, outcome: barrierOutcome, snapshot: barrierSnapshot } };
    }, true);
    await check("OBJ_SAME_PRINCIPAL_REPLAY", "Authenticated retrieval and exact native-node redelivery retain first committed JSONB bytes and complete canonical metadata", async () => {
      const before = committed(await custody(primary), [revenue, stock]), responses = [];
      for (const receipt of before.receipts) {
        const response = await privateGet(primary, receipt.objective_step_id); assert.equal(response.status, 200);
        assert.deepEqual(response.body, before.privateRows.find(row => row.reply_key === `objective:${receipt.objective_step_id}`)!.response);
        const step = before.steps.find(row => row.id === receipt.objective_step_id)!;
        assert.equal(await native(primary, { expectedStepNumber: step.step_number }), "completed");
        responses.push(response);
      }
      const after = committed(await custody(primary), [revenue, stock]); assert.deepEqual(privateBytes(after), privateBytes(before));
      assert.deepEqual(after.receipts, before.receipts); return { before, responses, after };
    }, true);

    const humanRoot = await prepare("original_human");
    await check("OBJ_ORIGINAL_HUMAN_ONLY", "Current owner, tenant owner, peer, foreign bearer or service identity cannot replace the original active input human", async () => {
      const primaryState = committed(await custody(primary), [revenue, stock]), stepId = primaryState.receipts[0]!.objective_step_id;
      const denials = [];
      for (const identity of ["actor", "peer", "foreign", "anonymous", "invalid"] as const) {
        const response = await privateGet(primary, stepId, identity); denied(response); denials.push({ identity, response });
      }
      const { readObjectiveEconomicQueryReply } = await import("../../packages/orchestration/src/objective-economic-reads");
      let serviceError: unknown;
      try { await readObjectiveEconomicQueryReply({ ...await http.context("scoped"), userId: "system:objective-loop", employeeId: undefined },
        { workId: primary.accepted.workId, workInputId: primary.accepted.workInputId, objectiveStepId: stepId }); }
      catch (error) { serviceError = String(error); }
      assert.ok(serviceError); noFacts(serviceError);
      const pending = await faultedCommit(humanRoot);
      const privateStep = pending.snapshot.receipts[0]!.objective_step_id;
      let inactiveHttp, inactiveNative, inactiveSnapshot;
      try {
        await admin.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2", [tenant, scopedActor]);
        inactiveHttp = await privateGet(humanRoot, privateStep); denied(inactiveHttp);
        inactiveNative = await refusedNative(humanRoot);
        inactiveSnapshot = await custody(humanRoot); assert.notEqual(inactiveSnapshot.loop.state, "completed");
      } finally { await admin.query("UPDATE finnor_os.users SET status='active' WHERE tenant_id=$1 AND id=$2", [tenant, scopedActor]); }
      const restored = await privateGet(humanRoot, privateStep); assert.equal(restored.status, 200);
      assert.deepEqual(restored.body, pending.snapshot.privateRows[0]!.response);
      assert.equal(await native(humanRoot), "completed");
      const after = committed(await custody(humanRoot), [revenue]); assert.deepEqual(privateBytes(after), privateBytes(pending.snapshot));
      return { primaryState, denials, serviceError, pending, inactiveHttp, inactiveNative, inactiveSnapshot, restored, after };
    }, true);

    const committedRoot = await prepare("committed_step"), proofRoot = await prepare("committed_proof");
    const boundedDeliveryRoot = await prepare("two_step_completed_delivery", [revenue], { maxSteps: 2 });
    await check("OBJ_COMMITTED_STEP_RECOVERY", "Actual post-private/pre-step and post-CompletionProof/pre-loop faults recover the same original native custody without re-timing", async () => {
      const scenarios = [];
      for (const [root, afterProof] of [[committedRoot, false], [proofRoot, true]] as const) {
        const before = await faultedCommit(root, afterProof);
        if (afterProof) assert.equal(before.snapshot.plans[0].status, "active", "Sealing and final check must roll back together");
        const httpBefore = await privateGet(root, before.snapshot.receipts[0]!.objective_step_id); assert.equal(httpBefore.status, 200);
        assert.equal(await native(root), "completed");
        const after = committed(await custody(root), root.requests);
        assert.equal(after.loop.state, "completed"); assert.equal(after.work.status, "completed");
        assert.deepEqual(privateBytes(after), privateBytes(before.snapshot));
        assert.deepEqual(after.receipts, before.snapshot.receipts);
        scenarios.push({ afterProof, before, httpBefore, after });
      }
      const before = await faultedCommit(boundedDeliveryRoot, true);
      assert.equal(before.snapshot.loop.max_steps, 2); assert.equal(before.snapshot.loop.step_count, 2);
      assert.ok(before.snapshot.steps.find(row => row.step_number === 1)?.completed_at);
      assert.ok(!before.snapshot.steps.find(row => row.step_number === 2)?.completed_at);
      const outcome = await native(boundedDeliveryRoot, { expectedStepNumber: 1 });
      const after = committed(await custody(boundedDeliveryRoot), [revenue]);
      assert.equal(outcome, "completed"); assert.equal(after.loop.step_count, 2); assert.equal(after.steps.length, 2);
      assert.equal(after.loop.query_count, before.snapshot.loop.query_count);
      assert.equal(after.loop.node_attempt_count, before.snapshot.loop.node_attempt_count);
      assert.deepEqual(privateBytes(after), privateBytes(before.snapshot)); assert.deepEqual(after.receipts, before.snapshot.receipts);
      return { scenarios, boundedDelivery: { before, outcome, after } };
    }, true);

    const uncommitted = await prepare("uncommitted_private");
    await check("OBJ_UNCOMMITTED_PRIVATE_RECOVERY", "An actual private INSERT fault cannot leave a succeeded receipt, and only current native recovery can rearm the same row", async () => {
      const remove = await fault("work_input_responses", uncommitted, "NEW.reply_key LIKE 'objective:%'", false);
      let error: unknown;
      try { await native(uncommitted); } catch (failure) { error = String(failure); noFacts(error); }
      finally { await remove(); }
      assert.ok(error);
      const before = await custody(uncommitted); assert.equal(before.receipts.length, 1);
      assert.equal(before.receipts[0].status, "failed"); assert.equal(before.privateRows.length, 0);
      let unfencedError: unknown;
      try { await executeTenantOperationalQuery(tenant, revenue, { workId: uncommitted.accepted.workId,
        workInputId: uncommitted.accepted.workInputId, userId: scopedActor, employeeId: scopedActor,
        executionKey: before.receipts[0].execution_key }); } catch (failure) { unfencedError = String(failure); }
      assert.ok(unfencedError); noFacts(unfencedError);
      const unfenced = await custody(uncommitted); assert.equal(unfenced.privateRows.length, 0);
      assert.deepEqual(unfenced.receipts, before.receipts);
      let staleClaimError: unknown;
      try { await executeTenantOperationalQuery(tenant, revenue, { workId: uncommitted.accepted.workId,
        workInputId: uncommitted.accepted.workInputId, userId: scopedActor, employeeId: scopedActor,
        executionKey: before.receipts[0].execution_key, objectiveClaim: {
          stepId: before.receipts[0].objective_step_id, leaseOwner: before.receipts[0].objective_claim_owner } }); }
      catch (failure) { staleClaimError = String(failure); }
      assert.ok(staleClaimError); noFacts(staleClaimError);
      assert.equal(await native(uncommitted), "completed");
      const after = committed(await custody(uncommitted), [revenue]);
      assert.equal(after.receipts[0].id, before.receipts[0].id); assert.equal(after.loop.query_count, 2);
      return { error, before, unfencedError, unfenced, staleClaimError, after };
    }, true);

    const grantRoot = await prepare("current_grants");
    await check("OBJ_CURRENT_GRANTS_REPLAY", "Exact grant, scope and matching deny changes are checked on both actual private HTTP replay and native continuation", async () => {
      const before = await faultedCommit(grantRoot), step = before.snapshot.receipts[0]!.objective_step_id;
      const scenarios: Array<{ name: string; change: () => Promise<unknown>; restore: () => Promise<unknown> }> = [
        { name: "missing exact query grant",
          change: () => admin.query("DELETE FROM finnor_os.role_authority_grants WHERE tenant_id=$1 AND role_id=$2 AND capability='query:company_revenue'", [tenant, role]),
          restore: () => admin.query("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect) VALUES($1,$2,'query:company_revenue','external_organization','allow')", [tenant, role]) },
        { name: "changed exact source resource scope",
          change: () => admin.query("UPDATE finnor_os.employee_role_assignments SET resource_scope=$3::jsonb WHERE tenant_id=$1 AND id=$2",
            [tenant, assignment, JSON.stringify({ ...resourceScope, resourceIds: [f.cashCompany] })]),
          restore: () => admin.query("UPDATE finnor_os.employee_role_assignments SET resource_scope=$3::jsonb WHERE tenant_id=$1 AND id=$2", [tenant, assignment, JSON.stringify(resourceScope)]) },
        { name: "matching exact-capability deny",
          change: async () => {
            await admin.query("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect) VALUES($1,$2,'query:company_revenue','external_organization','deny')", [tenant, denyRole]);
            await admin.query("INSERT INTO finnor_os.employee_role_assignments(id,tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,$4,$5::jsonb)",
              [denyAssignment, tenant, scopedActor, denyRole, JSON.stringify(resourceScope)]);
          },
          restore: async () => {
            await admin.query("DELETE FROM finnor_os.employee_role_assignments WHERE tenant_id=$1 AND id=$2", [tenant, denyAssignment]);
            await admin.query("DELETE FROM finnor_os.role_authority_grants WHERE tenant_id=$1 AND role_id=$2", [tenant, denyRole]);
          } },
      ];
      const observations = [];
      for (const scenario of scenarios) {
        try {
          await scenario.change();
          const currentGrants = await grantSnapshot(), httpDenial = await privateGet(grantRoot, step); denied(httpDenial);
          const nativeError = await refusedNative(grantRoot), snapshot = await custody(grantRoot);
          assert.notEqual(snapshot.loop.state, "completed"); assert.deepEqual(privateBytes(snapshot), privateBytes(before.snapshot));
          observations.push({ name: scenario.name, currentGrants, httpDenial, nativeError, snapshot });
        } finally { await scenario.restore(); }
      }
      const restored = await privateGet(grantRoot, step); assert.equal(restored.status, 200);
      assert.deepEqual(restored.body, before.snapshot.privateRows[0].response);
      assert.equal(await native(grantRoot), "completed");
      const after = committed(await custody(grantRoot), [revenue]); assert.deepEqual(privateBytes(after), privateBytes(before.snapshot));
      return { before, observations, restored, after };
    }, true);

    const invalidPlan = await prepare("inactive_plan"), invalidRevision = await prepare("changed_generation"), otherInput = await prepare("other_original_input");
    await check("OBJ_NATIVE_PROVENANCE_BINDING", "Work/input selectors, forged steps, inactive selected plans and changed native generations are not provenance or permission", async () => {
      const primaryState = committed(await custody(primary), [revenue, stock]), stepId = primaryState.receipts[0].objective_step_id;
      const selectors = [
        await privateGet(primary, randomUUID()),
        await privateGet(primary, stepId, "scoped", otherInput.accepted.workInputId),
        await privateGet(primary, stepId, "scoped", primary.accepted.workInputId, otherInput.accepted.workId),
      ];
      selectors.forEach(denied);
      const fenced = [];
      for (const [root, mode] of [[invalidPlan, "inactive_plan"], [invalidRevision, "changed_revision"]] as const) {
        const reservation = await reserveReadyPlanFrontier({ tenantId: tenant, workId: root.accepted.workId,
          objectiveLoopId: root.accepted.objectiveLoopId, expectedObjectiveRevision: 1, planRevisionId: root.prepared.plans[0].id,
          controllerStepId: root.prepared.steps[0].id, maxReady: 1 });
        assert.equal(reservation.state, "reserved");
        if (reservation.state !== "reserved") throw Error("ACTUAL_NATIVE_RESERVATION_REQUIRED");
        assert.equal(reservation.reservations.length, 1);
        if (mode === "inactive_plan") await admin.query("UPDATE finnor_os.work_plan_revisions SET status='superseded' WHERE tenant_id=$1 AND id=$2", [tenant, root.prepared.plans[0].id]);
        else await admin.query("UPDATE finnor_os.work_objective_loops SET revision=revision+1 WHERE tenant_id=$1 AND id=$2", [tenant, root.accepted.objectiveLoopId]);
        const outcome = await native(root, { expectedStepNumber: reservation.reservations[0]!.step.stepNumber });
        const snapshot = await custody(root);
        assert.equal(snapshot.receipts.length, 0); assert.equal(snapshot.privateRows.length, 0); assert.notEqual(outcome, "completed");
        fenced.push({ mode, reservation, outcome, snapshot });
      }
      const after = await custody(primary); assert.deepEqual(privateBytes(after), privateBytes(primaryState));
      return { primaryState, selectors, fenced, after };
    }, true);

    const conflictRoot = await prepare("current_claim_conflicts");
    await check("OBJ_REQUEST_CONFLICT_NODE_PROVENANCE", "A genuinely current native claim permits unchanged replay but refuses each independently changed bound field", async () => {
      const remove = await fault("work_objective_steps", conflictRoot,
        "(NEW.completed_at IS NOT NULL AND NEW.query_execution_id IS NOT NULL) OR (NEW.claim_owner IS NULL AND OLD.claim_owner IS NOT NULL)", true);
      let ownedFault: unknown;
      try { await native(conflictRoot); } catch (failure) { ownedFault = String(failure); noFacts(ownedFault); }
      finally { await remove(); }
      assert.ok(ownedFault, "The actual native claim-retention fault was not reached");
      const before = committed(await custody(conflictRoot), [revenue]), receipt = before.receipts[0]!;
      const claim = { stepId: receipt.objective_step_id, leaseOwner: before.loop.lease_owner as string };
      assert.ok(claim.leaseOwner);
      const attempts = [
        { name: "different typed request", request: { ...revenue, basis: "CASH" }, inputId: conflictRoot.accepted.workInputId, actor: scopedActor, executionKey: receipt.execution_key, claim },
        { name: "different key", request: revenue, inputId: conflictRoot.accepted.workInputId, actor: scopedActor, executionKey: randomUUID(), claim },
        { name: "different input", request: revenue, inputId: otherInput.accepted.workInputId, actor: scopedActor, executionKey: receipt.execution_key, claim },
        { name: "different principal", request: revenue, inputId: conflictRoot.accepted.workInputId, actor: f.peerActor, executionKey: receipt.execution_key, claim },
        { name: "unbound node", request: revenue, inputId: conflictRoot.accepted.workInputId, actor: scopedActor, executionKey: receipt.execution_key, claim: { ...claim, stepId: randomUUID() } },
      ];
      const observations = [];
      for (const attempt of attempts) {
        const control = await executeTenantOperationalQuery(tenant, revenue, {
          workId: conflictRoot.accepted.workId, workInputId: conflictRoot.accepted.workInputId,
          userId: scopedActor, employeeId: scopedActor, executionKey: receipt.execution_key, objectiveClaim: claim });
        assert.deepEqual(control, before.privateRows[0]!.response.query.result);
        const current = await custody(conflictRoot), checkedAt = (await admin.query("SELECT clock_timestamp() now")).rows[0].now.toISOString();
        const step = current.steps.find(row => row.id === claim.stepId);
        assert.ok(step && !step.completed_at && step.claim_owner === claim.leaseOwner && current.loop.lease_owner === claim.leaseOwner);
        assert.ok(new Date(step.claim_until).getTime() > Date.parse(checkedAt) && new Date(current.loop.lease_until).getTime() > Date.parse(checkedAt));
        let error: unknown;
        try { await executeTenantOperationalQuery(tenant, attempt.request as EconomicReadRequest, {
          workId: conflictRoot.accepted.workId, workInputId: attempt.inputId, userId: attempt.actor, employeeId: attempt.actor,
          executionKey: attempt.executionKey, objectiveClaim: attempt.claim }); } catch (failure) { error = String(failure); }
        assert.ok(error, `Conflicting native claim returned facts: ${attempt.name}`); noFacts(error);
        observations.push({ name: attempt.name, request: attempt.request, executionKey: attempt.executionKey, inputId: attempt.inputId,
          actor: attempt.actor, claim: attempt.claim, error, positiveControl: { result: control, current, checkedAt, claim } });
      }
      assert.equal(await native(conflictRoot, { workforceLeaseOwner: claim.leaseOwner }), "completed");
      const after = committed(await custody(conflictRoot), [revenue]); assert.deepEqual(privateBytes(after), privateBytes(before));
      assert.deepEqual(after.receipts, before.receipts); return { ownedFault, before, observations, after };
    }, true);

    const budgetRoots = await Promise.all(["query_budget", "attempt_budget", "deadline", "cancel"].map(label => prepare(label)));
    const lastQuery = await prepare("one_remaining_query", [revenue], { maxQueries: 1 });
    const inputRace = await prepare("completion_input_fence");
    const deadlineRace = await prepare("completion_deadline_fence", [revenue], { deadlineAt: new Date(Date.now() + 5_000) });
    const sealDeadlineRace = await prepare("completion_seal_deadline_fence", [revenue], { deadlineAt: new Date(Date.now() + 10_000) });
    await check("OBJ_BUDGET_DEADLINE_NO_ACTIVATION", "Original query/attempt budgets, actual cancellation, deadline and concurrent one-slot delivery are finite native fences", async () => {
      const completionFences = [await completionFence(deadlineRace, "deadline"),
        await completionFence(sealDeadlineRace, "deadline_seal"), await completionFence(inputRace, "input")];
      const installedGrantGuard = (await admin.query(`SELECT p.prosrc AS body,p.prosecdef AS security_definer,
        p.proconfig AS configuration,t.tgenabled AS enabled FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        JOIN pg_trigger t ON t.tgfoid=p.oid WHERE n.nspname='finnor_os' AND p.proname='pe_v3_objective_grant_guard'
        AND t.tgrelid='finnor_os.work_objective_loops'::regclass`)).rows;
      assert.equal(installedGrantGuard.length, 1); assert.equal(installedGrantGuard[0].enabled, "O");
      assert.equal(installedGrantGuard[0].security_definer, false);
      const grantRoot = budgetRoots.find(root => root.label === "query_budget"); assert.ok(grantRoot);
      const elevatedGrantDenials = [];
      for (const [field, limit] of [["max_steps", 97], ["max_actions", 26], ["max_queries", 51]] as const) {
        const before = await custody(grantRoot);
        let denial: { code?: string; message: string } | undefined;
        try {
          await admin.query(`UPDATE finnor_os.work_objective_loops SET ${field}=$3 WHERE tenant_id=$1 AND id=$2`,
            [tenant, grantRoot.accepted.objectiveLoopId, limit]);
        } catch (error) { denial = { code: (error as { code?: string }).code, message: String(error) }; }
        assert.ok(denial); assert.equal(denial.code, "P0001");
        assert.match(denial.message, /Larger finite grant requires the original accepted closing Work/);
        const after = await custody(grantRoot); assert.deepEqual(after.loop, before.loop);
        elevatedGrantDenials.push({ field, limit, denial, before, after });
      }
      const observations = [];
      for (const root of budgetRoots) {
        const before = await custody(root);
        if (root.label === "query_budget") await admin.query("UPDATE finnor_os.work_objective_loops SET query_count=max_queries WHERE tenant_id=$1 AND id=$2", [tenant, root.accepted.objectiveLoopId]);
        if (root.label === "attempt_budget") await admin.query("UPDATE finnor_os.work_objective_loops SET node_attempt_count=max_node_attempts WHERE tenant_id=$1 AND id=$2", [tenant, root.accepted.objectiveLoopId]);
        if (root.label === "deadline") await admin.query("UPDATE finnor_os.work_objective_loops SET deadline_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2", [tenant, root.accepted.objectiveLoopId]);
        if (root.label === "cancel") await controlWorkObjective({ tenantId: tenant, workId: root.accepted.workId, actorId: scopedActor, command: "cancel" });
        const outcome = await native(root), after = await custody(root);
        assert.notEqual(outcome, "completed"); assert.equal(after.receipts.length, 0); assert.equal(after.privateRows.length, 0);
        assert.equal(after.loop.acceptance_text, before.loop.acceptance_text);
        observations.push({ label: root.label, before, outcome, after });
      }
      const deliveries = await Promise.allSettled([native(lastQuery), native(lastQuery)]);
      const concurrent = committed(await custody(lastQuery), [revenue]);
      assert.equal(concurrent.loop.query_count, 1); assert.equal(concurrent.loop.state, "completed");
      return { observations, deliveries: deliveries.map(row => row.status === "fulfilled" ? { status: row.status, value: row.value } : { status: row.status, error: String(row.reason) }),
        concurrent, completionFences, installedGrantGuard, elevatedGrantDenials };
    }, true);

    const unsupported: Array<{ label: string; accepted: Awaited<ReturnType<typeof startWorkObjective>>;
      condition: ObjectiveSuccessCondition; before: Awaited<ReturnType<typeof custody>> }> = [];
    for (const [label, condition, objective] of [
      ["fact_dependent", { ...readCondition([revenue]), criteria: [{ kind: "canonical_query", request: revenue,
        assertion: { path: ["economicRead", "statement", "amount"], operator: "eq", expected: "An independently authorized private factual assertion is still required." } }] },
      "Read our revenue and verify the stronger original financial assertion."],
      ["mixed_business_goal", { ...readCondition([revenue]), criteria: [...readCondition([revenue]).criteria,
        { kind: "manual_verification", reason: "The board must actually receive an independently approved report." }] },
      "Read our revenue and send the independently approved report to the board."],
    ] satisfies Array<[string, ObjectiveSuccessCondition, string]>) {
      const accepted = await startWorkObjective(objective, await http.context("scoped"), { channel: "console", instructionId: randomUUID(),
        idempotencyKey: randomUUID(), successCondition: condition, deferInitialIteration: true,
        maxSteps: 8, maxActions: 0, maxQueries: 2, deadlineAt: new Date(Date.now() + 600_000) });
      unsupported.push({ label, accepted, condition, before: await custody({ accepted }) });
    }
    await check("OBJ_UNSUPPORTED_GENERAL_OBJECTIVE", "Fact-dependent or stronger mixed business acceptance blocks explicitly without replacing the original condition by query success", async () => {
      const observations = [];
      for (const root of unsupported) {
        const outcome = await new ObjectiveLoopRuntime(registry, actionOwner).runIteration({ tenantId: tenant, workId: root.accepted.workId,
          objectiveLoopId: root.accepted.objectiveLoopId, expectedRevision: 1, expectedStepNumber: 1, deferToWorkforceJob: true,
          signal: AbortSignal.timeout(30_000) });
        const after = await custody(root); assert.equal(outcome, "blocked"); assert.equal(after.loop.state, "blocked");
        assert.equal(after.loop.acceptance_text, root.before.loop.acceptance_text); assert.equal(after.receipts.length, 0); assert.equal(after.privateRows.length, 0);
        assert.equal(after.plans.length, 0); assert.equal(after.work.status, "blocked");
        observations.push({ label: root.label, before: root.before, outcome, after,
          beforeAcceptanceSha256: digest(root.before.loop.acceptance_text), afterAcceptanceSha256: digest(after.loop.acceptance_text) });
      }
      return { observations };
    }, true);

    const activationTables = ["jobs", "workforce_assignments", "computer_runs", "sandbox_outbox", "s5_reservations", "business_effects", "compute_resource_leases", "work_planner_attempts"];
    const meter = async () => Object.fromEntries(await Promise.all(activationTables.map(async table =>
      [table, Number((await admin.query(`SELECT count(*)::int n FROM finnor_os.${table}`)).rows[0].n)])));
    const primerBefore = await meter();
    const primer = await http.call("/api/queries", { ...revenue, idempotencyKey: randomUUID() }, "scoped");
    assert.equal(primer.status, 201); assert.equal(primer.body.result.economicRead.statement.amount, "950.25");
    const primerAfter = await meter(); assert.deepEqual(primerAfter, primerBefore);
    const modelRoot = await prepare("model_context", [revenue], { workId: primer.body.workId });
    await journal("EXPLICIT_HUMAN_STEERING_AFTER_A_REAL_ECONOMIC_OBSERVATION", { primer, primerBefore, primerAfter, accepted: modelRoot.accepted });
    await check("OBJ_MODEL_CONTEXT_NO_FACTS", "An actual owning planner callback after a prior real financial observation gets only native metadata, not truncated private facts", async () => {
      assert.equal(modelRoot.captures.length, 1);
      const capture = modelRoot.captures[0]; noFacts(capture);
      assert.ok(capture.opts.planningContext.queryExecutions.some((row: any) => row.id === primer.body.result.execution.id));
      const persisted = (await admin.query(`SELECT decision_context_snapshot,goal_spec,constraint_set,planning_snapshot,
        candidate_plans,compilation_result,planner_result,failure FROM finnor_os.work_planner_attempts WHERE tenant_id=$1 AND work_id=$2`,
      [tenant, modelRoot.accepted.workId])).rows; noFacts(persisted);
      assert.equal(await native(modelRoot), "completed");
      const after = committed(await custody(modelRoot), [revenue]);
      noFacts({ steps: after.steps, loop: after.loop, plans: after.plans, events: after.events, traces: after.traces, outcome: after.work.final_outcome });
      return { primer, primerBefore, primerAfter, capture, persisted, after };
    }, true);

    await check("OBJ_SHARED_REDACTION", "Actual shared SQL rows and authenticated Work list/detail/execution projections contain no native private financial facts", async () => {
      const snapshot = committed(await custody(primary), [revenue, stock]);
      const plannerAttempts = (await admin.query("SELECT * FROM finnor_os.work_planner_attempts WHERE tenant_id=$1 AND work_id=$2", [tenant, primary.accepted.workId])).rows;
      const objectiveAttempts = (await admin.query("SELECT * FROM finnor_os.work_objective_planner_attempts WHERE tenant_id=$1 AND objective_loop_id=$2", [tenant, primary.accepted.objectiveLoopId])).rows;
      const packRuns = (await admin.query("SELECT * FROM finnor_os.outcome_pack_runs WHERE tenant_id=$1 AND work_id=$2", [tenant, primary.accepted.workId])).rows;
      const shared = { work: snapshot.work, loop: snapshot.loop, steps: snapshot.steps, plans: snapshot.plans,
        receipts: snapshot.receipts, events: snapshot.events, traces: snapshot.traces, plannerAttempts, objectiveAttempts, packRuns };
      noFacts(shared);
      const responses = [];
      for (const identity of ["actor", "peer"] as const) {
        for (const path of ["/api/works", `/api/works/${primary.accepted.workId}`, `/api/works/${primary.accepted.workId}/execution`] as const) {
          const response = await get(path, identity); assert.equal(response.status, 200); noFacts(response.body);
          responses.push({ path, identity, response });
        }
      }
      return { shared, responses };
    }, true);

    const corruptions: Array<{ name: string; change: (reply: any) => void; root?: Root }> = [
      { name: "nested_request", change: reply => { reply.query.request.currency = "EUR"; } },
      { name: "nested_outcome", change: reply => { reply.query.result.economicRead.statement.amount = "950.26"; } },
      { name: "nested_execution", change: reply => { reply.query.result.execution.id = randomUUID(); } },
      { name: "nested_source", change: reply => { reply.query.result.economicRead.witnesses[0].sourceId = randomUUID(); } },
      { name: "nested_page", change: reply => { reply.query.result.page.returned = 99; } },
      { name: "nested_meta", change: reply => { reply.query.result.meta.source = null; } },
      { name: "nested_timing", change: reply => { reply.query.metadata.completedAt = "not-an-instant"; } },
      { name: "native_origin", change: reply => { reply.objective.originalInputSha256 = "0".repeat(64); } },
      { name: "native_node", change: reply => { reply.objective.nodeSemanticHash = `sha256:${"0".repeat(64)}`; } },
    ];
    for (const corruption of corruptions) corruption.root = await prepare(`corrupt_${corruption.name}`);
    await check("OBJ_COMPLETE_PRIVATE_VALIDATION", "Real HTTP and unfinished native replay validate every complete nested canonical query and native origin in isolated clones", async () => {
      const originalBefore = await custody(primary), observations = [];
      for (const corruption of corruptions) {
        const root = corruption.root!, original = await faultedCommit(root);
        const step = original.snapshot.receipts[0]!.objective_step_id;
        const validHttp = await privateGet(root, step); assert.equal(validHttp.status, 200);
        const bad = copy(original.snapshot.privateRows[0]!.response); corruption.change(bad);
        await admin.query("UPDATE finnor_os.work_input_responses SET response=$3::jsonb WHERE tenant_id=$1 AND work_input_id=$2 AND reply_key=$4",
          [tenant, root.accepted.workInputId, JSON.stringify(bad), `objective:${step}`]);
        const httpDenial = await privateGet(root, step); denied(httpDenial);
        const nativeError = await refusedNative(root), after = await custody(root);
        assert.equal(after.receipts.length, 1); assert.equal(after.receipts[0].status, "succeeded");
        assert.notEqual(after.loop.state, "completed");
        observations.push({ name: corruption.name, original, validHttp, corruptedResponseText: after.privateRows[0].response_text,
          corruptedResponseSha256: after.privateRows[0].response_sha256, httpDenial, nativeError, after });
      }
      const originalAfter = committed(await custody(primary), [revenue, stock]);
      assert.deepEqual(privateBytes(originalAfter), privateBytes(originalBefore));
      return { originalBefore, observations, originalAfter };
    }, true);

    const queryOf = (body: any) => body.query ?? { request: body.request, result: body.result, metadata: body.execution };
    async function inputPrivate(response: { body: any }) {
      const row = (await admin.query(`SELECT i.id,i.instruction_id,i.instruction_text,i.created_by,r.reply_key,r.response,
        r.response::text response_text FROM finnor_os.work_inputs i JOIN finnor_os.work_input_responses r
        ON r.tenant_id=i.tenant_id AND r.work_input_id=i.id AND r.reply_key='input'
        WHERE i.tenant_id=$1 AND i.work_id=$2 AND i.id=$3`, [tenant, response.body.workId, response.body.workInputId])).rows;
      assert.equal(row.length, 1);
      return { ...row[0], response_sha256: digest(row[0].response_text) };
    }
    await check("CANONICAL_HTTP_INSERT_ONLY", "Normal HTTP never UPDATEs or degrades a strict immutable canonical reply, while a real ancillary INSERT fault is still observable", async () => {
      const principal = (await getPool().query(`SELECT current_user,rolsuper,rolbypassrls,
        has_table_privilege(current_user,'finnor_os.work_input_responses','SELECT') can_select,
        has_table_privilege(current_user,'finnor_os.work_input_responses','INSERT') can_insert,
        has_table_privilege(current_user,'finnor_os.work_input_responses','UPDATE') can_update,
        has_table_privilege(current_user,'finnor_os.work_input_responses','DELETE') can_delete
        FROM pg_roles WHERE rolname=current_user`)).rows[0];
      assert.equal(principal.current_user, "finnor_app"); assert.equal(principal.rolsuper, false); assert.equal(principal.rolbypassrls, false);
      assert.equal(principal.can_select, true); assert.equal(principal.can_insert, true); assert.equal(principal.can_update, false); assert.equal(principal.can_delete, false);
      const body = { instruction: "What was our revenue last month?", instructionId: randomUUID(), idempotencyKey: randomUUID(), channel: "text" };
      const first = await http.call("/api/actions", body, "scoped"); assert.equal(first.status, 201);
      assert.equal(first.body.query.result.economicRead.statement.amount, "950.25");
      assert.ok(!first.body.projectionWarnings?.some((warning: any) => warning.stage === "response"));
      const original = await inputPrivate(first); assert.deepEqual(Object.keys(original.response).sort(), ["instructionId", "query", "workId", "workInputId"]);
      let deniedUpdate: unknown;
      try { await withTenantTransaction(tenant, { userId: scopedActor }, async (_db, client) => client.query(
        "UPDATE finnor_os.work_input_responses SET response=response WHERE tenant_id=$1 AND work_input_id=$2 AND reply_key='input'", [tenant, original.id])); }
      catch (error) { deniedUpdate = { code: (error as { code?: string }).code, message: String(error) }; }
      assert.equal((deniedUpdate as { code?: string })?.code, "42501");
      const duplicate = await http.call("/api/actions", body, "scoped"); assert.equal(duplicate.status, 200);
      assert.ok(!duplicate.body.replayDegraded); assert.ok(!duplicate.body.projectionWarnings?.some((warning: any) => warning.stage === "response"));
      assert.deepEqual(await inputPrivate(duplicate), original);
      const failedBody = { ...body, instructionId: randomUUID(), idempotencyKey: randomUUID() };
      const remove = await fault("work_input_responses", { instructionId: failedBody.instructionId },
        "EXISTS(SELECT 1 FROM finnor_os.work_query_executions q WHERE q.tenant_id=NEW.tenant_id AND q.work_input_id=NEW.work_input_id AND q.status='succeeded')", false);
      let ancillary;
      try {
        const firstFault = await http.call("/api/actions", failedBody, "scoped"); assert.equal(firstFault.status, 201);
        assert.ok(firstFault.body.projectionWarnings?.some((warning: any) => warning.stage === "response"));
        const committed = await inputPrivate(firstFault), replay = await http.call("/api/actions", failedBody, "scoped");
        assert.equal(replay.status, 200); assert.equal(replay.body.replayDegraded, true);
        assert.deepEqual(queryOf(replay.body), committed.response.query); assert.deepEqual(await inputPrivate(replay), committed);
        const diagnostics = (await admin.query(`SELECT event_type,payload FROM finnor_os.work_events
          WHERE tenant_id=$1 AND work_id=$2 AND event_type='economic_read_projection_degraded'`, [tenant, firstFault.body.workId])).rows;
        assert.equal(diagnostics.length, 1); noFacts(diagnostics);
        ancillary = { firstFault, committed, replay, diagnostics, faultKind: "REAL_BEFORE_INSERT_AFTER_ATOMIC_QUERY_COMMIT" };
      } finally { await remove(); }
      return { principal, body, first, original, deniedUpdate, duplicate, ancillary };
    }, true);

    await check("CANONICAL_HTTP_METADATA_STABILITY", "Actual natural and typed HTTP replays project the first query's exact complete identity, values and timing without persisting HTTP envelopes", async () => {
      const observations = [];
      for (const [path, body] of [
        ["/api/actions", { instruction: "What was our revenue last month?", instructionId: randomUUID(), idempotencyKey: randomUUID(), channel: "text" }],
        ["/api/queries", { ...revenue, idempotencyKey: randomUUID() }],
        ["/api/queries", { ...stock, idempotencyKey: randomUUID() }],
      ] as const) {
        const first = await http.call(path, body, "scoped"); assert.equal(first.status, 201);
        const before = await inputPrivate(first), originalQuery = before.response.query;
        assert.deepEqual(queryOf(first.body), originalQuery);
        assert.equal(originalQuery.result.economicRead.statement?.amount ?? originalQuery.result.economicRead.quote?.price,
          path === "/api/queries" && "intent" in body && body.intent === "stock_quote" ? "100.125" : "950.25");
        const duplicate = await http.call(path, body, "scoped"); assert.equal(duplicate.status, 200); assert.equal(duplicate.body.duplicate, true);
        assert.deepEqual(queryOf(duplicate.body), originalQuery); assert.equal(duplicate.headers["cache-control"], "no-store");
        const after = await inputPrivate(duplicate); assert.equal(after.response_text, before.response_text); assert.equal(after.response_sha256, before.response_sha256);
        assert.deepEqual(Object.keys(after.response).sort(), ["instructionId", "query", "workId", "workInputId"]);
        observations.push({ path, body, first, before, duplicate, after });
      }
      return { observations };
    }, true);

    const rightsRoot = await prepare("source_rights", [stock]), expiryRoot = await prepare("source_expiry", [stock]);
    await check("OBJ_SOURCE_RIGHTS_REPLAY", "Mapped source revocation, selected-source revision and actual elapsed quote eligibility deny both private HTTP and native continuation", async () => {
      const before = await faultedCommit(rightsRoot), step = before.snapshot.receipts[0]!.objective_step_id;
      const scopeRows = async () => (await admin.query("SELECT id,enabled,disabled_at,required_permissions,effective_permissions FROM finnor_os.integration_source_scopes WHERE tenant_id=$1 AND id=$2", [tenant, f.scope])).rows;
      const originalScope = await scopeRows();
      let scopeDenial, scopeNativeError, revokedScope;
      try {
        await admin.query("UPDATE finnor_os.integration_source_scopes SET enabled=false,disabled_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [tenant, f.scope]);
        revokedScope = await scopeRows();
        scopeDenial = await privateGet(rightsRoot, step); denied(scopeDenial);
        scopeNativeError = await refusedNative(rightsRoot);
      } finally { await admin.query("UPDATE finnor_os.integration_source_scopes SET enabled=true,disabled_at=NULL WHERE tenant_id=$1 AND id=$2", [tenant, f.scope]); }
      const restored = await privateGet(rightsRoot, step); assert.equal(restored.status, 200);
      assert.deepEqual(restored.body, before.snapshot.privateRows[0]!.response);
      const shortQuote = { ...f.quote, validUntil: new Date(Date.now() + 15_000).toISOString() };
      let changedDenial, changedNativeError, expiring, originalHttp, elapsedHttp, elapsedNativeError, elapsedAt, shortSourceRows;
      try {
        await f.appendQuote(shortQuote); shortSourceRows = await sources();
        changedDenial = await privateGet(rightsRoot, step); denied(changedDenial);
        changedNativeError = await refusedNative(rightsRoot);
        expiring = await faultedCommit(expiryRoot);
        originalHttp = await privateGet(expiryRoot, expiring.snapshot.receipts[0]!.objective_step_id); assert.equal(originalHttp.status, 200);
        const delay = Math.max(0, Date.parse(shortQuote.validUntil) - Date.now() + 30);
        assert.ok(delay <= 15_100, "Elapsed-source case may wait at most its explicit local bound");
        await new Promise<void>(resolve => setTimeout(resolve, delay));
        elapsedAt = (await admin.query("SELECT clock_timestamp() now")).rows[0].now.toISOString();
        assert.ok(Date.parse(elapsedAt) >= Date.parse(shortQuote.validUntil));
        elapsedHttp = await privateGet(expiryRoot, expiring.snapshot.receipts[0]!.objective_step_id); denied(elapsedHttp);
        elapsedNativeError = await refusedNative(expiryRoot);
      } finally { await f.appendQuote(f.quote); }
      const after = await custody(rightsRoot), expiryAfter = await custody(expiryRoot);
      assert.deepEqual(privateBytes(after), privateBytes(before.snapshot));
      assert.deepEqual(privateBytes(expiryAfter), privateBytes(expiring!.snapshot));
      assert.notEqual(after.loop.state, "completed"); assert.notEqual(expiryAfter.loop.state, "completed");
      const originalVersionsAfter = await sources();
      for (const original of originalSources.versions) {
        const current = originalVersionsAfter.versions.find(row => row.id === original.id);
        assert.equal(current?.row_text, original.row_text, "Immutable source version bytes may never be repaired into the oracle");
      }
      return { before, originalScope, revokedScope, scopeDenial, scopeNativeError, restored, shortQuote, shortSourceRows, changedDenial, changedNativeError,
        expiring, originalHttp, elapsedAt, elapsedHttp, elapsedNativeError, after, expiryAfter, originalVersionsAfter };
    }, true);
    if (primarySnapshot) assert.deepEqual(privateBytes(await custody(primary)), privateBytes(primarySnapshot));
  } finally {
    await admin.query("UPDATE finnor_os.employee_role_assignments SET active=false WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [tenant, [assignment, denyAssignment]]);
    await admin.query("UPDATE finnor_os.employee_role_assignments SET active=true WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
      [tenant, priorAssignments.map(row => row.id)]);
  }
}
