/** Owning E2E extensions. Literal facts/SQL faults were specified before repair.
 * Never import a formatter/parser under repair as the expected-value oracle. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import { closePool, getPool, receiveWork } from "@finnor/db";
import { createEvidenceSource } from "@finnor/memory";
import type { economicReadHttpFixture } from "./read-http-fixture.mts";

type Http = Awaited<ReturnType<typeof economicReadHttpFixture>>;
type Identity = Parameters<Http["context"]>[0];
type Check = (id: string, predicate: string, run: () => Promise<unknown>, transport?: boolean) => Promise<void>;
type Fixture = {
  admin: pg.Client; http: Http; check: Check; evidence: string;
  tenant: string; actor: string; peerActor: string; scopedActor: string;
  company: string; unrelatedCompany: string; scope: string;
  quote: any; quoteSource: { id: string };
  appendQuote: (body: any, source?: { id: string }, objectId?: string, scopeId?: string, integrationId?: string) => Promise<void>;
};
const revenue = { intent: "company_revenue", company: { kind: "TENANT_DEFAULT" }, period: "LAST_COMPLETED_MONTH" };
const quoteRequest = { intent: "stock_quote", instrument: { kind: "SYMBOL", symbol: "AAPL", exchange: "XNAS" } };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const queryOf = (body: any): any => body?.query ?? (body?.request && body?.result
  ? { request: body.request, result: body.result, metadata: body.execution ?? body.metadata } : null);
const economic = (body: any): any => queryOf(body)?.result?.economicRead;
function noFactPayload(value: unknown) {
  const wire = JSON.stringify(value);
  for (const secret of ["950.25", "100.125", "200.875", "41.75", "finnor.recorded-revenue-statement", "finnor.recorded-market-quote"])
    assert.ok(!wire.includes(secret), `Shared/error projection disclosed ${secret}`);
}
function noFacts(value: unknown) {
  noFactPayload(value);
  assert.ok(!JSON.stringify(value).includes('"economicRead"'), "Shared/error projection disclosed an economic outcome envelope");
}
function refused(response: { status: number; body: unknown }) {
  assert.ok(response.status >= 400 && response.status < 500, JSON.stringify(response));
  noFacts(response.body);
}

export async function runReadReviewV2Cases(f: Fixture) {
  const { admin, http, tenant, actor, scopedActor, company, scope, check } = f;
  const journal = async (step: string, observation: unknown) =>
    appendFile(join(f.evidence, "review-v2-steps.ndjson"), JSON.stringify({ at: new Date().toISOString(), step, observation }) + "\n");
  const call = async (path: Parameters<Http["call"]>[0], body: unknown, identity: Identity = "actor") => {
    const response = await http.call(path, body, identity);
    await journal("HTTP", { method: "POST", path, body, identity, response }); return response;
  };
  const get = async (path: Parameters<Http["get"]>[0], identity: Identity = "actor") => {
    const response = await http.get(path, identity);
    await journal("HTTP", { method: "GET", path, identity, response }); return response;
  };
  const natural = (instruction: string) => ({ instruction, channel: "text", instructionId: randomUUID(), idempotencyKey: randomUUID() });
  async function custody(workId: string, workInputId?: string) {
    const work = (await admin.query("SELECT id,status,final_outcome,failure,recovery FROM finnor_os.works WHERE tenant_id=$1 AND id=$2", [tenant, workId])).rows[0];
    const inputs = (await admin.query(`SELECT id,work_id,instruction_id,instruction_text,created_by FROM finnor_os.work_inputs
      WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC`, [tenant, workId])).rows;
    const input = workInputId ? inputs.find(row => row.id === workInputId) : inputs[0];
    assert.ok(work && input, "Actual original Work/input must exist");
    const receipts = (await admin.query(`SELECT id,work_id,work_input_id,intent,request,execution_key,status,result_summary,failure
      FROM finnor_os.work_query_executions WHERE tenant_id=$1 AND work_id=$2 AND work_input_id=$3`, [tenant, workId, input.id])).rows;
    const responses = (await admin.query("SELECT response FROM finnor_os.work_input_responses WHERE tenant_id=$1 AND work_input_id=$2", [tenant, input.id])).rows;
    const traces = (await admin.query("SELECT phase,payload FROM finnor_os.instruction_events WHERE tenant_id=$1 AND instruction_id=$2 ORDER BY seq", [tenant, input.instruction_id])).rows;
    const events = (await admin.query("SELECT event_type,payload FROM finnor_os.work_events WHERE tenant_id=$1 AND work_id=$2 ORDER BY seq", [tenant, workId])).rows;
    const observed = { work, inputs, input, receipts, responses, traces, events };
    await journal("SQL_CUSTODY", observed); return observed;
  }
  function committed(s: Awaited<ReturnType<typeof custody>>, expected?: any) {
    assert.equal(s.receipts.length, 1); assert.equal(s.receipts[0].status, "succeeded");
    assert.equal(s.responses.length, 1);
    const privateReply = s.responses[0].response, q = queryOf(privateReply);
    assert.ok(q); assert.equal(privateReply.workId, s.work.id); assert.equal(privateReply.workInputId, s.input.id);
    assert.equal(privateReply.instructionId, s.input.instruction_id);
    assert.equal(q.result.execution.id, s.receipts[0].id); assert.equal(q.metadata.queryId, s.receipts[0].id);
    assert.equal(q.result.execution.workId, s.work.id); assert.equal(q.result.execution.workInputId, s.input.id);
    assert.equal(q.result.execution.executionKey, s.receipts[0].execution_key);
    assert.deepEqual(q.request, s.receipts[0].request);
    if (expected) assert.deepEqual(q, expected, "Original complete query bytes/metadata must survive replay");
    return q;
  }
  const forInstruction = async (instructionId: string) => {
    const rows = (await admin.query("SELECT work_id,id FROM finnor_os.work_inputs WHERE tenant_id=$1 AND instruction_id=$2", [tenant, instructionId])).rows;
    assert.equal(rows.length, 1); return custody(rows[0].work_id, rows[0].id);
  };
  async function fault(
    table: "work_events" | "instruction_events" | "work_input_responses" | "employee_conversation_messages",
    condition: string, action = "RAISE EXCEPTION 'W1_V3_OWNED_WRITE_FAULT';", insertAndUpdate = false,
  ) {
    const name = `w1_v3_${randomUUID().replaceAll("-", "")}`;
    const definition = `CREATE FUNCTION finnor_os.${name}() RETURNS trigger LANGUAGE plpgsql AS $owned$
      BEGIN IF ${condition} THEN ${action} END IF; RETURN NEW; END $owned$`;
    await journal("INSTALL_REAL_SQL_FAULT", { table, condition, action });
    await admin.query(definition);
    try {
      await admin.query(`CREATE TRIGGER ${name} BEFORE INSERT${insertAndUpdate ? " OR UPDATE" : ""} ON finnor_os.${table}
        FOR EACH ROW EXECUTE FUNCTION finnor_os.${name}()`);
    } catch (error) { await admin.query(`DROP FUNCTION finnor_os.${name}()`); throw error; }
    return async () => {
      await admin.query(`DROP TRIGGER ${name} ON finnor_os.${table}`);
      await admin.query(`DROP FUNCTION finnor_os.${name}()`);
      await journal("REMOVE_REAL_SQL_FAULT", { table, name });
    };
  }
  const eventCondition = (instructionId: string, event: string) =>
    `NEW.tenant_id='${tenant}'::uuid AND NEW.event_type='${event}'
     AND EXISTS(SELECT 1 FROM finnor_os.work_inputs i WHERE i.tenant_id=NEW.tenant_id
       AND i.work_id=NEW.work_id AND i.instruction_id='${instructionId}'::uuid)`;
  const privateCondition = (instructionId: string) =>
    `NEW.tenant_id='${tenant}'::uuid AND EXISTS(SELECT 1 FROM finnor_os.work_inputs i
      WHERE i.tenant_id=NEW.tenant_id AND i.id=NEW.work_input_id AND i.instruction_id='${instructionId}'::uuid)`;
  async function retry(s: Awaited<ReturnType<typeof custody>>, expected?: any, identity: Identity = "actor") {
    const response = await call(`/api/works/${s.work.id}/retry`, { idempotencyKey: randomUUID() }, identity);
    assert.ok(response.status === 201 || response.status === 200, JSON.stringify(response));
    assert.equal(response.body.workId, s.work.id); assert.equal(response.body.workInputId, s.input.id);
    assert.equal(response.body.instructionId, s.input.instruction_id);
    const q = queryOf(response.body); assert.ok(q);
    if (expected) assert.deepEqual(q, expected);
    const after = await custody(s.work.id, s.input.id); committed(after, q);
    return { response, after };
  }

  await check("SHARED_ECONOMIC_REDACTION", "Natural/typed financial facts are private, including legacy full-query outcomes and revoked source replay", async () => {
    const reads: Array<{ path: "/api/actions" | "/api/queries"; body: any; response: any; snapshot: Awaited<ReturnType<typeof custody>> }> = [];
    for (const [path, body, expected] of [
      ["/api/actions", natural("What was our revenue last month?"), "950.25"],
      ["/api/actions", natural("What is the stock price for W1 recorded company?"), "100.125"],
      ["/api/queries", { ...revenue, idempotencyKey: randomUUID() }, "950.25"],
      ["/api/queries", { ...quoteRequest, idempotencyKey: randomUUID() }, "100.125"],
    ] as const) {
      const response = await call(path, body); assert.equal(response.status, 201, JSON.stringify(response));
      const outcome = economic(response.body);
      assert.equal(outcome?.statement?.amount ?? outcome?.quote?.price, expected);
      const snapshot = await custody(response.body.workId, response.body.workInputId); committed(snapshot, queryOf(response.body));
      noFacts(snapshot.work.final_outcome); noFacts(snapshot.traces); noFacts(snapshot.events);
      reads.push({ path, body, response, snapshot });
    }
    async function shared() {
      const seen = [];
      for (const identity of ["actor", "peer"] as const) {
        const list = await get("/api/works", identity); assert.equal(list.status, 200); noFacts(list.body); seen.push(list);
        for (const read of reads) for (const suffix of ["", "/execution"]) {
          const response = await get(`/api/works/${read.snapshot.work.id}${suffix}`, identity);
          assert.equal(response.status, 200, JSON.stringify(response)); noFacts(response.body); seen.push(response);
        }
      }
      return seen;
    }
    const initialShared = await shared();
    const legacy = reads[0]!;
    try {
      await admin.query("UPDATE finnor_os.works SET final_outcome=$3::jsonb WHERE tenant_id=$1 AND id=$2",
        [tenant, legacy.snapshot.work.id, JSON.stringify({ kind: "operational_query", query: queryOf(legacy.response.body), spokenSummary: "Closed accrual revenue was USD 950.25." })]);
      await shared();
    } finally {
      await admin.query("UPDATE finnor_os.works SET final_outcome=$3::jsonb WHERE tenant_id=$1 AND id=$2",
        [tenant, legacy.snapshot.work.id, JSON.stringify(legacy.snapshot.work.final_outcome)]);
    }
    const privacyDenyRole = randomUUID(), privacyDenyAssignment = randomUUID();
    try {
      await admin.query(`INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name,active)
        VALUES($1,$2,$3,'Disposable original read privacy deny',true)`, [privacyDenyRole, tenant, `v3-privacy-deny-${privacyDenyRole}`]);
      await admin.query(`INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect)
        VALUES($1,$2,'query:company_revenue','external_organization','deny')`, [tenant, privacyDenyRole]);
      await admin.query(`INSERT INTO finnor_os.employee_role_assignments(id,tenant_id,employee_id,role_id,resource_scope,effective_from)
        VALUES($1,$2,$3,$4,$5::jsonb,clock_timestamp()-interval '1 day')`,
        [privacyDenyAssignment, tenant, actor, privacyDenyRole, JSON.stringify({ kind: "resources", resourceType: "external_organization", resourceIds: [company] })]);
      await admin.query("UPDATE finnor_os.integration_source_scopes SET enabled=false,disabled_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [tenant, scope]);
      await journal("ORIGINAL_ACTOR_FINANCIAL_DENY_AND_QUOTE_SCOPE_REVOCATION", { privacyDenyRole, privacyDenyAssignment, actor, company, scope });
      await shared();
      for (const read of reads) {
        const replay = await call(read.path, read.body); assert.equal(replay.status, 404, JSON.stringify(replay)); noFacts(replay.body);
      }
    } finally {
      await admin.query("UPDATE finnor_os.integration_source_scopes SET enabled=true,disabled_at=NULL WHERE tenant_id=$1 AND id=$2", [tenant, scope]);
      await admin.query("UPDATE finnor_os.employee_role_assignments SET active=false WHERE tenant_id=$1 AND id=$2", [tenant, privacyDenyAssignment]);
    }
    return { inputs: reads.map(read => ({ path: read.path, body: read.body })), originalPrivate: reads.map(read => read.snapshot), initialShared };
  }, true);

  await check("CONTEXT_READ_NO_FLEET", "A valid different selected company does not downgrade or substitute exact financial reads", async () => {
    const selected = { entityType: "external_organization", entityId: f.unrelatedCompany };
    const activeContext = { version: 1, capturedAt: new Date().toISOString(), source: "text", businessRoot: selected,
      focusedEntity: selected, selectedEntities: [selected], excludedEntities: [], surface: { id: "world", route: "/centropy/world", spatialState: "canvas" }, filters: [] };
    const responses = [];
    for (const instruction of ["What was our revenue last month?", "What is the stock price for W1 recorded company?"]) {
      const response = await call("/api/actions", { ...natural(instruction), activeContext });
      assert.equal(response.status, 201, JSON.stringify(response)); assert.deepEqual(response.body.planned, []);
      if (economic(response.body)?.intent === "company_revenue") {
        assert.equal(economic(response.body).statement?.amount, "950.25"); assert.equal(economic(response.body).statement?.companyId, company);
      } else { assert.equal(economic(response.body)?.quote?.price, "100.125"); assert.equal(economic(response.body)?.quote?.instrument?.issuerCompanyId, company); }
      responses.push(response);
    }
    return { activeContext, responses };
  }, true);

  await check("REVENUE_NAMED_FORMS", "At/for/of/possessive and bare named companies never fall back to tenant default", async () => {
    const observations = [];
    for (const name of ["Unrelated Holdings", "W1 recorded company"]) for (const instruction of [
      `What was last month's revenue at ${name}?`, `What was last month's revenue for ${name}?`,
      `What was last month's revenue of ${name}?`, `What was ${name}'s revenue last month?`, `What was ${name} revenue last month?`,
      `What was our revenue last month at ${name}?`,
    ]) {
      const response = await call("/api/actions", natural(instruction)); assert.equal(response.status, 201, JSON.stringify(response));
      assert.deepEqual(queryOf(response.body)?.request.company, { kind: "NAME", name });
      if (name === "Unrelated Holdings") { assert.equal(economic(response.body)?.availability, "UNAVAILABLE"); noFactPayload(response.body); }
      else assert.equal(economic(response.body)?.statement?.amount, "950.25");
      observations.push({ instruction, response });
    }
    return observations;
  }, true);

  await check("REVENUE_SELECTORS", "Natural basis/currency and explicit calendar selectors survive to the source owner unchanged", async () => {
    const instruction = "What was our cash revenue last month in EUR?";
    const mismatch = await call("/api/actions", natural(instruction));
    assert.equal(mismatch.status, 201, JSON.stringify(mismatch)); assert.equal(economic(mismatch.body)?.availability, "UNAVAILABLE");
    assert.equal(queryOf(mismatch.body)?.request.basis, "CASH"); assert.equal(queryOf(mismatch.body)?.request.currency, "EUR"); noFactPayload(mismatch.body);
    const cash = await call("/api/actions", natural(instruction), "foreign");
    assert.equal(cash.status, 201, JSON.stringify(cash)); assert.equal(economic(cash.body)?.statement?.amount, "41.75");
    assert.equal(economic(cash.body)?.statement?.basis, "CASH"); assert.equal(economic(cash.body)?.statement?.currency, "EUR");
    assert.equal(economic(cash.body)?.statement?.reportingStatus, "PROVISIONAL"); assert.equal(economic(cash.body)?.statement?.calendarRef, "owner-recorded-fiscal-15-utc");
    const calendars = [];
    for (const selector of ["calendar", "fiscal"]) for (const path of ["/api/actions", "/api/queries"] as const) {
      const body = path === "/api/actions" ? natural(`What was our revenue last ${selector} month?`)
        : { ...revenue, calendar: selector.toUpperCase(), idempotencyKey: randomUUID() };
      const response = await call(path, body); assert.equal(response.status, 201, JSON.stringify(response));
      assert.equal(queryOf(response.body)?.request.calendar, selector.toUpperCase());
      assert.equal(economic(response.body)?.availability, "UNAVAILABLE"); noFactPayload(response.body); calendars.push({ body, response });
    }
    return { instruction, mismatch, cash, calendars };
  }, true);

  await check("POSITIVE_EFFECT_VOCABULARY", "Message/call/remove/assign/run/launch and a standing mandate stay outside the read grammar", async () => {
    const observations = [];
    for (const instruction of [
      "Show our revenue last month. Message the board.", "Show our revenue last month. Call the board.",
      "Show our revenue last month. Remove the report.", "Show our revenue last month. Assign the report to the board.",
      "Show our revenue last month. Run the report delivery.", "Show our revenue last month. Launch a worker.",
      "Every month, show our revenue and send the report to the board.",
    ]) {
      const response = await call("/api/actions", natural(instruction));
      assert.equal(response.status, 503, JSON.stringify(response)); assert.equal(response.body.code, "worker_fleet_unavailable");
      assert.equal(economic(response.body), undefined); observations.push({ instruction, response });
    }
    return observations;
  }, true);

  await check("MULTILINE_NEGATION", "A negative create bullet cannot suppress a later positive send bullet; negative-only reads remain reads", async () => {
    const instruction = "What was our revenue last month?\n- Do not create workers.\n- Send the report to the board.";
    const positive = await call("/api/actions", natural(instruction));
    assert.equal(positive.status, 503, JSON.stringify(positive)); assert.equal(positive.body.code, "worker_fleet_unavailable"); assert.equal(economic(positive.body), undefined);
    const negative = await call("/api/actions", natural("What was our revenue last month?\n- Do not create workers or spawn sandboxes.\n- Do not send the report."));
    assert.equal(negative.status, 201, JSON.stringify(negative)); assert.equal(economic(negative.body)?.statement?.amount, "950.25");
    return { instruction, positive, negative };
  }, true);

  // All grants below belong only to a newly created disposable fixture employee.
  // No production/protected grants, policy owners or service-prefix shortcuts.
  const role = randomUUID(), assignment = randomUUID(), denyRole = randomUUID(), denyAssignment = randomUUID();
  await admin.query("DELETE FROM finnor_os.employee_role_assignments WHERE tenant_id=$1 AND employee_id=$2", [tenant, scopedActor]);
  await admin.query(`INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name,active) VALUES
    ($1,$2,$3,'V3 exact financial fixture',true),($4,$2,$5,'V3 relevant deny fixture',true)`,
    [role, tenant, `v3-financial-${role}`, denyRole, `v3-deny-${denyRole}`]);
  const resourceScope = JSON.stringify({ kind: "resources", resourceType: "external_organization", resourceIds: [company] });
  await admin.query(`INSERT INTO finnor_os.employee_role_assignments(id,tenant_id,employee_id,role_id,resource_scope,effective_from)
    VALUES($1,$2,$3,$4,$5::jsonb,clock_timestamp()-interval '1 day')`, [assignment, tenant, scopedActor, role, resourceScope]);
  await admin.query(`INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect)
    VALUES($1,$2,'query:company_revenue','external_organization','allow'),($1,$2,'query:stock_quote','external_organization','allow')`, [tenant, role]);
  await journal("EXACT_FINANCIAL_FIXTURE_GRANTS", { scopedActor, role, assignment, resourceScope, capabilities: ["query:company_revenue", "query:stock_quote"] });

  await check("RESOLVED_RESOURCE_SCOPES", "Exact-resource-only grants allow default/NAME/ID/symbol reads without a world-state grant", async () => {
    const responses = [];
    for (const instruction of ["What was our revenue last month?", "What was last month's revenue at W1 recorded company?", "What is the stock price for W1 recorded company?"]) {
      const response = await call("/api/actions", natural(instruction), "scoped"); assert.equal(response.status, 201, JSON.stringify(response));
      assert.ok(economic(response.body)?.statement?.amount === "950.25" || economic(response.body)?.quote?.price === "100.125"); responses.push(response);
    }
    for (const request of [
      { ...revenue, company: { kind: "ID", id: company } }, { ...revenue, company: { kind: "NAME", name: "W1 recorded company" } },
      quoteRequest, { intent: "stock_quote", instrument: { kind: "NAME", name: "W1 recorded company", exchange: "XNAS" } },
    ]) {
      const response = await call("/api/queries", { ...request, idempotencyKey: randomUUID() }, "scoped");
      assert.equal(response.status, 201, JSON.stringify(response)); assert.ok(economic(response.body)?.statement?.amount === "950.25" || economic(response.body)?.quote?.price === "100.125"); responses.push(response);
    }
    const { getOrchestrator } = await import("../../apps/api/lib/orchestrator");
    const ctx = await http.context("scoped");
    const core = await getOrchestrator().handleOperationalQuery({ intent: "company_revenue", company: { kind: "ID", id: company }, period: "LAST_COMPLETED_MONTH" }, ctx, { idempotencyKey: randomUUID() });
    assert.equal(economic(core)?.statement?.amount, "950.25");
    const foreign = await call("/api/queries", { ...revenue, company: { kind: "ID", id: f.unrelatedCompany }, idempotencyKey: randomUUID() }, "scoped");
    assert.equal(foreign.status, 201, JSON.stringify(foreign)); assert.equal(economic(foreign.body)?.availability, "UNAVAILABLE");
    assert.deepEqual(queryOf(foreign.body)?.request.company, { kind: "ID", id: f.unrelatedCompany }); noFactPayload(foreign.body);
    const grants = (await admin.query("SELECT capability,resource_type,effect FROM finnor_os.role_authority_grants WHERE tenant_id=$1 AND role_id=$2 ORDER BY capability", [tenant, role])).rows;
    assert.deepEqual(grants.map(row => row.capability), ["query:company_revenue", "query:stock_quote"]);
    return { grants, resourceScope, responses, core, foreign };
  }, true);

  await check("SCOPED_GRANT_CURRENTNESS", "Current grant/assignment/role/user and exact-resource scope revocation deny both new reads and private replay", async () => {
    const originalBody = { ...revenue, idempotencyKey: randomUUID() }, original = await call("/api/queries", originalBody, "scoped");
    assert.equal(original.status, 201, JSON.stringify(original));
    const scenarios: Array<{ name: string; deny: () => Promise<unknown>; restore: () => Promise<unknown> }> = [
      { name: "missing financial capability", deny: () => admin.query("DELETE FROM finnor_os.role_authority_grants WHERE tenant_id=$1 AND role_id=$2 AND capability='query:company_revenue'", [tenant, role]),
        restore: () => admin.query("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect) VALUES($1,$2,'query:company_revenue','external_organization','allow')", [tenant, role]) },
      { name: "wrong resource scope", deny: () => admin.query("UPDATE finnor_os.employee_role_assignments SET resource_scope=$3::jsonb WHERE tenant_id=$1 AND id=$2", [tenant, assignment, JSON.stringify({ kind: "resources", resourceType: "external_organization", resourceIds: [f.unrelatedCompany] })]),
        restore: () => admin.query("UPDATE finnor_os.employee_role_assignments SET resource_scope=$3::jsonb WHERE tenant_id=$1 AND id=$2", [tenant, assignment, resourceScope]) },
      { name: "inactive assignment", deny: () => admin.query("UPDATE finnor_os.employee_role_assignments SET active=false WHERE tenant_id=$1 AND id=$2", [tenant, assignment]),
        restore: () => admin.query("UPDATE finnor_os.employee_role_assignments SET active=true WHERE tenant_id=$1 AND id=$2", [tenant, assignment]) },
      { name: "expired assignment", deny: () => admin.query("UPDATE finnor_os.employee_role_assignments SET expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND id=$2", [tenant, assignment]),
        restore: () => admin.query("UPDATE finnor_os.employee_role_assignments SET expires_at=NULL WHERE tenant_id=$1 AND id=$2", [tenant, assignment]) },
      { name: "inactive role", deny: () => admin.query("UPDATE finnor_os.employee_roles SET active=false WHERE tenant_id=$1 AND id=$2", [tenant, role]),
        restore: () => admin.query("UPDATE finnor_os.employee_roles SET active=true WHERE tenant_id=$1 AND id=$2", [tenant, role]) },
      { name: "suspended employee", deny: () => admin.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2", [tenant, scopedActor]),
        restore: async () => {
          await admin.query("UPDATE finnor_os.users SET status='active' WHERE tenant_id=$1 AND id=$2", [tenant, scopedActor]);
          await admin.query("DELETE FROM finnor_os.employee_role_assignments WHERE tenant_id=$1 AND employee_id=$2 AND role_id<>$3", [tenant, scopedActor, role]);
        } },
    ];
    const observations = [];
    for (const scenario of scenarios) {
      try {
        await scenario.deny();
        const fresh = await call("/api/queries", { ...revenue, idempotencyKey: randomUUID() }, "scoped"), replay = await call("/api/queries", originalBody, "scoped");
        refused(fresh); refused(replay); observations.push({ scenario: scenario.name, fresh, replay });
      } finally { await scenario.restore(); }
    }
    const restored = await call("/api/queries", originalBody, "scoped"); assert.equal(restored.status, 200); assert.deepEqual(queryOf(restored.body), queryOf(original.body));
    return { original, observations, restored };
  }, true);

  await check("EXACT_CAPABILITY_DENIES", "An unrelated query deny does not veto financial reads, but the actual matching scoped deny does", async () => {
    const observations = [];
    try {
      await admin.query("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect) VALUES($1,$2,'query:team_roster','*','deny')", [tenant, role]);
      const unrelated = await call("/api/queries", { ...revenue, idempotencyKey: randomUUID() }, "scoped");
      assert.equal(unrelated.status, 201, JSON.stringify(unrelated)); assert.equal(economic(unrelated.body)?.statement?.amount, "950.25"); observations.push(unrelated);
      await admin.query("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect) VALUES($1,$2,'query:company_revenue','external_organization','deny')", [tenant, denyRole]);
      await admin.query("INSERT INTO finnor_os.employee_role_assignments(id,tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,$4,$5::jsonb)", [denyAssignment, tenant, scopedActor, denyRole, resourceScope]);
      const matching = await call("/api/queries", { ...revenue, idempotencyKey: randomUUID() }, "scoped"); assert.equal(matching.status, 404, JSON.stringify(matching)); noFacts(matching.body); observations.push(matching);
    } finally {
      await admin.query("DELETE FROM finnor_os.employee_role_assignments WHERE tenant_id=$1 AND id=$2", [tenant, denyAssignment]);
      await admin.query("DELETE FROM finnor_os.role_authority_grants WHERE tenant_id=$1 AND role_id=$2", [tenant, denyRole]);
      await admin.query("DELETE FROM finnor_os.role_authority_grants WHERE tenant_id=$1 AND role_id=$2 AND capability='query:team_roster'", [tenant, role]);
    }
    return observations;
  }, true);

  await check("COMMITTED_RECEIPT_RECOVERY_NO_KEY", "A real durable completion-event failure after commit replays the exact original through actual retry without an original key", async () => {
    const body = { instruction: "What was our revenue last month?", channel: "text", instructionId: randomUUID() }; // deliberately NO idempotencyKey
    const remove = await fault("work_events", eventCondition(body.instructionId, "query_execution_completed"));
    let first, before: Awaited<ReturnType<typeof custody>> | undefined;
    try {
      first = await call("/api/actions", body); assert.ok(first.status >= 500, JSON.stringify(first)); noFacts(first.body);
      before = await forInstruction(body.instructionId); assert.equal(before.work.status, "failed");
      const original = committed(before); assert.equal(original.result.economicRead.statement?.amount, "950.25");
    } finally { await remove(); }
    const original = committed(before!), recovery = await retry(before!, original), repeated = await retry(recovery.after, original);
    const duplicate = await call("/api/actions", body); assert.equal(duplicate.status, 200, JSON.stringify(duplicate)); assert.equal(duplicate.body.duplicate, true);
    assert.deepEqual(queryOf(duplicate.body), original); committed(await custody(before!.work.id, before!.input.id), original);
    return { body, first, before: before!, recovery, repeated, duplicate };
  }, true);

  await check("TRACE_FAILURE_BEST_EFFORT", "Ordinary verifying trace errors are swallowed by their existing best-effort owner, not manufactured into Work failure", async () => {
    const body = natural("What was our revenue last month?");
    const remove = await fault("instruction_events", `NEW.tenant_id='${tenant}'::uuid AND NEW.instruction_id='${body.instructionId}'::uuid AND NEW.phase='verifying'`);
    try {
      const first = await call("/api/actions", body); assert.equal(first.status, 201, JSON.stringify(first)); assert.equal(economic(first.body)?.statement?.amount, "950.25");
      const s = await forInstruction(body.instructionId); committed(s, queryOf(first.body)); assert.equal(s.work.status, "completed");
      assert.equal(s.traces.some(row => row.phase === "verifying"), false); return { body, first, s };
    } finally { await remove(); }
  }, true);

  await check("QUOTE_EXPLICIT_SUBJECT", "FYI is not a ticker and cannot override the explicit exact issuer NAME or currency", async () => {
    const body = natural("FYI, what is the stock price for W1 recorded company in USD?");
    const response = await call("/api/actions", body); assert.equal(response.status, 201, JSON.stringify(response));
    assert.deepEqual(queryOf(response.body)?.request, { intent: "stock_quote", instrument: { kind: "NAME", name: "W1 recorded company" }, currency: "USD" });
    assert.equal(economic(response.body)?.quote?.price, "100.125"); assert.equal(economic(response.body)?.quote?.instrument?.symbol, "AAPL");
    assert.equal(economic(response.body)?.quote?.instrument?.exchange, "XNAS"); assert.equal(economic(response.body)?.quote?.providerTimestamp, f.quote.providerTimestamp);
    return { body, response };
  }, true);

  await check("SIMULTANEOUS_QUOTE_VALIDITY", "Simultaneous agreeing source validity is semantic, not UUID order; stale/conflict controls remain intact", async () => {
    const bindingIndexes = (await admin.query(`SELECT indexname,indexdef FROM pg_indexes
      WHERE schemaname='finnor_os' AND tablename='external_refs' AND indexname=ANY($1::text[])`,
      [["external_refs_internal_provider_idx", "external_refs_internal_binding_unique", "external_refs_external_binding_unique"]])).rows;
    assert.deepEqual(bindingIndexes.map(row => row.indexname).sort(),
      ["external_refs_external_binding_unique", "external_refs_internal_binding_unique"]);
    // The second source has its own actual integration, preserving the unique
    // (tenant, entity, internal_id, provider, integration) source-link binding.
    const integration = randomUUID(), extraScope = randomUUID();
    await admin.query("INSERT INTO finnor_os.tenant_integrations(id,tenant_id,capability,binding,mode) VALUES($1,$2,'documents','microsoft_graph','emulator')", [integration, tenant]);
    await admin.query(`INSERT INTO finnor_os.integration_source_scopes(id,tenant_id,integration_id,provider,source_kind,provider_scope_type,provider_resource_id,scope_key,
      root_binding_type,root_binding_id,sync_strategy,recovery_strategy,required_permissions,effective_permissions,permission_verified_at,configured_by)
      SELECT $1,tenant_id,$2,provider,source_kind,provider_scope_type,'v3-independent-quote-drive','v3-independent-quote',
        root_binding_type,root_binding_id,sync_strategy,recovery_strategy,required_permissions,effective_permissions,permission_verified_at,configured_by
      FROM finnor_os.integration_source_scopes WHERE tenant_id=$3 AND id=$4`, [extraScope, integration, tenant, scope]);
    const extra = await createEvidenceSource(tenant, { sourceKey: `v3-simultaneous-${integration}`, sourceType: "market_data_quote", title: "Independent lawful same-time quote fixture" });
    const sources = [{ source: f.quoteSource, write: (q: any) => f.appendQuote(q) },
      { source: extra, write: (q: any) => f.appendQuote(q, extra, "v3-independent-quote-file", extraScope, integration) }]
      .sort((a, b) => a.source.id.localeCompare(b.source.id));
    const expired = { ...f.quote, validUntil: new Date(Date.parse(f.quote.providerTimestamp) + 1).toISOString() };
    const observations = [];
    try {
      await f.appendQuote(f.quote, extra, "v3-independent-quote-file", extraScope, integration);
      await assert.rejects(admin.query(`INSERT INTO finnor_os.external_refs
        (tenant_id,entity,internal_id,provider,external_id,integration_id,external_object_type)
        VALUES($1,'external_organization',$2,'microsoft_graph',$3,$4,'drive_item')`,
        [tenant, company, `v3-duplicate-${randomUUID()}`, integration]),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "23505"
        && "constraint" in error && error.constraint === "external_refs_internal_binding_unique");
      for (const staleIndex of [0, 1]) {
        await sources[staleIndex]!.write(expired); await sources[1 - staleIndex]!.write(f.quote);
        const response = await call("/api/queries", { ...quoteRequest, idempotencyKey: randomUUID() });
        assert.equal(response.status, 201, JSON.stringify(response)); assert.equal(economic(response.body)?.availability, "CURRENT");
        assert.equal(economic(response.body)?.quote?.price, "100.125"); assert.equal(economic(response.body)?.quote?.validUntil, f.quote.validUntil);
        assert.equal(economic(response.body)?.witnesses?.length, 2); observations.push({ staleSourceId: sources[staleIndex]!.source.id, response });
      }
      await sources[0]!.write(expired); await sources[1]!.write(expired);
      const stale = await call("/api/queries", { ...quoteRequest, idempotencyKey: randomUUID() });
      assert.equal(stale.status, 201); assert.equal(economic(stale.body)?.availability, "STALE"); assert.equal(economic(stale.body)?.quote, undefined); observations.push(stale);
      for (const conflicting of [{ ...f.quote, price: "100.126" }, { ...f.quote, marketSession: "AFTER_HOURS" }, { ...f.quote, delaySeconds: 900 }]) {
        await sources[0]!.write(f.quote); await sources[1]!.write(conflicting);
        const response = await call("/api/queries", { ...quoteRequest, idempotencyKey: randomUUID() });
        assert.equal(response.status, 201); assert.equal(economic(response.body)?.availability, "CONFLICTED"); assert.equal(economic(response.body)?.quote, undefined); observations.push(response);
      }
    } finally {
      await f.appendQuote(f.quote);
      await f.appendQuote(f.quote, extra, "v3-independent-quote-file", extraScope, integration);
    }
    return { integration, extraScope, bindingIndexes, duplicateWithinBindingRejected: true,
      sourceIdsInSqlOrder: sources.map(row => row.source.id), observations };
  }, true);

  await check("SUPPLIED_ID_RECOVERY_CUSTODY", "An early natural failure before a receipt recovers the exact supplied original IDs and commits private custody", async () => {
    const body = natural("What was our revenue last month?");
    const remove = await fault("work_events", eventCondition(body.instructionId, "understanding_started"));
    let first, before: Awaited<ReturnType<typeof custody>> | undefined;
    try {
      first = await call("/api/actions", body); assert.ok(first.status >= 500, JSON.stringify(first));
      before = await forInstruction(body.instructionId); assert.equal(before.work.status, "failed");
      assert.equal(before.receipts.length, 0); assert.equal(before.responses.length, 0);
      assert.equal(before.input.instruction_text, body.instruction);
    } finally { await remove(); }
    const recovery = await retry(before!); assert.equal(economic(recovery.response.body)?.statement?.amount, "950.25");
    const duplicate = await call("/api/actions", body); assert.equal(duplicate.status, 200); assert.deepEqual(queryOf(duplicate.body), queryOf(recovery.response.body));
    return { body, first, before: before!, recovery, duplicate };
  }, true);

  await check("PRIVATE_INSERT_ATOMIC_RECOVERY", "Failure of the canonical private INSERT cannot leave a succeeded receipt without reply; real retry rearms the same row", async () => {
    const body = natural("What was our revenue last month?");
    const remove = await fault("work_input_responses", privateCondition(body.instructionId));
    let first, before: Awaited<ReturnType<typeof custody>> | undefined;
    try {
      first = await call("/api/actions", body); assert.ok(first.status >= 500, JSON.stringify(first)); noFacts(first.body);
      before = await forInstruction(body.instructionId); assert.equal(before.work.status, "failed");
      assert.equal(before.receipts.length, 1); assert.notEqual(before.receipts[0].status, "succeeded"); assert.equal(before.responses.length, 0);
      noFacts({ failure: before.work.failure, traces: before.traces, events: before.events, receiptFailure: before.receipts[0].failure });
    } finally { await remove(); }
    const recovery = await retry(before!); assert.equal(economic(recovery.response.body)?.statement?.amount, "950.25");
    assert.equal(recovery.after.receipts[0].id, before!.receipts[0].id);
    assert.equal(recovery.after.receipts[0].execution_key, before!.receipts[0].execution_key);
    const duplicate = await call("/api/actions", body); assert.equal(duplicate.status, 200); assert.deepEqual(queryOf(duplicate.body), queryOf(recovery.response.body));
    return { body, first, before: before!, recovery, duplicate };
  }, true);

  await check("ANCILLARY_RESPONSE_FAILURE_REPLAY", "An ancillary private-envelope write failure after succeeded receipt cannot erase the already atomic original reply", async () => {
    const body = natural("What was our revenue last month?");
    const remove = await fault("work_input_responses", `${privateCondition(body.instructionId)}
      AND EXISTS(SELECT 1 FROM finnor_os.work_query_executions q WHERE q.tenant_id=NEW.tenant_id AND q.work_input_id=NEW.work_input_id AND q.status='succeeded')`, undefined, true);
    try {
      const first = await call("/api/actions", body); assert.equal(first.status, 201, JSON.stringify(first));
      assert.ok(first.body.projectionWarnings?.some((warning: any) => warning.stage === "response"));
      const s = await forInstruction(body.instructionId), original = committed(s, queryOf(first.body));
      assert.equal(s.work.status, "completed"); assert.deepEqual(Object.keys(s.responses[0].response).sort(), ["instructionId", "query", "workId", "workInputId"]);
      const duplicate = await call("/api/actions", body); assert.equal(duplicate.status, 200, JSON.stringify(duplicate));
      assert.equal(duplicate.body.replayDegraded, true); assert.deepEqual(queryOf(duplicate.body), original);
      return { body, first, s, duplicate };
    } finally { await remove(); }
  }, true);

  await check("ASSISTANT_PROJECTION_FAILURE_REPLAY", "A real assistant-message failure is ancillary and does not turn committed read replay into a terminal 500", async () => {
    const body = natural("What was our revenue last month?");
    const remove = await fault("employee_conversation_messages", `NEW.tenant_id='${tenant}'::uuid AND NEW.instruction_id='${body.instructionId}'::uuid AND NEW.role='assistant'`);
    try {
      const first = await call("/api/actions", body); assert.equal(first.status, 201, JSON.stringify(first));
      assert.ok(first.body.projectionWarnings?.some((warning: any) => warning.stage === "assistant message"));
      const s = await forInstruction(body.instructionId); committed(s, queryOf(first.body)); assert.equal(s.work.status, "completed");
      const duplicate = await call("/api/actions", body); assert.equal(duplicate.status, 200); assert.deepEqual(queryOf(duplicate.body), queryOf(first.body));
      return { body, first, s, duplicate };
    } finally { await remove(); }
  }, true);

  await check("QUOTE_POSSESSIVE", "Possessive and misleading objective/deadline quote questions remain exact NAME reads with no fleet", async () => {
    const observations = [];
    for (const instruction of ["What is W1 recorded company's stock price?", "W1 recorded company's stock price", "Ensure I know W1 recorded company's stock price before the deadline."]) {
      const response = await call("/api/actions", natural(instruction)); assert.equal(response.status, 201, JSON.stringify(response));
      assert.deepEqual(queryOf(response.body)?.request.instrument, { kind: "NAME", name: "W1 recorded company" });
      assert.equal(economic(response.body)?.quote?.price, "100.125"); assert.deepEqual(response.body.planned, []); observations.push({ instruction, response });
    }
    return observations;
  }, true);

  await check("EFFECT_WORD_ENTITY", "Change Healthcare is an exact entity, while an actual change/send command outside its subject remains an effect", async () => {
    const observations = [];
    try {
      await admin.query("UPDATE finnor_os.external_organizations SET name='Change Healthcare' WHERE tenant_id=$1 AND id=$2", [tenant, company]);
      for (const instruction of ["What was Change Healthcare's revenue last month?", "What was last month's revenue at Change Healthcare?",
        "What was last month's revenue for Change Healthcare?", "What was last month's revenue of Change Healthcare?"]) {
        const response = await call("/api/actions", natural(instruction)); assert.equal(response.status, 201, JSON.stringify(response));
        assert.equal(economic(response.body)?.statement?.amount, "950.25"); assert.deepEqual(queryOf(response.body)?.request.company, { kind: "NAME", name: "Change Healthcare" }); observations.push({ instruction, response });
      }
      await admin.query("UPDATE finnor_os.external_organizations SET name='Oil and Change Holdings' WHERE tenant_id=$1 AND id=$2", [tenant, company]);
      const conjunction = await call("/api/actions", natural("What was Oil and Change Holdings revenue last month?"));
      assert.equal(conjunction.status, 201, JSON.stringify(conjunction));
      assert.equal(economic(conjunction.body)?.statement?.amount, "950.25");
      assert.deepEqual(queryOf(conjunction.body)?.request.company, { kind: "NAME", name: "Oil and Change Holdings" });
      observations.push({ conjunction });
      await admin.query("UPDATE finnor_os.external_organizations SET name='Change Healthcare' WHERE tenant_id=$1 AND id=$2", [tenant, company]);
      for (const instruction of ["Change the report title. Show Change Healthcare's revenue last month.",
        "What was Change Healthcare's revenue last month? Send the report to the board."]) {
        const response = await call("/api/actions", natural(instruction)); assert.equal(response.status, 503, JSON.stringify(response));
        assert.equal(response.body.code, "worker_fleet_unavailable"); assert.equal(economic(response.body), undefined); observations.push({ instruction, response });
      }
    } finally { await admin.query("UPDATE finnor_os.external_organizations SET name='W1 recorded company' WHERE tenant_id=$1 AND id=$2", [tenant, company]); }
    return observations;
  }, true);

  await check("TYPED_REQUEST_RECOVERY", "A typed early failure durably retains all actual selectors and recovers via real retry, not intent-placeholder planning", async () => {
    const observations = [];
    for (const request of [
      { intent: "company_revenue", company: { kind: "ID", id: company }, period: "LAST_COMPLETED_MONTH", basis: "ACCRUAL", currency: "USD" },
      { intent: "stock_quote", instrument: { kind: "SYMBOL", symbol: "AAPL", exchange: "XNAS" }, currency: "USD" },
    ]) {
      const existingIds = (await admin.query("SELECT id FROM finnor_os.work_inputs WHERE tenant_id=$1", [tenant])).rows.map(row => row.id);
      const remove = await fault("work_events", `NEW.tenant_id='${tenant}'::uuid AND NEW.event_type='query_execution_started' AND NEW.payload->>'intent'='${request.intent}'`);
      let first, before: Awaited<ReturnType<typeof custody>> | undefined;
      const body = { ...request, idempotencyKey: randomUUID() };
      try {
        first = await call("/api/queries", body); assert.ok(first.status >= 500, JSON.stringify(first)); noFacts(first.body);
        const added = (await admin.query("SELECT id,work_id FROM finnor_os.work_inputs WHERE tenant_id=$1 AND NOT(id=ANY($2::uuid[]))", [tenant, existingIds])).rows;
        assert.equal(added.length, 1); before = await custody(added[0].work_id, added[0].id);
        assert.equal(before.work.status, "failed"); assert.equal(before.receipts.length, 0); assert.equal(before.responses.length, 0);
        assert.ok(before.input.instruction_text.startsWith("Typed economic query v1: "));
        assert.deepEqual(JSON.parse(before.input.instruction_text.slice("Typed economic query v1: ".length)), request);
      } finally { await remove(); }
      const recovery = await retry(before!); assert.deepEqual(queryOf(recovery.response.body)?.request, request);
      assert.ok(economic(recovery.response.body)?.statement?.amount === "950.25" || economic(recovery.response.body)?.quote?.price === "100.125");
      const duplicate = await call("/api/queries", body); assert.equal(duplicate.status, 200); assert.deepEqual(queryOf(duplicate.body), queryOf(recovery.response.body));
      observations.push({ body, first, before: before!, recovery, duplicate });
    }
    return observations;
  }, true);

  await check("COMPLETE_OUTPUT_REPLAY_VALIDATION", "Real private JSONB tampering cannot bypass complete output/identity/current-source validation or escape to generic replay", async () => {
    const observations = [];
    for (const [path, body] of [["/api/actions", natural("What was our revenue last month?")],
      ["/api/queries", { ...quoteRequest, idempotencyKey: randomUUID() }]] as const) {
      const first = await call(path, body); assert.equal(first.status, 201);
      assert.equal(economic(first.body)?.availability, path === "/api/actions" ? "AVAILABLE" : "CURRENT");
      assert.equal(path === "/api/actions" ? economic(first.body)?.statement?.amount : economic(first.body)?.quote?.price,
        path === "/api/actions" ? "950.25" : "100.125");
      const s = await custody(first.body.workId, first.body.workInputId), original = clone(s.responses[0].response);
      const corruptions: Array<[string, (reply: any) => void]> = [
        ["metadata duration", reply => { reply.query.metadata.durationMs = "NaN"; }],
        ["metadata id", reply => { reply.query.metadata.queryId = randomUUID(); }],
        ["page/count mismatch", reply => { reply.query.result.page.returned = 0; }],
        ["status/outcome mismatch", reply => { reply.query.result.status = "unavailable"; }],
        ["data/outcome mismatch", reply => { reply.query.result.data.availability = "UNAVAILABLE"; }],
        ["source/meta mismatch", reply => { reply.query.result.meta.source.tables = ["workforce_assignments"]; }],
        ["execution/input mismatch", reply => { reply.query.result.execution.workInputId = randomUUID(); }],
        ["outer input mismatch", reply => { reply.workInputId = randomUUID(); }],
        ["outer Work mismatch", reply => { reply.workId = randomUUID(); }],
        ["outer instruction mismatch", reply => { reply.instructionId = randomUUID(); }],
        ["request/outcome intent mismatch", reply => { reply.query.result.economicRead.intent = reply.query.request.intent === "stock_quote" ? "company_revenue" : "stock_quote"; }],
        ["validly typed but false financial fact", reply => {
          const result = reply.query.result.economicRead; if (result.statement) result.statement.amount = "950.26"; else result.quote.price = "100.126";
        }],
        ["corrupted into generic reply", reply => { for (const key of Object.keys(reply)) delete reply[key]; Object.assign(reply, { planned: [], answer: { spokenSummary: "forged generic answer" } }); }],
      ];
      try {
        for (const [name, corrupt] of corruptions) {
          const tampered = clone(original); corrupt(tampered);
          // Do not let an answer.query mismatch be the only reason malformed
          // pages/source/metadata are rejected: keep that duplicate in sync.
          if (tampered.answer?.query && tampered.query) tampered.answer.query = clone(tampered.query);
          assert.notDeepEqual(tampered, original, `Corruption must change the original complete reply: ${name}`);
          await admin.query("UPDATE finnor_os.work_input_responses SET response=$3::jsonb WHERE tenant_id=$1 AND work_input_id=$2", [tenant, s.input.id, JSON.stringify(tampered)]);
          const replay = await call(path, body); refused(replay); assert.equal(economic(replay.body), undefined);
          observations.push({ path, name, replay });
        }
      } finally {
        await admin.query("UPDATE finnor_os.work_input_responses SET response=$3::jsonb WHERE tenant_id=$1 AND work_input_id=$2", [tenant, s.input.id, JSON.stringify(original)]);
      }
      const restored = await call(path, body); assert.equal(restored.status, 200); assert.deepEqual(queryOf(restored.body), queryOf(first.body)); committed(await custody(s.work.id, s.input.id), queryOf(first.body));
    }
    return observations;
  }, true);

  await check("ORIGINAL_INPUT_PRINCIPAL_IDENTITY", "Changed original text/IDs or another same-tenant employee cannot recover or replay a private financial input", async () => {
    const body = natural("What was our revenue last month?"), first = await call("/api/actions", body);
    assert.equal(first.status, 201); const s = await custody(first.body.workId, first.body.workInputId);
    const { getOrchestrator } = await import("../../apps/api/lib/orchestrator");
    const ctx = await http.context(), peer = await http.context("peer"), observations = [];
    const originalIds = { workId: s.work.id, workInputId: s.input.id, instructionId: s.input.instruction_id };
    for (const input of [
      { instruction: "What was our revenue last month in EUR?", ctx, ids: originalIds },
      { instruction: body.instruction, ctx, ids: { ...originalIds, instructionId: randomUUID() } },
      { instruction: body.instruction, ctx: peer, ids: originalIds },
    ]) {
      let rejection: unknown;
      try { await getOrchestrator().handleInstructionResult(input.instruction, input.ctx, input.ids); } catch (error) { rejection = String(error); }
      assert.ok(rejection, "Supplied IDs or act_as may not replace original input/principal"); noFacts(rejection); observations.push({ input: { ...input, ctx: { userId: input.ctx.userId } }, rejection });
    }
    const retryByPeer = await call(`/api/works/${s.work.id}/retry`, { idempotencyKey: randomUUID() }, "peer"); refused(retryByPeer);
    const after = await custody(s.work.id, s.input.id); committed(after, queryOf(first.body)); assert.deepEqual(after.work.recovery, s.work.recovery);
    return { body, first, observations, retryByPeer, after };
  }, true);

  await check("IN_FLIGHT_DUPLICATE_RECEIPT", "A real delayed private commit exposes in-progress duplicate, then exactly one unchanged original receipt/reply", async () => {
    const body = natural("What was our revenue last month?"), hold = randomUUID();
    await admin.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [hold]);
    const remove = await fault("work_input_responses", privateCondition(body.instructionId), `PERFORM pg_advisory_xact_lock(hashtextextended('${hold}',0));`);
    const pending = Promise.allSettled([call("/api/actions", body)]);
    try {
      let running = false;
      for (let attempt = 0; attempt < 500 && !running; attempt++) {
        const rows = (await admin.query(`SELECT q.status FROM finnor_os.work_query_executions q JOIN finnor_os.work_inputs i
          ON i.tenant_id=q.tenant_id AND i.id=q.work_input_id WHERE i.tenant_id=$1 AND i.instruction_id=$2`, [tenant, body.instructionId])).rows;
        running = rows.some(row => row.status === "running");
        if (!running) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(running, true, "Actual in-flight receipt must be observed; an already-finished duplicate is not this oracle");
      const inProgress = await call("/api/actions", body); assert.equal(inProgress.status, 202, JSON.stringify(inProgress)); assert.equal(economic(inProgress.body), undefined);
      await admin.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [hold]);
      const [firstResult] = await pending;
      if (firstResult.status === "rejected") throw firstResult.reason;
      const first = firstResult.value; assert.equal(first.status, 201, JSON.stringify(first));
      const duplicate = await call("/api/actions", body); assert.equal(duplicate.status, 200); assert.deepEqual(queryOf(duplicate.body), queryOf(first.body));
      const s = await forInstruction(body.instructionId); committed(s, queryOf(first.body)); return { body, first, inProgress, duplicate, s };
    } finally {
      await admin.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [hold]);
      try { await pending; } finally { await remove(); }
    }
  }, true);

  // Real queue roots are created BEFORE the bounded read episode. No role grant
  // is widened: use the migrated non-superuser/non-BYPASSRLS worker role.
  const priorDatabaseUrl = process.env.DATABASE_URL;
  const workerUrl = new URL(priorDatabaseUrl!); workerUrl.username = "finnor_worker"; workerUrl.password = "w1_disposable_worker";
  await admin.query("ALTER ROLE finnor_worker LOGIN PASSWORD 'w1_disposable_worker'");
  const backgroundRoots: Array<Awaited<ReturnType<typeof receiveWork>> & { instruction: string; jobKey: string }> = [];
  for (const instruction of ["What was our revenue last month?", "What is the stock price for W1 recorded company?"]) {
    const root = await receiveWork({ tenantId: tenant, userId: scopedActor, instruction, channel: "voice", instructionId: randomUUID(), idempotencyKey: randomUUID() });
    backgroundRoots.push({ instruction, ...root, jobKey: randomUUID() });
  }
  try {
    process.env.DATABASE_URL = workerUrl.href; await closePool();
    const { JobQueue } = await import("../../apps/worker/src/queue");
    const { processInstruction } = await import("../../apps/worker/src/handlers/process-instruction");
    const cutover = (await admin.query("SELECT state FROM finnor_os.compute_plane_cutover WHERE singleton=true")).rows[0];
    assert.ok(cutover, "Actual queue cutover owner state must exist");
    const queue = new JobQueue(`w1-v3-owned-${randomUUID()}`, 300, cutover.state === "authoritative" ? "INTERACTIVE" : null);
    queue.register("process_instruction", processInstruction, { protocolVersions: [1], retrySafety: "locally_idempotent", allowedClasses: ["INTERACTIVE"] });
    for (const root of backgroundRoots) await queue.enqueue("process_instruction", {
      tenantId: tenant, instruction: root.instruction, workId: root.workId, workInputId: root.workInputId, instructionId: root.instructionId,
    }, root.jobKey, "interactive", 100);
    await journal("SEPARATE_BACKGROUND_ROOTS_BEFORE_EPISODE", backgroundRoots);
    await check("BACKGROUND_PRINCIPAL_NO_ACTIVATION", "Actual queued process_instruction reads use each original human and create zero additional activations", async () => {
      const principal = (await getPool().query("SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
      assert.equal(principal.current_user, "finnor_worker"); assert.equal(principal.rolsuper, false); assert.equal(principal.rolbypassrls, false);
      assert.equal(await queue.tick(), true); assert.equal(await queue.tick(), true);
      const observations = [];
      for (const root of backgroundRoots) {
        const s = await custody(root.workId, root.workInputId), q = committed(s);
        assert.equal(s.input.created_by, scopedActor); assert.equal(s.work.status, "completed");
        assert.ok(q.result.economicRead.statement?.amount === "950.25" || q.result.economicRead.quote?.price === "100.125");
        const job = (await admin.query("SELECT status,attempts,payload FROM finnor_os.jobs WHERE idempotency_key=$1", [root.jobKey])).rows;
        assert.equal(job.length, 1); assert.equal(job[0].status, "completed"); assert.equal(job[0].attempts, 1);
        noFacts({ finalOutcome: s.work.final_outcome, traces: s.traces, events: s.events }); observations.push({ root, s, job });
      }
      assert.equal((await admin.query("SELECT count(*)::int n FROM finnor_os.users WHERE id='00000000-0000-4000-8000-0000000000ee'")).rows[0].n, 0);
      return { principal, observations };
    }, true);
  } finally {
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDatabaseUrl;
    await closePool();
  }
}
